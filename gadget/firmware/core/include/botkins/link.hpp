// The Botkins link as a gadget speaks it: find the computer, open a sealed session, make sealed
// calls. gadget/docs/contract.md ("The link's bytes") is the description; mobile/src/link/client.ts
// is the phone's version of the same thing.
#pragma once
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "botkins/crypto.hpp"
#include "botkins/hal.hpp"
#include "botkins/json.hpp"

namespace botkins {

/** What a gadget is handed when it is introduced: who the computer is and where to find it. */
struct Introduction {
  std::string device_id, server_id, server_key, name;
  std::vector<std::string> hosts;

  bool valid() const { return !device_id.empty() && !server_id.empty() && !server_key.empty() && !hosts.empty(); }
  Json to_json() const;
  static bool from_json(const Json& json, Introduction& out);
};

class Link {
 public:
  enum class Error {
    None,
    /** The computer didn't answer, or answered something this session can't read. Try again later. */
    Offline,
    /** The computer no longer knows this gadget. Forget the introduction. */
    Removed,
    /** The computer answered with a sentence for a person (`message`). */
    Remote,
  };
  struct Result {
    Error error = Error::None;
    Json value;
    std::string message;
    bool ok() const { return error == Error::None; }
  };

  Link(Transport& transport, const KeyPair& keys, Introduction introduction);

  /** One call, waited for. `args` is the call's arguments as a JSON array. Safe from two threads. */
  Result call(const std::string& method, const Json& args, int timeout_ms = 60000);
  /** The computer's addresses as it last gave them (a port saves them: this is how a moved computer is found again). */
  std::function<void(const std::vector<std::string>&)> on_hosts;
  /** The computer app's run: a new one means every version and cursor held is stale. */
  std::string epoch();
  const Introduction& introduction() const { return intro_; }
  /** Forgets the session, so the next call opens a new one (after the network came back). */
  void reset();

 private:
  struct Session {
    std::string id, host;
    uint8_t to_host[32], to_gadget[32];
    uint64_t seq = 0;
  };
  Error open_session();
  Error open_at(const std::string& host);

  Transport& transport_;
  KeyPair keys_;
  Introduction intro_;
  uint8_t device_key_[32];
  bool has_device_key_ = false;
  std::mutex mutex_;       // guards session_, epoch_ and intro_.hosts
  std::mutex opening_;     // one thread opens a session at a time
  Session session_;
  bool has_session_ = false;
  std::string epoch_;
};

}  // namespace botkins
