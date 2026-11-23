// The link's HTTP over plain sockets (BSD sockets: a computer's, and lwIP's on an ESP32). One
// request for each connection: the computer is on the same network, so a connection costs a few
// milliseconds, and nothing has to be kept alive across Wi-Fi naps.
#pragma once
#include "botkins/hal.hpp"

namespace botkins {

struct SocketTransport : Transport {
  /** The longest answer taken, in bytes. An answer that says it is longer is refused before any of it is kept. */
  size_t max_answer = 1024 * 1024;
  HttpResponse request(const std::string& host, const char* method, const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, const std::string& body, int timeout_ms) override;
};

/** A TCP connection to "address:port" ("[v6]:port"; 47610 without a port), non-blocking, or -1. */
int connect_to(const std::string& host, int timeout_ms);

}  // namespace botkins
