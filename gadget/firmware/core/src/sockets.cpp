#include "botkins/sockets.hpp"

#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

namespace botkins {

namespace {
const int kDefaultPort = 47610;
const int kConnectMs = 4000;

using Clock = std::chrono::steady_clock;
int left(Clock::time_point deadline) {
  return (int)std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
}

/** "192.168.1.5:47610", "studio.local" or "[fe80::1]:47610" as a name and a port. */
void split(const std::string& host, std::string& name, std::string& port) {
  port = std::to_string(kDefaultPort);
  if (!host.empty() && host[0] == '[') {
    size_t close = host.find(']');
    name = host.substr(1, close == std::string::npos ? std::string::npos : close - 1);
    if (close != std::string::npos && close + 1 < host.size() && host[close + 1] == ':') port = host.substr(close + 2);
    return;
  }
  size_t colon = host.rfind(':');
  if (colon != std::string::npos && host.find(':') == colon) {
    name = host.substr(0, colon);
    port = host.substr(colon + 1);
  } else name = host;
}

/** Waits until the socket can be read (or written). False when the time ran out. */
bool ready(int fd, bool writing, int ms) {
  if (ms <= 0) return false;
  fd_set set;
  FD_ZERO(&set);
  FD_SET(fd, &set);
  timeval tv{ms / 1000, (ms % 1000) * 1000};
  return select(fd + 1, writing ? nullptr : &set, writing ? &set : nullptr, nullptr, &tv) > 0;
}

int open_socket(const std::string& host, Clock::time_point deadline) {
  std::string name, port;
  split(host, name, port);
  addrinfo hints{};
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* found = nullptr;
  if (getaddrinfo(name.c_str(), port.c_str(), &hints, &found) != 0 || !found) return -1;
  int fd = -1;
  for (addrinfo* at = found; at && fd < 0; at = at->ai_next) {
    int candidate = socket(at->ai_family, at->ai_socktype, at->ai_protocol);
    if (candidate < 0) continue;
    fcntl(candidate, F_SETFL, fcntl(candidate, F_GETFL, 0) | O_NONBLOCK);
    int connected = connect(candidate, at->ai_addr, at->ai_addrlen);
    if (connected != 0 && errno == EINPROGRESS) {
      int ms = left(deadline) < kConnectMs ? left(deadline) : kConnectMs;
      int error = 0;
      socklen_t size = sizeof error;
      if (ready(candidate, true, ms) && getsockopt(candidate, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0) connected = 0;
    }
    if (connected == 0) fd = candidate;
    else close(candidate);
  }
  freeaddrinfo(found);
  return fd;
}

bool send_all(int fd, const char* data, size_t size, Clock::time_point deadline) {
  while (size) {
    ssize_t sent = send(fd, data, size, 0);
    if (sent > 0) {
      data += sent;
      size -= (size_t)sent;
    } else if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (!ready(fd, true, left(deadline))) return false;
    } else return false;
  }
  return true;
}
}  // namespace

HttpResponse SocketTransport::request(const std::string& host, const char* method, const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, const std::string& body, int timeout_ms) {
  HttpResponse response;
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  int fd = open_socket(host, deadline);
  if (fd < 0) return response;

  std::string head = std::string(method) + " " + path + " HTTP/1.1\r\nhost: " + host + "\r\nconnection: close\r\ncontent-length: " + std::to_string(body.size()) + "\r\n";
  for (const auto& header : headers) head += header.first + ": " + header.second + "\r\n";
  head += "\r\n";
  std::string answer;
  bool sent = send_all(fd, head.data(), head.size(), deadline) && send_all(fd, body.data(), body.size(), deadline);
  head = std::string();

  size_t body_at = std::string::npos, length = std::string::npos;
  char chunk[2048];
  while (sent) {
    if (body_at != std::string::npos && length != std::string::npos && answer.size() - body_at >= length) break;
    if (!ready(fd, false, left(deadline))) {
      sent = false;
      break;
    }
    ssize_t got = recv(fd, chunk, sizeof chunk, 0);
    if (got == 0) break;
    if (got < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
      sent = false;
      break;
    }
    answer.append(chunk, (size_t)got);
    if (answer.size() > max_answer + 4096) {
      sent = false;
      break;
    }
    if (body_at == std::string::npos) {
      size_t end = answer.find("\r\n\r\n");
      if (end == std::string::npos) continue;
      body_at = end + 4;
      // The one header that matters: how long the body is. Header names come in any case.
      std::string lower = answer.substr(0, end);
      for (char& c : lower) c = (char)tolower((unsigned char)c);
      size_t at = lower.find("\r\ncontent-length:");
      if (at != std::string::npos) {
        length = (size_t)strtoul(lower.c_str() + at + 17, nullptr, 10);
        // Whoever answers may be anyone on the network: a length is believed only up to what a gadget takes.
        if (length > max_answer) {
          sent = false;
          break;
        }
        answer.reserve(body_at + length);
      }
    }
  }
  close(fd);
  if (!sent || body_at == std::string::npos || answer.compare(0, 5, "HTTP/") != 0) return response;
  if (length != std::string::npos && answer.size() - body_at < length) return response;
  size_t space = answer.find(' ');
  response.status = space == std::string::npos ? 0 : atoi(answer.c_str() + space + 1);
  response.body = length == std::string::npos ? answer.substr(body_at) : answer.substr(body_at, length);
  return response;
}

}  // namespace botkins
