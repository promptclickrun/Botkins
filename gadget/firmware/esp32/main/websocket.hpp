// The board's WebSocket (botkins::Socket, core/include/botkins/hal.hpp) on ESP-IDF's esp_websocket_client:
// the relay's socket and live voice's. gadget/firmware/host/websocket.cpp is the same thing for a computer,
// and the reference for how it behaves.
#pragma once
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>

#include "botkins/hal.hpp"
#include "esp_event.h"
#include "esp_websocket_client.h"

namespace port {

class EspSocket : public botkins::Socket {
 public:
  ~EspSocket() override;
  bool open(const std::string& url, const std::string& protocol, int timeout_ms, size_t max_message, Events events) override;
  bool send(const uint8_t* data, size_t size, bool binary) override;
  void close() override;

  /** Why the last open() failed, in a few words (for a log line): "HTTP 404", "TLS -0x2700", "timed out", … */
  const std::string& failure() const { return failure_; }
  /** How long the last open() took: DNS, TCP, TLS and the HTTP upgrade. */
  int open_ms() const { return open_ms_; }

 private:
  enum class Phase { Idle, Opening, Open, Failed, Ended, Closing };
  static void on_event(void* self, esp_event_base_t base, int32_t id, void* data);
  void event(int32_t id, const esp_websocket_event_data_t& data);
  void data(const esp_websocket_event_data_t& data);
  /** Closes the connection with `code` (1009: a message over max_message; 1002: fragments out of order) and tells the core. */
  void refuse(int code);
  void deliver_closed(int code);

  esp_websocket_client_handle_t client_ = nullptr;
  std::string url_, protocol_, where_;  // where_: the URL without its query (the query may hold a token)
  Events events_;
  size_t max_message_ = 0;

  std::mutex m_;  // guards the fields below
  std::condition_variable changed_;
  Phase phase_ = Phase::Idle;
  bool returned_ = false;  // open() has returned true: events may go to the core
  int senders_ = 0;        // send() calls under way: close() waits for them
  std::string chosen_;     // the server's Sec-WebSocket-Protocol
  bool chose_ = false;
  std::string failure_;
  int open_ms_ = 0;

  // The socket's own task only.
  std::string message_;  // a message in fragments, until its last
  uint8_t kind_ = 0;     // its opcode: 1 text, 2 binary; 0 when none is under way
  int close_code_ = 0;
  std::string close_reason_;  // the server's words with its close, for the log
  int64_t began_us_ = 0;
  unsigned stack_least_ = 0;  // the least stack left on the socket's task, in bytes
};

}  // namespace port
