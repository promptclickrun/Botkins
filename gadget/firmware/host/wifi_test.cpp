// Host regression for the core Wi-Fi trial and the StopWatch touchscreen editor.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "botkins/crypto.hpp"
#include "botkins/gadget.hpp"
#include "botkins/json.hpp"
#include "botkins/sockets.hpp"
#include "wifi_menu.hpp"

using namespace botkins;

namespace {
int failed = 0;
void check(bool ok, const std::string& what) {
  if (!ok) {
    std::printf("FAILED: %s\n", what.c_str());
    failed++;
  }
}

// ── A gadget on scripted Wi-Fi, for the trial ─────────────────────────────────────────────────────

struct MemoryStorage : Storage {
  std::mutex mutex;
  std::map<std::string, std::string> values;
  bool load(const char* name, std::string& value) override {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = values.find(name);
    if (it == values.end()) return false;
    value = it->second;
    return true;
  }
  void save(const char* name, const std::string& value) override {
    std::lock_guard<std::mutex> lock(mutex);
    values[name] = value;
  }
  void erase(const char* name) override {
    std::lock_guard<std::mutex> lock(mutex);
    values.erase(name);
  }
  std::string wifi() {
    std::lock_guard<std::mutex> lock(mutex);
    return values.count("wifi") ? values["wifi"] : "";
  }
};

/** Networks in range by name and password; one that never answers stays "joining". */
struct ScriptedNetwork : Network {
  std::mutex mutex;
  std::vector<std::pair<std::string, std::string>> in_range;
  std::string silent;  // a network that is there but never gives an address
  // For this long after the next join, the network being left still reads "on", its address its own (a
  // late event). Once: the join after it is clean.
  int stale_ms = 0;
  std::chrono::steady_clock::time_point stale_until{};
  std::string ssid, password, left;
  std::vector<std::string> joins;
  std::chrono::steady_clock::time_point at{};
  void join(const std::string& name, const std::string& pass) override {
    std::lock_guard<std::mutex> lock(mutex);
    left = ssid;
    ssid = name, password = pass, at = std::chrono::steady_clock::now();
    if (stale_ms > 0) stale_until = at + std::chrono::milliseconds(stale_ms), stale_ms = 0;
    joins.push_back(name);
  }
  const char* state() override {
    std::lock_guard<std::mutex> lock(mutex);
    if (ssid.empty()) return "off";
    const auto waited = std::chrono::steady_clock::now() - at;
    if (std::chrono::steady_clock::now() < stale_until && !left.empty()) return "on";
    if (ssid == silent) return "joining";
    const bool works = std::find(in_range.begin(), in_range.end(), std::make_pair(ssid, password)) != in_range.end();
    if (works) return waited >= std::chrono::milliseconds(30) ? "on" : "joining";
    return waited >= std::chrono::milliseconds(90) ? "failed" : "joining";
  }
  std::string address() override { return ""; }
  std::string joined_ssid() override {
    if (std::string(state()) != "on") return "";
    std::lock_guard<std::mutex> lock(mutex);
    return std::chrono::steady_clock::now() < stale_until && !left.empty() ? left : ssid;
  }
  std::string last() {
    std::lock_guard<std::mutex> lock(mutex);
    return joins.empty() ? "" : joins.back();
  }
};

void fill(uint8_t* out, size_t size) {
  for (size_t i = 0; i < size; i++) out[i] = (uint8_t)(i * 37 + 11);
}

/** Waits for the last trial to end (its fallback verified too); its state, and its fallback after a slash. */
std::string settle(Gadget& gadget, int ms = 4000) {
  for (int waited = 0; waited < ms; waited += 10) {
    const Json trial = gadget.network_trial();
    const std::string state = trial["state"].str();
    if (state != "trying" && state != "rolling-back") return trial.has("fallback") ? state + "/" + trial["fallback"].str() : state;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return "trying";
}

std::vector<std::string> saved(MemoryStorage& storage) {
  Json json;
  std::vector<std::string> names;
  if (!Json::parse(storage.wifi(), json)) return names;
  for (const Json& item : json["networks"].items()) names.push_back(item["ssid"].str());
  return names;
}
}  // namespace

int main() {
  set_random(fill);
  // ── The real gadget's trial ──
  {
    MemoryStorage storage;
    storage.save("wifi", R"({"networks":[{"ssid":"Home","password":"home-pass-1"},{"ssid":"Old","password":"old-pass-1"}]})");
    ScriptedNetwork network;
    network.in_range = {{"Home", "home-pass-1"}, {"Cafe", "cafe-pass-1"}, {"Old", "old-pass-1"}, {"q", "qqqqqqqq"}};
    network.silent = "Slow";
    SocketTransport transport;
    Board board;
    board.transport = &transport;
    board.storage = &storage;
    board.network = &network;
    board.wifi_trial_ms = 400;
    {
      Gadget gadget(board);
      gadget.begin();
      check(network.last() == "Home", "it starts on the first saved network");
      std::string current;
      check(gadget.saved_networks(&current) == std::vector<std::string>({"Home", "Old"}) && current == "Home", "saved names, the one in use");

      // Validation, before anything is joined.
      const size_t joins = network.joins.size();
      const std::string short_pw = "1234567", long_pw(65, 'x'), long_name(33, 'n'), empty;
      check(!gadget.try_network("", &short_pw).empty(), "no name: refused");
      check(!gadget.try_network(long_name, &empty).empty(), "a name over 32 bytes: refused");
      check(!gadget.try_network("Cafe", &short_pw).empty(), "a password under 8: refused");
      check(!gadget.try_network("Cafe", &long_pw).empty(), "a password over 64: refused");
      check(gadget.try_network("Nowhere", nullptr) == "That network isn't saved: it needs its password.", "an unsaved network without a password: refused");
      check(network.joins.size() == joins, "nothing was joined for those");

      // A wrong password: rolled back to Home, nothing saved.
      const std::string before = storage.wifi();
      const std::string wrong = "wrong-pass-9";
      check(gadget.try_network("Cafe", &wrong).empty(), "a trial starts");
      check(!gadget.try_network("Cafe", &wrong).empty(), "one trial at a time");
      check(gadget.network_trial()["state"].str() == "trying", "trying first");
      bool saw_rolling = false;
      for (int i = 0; i < 300 && !saw_rolling; i++) {
        saw_rolling = gadget.network_trial()["state"].str() == "rolling-back";
        if (gadget.network_trial()["state"].str() == "rolled-back") break;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      }
      check(saw_rolling, "while the network before is joined again it says rolling-back, not rolled-back");
      check(settle(gadget) == "rolled-back/on", "a wrong password is rolled back, and the network before is on again");
      check(network.last() == "Home", "back on Home");
      check(storage.wifi() == before, "nothing was saved");

      // Out of range for longer than the trial (a network that never answers): rolled back at the deadline.
      const std::string slow = "slow-pass-1";
      const auto started = std::chrono::steady_clock::now();
      check(gadget.try_network("Slow", &slow).empty(), "a trial of a silent network starts");
      check(settle(gadget) == "rolled-back/on", "a network with no address in time is rolled back");
      check(std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(380), "only once its time is up");
      check(network.last() == "Home" && storage.wifi() == before, "back on Home, nothing saved");

      // A late "on" from the network being left (its address, after the switch) is not the new one's.
      network.stale_ms = 350;  // past the trial's first two looks (every 200 ms), within its 400 ms
      check(gadget.try_network("Cafe", &wrong).empty(), "a trial with a late address from Home");
      check(settle(gadget) == "rolled-back/on", "Home's late address didn't make a wrong password a success");
      check(storage.wifi() == before, "so nothing was saved");

      // A setup over USB while a network is tried: the cable's network wins; the trial ends, nothing rolls back over it.
      check(gadget.try_network("Slow", &slow).empty(), "a trial that would time out");
      const std::string answer = gadget.console(R"(@botkins {"do":"setup","wifi":{"ssid":"Old","password":"old-pass-1"}})");
      check(answer.find("\"ok\":true") != std::string::npos, "the setup over USB is taken: " + answer);
      check(settle(gadget) == "cancelled", "the trial says it was cancelled");
      std::this_thread::sleep_for(std::chrono::milliseconds(600));  // past the trial's own deadline
      check(network.last() == "Old", "nothing joined Home over the cable's network");
      check(saved(storage).front() == "Old", "the cable's network is first, as a setup over USB makes it");
      // Back to Home for what follows.
      check(gadget.try_network("Home", nullptr).empty() && settle(gadget) == "joined", "Home again");

      // The network before can't be reached either (away from home): rolled back, its fallback unreachable.
      network.in_range.erase(std::remove(network.in_range.begin(), network.in_range.end(), std::make_pair(std::string("Home"), std::string("home-pass-1"))), network.in_range.end());
      check(gadget.try_network("Cafe", &wrong).empty(), "a trial away from Home");
      check(settle(gadget) == "rolled-back/unreachable", "rolled back to Home, which isn't in range: said so");
      network.in_range.push_back({"Home", "home-pass-1"});

      // One that works: kept first, with its password; the old ones stay.
      const std::string cafe = "cafe-pass-1";
      check(gadget.try_network("Cafe", &cafe).empty(), "a trial of a working network starts");
      check(settle(gadget) == "joined", "a network that gives an address is kept");
      check(saved(storage) == std::vector<std::string>({"Cafe", "Home", "Old"}), "saved first: " + storage.wifi().substr(0, 0));
      check(gadget.network_trial()["ssid"].str() == "Cafe" && !gadget.network_trial().has("password"), "the trial's report holds no password");

      // A saved network, without its password.
      check(gadget.try_network("Old", nullptr).empty(), "a saved network is tried without its password");
      check(settle(gadget) == "joined" && network.last() == "Old", "and joined with its own");
      check(saved(storage) == std::vector<std::string>({"Old", "Cafe", "Home"}), "it moves first");
      // Same controller as physical taps: add a network with the keyboard while the host is absent.
      stopwatch::WifiMenu menu;
      using Page = stopwatch::WifiMenu::Page;
      menu.open(gadget);
      check(menu.shown(gadget).page == Page::Networks, "the menu opens without a host");
      menu.tap(285, 389, gadget);  // Add
      menu.tap(52, 190, gadget);   // q
      check(menu.shown(gadget).input == "q", "typed SSID is shown");
      menu.tap(285, 389, gadget);  // Next
      check(menu.shown(gadget).page == Page::Password, "the password can be typed on the watch");
      for (int i = 0; i < 8; ++i) menu.tap(52, 190, gadget);
      check(menu.shown(gadget).input == "********", "the drawing only receives masked password text");
      menu.tap(285, 389, gadget);  // Join
      check(menu.shown(gadget).page == Page::Result && settle(gadget) == "joined", "the touchscreen joins a new network");
      check(saved(storage).front() == "q", "the touchscreen network was saved");
      menu.tap(170, 389, gadget);  // Networks
      menu.tap(233, 190, gadget);  // the old network, now second
      check(settle(gadget) == "joined" && network.last() == "Old", "the touchscreen switches to a saved network");
      menu.close();
      check(menu.shown(gadget).page == Page::Closed && menu.shown(gadget).input.empty(), "closing clears the editor");
      gadget.stop();
    }
    // A restart: what was kept is what is joined.
    {
      Gadget again(board);
      again.begin();
      check(network.last() == "Old", "after a restart, the network kept last is joined first");
      again.stop();
    }
    // Every saved password is in the gadget's own store, and only there: no trial left one in its report.
    check(storage.wifi().find("cafe-pass-1") != std::string::npos, "the kept password is in the gadget's store");
    check(storage.wifi().find("wrong-pass-9") == std::string::npos && storage.wifi().find("slow-pass-1") == std::string::npos, "a rolled-back password is not");
  }

  // ── A trial with no network before it: rolled back to none ──
  {
    MemoryStorage storage;
    ScriptedNetwork network;
    SocketTransport transport;
    Board board;
    board.transport = &transport;
    board.storage = &storage;
    board.network = &network;
    board.wifi_trial_ms = 200;
    Gadget gadget(board);
    gadget.begin();
    const std::string pass = "some-pass-1";
    check(gadget.try_network("Gone", &pass).empty(), "a trial starts on a gadget with no saved network");
    check(settle(gadget) == "rolled-back/none" && network.last().empty() && storage.wifi().empty(), "it fails, leaves the network, saves nothing");
    gadget.stop();
  }

  if (failed) return 1;
  std::printf("wifi checks ok\n");
  return 0;
}
