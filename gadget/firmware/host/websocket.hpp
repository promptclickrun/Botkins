// A WebSocket client (RFC 6455) over plain BSD sockets, for the relay on this computer: ws:// only, no
// TLS. A board's is its platform's own client with TLS (ESP-IDF's esp_websocket_client on an ESP32).
#pragma once
#include <atomic>
#include <mutex>
#include <string>
#include <thread>

#include "botkins/hal.hpp"

namespace botkins {

class HostSocket : public Socket {
 public:
  ~HostSocket() override;
  bool open(const std::string& url, const std::string& protocol, int timeout_ms, size_t max_message, Events events) override;
  bool send(const uint8_t* data, size_t size, bool binary) override;
  void close() override;

 private:
  void read_loop(std::string buffer);
  /** One masked frame. Called with `write_` held. */
  bool write_frame(uint8_t opcode, const uint8_t* data, size_t size, int timeout_ms);

  int fd_ = -1;
  std::mutex write_;  // guards fd_ and each frame being written
  std::thread reader_;
  std::atomic<bool> closing_{false};
  Events events_;
  size_t max_message_ = 0;
};

}  // namespace botkins
