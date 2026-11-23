#include "botkins/link.hpp"

#include <algorithm>
#include <cstring>

namespace botkins {

namespace {
const char* kPrefix = "/botkins/v1/";
const int kHelloMs = 3000;
// A direct address gets little time when the relay is there to take over (the phone's 1.5 s).
const int kQuickHelloMs = 1500;
// The relay's first request may have to open its socket first (TLS, on a board).
const int kRelayHelloMs = 8000;
const int kSessionMs = 10000;
const int kProbeMaxMs = 10 * 60 * 1000;
const size_t kMaxHosts = 8;

bool is_relay(const std::string& host) { return host.rfind("relay!", 0) == 0; }
}  // namespace

Json Introduction::to_json() const {
  Json list = Json::array();
  for (const auto& host : hosts) list.push(host);
  return Json::object().set("deviceId", device_id).set("serverId", server_id).set("serverKey", server_key).set("name", name).set("hosts", std::move(list));
}
bool Introduction::from_json(const Json& json, Introduction& out) {
  Introduction next;
  next.device_id = json["deviceId"].str();
  next.server_id = json["serverId"].str();
  next.server_key = json["serverKey"].str();
  next.name = json["name"].str();
  for (const Json& host : json["hosts"].items())
    if (host.is_string() && !host.str().empty() && host.str().size() < 200 && next.hosts.size() < kMaxHosts) next.hosts.push_back(host.str());
  Bytes key;
  if (!next.valid() || !unb64(next.server_key, key) || key.size() != 32) return false;
  out = std::move(next);
  return true;
}

Link::Link(Transport& transport, const KeyPair& keys, Introduction introduction) : transport_(transport), keys_(keys), intro_(std::move(introduction)) {
  Bytes server;
  uint8_t shared[32];
  if (unb64(intro_.server_key, server) && server.size() == 32 && agree(keys_.secret, server.data(), shared)) {
    hkdf(shared, 32, (const uint8_t*)intro_.device_id.data(), intro_.device_id.size(), "botkins/device/v1", device_key_);
    has_device_key_ = true;
  }
}

std::string Link::epoch() {
  std::lock_guard<std::mutex> lock(mutex_);
  return epoch_;
}
void Link::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  has_session_ = false;
}

/** Who is there: the computer this gadget was introduced to, or nobody it talks to. */
bool Link::answers(const std::string& host, int hello_ms) {
  HttpResponse hello = transport_.request(host, "GET", std::string(kPrefix) + "hello", {}, "", hello_ms);
  Json said;
  if (hello.status != 200 || !Json::parse(hello.body, said)) return false;
  return said["serverId"].str() == intro_.server_id && said["publicKey"].str() == intro_.server_key;
}

Link::Error Link::open_at(const std::string& host, int hello_ms) {
  if (!answers(host, hello_ms)) return Error::Offline;

  KeyPair eph = new_key_pair();
  uint8_t nonce[16];
  random_bytes(nonce, 16);
  const std::string eph_text = b64u(eph.pub, 32);
  const std::string inner = Json::object().set("eph", eph_text).set("nonce", b64u(nonce, 16)).dump();
  const std::string body = Json::object().set("device", intro_.device_id).set("eph", eph_text).set("box", box(device_key_, inner, "session:" + intro_.server_id)).dump();
  HttpResponse answer = transport_.request(host, "POST", std::string(kPrefix) + "session", {{"content-type", "application/json"}}, body, kSessionMs);
  Json reply;
  if (answer.status == 0 || !Json::parse(answer.body, reply)) return Error::Offline;
  if (answer.status == 403 && reply["error"].str() == "unknown_device") return Error::Removed;
  std::string opened;
  Json ok;
  if (answer.status != 200 || !unbox(device_key_, reply["box"].str(), "session-ok:" + intro_.server_id, opened) || !Json::parse(opened, ok)) return Error::Offline;

  Bytes host_eph, host_nonce;
  uint8_t shared[32];
  if (!unb64(ok["eph"].str(), host_eph) || host_eph.size() != 32 || !unb64(ok["nonce"].str(), host_nonce) || host_nonce.size() != 16 || !agree(eph.secret, host_eph.data(), shared)) return Error::Offline;
  uint8_t salt[32], ikm[64], master[32];
  memcpy(salt, nonce, 16);
  memcpy(salt + 16, host_nonce.data(), 16);
  memcpy(ikm, shared, 32);
  memcpy(ikm + 32, device_key_, 32);
  hkdf(ikm, 64, salt, 32, "botkins/session/v1", master);

  std::vector<std::string> changed;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    session_ = Session();
    session_.id = ok["session"].str();
    session_.host = host;
    hkdf(master, 32, salt, 32, "botkins/c2s/v1", session_.to_host);
    hkdf(master, 32, salt, 32, "botkins/s2c/v1", session_.to_gadget);
    has_session_ = !session_.id.empty();
    epoch_ = ok["epoch"].str();
    // The address that just worked stays first; the computer's current ones follow, then the ones held.
    // The computer's current relay entry replaces older ones (its room changes with its relay key).
    std::vector<std::string> current, hosts{host};
    for (const Json& item : ok["hosts"].items()) current.push_back(item.str());
    const bool relay_now = std::any_of(current.begin(), current.end(), is_relay);
    auto add = [&](const std::string& item) {
      if (relay_now && is_relay(item) && item != host && std::find(current.begin(), current.end(), item) == current.end()) return;
      if (!item.empty() && item.size() < 200 && std::find(hosts.begin(), hosts.end(), item) == hosts.end()) hosts.push_back(item);
    };
    for (const auto& item : current) add(item);
    for (const auto& item : intro_.hosts) add(item);
    // A computer with many addresses must not push its relay entry out of the few kept.
    if (hosts.size() > kMaxHosts) {
      auto relay = std::find_if(hosts.begin(), hosts.end(), is_relay);
      const std::string kept = relay == hosts.end() ? "" : *relay;
      hosts.resize(kMaxHosts);
      if (!kept.empty() && std::none_of(hosts.begin(), hosts.end(), is_relay)) hosts.back() = kept;
    }
    if (is_relay(host)) {
      probe_wait_ = probe_ms;
      probe_at_ = std::chrono::steady_clock::now() + std::chrono::milliseconds(probe_wait_);
    }
    if (hosts != intro_.hosts) {
      intro_.hosts = hosts;
      changed = hosts;
    }
  }
  memset(shared, 0, sizeof shared);
  memset(ikm, 0, sizeof ikm);
  memset(master, 0, sizeof master);
  if (!changed.empty() && on_hosts) on_hosts(changed);
  return has_session_ ? Error::None : Error::Offline;
}

Link::Error Link::open_session() {
  std::lock_guard<std::mutex> opening(opening_);
  std::vector<std::string> hosts;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (has_session_) return Error::None;
    hosts = intro_.hosts;
  }
  if (!has_device_key_) return Error::Removed;
  // As the phone does: the computer's own addresses first, and the relay only when none of them answered.
  std::vector<std::string> direct, relays;
  for (const auto& host : hosts) (is_relay(host) ? relays : direct).push_back(host);
  if (!transport_.relays()) relays.clear();
  for (const auto& host : direct) {
    Error error = open_at(host, relays.empty() ? kHelloMs : kQuickHelloMs);
    if (error != Error::Offline) return error;
  }
  for (const auto& host : relays) {
    Error error = open_at(host, kRelayHelloMs);
    if (error != Error::Offline) return error;
  }
  return Error::Offline;
}

void Link::probe() {
  std::vector<std::string> direct;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now = std::chrono::steady_clock::now();
    if (!has_session_ || !is_relay(session_.host) || now < probe_at_) return;
    probe_wait_ = probe_wait_ < kProbeMaxMs / 2 ? probe_wait_ * 2 : kProbeMaxMs;
    probe_at_ = now + std::chrono::milliseconds(probe_wait_);
    for (const auto& host : intro_.hosts)
      if (!is_relay(host)) direct.push_back(host);
  }
  for (const auto& host : direct) {
    if (!answers(host, kQuickHelloMs)) continue;
    // Home again. A call waiting on the relay keeps its session; the next call opens one here (and if
    // that fails, the relay is tried again in the same look).
    std::lock_guard<std::mutex> lock(mutex_);
    if (has_session_ && is_relay(session_.host)) has_session_ = false;
    return;
  }
}

Link::Result Link::call(const std::string& method, const Json& args, int timeout_ms) {
  Result result;
  for (int attempt = 0; attempt < 3; attempt++) {
    result.error = open_session();
    if (!result.ok()) return result;
    Session session;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!has_session_) continue;
      session_.seq++;
      session = session_;
    }
    uint8_t nonce[12];
    seq_nonce(session.seq, nonce);
    std::string body(8, '\0');
    for (int i = 0; i < 8; i++) body[i] = (char)(session.seq >> (56 - 8 * i));
    {
      const std::string plain = Json::object().set("m", method).set("a", args).dump();
      Bytes sealed = seal(session.to_host, nonce, (const uint8_t*)plain.data(), plain.size(), "rpc:" + session.id);
      body.append((const char*)sealed.data(), sealed.size());
    }
    HttpResponse answer = transport_.request(session.host, "POST", std::string(kPrefix) + "rpc", {{"content-type", "application/octet-stream"}, {"x-botkins-session", session.id}}, body, timeout_ms);
    body = std::string();
    if (answer.status == 401 || answer.status == 0) {
      // The computer forgot the session (its app restarted), or went away: the next try finds it again.
      std::lock_guard<std::mutex> lock(mutex_);
      if (has_session_ && session_.id == session.id) has_session_ = false;
      if (answer.status == 401) continue;
      result.error = Error::Offline;
      return result;
    }
    Bytes plain;
    if (answer.status != 200 || !open(session.to_gadget, nonce, (const uint8_t*)answer.body.data(), answer.body.size(), "ok:" + session.id, plain)) {
      result.error = Error::Offline;
      return result;
    }
    answer.body = std::string();
    Json reply;
    bool parsed = Json::parse(std::string_view((const char*)plain.data(), plain.size()), reply);
    plain = Bytes();
    if (!parsed) {
      result.error = Error::Offline;
      return result;
    }
    if (reply.has("e")) {
      result.error = Error::Remote;
      result.message = reply["e"]["message"].str();
      if (result.message.empty()) result.message = "That didn't work on your computer.";
      return result;
    }
    result.value = reply.take("r");
    return result;
  }
  result.error = Error::Offline;
  return result;
}

}  // namespace botkins
