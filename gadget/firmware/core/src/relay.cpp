#include "botkins/relay.hpp"

#include <cctype>
#include <cstdlib>
#include <cstring>

namespace botkins {

namespace {
const char* kPhoneProtocol = "botkins.phone.v1";
const char* kPrefix = "/botkins/v1/";
// The route byte of a request: its place in this list, from 1.
const char* const kRoutes[] = {"hello", "pair", "session", "rpc", "join"};
// The relay closes a phone socket that sends more than 6 MiB + 64 KiB.
const size_t kMaxFrame = 6 * 1024 * 1024 + 64 * 1024;
const size_t kRoomLength = 43;

bool room_char(char c) { return isalnum((unsigned char)c) || c == '_' || c == '-'; }
bool name_char(char c) { return isalnum((unsigned char)c) || c == '.' || c == '-'; }

uint32_t read_u32(const uint8_t* at) { return (uint32_t)at[0] << 24 | (uint32_t)at[1] << 16 | (uint32_t)at[2] << 8 | at[3]; }
}  // namespace

bool parse_relay(const std::string& entry, RelayAddress& out) {
  // relay!<room: 43 of A-Z a-z 0-9 _ -> @ <authority>
  if (entry.compare(0, 6, "relay!") != 0 || entry.size() < 6 + kRoomLength + 2 || entry[6 + kRoomLength] != '@') return false;
  const std::string room = entry.substr(6, kRoomLength);
  for (char c : room)
    if (!room_char(c)) return false;
  const std::string authority = entry.substr(6 + kRoomLength + 1);
  // A plain host name or address with an optional port. `[::1]` is the one bracketed literal (loopback).
  std::string host, port;
  if (authority.compare(0, 5, "[::1]") == 0) {
    host = "[::1]";
    port = authority.substr(5);
  } else {
    size_t colon = authority.find(':');
    host = authority.substr(0, colon);
    port = colon == std::string::npos ? "" : authority.substr(colon);
    if (host.empty() || !isalnum((unsigned char)host.front()) || !isalnum((unsigned char)host.back()) || host.find("..") != std::string::npos) return false;
    for (char c : host)
      if (!name_char(c)) return false;
  }
  if (!port.empty()) {
    if (port[0] != ':' || port.size() < 2 || port.size() > 6) return false;
    for (size_t i = 1; i < port.size(); i++)
      if (!isdigit((unsigned char)port[i])) return false;
    const long number = strtol(port.c_str() + 1, nullptr, 10);
    if (number < 1 || number > 65535) return false;
  }
  std::string lower = host;
  for (char& c : lower) c = (char)tolower((unsigned char)c);
  const bool loopback = lower == "127.0.0.1" || lower == "localhost" || lower == "[::1]";
  out.entry = entry;
  out.room = room;
  out.authority = authority;
  out.url = (loopback ? "ws://" : "wss://") + authority + "/v1/room/" + room;
  return true;
}

RelayTransport::RelayTransport(Transport& direct, Sockets sockets) : direct_(direct), sockets_(std::move(sockets)) {}

RelayTransport::~RelayTransport() {
  std::vector<std::shared_ptr<Socket>> open;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& room : rooms_)
      if (room.second.conn) {
        auto socket = end(*room.second.conn);
        if (socket) open.push_back(std::move(socket));
      }
  }
  for (auto& socket : open) socket->close();
}

HttpResponse RelayTransport::request(const std::string& host, const char* method, const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, const std::string& body, int timeout_ms) {
  RelayAddress address;
  if (!parse_relay(host, address)) {
    // A relay entry that can't be read is nobody's address.
    if (host.compare(0, 6, "relay!") == 0) return HttpResponse();
    return direct_.request(host, method, path, headers, body, timeout_ms);
  }
  // The route stands for the method and the path (relay.ts: GET hello, POST the rest).
  uint8_t route = 0;
  if (path.compare(0, strlen(kPrefix), kPrefix) == 0)
    for (uint8_t i = 0; i < sizeof kRoutes / sizeof kRoutes[0]; i++)
      if (path.compare(strlen(kPrefix), std::string::npos, kRoutes[i]) == 0) route = i + 1;
  if (!route) return HttpResponse();
  // The one header that goes along: an rpc call's session. Its content type is implied by the route.
  std::string session;
  for (const auto& header : headers) {
    std::string name = header.first;
    for (char& c : name) c = (char)tolower((unsigned char)c);
    if (name == "x-botkins-session") session = header.second;
  }
  if (session.size() > 255) return HttpResponse();
  for (char c : session)
    if (c < 0x20 || c > 0x7e) return HttpResponse();

  // [0x01][id u32][route u8][n u8][session n][body…]: the id is written once a socket gives one.
  std::string frame;
  frame.reserve(7 + session.size() + body.size());
  frame.push_back('\x01');
  frame.append(4, '\0');
  frame.push_back((char)route);
  frame.push_back((char)session.size());
  frame += session;
  frame += body;
  if (frame.size() > kMaxFrame) return HttpResponse();
  return carry(address, frame, timeout_ms);
}

HttpResponse RelayTransport::carry(const RelayAddress& address, std::string& frame, int timeout_ms) {
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  std::unique_lock<std::mutex> lock(mutex_);
  std::shared_ptr<Conn> conn;
  for (;;) {
    Room& room = rooms_[address.entry];
    conn = room.conn;
    Clock::time_point now = Clock::now();
    if (conn && conn->state == Conn::State::Open && conn->pending.empty() && now - conn->used > std::chrono::milliseconds(idle_ms)) {
      // A socket that sat idle may have died quietly (a Wi-Fi nap, a router that forgot it). A new one is surer
      // than a request that waits for the next ping to find out.
      auto stale = end(*conn);
      lock.unlock();
      if (stale) stale->close();
      lock.lock();
      continue;
    }
    if (conn && conn->state == Conn::State::Open) break;
    if (conn && conn->state == Conn::State::Opening) {
      // Another request is opening it: this one goes along once it is open.
      if (changed_.wait_until(lock, deadline) == std::cv_status::timeout && Clock::now() >= deadline) return HttpResponse();
      continue;
    }
    // None yet, or the last one ended: a new socket, unless opening one failed a moment ago.
    if (now < room.retry_at) return HttpResponse();
    std::shared_ptr<Socket> stale = conn ? std::move(conn->socket) : nullptr;
    conn = std::make_shared<Conn>();
    conn->serial = ++serials_;
    room.conn = conn;
    lock.unlock();
    if (stale) stale->close();
    std::shared_ptr<Socket> socket(sockets_ ? sockets_().release() : nullptr);
    const int left = (int)std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    const int wait = left < connect_ms ? left : connect_ms;
    Socket::Events events;
    const std::string entry = address.entry;
    const uint64_t serial = conn->serial;
    events.message = [this, entry, serial](const uint8_t* data, size_t size, bool binary) { received(entry, serial, data, size, binary); };
    events.closed = [this, entry, serial](int) { closed(entry, serial); };
    const bool opened = socket && wait > 0 && socket->open(address.url, kPhoneProtocol, wait, max_answer + 64, std::move(events));
    lock.lock();
    Room& same = rooms_[address.entry];
    now = Clock::now();
    if (opened && conn->state == Conn::State::Opening) {
      conn->state = Conn::State::Open;
      conn->socket = std::move(socket);
      conn->used = conn->pinged = now;
      same.failures = 0;
      same.retry_at = Clock::time_point();
    } else {
      conn->state = Conn::State::Closed;
      if (!opened) {
        same.failures++;
        int backoff = backoff_ms;
        for (int i = 1; i < same.failures && backoff < backoff_max_ms; i++) backoff *= 2;
        same.retry_at = now + std::chrono::milliseconds(backoff < backoff_max_ms ? backoff : backoff_max_ms);
      }
    }
    changed_.notify_all();
    if (socket) {
      // It failed to open, or opened and closed again before it could be used.
      lock.unlock();
      socket->close();
      lock.lock();
    }
    if (conn->state != Conn::State::Open) return HttpResponse();
  }

  // A fresh id that no waiting request holds. Ids are not used again on a socket: the relay remembers answered ones.
  uint32_t id = conn->next_id++;
  while (conn->pending.count(id)) id = conn->next_id++;
  frame[1] = (char)(id >> 24);
  frame[2] = (char)(id >> 16);
  frame[3] = (char)(id >> 8);
  frame[4] = (char)id;
  Waiter me;
  conn->pending[id] = &me;
  conn->used = Clock::now();
  std::shared_ptr<Socket> socket = conn->socket;
  lock.unlock();
  // Sent outside the lock: a large request must not hold up the answers to the other thread's.
  const bool sent = socket->send((const uint8_t*)frame.data(), frame.size(), true);
  frame = std::string();
  lock.lock();
  if (!sent && conn->state == Conn::State::Open) {
    auto broken = end(*conn);
    lock.unlock();
    if (broken) broken->close();
    lock.lock();
  }

  while (!me.done) {
    const Clock::time_point now = Clock::now();
    if (now >= deadline) {
      // Given up on: an answer that still comes is dropped.
      conn->pending.erase(id);
      conn->used = now;
      return HttpResponse();
    }
    Clock::time_point wake = deadline;
    if (conn->state == Conn::State::Open) {
      // The keep-alive: the waiting requests take turns at it, so the transport needs no thread of its own.
      if (conn->ping_out && now >= conn->pinged + std::chrono::milliseconds(dead_ms)) {
        auto dead = end(*conn);
        lock.unlock();
        if (dead) dead->close();
        lock.lock();
        continue;
      }
      if (!conn->ping_out && now >= conn->pinged + std::chrono::milliseconds(ping_ms)) {
        conn->ping_out = true;
        conn->pinged = now;
        std::shared_ptr<Socket> pinging = conn->socket;
        lock.unlock();
        const bool ok = pinging->send((const uint8_t*)"ping", 4, false);
        lock.lock();
        if (!ok && conn->state == Conn::State::Open) {
          auto broken = end(*conn);
          lock.unlock();
          if (broken) broken->close();
          lock.lock();
        }
        continue;
      }
      const Clock::time_point timer = conn->pinged + std::chrono::milliseconds(conn->ping_out ? dead_ms : ping_ms);
      if (timer < wake) wake = timer;
    }
    changed_.wait_until(lock, wake);
  }
  // Idle counts from the last answer, not from the last question.
  conn->used = Clock::now();
  return std::move(me.response);
}

/** The connection of `entry` if it is still the one numbered `serial`. Called with the lock held. */
RelayTransport::Conn* RelayTransport::find(const std::string& entry, uint64_t serial) {
  auto room = rooms_.find(entry);
  if (room == rooms_.end() || !room->second.conn || room->second.conn->serial != serial) return nullptr;
  return room->second.conn.get();
}

/**
 * Ends a connection for good: what waited on it fails (status 0, as a computer that didn't answer), and
 * its socket is handed back to be closed once the lock is let go. Called with the lock held.
 */
std::shared_ptr<Socket> RelayTransport::end(Conn& conn) {
  conn.state = Conn::State::Closed;
  for (auto& waiting : conn.pending) waiting.second->done = true;
  conn.pending.clear();
  changed_.notify_all();
  return std::move(conn.socket);
}

void RelayTransport::received(const std::string& entry, uint64_t serial, const uint8_t* data, size_t size, bool binary) {
  std::lock_guard<std::mutex> lock(mutex_);
  Conn* conn = find(entry, serial);
  if (!conn || conn->state == Conn::State::Closed) return;
  // Anything at all from the relay shows the socket is alive.
  conn->ping_out = false;
  if (!binary || size == 0) return;
  if (data[0] == 0x05) {
    // The computer's own socket to the relay closed: nothing that is waiting will be answered.
    for (auto& waiting : conn->pending) waiting.second->done = true;
    conn->pending.clear();
    changed_.notify_all();
    return;
  }
  if (size < 5) return;
  auto found = conn->pending.find(read_u32(data + 1));
  // An answer for a request that was given up on is dropped.
  if (found == conn->pending.end()) return;
  Waiter* waiter = found->second;
  if (data[0] == 0x02 && size >= 7) {
    waiter->response.status = data[5] << 8 | data[6];
    waiter->response.body.assign((const char*)data + 7, size - 7);
  } else if (data[0] != 0x03) {
    // 0x07, a follow part, comes only for a call that asked to be followed, and a gadget asks for none.
    return;
  }
  // 0x03: no computer is connected, so nothing was passed on. Status 0, as a computer that didn't answer.
  waiter->done = true;
  conn->pending.erase(found);
  changed_.notify_all();
}

void RelayTransport::closed(const std::string& entry, uint64_t serial) {
  std::lock_guard<std::mutex> lock(mutex_);
  Conn* conn = find(entry, serial);
  if (!conn || conn->state == Conn::State::Closed) return;
  // Closed by the relay (restarting, or 4008: another socket from this network took this one's place) or
  // by the network. The socket is closed by the next request, not from inside its own event.
  conn->state = Conn::State::Closed;
  for (auto& waiting : conn->pending) waiting.second->done = true;
  conn->pending.clear();
  changed_.notify_all();
}

}  // namespace botkins
