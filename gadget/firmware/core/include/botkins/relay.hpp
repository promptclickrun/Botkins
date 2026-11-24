// The phone's side of the Botkins relay, for a gadget away from its computer's network (or with a
// computer that is reachable only through its relay). mobile/relay/README.md ("Wire format") is the
// protocol; mobile/src/link/relay.ts is the phone's version of the same thing.
//
// A relay address is one more entry in the computer's addresses: `relay!<room>@<relay host[:port]>`.
// RelayTransport carries the link's requests for such an entry over one WebSocket
// (wss://<relay>/v1/room/<room>, subprotocol botkins.phone.v1), and hands every other host to the
// board's own Transport. Every request is already sealed by the link: the relay reads none of it.
//
//   phone → relay   [0x01][id u32][route u8][n u8][session: n bytes][body…]   route: 1 hello … 5 join
//   relay → phone   [0x02][id u32][status u16][body…]                          the answer
//                   [0x03][id u32]                                             no computer: not passed on
//                   [0x05]                                                     the computer left: nothing waiting will be answered
//                   [0x07][id u32][…]                                          a follow part (a gadget asks for none)
//   text "ping" is answered "pong". Numbers are big-endian.
#pragma once
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "botkins/hal.hpp"

namespace botkins {

/** A `relay!<room>@<authority>` entry, read. */
struct RelayAddress {
  std::string entry, room, authority;
  /** wss://<authority>/v1/room/<room>; ws:// for 127.0.0.1, localhost and [::1]. */
  std::string url;
};
/** Reads a relay entry as the phone does (`parseRelayHost`). False when it is not one, or is malformed. */
bool parse_relay(const std::string& entry, RelayAddress& out);

class RelayTransport : public Transport {
 public:
  using Sockets = std::function<std::unique_ptr<Socket>()>;
  /** `direct` takes every host that is not a relay entry. `sockets` makes a WebSocket (Board::socket). */
  RelayTransport(Transport& direct, Sockets sockets);
  ~RelayTransport() override;

  HttpResponse request(const std::string& host, const char* method, const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, const std::string& body, int timeout_ms) override;
  bool relays() const override { return true; }

  /** The longest answer taken, in bytes. A longer message closes the socket. */
  size_t max_answer = 1024 * 1024;
  /** A socket that has not opened by then has failed. */
  int connect_ms = 8000;
  /** While requests wait, "ping" is sent this often (the relay and the proxies before it see a live socket). */
  int ping_ms = 25000;
  /** A socket that has heard nothing this long after a ping is dead: what waited on it fails. */
  int dead_ms = 10000;
  /** A socket with nothing waiting for this long is not trusted again: the next request opens a new one. */
  int idle_ms = 30000;
  /** After a socket failed to open, requests fail at once for this long, doubling with each failure up to `backoff_max_ms`. */
  int backoff_ms = 1000;
  int backoff_max_ms = 15000;

 private:
  using Clock = std::chrono::steady_clock;
  struct Waiter {
    bool done = false;
    HttpResponse response;
  };
  /** One socket's life, from opening to its end. A later request makes a new one. */
  struct Conn {
    enum class State { Opening, Open, Closed } state = State::Opening;
    uint64_t serial = 0;
    std::shared_ptr<Socket> socket;
    std::map<uint32_t, Waiter*> pending;
    uint32_t next_id = 0;
    Clock::time_point used, pinged;
    bool ping_out = false;
  };
  /** A relay entry: its socket now, and how its last tries to open one went. */
  struct Room {
    std::shared_ptr<Conn> conn;
    int failures = 0;
    Clock::time_point retry_at;
  };

  HttpResponse carry(const RelayAddress& address, std::string& frame, int timeout_ms);
  Conn* find(const std::string& entry, uint64_t serial);
  std::shared_ptr<Socket> end(Conn& conn);
  void received(const std::string& entry, uint64_t serial, const uint8_t* data, size_t size, bool binary);
  void closed(const std::string& entry, uint64_t serial);

  Transport& direct_;
  Sockets sockets_;
  std::mutex mutex_;  // guards everything below
  std::condition_variable changed_;
  std::map<std::string, Room> rooms_;
  uint64_t serials_ = 0;
};

}  // namespace botkins
