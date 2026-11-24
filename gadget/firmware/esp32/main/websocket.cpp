// The board's WebSocket on esp_websocket_client (a managed component, ../THIRD_PARTY.md). What it adds to
// the client, to be the core's Socket (core/include/botkins/hal.hpp):
//   - whole messages: the client hands over a frame a buffer at a time, and a message may come in
//     several frames; they are joined here, up to max_message (beyond it the socket closes with 1009);
//   - the subprotocol the server chose is checked (the client sends the offer but reads no answer), and
//     with none offered no Sec-WebSocket-Protocol header goes at all;
//   - no reconnecting: a socket that ends is over, and the core says so once (`closed`);
//   - close() returns only when the client's task has ended, so no event can follow.
// wss:// is checked against ESP-IDF's certificate bundle (esp_crt_bundle_attach).
#include "websocket.hpp"

#include <netdb.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <thread>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_pthread.h"
#include "esp_timer.h"
#include "esp_tls.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "port.hpp"

namespace port {
namespace {
const char* TAG = "botkins.socket";
// The client's task: TLS (the handshake runs on it) and the core's message handling (live voice reads
// Gemini's JSON and resamples its sound there). The least left is logged when a socket closes.
const int kStack = 8 * 1024;
// The client reads and writes a buffer at a time, and sends a message longer than this as several
// frames. Over 16 KB, so both buffers land in PSRAM (CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL), not in
// internal RAM: a relay answer or a piece of Gemini's voice usually fits in one.
const int kBuffer = 20 * 1024;
const int kSendMs = 10000;
// How long close() waits for the server to answer its close frame before it cuts the connection.
const int kCloseMs = 1000;

int64_t now_ms() { return esp_timer_get_time() / 1000; }

bool starts_with(const std::string& text, const char* prefix) { return text.compare(0, strlen(prefix), prefix) == 0; }

std::atomic<void*> g_tasks[4];  // the sockets' tasks now, so close() can tell it isn't called from one
}  // namespace

EspSocket::~EspSocket() { close(); }

bool EspSocket::open(const std::string& url, const std::string& protocol, int timeout_ms, size_t max_message, Events events) {
  if (client_) return false;
  const bool tls = starts_with(url, "wss://");
  if (!tls && !starts_with(url, "ws://")) return false;
  url_ = url;
  protocol_ = protocol;
  // The query may hold a token (live voice's access_token): it is never logged.
  where_ = url.substr(0, url.find('?'));
  events_ = std::move(events);
  max_message_ = max_message;
  message_ = std::string();
  kind_ = 0;
  close_code_ = 0;
  close_reason_.clear();
  stack_least_ = UINT32_MAX;
  {
    std::lock_guard<std::mutex> lock(m_);
    phase_ = Phase::Opening;
    returned_ = false;
    senders_ = 0;
    chosen_.clear();
    chose_ = false;
    failure_.clear();
    open_ms_ = 0;
  }

  esp_websocket_client_config_t config = {};
  config.uri = url_.c_str();
  // None offered: no Sec-WebSocket-Protocol header at all.
  config.subprotocol = protocol_.empty() ? nullptr : protocol_.c_str();
  config.disable_auto_reconnect = true;
  config.task_prio = 5;
  config.task_name = "socket";
  config.task_stack = kStack;
  config.buffer_size = kBuffer;
  // The connection (DNS, TCP, TLS, the upgrade) in one go, then each read and write.
  config.network_timeout_ms = std::max(1000, std::min(timeout_ms, kSendMs));
  // WebSocket pings keep a quiet connection (a live session between turns) known to be alive.
  config.ping_interval_sec = 15;
  config.pingpong_timeout_sec = 45;
  config.user_context = this;
  config.transport = tls ? WEBSOCKET_TRANSPORT_OVER_SSL : WEBSOCKET_TRANSPORT_OVER_TCP;
  if (tls) config.crt_bundle_attach = esp_crt_bundle_attach;
  client_ = esp_websocket_client_init(&config);
  if (!client_) {
    ESP_LOGW(TAG, "%s: the client didn't start (memory?)", where_.c_str());
    return false;
  }
  esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY, &EspSocket::on_event, this);
  began_us_ = esp_timer_get_time();
  if (esp_websocket_client_start(client_) != ESP_OK) {
    esp_websocket_client_destroy(client_);
    client_ = nullptr;
    ESP_LOGW(TAG, "%s: the client's task didn't start (memory?)", where_.c_str());
    return false;
  }
  {
    std::unique_lock<std::mutex> lock(m_);
    changed_.wait_for(lock, std::chrono::milliseconds(timeout_ms), [this] { return phase_ != Phase::Opening; });
    if (phase_ == Phase::Open) {
      returned_ = true;
      changed_.notify_all();
      return true;
    }
    if (phase_ == Phase::Opening && failure_.empty()) failure_ = "timed out";
    phase_ = Phase::Closing;
    changed_.notify_all();
  }
  // Stops the client's task (an unfinished connect gives up within network_timeout_ms) and frees it.
  esp_websocket_client_destroy(client_);
  client_ = nullptr;
  ESP_LOGW(TAG, "%s didn't open (%s) after %d ms", where_.c_str(), failure_.c_str(), (int)((esp_timer_get_time() - began_us_) / 1000));
  return false;
}

bool EspSocket::send(const uint8_t* data, size_t size, bool binary) {
  {
    std::lock_guard<std::mutex> lock(m_);
    if (phase_ != Phase::Open || !returned_ || !client_) return false;
    senders_++;
  }
  // The client holds its send lock for the whole message (CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK: not the
  // lock its task reads under), so two senders never mix their frames.
  const int sent = esp_websocket_client_send_with_opcode(client_, binary ? WS_TRANSPORT_OPCODES_BINARY : WS_TRANSPORT_OPCODES_TEXT, data, (int)size,
                                                         pdMS_TO_TICKS(kSendMs));
  {
    std::lock_guard<std::mutex> lock(m_);
    senders_--;
    changed_.notify_all();
  }
  return sent == (int)size;
}

void EspSocket::close() {
  if (!client_) return;
  void* me = xTaskGetCurrentTaskHandle();
  bool own = false;
  for (auto& task : g_tasks)
    if (task.load() == me) own = true;
  bool was_open;
  {
    std::unique_lock<std::mutex> lock(m_);
    was_open = phase_ == Phase::Open;
    phase_ = Phase::Closing;
    changed_.notify_all();
    // A message being sent finishes first (at most kSendMs): the client goes away below.
    changed_.wait(lock, [this] { return senders_ == 0; });
  }
  if (own) {
    // Not allowed by the core (hal.hpp): a task can't wait for itself to end. The close frame goes, and
    // the client frees itself once the server has closed the connection.
    ESP_LOGE(TAG, "%s: close() from the socket's own task", where_.c_str());
    const uint8_t body[2] = {1000 >> 8, 1000 & 0xff};
    esp_websocket_client_send_with_opcode(client_, WS_TRANSPORT_OPCODES_CLOSE, body, 2, pdMS_TO_TICKS(1000));
    esp_websocket_client_destroy_on_exit(client_);
    client_ = nullptr;
    return;
  }
  // The close frame, a moment for the server's answer, then the task is stopped either way.
  if (was_open && esp_websocket_client_is_connected(client_)) esp_websocket_client_close_with_code(client_, 1000, nullptr, 0, pdMS_TO_TICKS(kCloseMs));
  esp_websocket_client_destroy(client_);
  client_ = nullptr;
  if (stack_least_ != UINT32_MAX) ESP_LOGI(TAG, "%s closed; its task had at least %u of %d bytes of stack left", where_.c_str(), stack_least_, kStack);
}

void EspSocket::on_event(void* self, esp_event_base_t, int32_t id, void* data) {
  static_cast<EspSocket*>(self)->event(id, *static_cast<const esp_websocket_event_data_t*>(data));
}

void EspSocket::event(int32_t id, const esp_websocket_event_data_t& data) {
  // The least stack left on the client's task: after the TLS handshake (CONNECTED) and each message.
  const unsigned left = uxTaskGetStackHighWaterMark(nullptr);  // bytes, on ESP-IDF
  if (left < stack_least_) stack_least_ = left;
  switch (id) {
    case WEBSOCKET_EVENT_BEGIN: {
      for (auto& task : g_tasks) {
        void* none = nullptr;
        if (task.compare_exchange_strong(none, xTaskGetCurrentTaskHandle())) break;
      }
      break;
    }
    case WEBSOCKET_EVENT_FINISH: {
      for (auto& task : g_tasks) {
        void* mine = xTaskGetCurrentTaskHandle();
        task.compare_exchange_strong(mine, nullptr);
      }
      std::lock_guard<std::mutex> lock(m_);
      if (phase_ == Phase::Opening) {
        phase_ = Phase::Failed;
        if (failure_.empty()) failure_ = "ended";
        changed_.notify_all();
      }
      break;
    }
    case WEBSOCKET_EVENT_HEADER_RECEIVED: {
      // One line of the server's answer to the upgrade (all but Sec-WebSocket-Accept, which the transport checks).
      std::string line(data.data_ptr, (size_t)data.data_len);
      const char* name = "sec-websocket-protocol:";
      if (line.size() >= strlen(name) && strncasecmp(line.c_str(), name, strlen(name)) == 0) {
        std::string value = line.substr(strlen(name));
        while (!value.empty() && isspace((unsigned char)value.front())) value.erase(0, 1);
        while (!value.empty() && isspace((unsigned char)value.back())) value.pop_back();
        std::lock_guard<std::mutex> lock(m_);
        chosen_ = value;
        chose_ = true;
      }
      break;
    }
    case WEBSOCKET_EVENT_CONNECTED: {
      const int ms = (int)((esp_timer_get_time() - began_us_) / 1000);
      std::lock_guard<std::mutex> lock(m_);
      open_ms_ = ms;
      if (phase_ != Phase::Opening) break;
      // The server must choose the one subprotocol offered, and name none when none was.
      const bool agreed = protocol_.empty() ? !chose_ : (chose_ && chosen_ == protocol_);
      if (!agreed) {
        phase_ = Phase::Failed;
        failure_ = chose_ ? "the server chose the subprotocol \"" + chosen_ + "\"" : "the server chose no subprotocol";
      } else {
        phase_ = Phase::Open;
        ESP_LOGI(TAG, "%s open in %d ms; internal free %u (least %u since boot), psram free %u (least %u since boot)", where_.c_str(), ms,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)least_since_boot(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned)least_since_boot(MALLOC_CAP_SPIRAM));
      }
      changed_.notify_all();
      break;
    }
    case WEBSOCKET_EVENT_ERROR: {
      // The upgrade's HTTP status, when the server answered one that isn't 101.
      const int status = data.error_handle.esp_ws_handshake_status_code;
      std::lock_guard<std::mutex> lock(m_);
      if (phase_ == Phase::Opening && status > 0 && status != 101) failure_ = "HTTP " + std::to_string(status);
      break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED: {
      {
        std::lock_guard<std::mutex> lock(m_);
        if (phase_ == Phase::Opening) {
          if (failure_.empty()) {
            char text[96];
            const esp_websocket_error_codes_t& error = data.error_handle;
            if (error.esp_tls_stack_err || error.esp_tls_cert_verify_flags)
              snprintf(text, sizeof text, "TLS %s, -0x%x, certificate flags 0x%x", esp_err_to_name(error.esp_tls_last_esp_err), (unsigned)-error.esp_tls_stack_err,
                       (unsigned)error.esp_tls_cert_verify_flags);
            else if (error.esp_tls_last_esp_err)
              snprintf(text, sizeof text, "%s, errno %d", esp_err_to_name(error.esp_tls_last_esp_err), error.esp_transport_sock_errno);
            else snprintf(text, sizeof text, "no connection, errno %d", error.esp_transport_sock_errno);
            failure_ = text;
          }
          phase_ = Phase::Failed;
          changed_.notify_all();
          break;
        }
      }
      // The connection broke (or a ping went unanswered).
      deliver_closed(0);
      break;
    }
    case WEBSOCKET_EVENT_CLOSED:
      // The server closed it, and the close frames were exchanged.
      deliver_closed(close_code_ ? close_code_ : 1005);
      break;
    case WEBSOCKET_EVENT_DATA:
      this->data(data);
      break;
    default:
      break;
  }
}

void EspSocket::data(const esp_websocket_event_data_t& data) {
  const uint8_t op = data.op_code;
  const bool first = data.payload_offset == 0;
  const bool last = data.payload_offset + data.data_len >= data.payload_len;
  if (op == WS_TRANSPORT_OPCODES_CLOSE) {
    // The server's close: its code, then the client answers it and CLOSED follows.
    if (first) {
      close_code_ = data.data_len >= 2 ? (uint8_t)data.data_ptr[0] << 8 | (uint8_t)data.data_ptr[1] : 1005;
      close_reason_ = data.data_len > 2 ? std::string(data.data_ptr + 2, (size_t)data.data_len - 2) : std::string();
    }
    return;
  }
  if (op != WS_TRANSPORT_OPCODES_CONT && op != WS_TRANSPORT_OPCODES_TEXT && op != WS_TRANSPORT_OPCODES_BINARY) return;  // pings: the client answers them
  {
    // Events go to the core only once open() has returned true, and none once close() began.
    std::unique_lock<std::mutex> lock(m_);
    changed_.wait(lock, [this] { return returned_ || phase_ != Phase::Open; });
    if (phase_ != Phase::Open) return;
  }
  if (first) {
    if ((op == WS_TRANSPORT_OPCODES_CONT) != (kind_ != 0)) {
      // A continuation with no message begun, or a new message inside another.
      refuse(1002);
      return;
    }
    if (message_.size() + (size_t)data.payload_len > max_message_) {
      refuse(1009);
      return;
    }
    if (op != WS_TRANSPORT_OPCODES_CONT) {
      kind_ = op;
      if (data.fin && last) {
        // A whole message in one buffer: straight from the client's.
        kind_ = 0;
        if (events_.message) events_.message((const uint8_t*)data.data_ptr, (size_t)data.data_len, op == WS_TRANSPORT_OPCODES_BINARY);
        return;
      }
    }
    message_.reserve(message_.size() + (size_t)data.payload_len);
  }
  message_.append(data.data_ptr, (size_t)data.data_len);
  if (data.fin && last) {
    const bool binary = kind_ == WS_TRANSPORT_OPCODES_BINARY;
    kind_ = 0;
    std::string whole = std::move(message_);
    message_ = std::string();
    if (events_.message) events_.message((const uint8_t*)whole.data(), whole.size(), binary);
  }
}

void EspSocket::refuse(int code) {
  ESP_LOGW(TAG, "%s: closing it (%d)", where_.c_str(), code);
  message_ = std::string();
  kind_ = 0;
  const uint8_t body[2] = {(uint8_t)(code >> 8), (uint8_t)code};
  esp_websocket_client_send_with_opcode(client_, WS_TRANSPORT_OPCODES_CLOSE, body, 2, pdMS_TO_TICKS(1000));
  deliver_closed(code);
}

void EspSocket::deliver_closed(int code) {
  {
    std::unique_lock<std::mutex> lock(m_);
    changed_.wait(lock, [this] { return returned_ || phase_ != Phase::Open; });
    if (phase_ != Phase::Open) return;
    // At most once: what the socket's task sees after this goes nowhere.
    phase_ = Phase::Ended;
    changed_.notify_all();
  }
  if (close_reason_.empty()) ESP_LOGI(TAG, "%s ended (%d)", where_.c_str(), code);
  else ESP_LOGI(TAG, "%s ended (%d: %.100s)", where_.c_str(), code, close_reason_.c_str());
  if (events_.closed) events_.closed(code);
}

// The console's `socket <url> [subprotocol|-] [first message]` (README.md): how a TLS WebSocket to that address goes, each
// step timed, with the memory while it is open. It proves the board reaches an address (the relay, or
// Gemini's with no key) without the rest of the gadget.
void probe_socket(const std::string& args) {
  // The probe's own stack is in PSRAM, so the internal RAM it reports is the socket's alone.
  esp_pthread_cfg_t before = esp_pthread_get_default_config();
  esp_pthread_get_cfg(&before);
  esp_pthread_cfg_t probe = esp_pthread_get_default_config();
  probe.stack_size = 12 * 1024;
  probe.stack_alloc_caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
  probe.thread_name = "probe";
  esp_pthread_set_cfg(&probe);
  std::thread([args] {
    // <url> [subprotocol, or - for none] [a first message, sent as text once it is open]
    std::string url = args, protocol, first;
    const size_t space = args.find(' ');
    if (space != std::string::npos) {
      url = args.substr(0, space);
      protocol = args.substr(space + 1);
      const size_t second = protocol.find(' ');
      if (second != std::string::npos) {
        first = protocol.substr(second + 1);
        protocol.resize(second);
      }
      if (protocol == "-") protocol.clear();
    }
    const bool tls = starts_with(url, "wss://");
    const size_t start = tls ? 6 : starts_with(url, "ws://") ? 5 : std::string::npos;
    if (start == std::string::npos) {
      ESP_LOGW(TAG, "probe: a ws:// or wss:// address, please");
      return;
    }
    const std::string where = url.substr(0, url.find('?'));
    std::string authority = url.substr(start, url.find_first_of("/?", start) - start);
    std::string host = authority;
    int port = tls ? 443 : 80;
    const size_t colon = authority.rfind(':');
    if (colon != std::string::npos && authority.find(']') == std::string::npos) {
      host = authority.substr(0, colon);
      port = atoi(authority.c_str() + colon + 1);
    }
    // Each step's least free memory on its own ("since reset" in each line).
    heap_reset();
    log_heap("probe: before");

    int64_t at = now_ms();
    addrinfo hints = {}, *found = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    const int dns = getaddrinfo(host.c_str(), nullptr, &hints, &found);
    const int dns_ms = (int)(now_ms() - at);
    if (found) freeaddrinfo(found);
    if (dns != 0) {
      ESP_LOGW(TAG, "probe: %s: DNS failed (%d) after %d ms", host.c_str(), dns, dns_ms);
      return;
    }
    ESP_LOGI(TAG, "probe: %s: DNS %d ms (it may have been cached)", host.c_str(), dns_ms);

    if (tls) {
      // TCP and the TLS handshake alone, the certificate checked as the socket checks it.
      esp_tls_cfg_t cfg = {};
      cfg.crt_bundle_attach = esp_crt_bundle_attach;
      cfg.timeout_ms = 10000;
      esp_tls_t* conn = esp_tls_init();
      at = now_ms();
      const int ok = conn ? esp_tls_conn_new_sync(host.c_str(), (int)host.size(), port, &cfg, conn) : -1;
      const int tls_ms = (int)(now_ms() - at);
      if (ok == 1) ESP_LOGI(TAG, "probe: %s:%d: TCP and TLS handshake %d ms, certificate checked", host.c_str(), port, tls_ms);
      else ESP_LOGW(TAG, "probe: %s:%d: TLS failed after %d ms", host.c_str(), port, tls_ms);
      if (conn) esp_tls_conn_destroy(conn);
      log_heap("probe: after the TLS handshake");
      heap_reset();
    }

    struct Seen {
      std::mutex m;
      std::condition_variable cv;
      int messages = 0, code = -1;
      std::string first;
    } seen;
    EspSocket::Events events;
    events.message = [&seen](const uint8_t* data, size_t size, bool binary) {
      std::lock_guard<std::mutex> lock(seen.m);
      if (seen.messages++ == 0) seen.first = binary ? "(binary, " + std::to_string(size) + " bytes)" : std::string((const char*)data, std::min<size_t>(size, 160));
      seen.cv.notify_all();
    };
    events.closed = [&seen](int code) {
      std::lock_guard<std::mutex> lock(seen.m);
      seen.code = code;
      seen.cv.notify_all();
    };
    EspSocket socket;
    at = now_ms();
    if (!socket.open(url, protocol, 10000, 512 * 1024, events)) {
      ESP_LOGI(TAG, "probe: %s: the WebSocket didn't open: %s (%d ms)", where.c_str(), socket.failure().c_str(), (int)(now_ms() - at));
      log_heap("probe: after");
      return;
    }
    ESP_LOGI(TAG, "probe: %s: WebSocket open in %d ms (DNS, TCP, TLS and the upgrade)", where.c_str(), socket.open_ms());
    log_heap("probe: socket open");
    if (!first.empty()) ESP_LOGI(TAG, "probe: sent %u bytes: %s", (unsigned)first.size(), socket.send((const uint8_t*)first.data(), first.size(), false) ? "yes" : "no");
    {
      std::unique_lock<std::mutex> lock(seen.m);
      seen.cv.wait_for(lock, std::chrono::seconds(5), [&seen] { return seen.messages > 0 || seen.code >= 0; });
      // A close right after the first message: a moment longer for it.
      if (seen.messages && seen.code < 0) seen.cv.wait_for(lock, std::chrono::seconds(2), [&seen] { return seen.code >= 0; });
      if (seen.messages) ESP_LOGI(TAG, "probe: first message: %s", seen.first.c_str());
      if (seen.code >= 0) ESP_LOGI(TAG, "probe: the server closed it (%d)", seen.code);
      else if (!seen.messages) ESP_LOGI(TAG, "probe: nothing came in 5 s");
    }
    socket.close();
    log_heap("probe: after");
  }).detach();
  esp_pthread_set_cfg(&before);
}

}  // namespace port
