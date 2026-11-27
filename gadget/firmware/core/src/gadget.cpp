#include "botkins/gadget.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>

#include "botkins/live.hpp"

namespace botkins {

namespace {
const char* kKey = "key";
const char* kLink = "link";
const char* kWifi = "wifi";
const char* kSettings = "settings";
const size_t kMaxNetworks = 8;
// A saved network that isn't answering is left for the next one after this long.
const int kNetworkSwitchMs = 20000;

/** A network's name and password as a station can use them: 1 to 32 bytes of name, at most 64 of password. */
bool valid_network(const std::string& ssid, const std::string& password) { return !ssid.empty() && ssid.size() <= 32 && password.size() <= 64; }
const char* kMark = "@botkins ";
// A recording goes up in pieces of half a second, while the button is still held.
const double kPieceSeconds = 0.5;
// What the microphone may run ahead of the link, in seconds: past it the recording is given up, not kept growing.
const int kAheadSeconds = 12;
const int kWaits[] = {400, 1000, 2000, 4000, 8000, 15000};
const int kRemovedWaitMs = 30000;
// Tries that found nobody before the screen says why it waits: a blip stays quiet, a computer that is gone doesn't.
const int kTriesBeforeTelling = 2;

std::string reply_line(const Json& json) { return std::string(kMark) + json.dump(); }
Json args(Json one) { return Json::array().push(std::move(one)); }
}  // namespace

Gadget::Gadget(Board board) : board_(std::move(board)) {
  if (board_.socket) relay_.reset(new RelayTransport(*board_.transport, board_.socket));
  // Live voice needs the provider's socket and a speaker for its voice.
  if (board_.socket && board_.speaker) {
    LiveVoice::Hooks hooks;
    hooks.link = [this] { return link(); };
    hooks.post = [this](std::function<void(Link&)> job) { post(std::move(job)); };
    hooks.change = [this](const std::function<void(View&)>& edit) { change(edit); };
    hooks.failed = [this] { live_failed(); };
    live_.reset(new LiveVoice(board_, std::move(hooks)));
  }
}
Gadget::~Gadget() { stop(); }

void Gadget::begin() {
  // The key is made once and never leaves the gadget.
  std::string saved;
  Bytes secret;
  if (board_.storage->load(kKey, saved) && unb64(saved, secret) && secret.size() == 32) keys_ = key_pair_from_secret(secret.data());
  else {
    keys_ = new_key_pair();
    board_.storage->save(kKey, b64u(keys_.secret, 32));
  }
  Json json;
  if (board_.storage->load(kLink, saved) && Json::parse(saved, json)) Introduction::from_json(json, intro_);
  // A gadget that knows its computer starts by looking for it, not on the setup screen.
  if (intro_.valid()) view_.stage = View::Stage::Connecting;
  // The settings it had: the computer's copy comes with the first look, and a gadget starts with these until then.
  if (board_.storage->load(kSettings, saved) && Json::parse(saved, json)) apply_settings(json);
  load_networks();
  if (!networks_.empty()) board_.network->join(networks_[0].first, networks_[0].second);
  running_ = true;
  sync_thread_ = std::thread([this] { sync_loop(); });
  work_thread_ = std::thread([this] { work_loop(); });
}

void Gadget::stop() {
  {
    std::lock_guard<std::mutex> start(trial_start_);
    if (!running_.exchange(false)) return;
  }
  quiet_++;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    wake_.notify_all();
  }
  if (live_) live_->stop();
  if (sync_thread_.joinable()) sync_thread_.join();
  if (work_thread_.joinable()) work_thread_.join();
  if (hold_thread_.joinable()) hold_thread_.join();
  if (trial_thread_.joinable()) trial_thread_.join();
}

View Gadget::view() {
  std::lock_guard<std::mutex> lock(mutex_);
  return view_;
}
std::string Gadget::public_key() const { return b64u(keys_.pub, 32); }

void Gadget::change(const std::function<void(View&)>& edit) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    edit(view_);
    view_.revision++;
  }
  if (on_change) on_change();
}
void Gadget::notice(const std::string& sentence) {
  change([&](View& view) { view.notice = sentence; });
}
void Gadget::fail(const Link::Result& result) {
  if (result.error == Link::Error::Remote) notice(result.message);
  else if (result.error == Link::Error::Offline) notice("Your computer can't be reached right now.");
}

/** Sleeps, unless the gadget is stopping or something woke it. False when stopping. */
bool Gadget::wait(int ms) {
  std::unique_lock<std::mutex> lock(mutex_);
  wake_.wait_for(lock, std::chrono::milliseconds(ms));
  return running_;
}

/** The link to the computer of the introduction held now, with which introduction that is (`generation`). */
std::shared_ptr<Link> Gadget::link(uint32_t* generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation) *generation = generation_;
  if (!intro_.valid()) return nullptr;
  if (!link_) {
    link_ = std::make_shared<Link>(relay_ ? *relay_ : *board_.transport, keys_, intro_);
    link_->probe_ms = board_.relay_probe_ms;
    // The computer's addresses as it gives them are kept: this is how a computer that moved is found again.
    // A link from before another setup says nothing about the computer held now.
    const uint32_t mine = generation_;
    link_->on_hosts = [this, mine](const std::vector<std::string>& hosts) {
      Introduction next;
      {
        std::lock_guard<std::mutex> inner(mutex_);
        if (generation_ != mine) return;
        intro_.hosts = hosts;
        next = intro_;
      }
      board_.storage->save(kLink, next.to_json().dump());
    };
  }
  return link_;
}

/** What is on show when the computer changed or went: nothing of the one before. The sync thread may still be waiting on it. */
static void clear_view(View& view, View::Stage stage) {
  View fresh;
  fresh.revision = view.revision;
  fresh.stage = stage;
  view = fresh;
}
void Gadget::adopt(const Introduction& introduction) {
  board_.storage->save(kLink, introduction.to_json().dump());
  {
    std::lock_guard<std::mutex> lock(mutex_);
    intro_ = introduction;
    link_.reset();
    generation_++;
    wake_.notify_all();
  }
  change([](View& view) { clear_view(view, View::Stage::Connecting); });
}
void Gadget::forget_link() {
  board_.storage->erase(kLink);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    intro_ = Introduction();
    link_.reset();
    generation_++;
    wake_.notify_all();
  }
  change([](View& view) { clear_view(view, View::Stage::Setup); });
}

// ── Keeping in step with the computer ───────────────────────────────────────────────────────────

void Gadget::sync_loop() {
  uint32_t generation = 0;
  int failures = 0;
  auto stage = [this](View::Stage next) {
    bool same;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      same = view_.stage == next;
    }
    if (!same) change([next](View& view) { view.stage = next; });
  };
  while (running_) {
    uint32_t now;
    std::shared_ptr<Link> link = this->link(&now);
    if (now != generation) {
      // Another computer, or none: nothing held is about this one.
      generation = now;
      have_ = Json::object();
      epoch_.clear();
      text_id_.clear();
      stream_.clear();
      last_reply_.clear();
      stream_units_ = thinking_units_ = 0;
      greeted_ = false;
      first_part_ = true;
      failures = 0;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        chat_id_.clear();
        bots_.clear();
        bot_id_.clear();
      }
      saves_history_ = saves_turns_ = false;
      if (live_) live_->end();
      change([link](View& view) { clear_view(view, link ? View::Stage::Connecting : View::Stage::Setup); });
    }
    if (!link) {
      stage(View::Stage::Setup);
      if (!wait(500)) break;
      continue;
    }
    const std::string network = board_.network->state();
    if (network != "on") {
      stage(network == "failed" ? View::Stage::NoNetwork : View::Stage::Joining);
      // A saved network that refuses or is out of range: the next saved one gets a turn.
      {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto now = std::chrono::steady_clock::now();
        if (network == "failed" && !trial_.active && networks_.size() > 1 &&
            now - switched_at_ > std::chrono::milliseconds(kNetworkSwitchMs) && std::string(board_.network->state()) == "failed") {
          network_at_ = (network_at_ + 1) % networks_.size();
          const auto& next = networks_[network_at_];
          board_.network->join(next.first, next.second);
          switched_at_ = now;
        }
      }
      link->reset();
      if (!wait(300)) break;
      continue;
    }

    Link::Result result;
    // Hello again after the saved networks changed: the owner's page shows them.
    if (report_wifi_.exchange(false)) greeted_ = false;
    if (!greeted_) {
      Json hello = Json::object().set("board", board_.name).set("firmware", board_.firmware).set("rate", board_.speaker_rate).set("wifi", wifi_report());
      if (board_.screen_width > 0) hello.set("screen", Json::object().set("width", board_.screen_width).set("height", board_.screen_height).set("round", board_.screen_round));
      if (!board_.speaker) hello.set("speaker", false);
      result = link->call("link.gadget.hello", args(std::move(hello)), 15000);
      if (result.ok()) greeted_ = true;
    }
    if (greeted_) {
      // Through the relay, now and then: is the computer's own address back? This thread waits for news
      // anyway, so a look that finds nobody costs no one.
      link->probe();
      // After a look that failed, the next one doesn't wait for news: the screen says the computer is back
      // as soon as it answers, not up to 25 s later.
      Json request = Json::object().set("epoch", epoch_).set("have", have_).set("wait", failures > 0 ? 0 : 25000);
      if (!chat_id_.empty()) {
        request.set("watch", Json::array().push(chat_id_));
        Json cursors = Json::object();
        if (!text_id_.empty()) cursors.set(chat_id_, Json::object().set("id", text_id_).set("stream", stream_units_).set("thinking", thinking_units_));
        request.set("appends", std::move(cursors));
      } else request.set("watch", Json::array()).set("appends", Json::object());
      result = link->call("link.sync", args(std::move(request)), 40000);
    }
    if (!running_) break;
    {
      // Set up again, or forgotten, while that call waited: its answer is about a computer this gadget left.
      std::lock_guard<std::mutex> lock(mutex_);
      if (generation_ != generation) continue;
    }

    if (result.error == Link::Error::Removed) {
      // Removed on the computer or a phone. The introduction is kept and asked about again now and then:
      // "unknown" is an answer anyone on the network could give, and it must not be able to erase a gadget.
      // Setup replaces it.
      stage(View::Stage::Removed);
      notice("This gadget was removed. Set it up again to use it.");
      greeted_ = false;
      if (!wait(kRemovedWaitMs)) break;
      continue;
    }
    if (!result.ok()) {
      // A sentence from the computer (an older app with no gadgets) is shown; then both cases wait and try again.
      if (result.error == Link::Error::Remote) notice(result.message);
      stage(View::Stage::Connecting);
      greeted_ = greeted_ && result.error != Link::Error::Remote;
      int ms = kWaits[failures < 5 ? failures : 5];
      failures++;
      // "Connecting" alone doesn't say what to do. Nobody answering at the computer's addresses almost always
      // means its Botkins is closed, or it is on another network.
      if (result.error == Link::Error::Offline && failures == kTriesBeforeTelling) {
        std::string computer;
        bool relay = false;
        {
          std::lock_guard<std::mutex> lock(mutex_);
          computer = intro_.name.empty() ? "your computer" : intro_.name;
          for (const auto& host : intro_.hosts) relay = relay || (relay_ && host.compare(0, 6, "relay!") == 0);
        }
        // Through its relay a computer is reached from any network: "the same Wi-Fi" is then not what to check.
        unreachable_ = "Can't reach " + computer + (relay ? ". Check that Botkins is open there." : ". Check that Botkins is open there, on the same Wi-Fi.");
        notice(unreachable_);
      }
      if (!wait(ms)) break;
      continue;
    }
    failures = 0;
    if (!unreachable_.empty()) {
      // Reached again: the sentence about not reaching it goes, and only that one.
      const std::string told = unreachable_;
      unreachable_.clear();
      change([&told](View& view) {
        if (view.notice == told) view.notice.clear();
      });
    }
    stage(View::Stage::Online);
    // Reached: what waited for the computer goes now (settings changed while it was away, faces not fetched yet).
    send_settings();
    ensure_faces();
    if (!greeted_ || !result.value.is_object()) continue;
    const std::string epoch = result.value["epoch"].str();
    if (epoch != epoch_) {
      // The computer's app restarted: ask for everything again.
      epoch_ = epoch;
      have_ = Json::object();
      text_id_.clear();
      stream_units_ = thinking_units_ = 0;
      if (!result.value["v"].is_object()) continue;
    }
    if (!result.value["v"].is_object()) continue;
    Json versions = result.value.take("v");
    Json parts = result.value.take("parts");
    have_ = std::move(versions);
    apply(parts);
  }
}

void Gadget::apply_text(const Json& delta) {
  if (delta.is_null()) {
    text_id_.clear();
    stream_.clear();
    stream_units_ = thinking_units_ = 0;
    return;
  }
  const std::string id = delta["id"].str();
  const size_t stream_from = (size_t)delta["stream"]["from"].num();
  const size_t thinking_from = (size_t)delta["thinking"]["from"].num();
  const bool fits = (stream_from == 0 || (id == text_id_ && stream_from == stream_units_)) && (thinking_from == 0 || (id == text_id_ && thinking_from == thinking_units_));
  if (!fits) {
    // The computer and the gadget disagree on what was sent: ask for the text again from its start.
    text_id_.clear();
    stream_.clear();
    stream_units_ = thinking_units_ = 0;
    have_ = Json::object();
    return;
  }
  const std::string& add = delta["stream"]["add"].str();
  if (stream_from == 0) {
    stream_ = add;
    stream_units_ = utf16_units(add);
  } else {
    stream_ += add;
    stream_units_ += utf16_units(add);
  }
  // Thinking is not shown on a gadget; only how much of it came is kept, for the cursor.
  thinking_units_ = (thinking_from == 0 ? 0 : thinking_units_) + utf16_units(delta["thinking"]["add"].str());
  text_id_ = id;
}

void Gadget::apply(Json& parts) {
  bool texted = false;
  for (const auto& field : parts.fields()) {
    if (field.first.rfind("text:", 0) == 0 && field.first.substr(5) == chat_id_) {
      apply_text(field.second);
      texted = true;
    }
  }
  const Json& meta = parts["meta"];
  const Json& part = parts["gadget"];
  std::string speak_reply;
  int speak_parts = 0;
  if (meta.is_object()) {
    // Whether the computer keeps spoken lines in the chat, for live voice.
    saves_history_ = saves_turns_ = false;
    for (const Json& capability : meta["capabilities"].items()) {
      saves_history_ = saves_history_ || capability.str() == "voice-history-v1";
      saves_turns_ = saves_turns_ || capability.str() == "voice-turns-v1";
    }
  }
  if (part.is_object() && live_) {
    LivePart now;
    now.provider = part["voice"]["live"].str();
    now.bot_id = part["bot"]["id"].str();
    now.chat_id = part["chat"]["id"].str();
    now.phase = part["phase"].str();
    now.queued = (int)part["queued"].num();
    now.reply_id = part["reply"]["id"].str();
    now.reply_text = part["reply"]["text"].str();
    now.history = saves_history_;
    now.turns = saves_turns_;
    live_->part(now);
  }
  // While live voice is open its voice speaks the replies (ask_bot hands them over): none is read aloud too.
  const bool live = live_ && live_->active();
  if (part.is_object()) {
    const std::string chat = part["chat"]["id"].str();
    if (chat != chat_id_) {
      // Another chat: its text is asked for from the start with the next sync.
      text_id_.clear();
      stream_.clear();
      stream_units_ = thinking_units_ = 0;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      chat_id_ = chat;
      bot_id_ = part["bot"]["id"].str();
      bots_.clear();
      for (const Json& bot : part["bots"].items()) bots_.emplace_back(bot["id"].str(), bot["name"].str());
    }
    const std::string reply = part["reply"]["id"].str();
    // A reply that is new since the gadget came online is read aloud. The one that was there at the start is not.
    if (!reply.empty() && reply != last_reply_ && !first_part_ && board_.speaker && part["voice"]["speak"].truthy() && !live) {
      speak_reply = reply;
      speak_parts = (int)part["reply"]["parts"].num();
      if (speak_parts > 64) speak_parts = 64;
    }
    last_reply_ = reply;
    first_part_ = false;

    // Settings from the computer, unless the gadget's own change hasn't reached it yet.
    if (part["settings"].is_object()) {
      bool held;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        held = settings_sending_ > 0 || settings_unsent_.size() > 0;
      }
      if (!held) apply_settings(part["settings"]);
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      face_look_ = part["face"]["look"].str();
    }
    // Wi-Fi changes from the owner, each taken once.
    std::vector<Json> changes;
    std::vector<std::string> sent;
    for (const Json& change : part["wifi"]["changes"].items()) {
      const std::string id = change["id"].str();
      if (id.empty()) continue;
      sent.push_back(id);
      if (std::find(wifi_taken_.begin(), wifi_taken_.end(), id) == wifi_taken_.end()) {
        wifi_taken_.push_back(id);
        changes.push_back(change);
      }
    }
    // A change the computer no longer sends was taken: its id can go.
    wifi_taken_.erase(std::remove_if(wifi_taken_.begin(), wifi_taken_.end(), [&sent](const std::string& id) { return std::find(sent.begin(), sent.end(), id) == sent.end(); }), wifi_taken_.end());
    if (!changes.empty()) post([this, changes](Link& link) { apply_wifi(link, changes); });
    // A restart the owner asked for: said, then done.
    const std::string restart = part["restart"].str();
    if (!restart.empty() && restart != restart_seen_) {
      restart_seen_ = restart;
      post([this, restart](Link& link) {
        link.call("link.gadget.set", args(Json::object().set("restarting", restart)), 15000);
        if (board_.restart) {
          std::this_thread::sleep_for(std::chrono::milliseconds(300));
          board_.restart();
        }
      });
    }
  }
  if (!part.is_object() && !meta.is_object() && !texted) return;
  change([&](View& view) {
    if (meta.is_object()) view.computer = meta["name"].str();
    if (part.is_object()) {
      view.name = part["name"].str();
      view.bot = part["bot"]["name"].str();
      view.phase = part["phase"].str();
      view.doing = part["doing"].str();
      view.can_hear = part["voice"]["hear"].truthy();
      view.can_speak = part["voice"]["speak"].truthy();
      view.steps = (int)part["steps"].num();
      const Json& request = part["request"];
      view.request = View::Request();
      if (request.is_object()) {
        view.request.id = request["id"].str();
        view.request.kind = request["kind"].str();
        view.request.title = request["title"].str();
        view.request.preview = request["preview"].str();
        view.request.remember = request["remember"].truthy();
        for (const Json& choice : request["choices"].items()) view.request.choices.push_back(choice.str());
      }
      // Live, the screen shows what the voice says rather than the reply it was handed.
      if (part["reply"].is_object()) {
        if (!live) view.text = part["reply"]["text"].str();
      } else if (view.phase == "working" || view.phase == "writing") view.text = stream_;
      // A turn that started clears what was said about the one before.
      if (view.phase != "idle") view.notice.clear();
    } else if (texted && (view.phase == "working" || view.phase == "writing")) view.text = stream_;
  });
  if (!speak_reply.empty() && speak_parts > 0) {
    const std::string reply = speak_reply;
    const uint32_t quiet = quiet_;
    post([this, reply, speak_parts, quiet](Link& link) { read_aloud(link, reply, speak_parts, quiet); });
  }
  ensure_faces();
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────

/** Settings in the part's names, over the ones held: shown and kept, so the next start has them. */
void Gadget::apply_settings(const Json& from) {
  View::Settings next;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    next = view_.settings;
  }
  auto whole = [&from](const char* name, int low, int high, int& out) {
    const Json& value = from[name];
    if (value.type() == Json::Type::Number && value.num() >= low && value.num() <= high) out = (int)value.num();
  };
  whole("volume", 0, 100, next.volume);
  whole("brightness", 5, 100, next.brightness);
  whole("dimAfter", 0, 3600, next.dim_after);
  whole("offAfter", 0, 86400, next.off_after);
  const std::string& mic = from["mic"].str();
  if (mic == "low" || mic == "normal" || mic == "high") next.mic = mic;
  if (from["mute"].type() == Json::Type::Bool) next.mute = from["mute"].truthy();
  bool same;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const View::Settings& now = view_.settings;
    same = now.volume == next.volume && now.mic == next.mic && now.mute == next.mute && now.brightness == next.brightness && now.dim_after == next.dim_after && now.off_after == next.off_after;
  }
  if (same) return;
  change([&next](View& view) {
    // Turned on again: the sentence saying it was off is no longer true.
    if (view.settings.mute && !next.mute && view.notice.rfind("The microphone is off", 0) == 0) view.notice.clear();
    view.settings = next;
  });
  board_.storage->save(kSettings, Json::object().set("volume", next.volume).set("mic", next.mic).set("mute", next.mute).set("brightness", next.brightness).set("dimAfter", next.dim_after).set("offAfter", next.off_after).dump());
}

void Gadget::change_settings(const Json& patch) {
  if (!patch.is_object() || !patch.size()) return;
  apply_settings(patch);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& field : patch.fields()) settings_unsent_.set(field.first, field.second);
  }
  send_settings();
}

/** Tells the computer the settings changed on the gadget, if any wait. Kept for later when it is away. */
void Gadget::send_settings() {
  Json patch;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!settings_unsent_.size() || settings_sending_ > 0) return;
    patch = settings_unsent_;
    settings_unsent_ = Json::object();
    settings_sending_++;
  }
  post([this, patch](Link& link) {
    Link::Result result = link.call("link.gadget.set", args(Json::object().set("settings", patch)), 15000);
    std::lock_guard<std::mutex> lock(mutex_);
    settings_sending_--;
    // Away: they wait, under anything changed since.
    if (result.error == Link::Error::Offline)
      for (const auto& field : patch.fields())
        if (!settings_unsent_.has(field.first)) settings_unsent_.set(field.first, field.second);
  });
}

// ── The Botkin's faces ──────────────────────────────────────────────────────────────────────────

/** Fetches the next face the set the computer names lacks, one pose a job, so talking never waits long behind them. */
void Gadget::ensure_faces() {
  std::string look;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (face_look_.empty() || fetching_face_) return;
    if (view_.look == face_look_ && view_.faces && view_.faces->size() >= sizeof kPoses / sizeof kPoses[0]) return;
    fetching_face_ = true;
    look = face_look_;
  }
  post([this, look](Link& link) { fetch_face(link, look); });
}

void Gadget::fetch_face(Link& link, const std::string& look) {
  std::string pose;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const bool fresh = view_.look != look || !view_.faces;
    for (const char* name : kPoses)
      if (fresh || !view_.faces->count(name)) {
        pose = name;
        break;
      }
  }
  Link::Result result;
  if (!pose.empty()) result = link.call("link.gadget.face", args(Json::object().set("pose", pose)), 30000);
  bool more = false;
  if (result.ok() && result.value["look"].str() == look && result.value["svg"].is_string()) {
    std::string svg = result.value.take("svg").take_str();
    change([&](View& view) {
      // A new look's first face replaces the old set at once; the others join it as they come.
      auto faces = std::make_shared<std::map<std::string, std::string>>();
      if (view.look == look && view.faces) *faces = *view.faces;
      (*faces)[pose] = std::move(svg);
      view.look = look;
      view.faces = std::move(faces);
    });
    more = true;
  }
  {
    std::lock_guard<std::mutex> lock(mutex_);
    fetching_face_ = false;
  }
  // The next pose, or the set the computer names now if it changed meanwhile. A failure waits for the next look.
  if (more) ensure_faces();
}

// ── Wi-Fi ───────────────────────────────────────────────────────────────────────────────────────

/** The saved networks: `{"networks":[{"ssid","password"}…]}`, or the single `{"ssid","password"}` of before. */
void Gadget::load_networks() {
  std::string saved;
  Json json;
  std::lock_guard<std::mutex> lock(mutex_);
  networks_.clear();
  network_at_ = 0;
  if (!board_.storage->load(kWifi, saved) || !Json::parse(saved, json)) return;
  if (json["networks"].is_array()) {
    for (const Json& item : json["networks"].items())
      if (!item["ssid"].str().empty() && networks_.size() < kMaxNetworks) networks_.emplace_back(item["ssid"].str(), item["password"].str());
  } else if (!json["ssid"].str().empty()) {
    networks_.emplace_back(json["ssid"].str(), json["password"].str());
  }
}

/** Called with mutex_ held. */
void Gadget::save_networks() {
  Json list = Json::array();
  for (const auto& network : networks_) list.push(Json::object().set("ssid", network.first).set("password", network.second));
  if (networks_.empty()) board_.storage->erase(kWifi);
  else board_.storage->save(kWifi, Json::object().set("networks", std::move(list)).dump());
}

std::vector<std::string> Gadget::saved_networks(std::string* current) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::string> names;
  for (const auto& network : networks_) names.push_back(network.first);
  if (current) *current = trial_.active ? trial_.ssid : network_at_ < networks_.size() ? networks_[network_at_].first : "";
  return names;
}

std::string Gadget::try_network(const std::string& ssid, const std::string* given) {
  std::lock_guard<std::mutex> start(trial_start_);
  if (!running_) return "Wi-Fi isn't ready.";
  std::string password;
  uint32_t generation;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (trial_.active) return "Another network is being tried.";
    if (given) {
      password = *given;
    } else {
      const auto saved = std::find_if(networks_.begin(), networks_.end(), [&ssid](const auto& network) { return network.first == ssid; });
      if (saved == networks_.end()) return "That network isn't saved: it needs its password.";
      password = saved->second;
    }
    // A WPA passphrase is 8 to 63 characters (64 is the key in hex); none is an open network.
    if (!valid_network(ssid, password) || (!password.empty() && password.size() < 8)) return "That isn't a Wi-Fi network's name and password.";
    trial_.active = true;
    trial_.ssid = ssid;
    trial_.password = password;
    trial_.state = "trying";
    trial_.fallback.clear();
    trial_.had_previous = network_at_ < networks_.size();
    trial_.previous = trial_.had_previous ? networks_[network_at_].first : "";
    trial_.deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(board_.wifi_trial_ms);
    generation = ++trial_.generation;
    board_.network->join(ssid, password);
    password.assign(password.size(), '\0');
  }
  if (trial_thread_.joinable()) trial_thread_.join();  // the previous trial was finished or cancelled
  trial_thread_ = board_.thread ? board_.thread("wifi", [this, generation] { run_trial(generation); })
                                : std::thread([this, generation] { run_trial(generation); });
  return "";
}

void Gadget::cancel_trial() {
  if (!trial_.active) return;
  trial_.active = false;
  trial_.state = "cancelled";
  trial_.password.assign(trial_.password.size(), '\0');
  trial_.password.clear();
  trial_.generation++;
}

void Gadget::run_trial(uint32_t generation) {
  bool returning = false;
  std::string back;  // the network being joined again
  std::chrono::steady_clock::time_point back_deadline{};
  for (;;) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    {
      std::lock_guard<std::mutex> lock(mutex_);
      // Cancelled (a setup over USB, the networks forgotten) or replaced: it is theirs now.
      if (trial_.generation != generation || !trial_.active) return;
      const auto now = std::chrono::steady_clock::now();
      if (!running_) {
        trial_.active = false;
        cancel_trial();
        return;
      }
      const std::string state = board_.network->state();
      const std::string from = board_.network->joined_ssid();
      if (!returning) {
        // An address from the network being left is not this one's.
        if (state == "on" && (from.empty() || from == trial_.ssid)) {
          // It gave an address: kept first, with its password, as a setup over USB keeps one.
          const std::string ssid = trial_.ssid;
          networks_.erase(std::remove_if(networks_.begin(), networks_.end(), [&ssid](const auto& network) { return network.first == ssid; }), networks_.end());
          networks_.insert(networks_.begin(), {trial_.ssid, trial_.password});
          if (networks_.size() > kMaxNetworks) networks_.pop_back();
          network_at_ = 0;
          save_networks();
          report_wifi_ = true;
          trial_.state = "joined";
          trial_.active = false;
          trial_.password.assign(trial_.password.size(), '\0');
          trial_.password.clear();
          switched_at_ = now;
          wake_.notify_all();
          return;
        }
        if (state != "failed" && now < trial_.deadline) continue;
        // No address in time: back to the network it was on, as it is saved now (the owner may have changed
        // the list meanwhile), else the first saved one. Nothing of the trial is saved.
        trial_.password.assign(trial_.password.size(), '\0');
        trial_.password.clear();
        trial_.state = "rolling-back";
        auto saved = networks_.end();
        if (trial_.had_previous) saved = std::find_if(networks_.begin(), networks_.end(), [this](const auto& network) { return network.first == trial_.previous; });
        if (saved == networks_.end() && trial_.had_previous && !networks_.empty()) saved = networks_.begin();
        if (saved == networks_.end()) {
          board_.network->join("", "");
          trial_.state = "rolled-back";
          trial_.fallback = "none";
          trial_.active = false;
          switched_at_ = now;
          wake_.notify_all();
          return;
        }
        network_at_ = (size_t)(saved - networks_.begin());
        back = saved->first;
        trial_.fallback = "reconnecting";
        returning = true;
        back_deadline = now + std::chrono::milliseconds(board_.wifi_trial_ms);
        switched_at_ = now;
        board_.network->join(saved->first, saved->second);
      } else {
        // The network before, verified: an address of its own, or none in time (the saved ones are then
        // tried in turn, as always).
        const bool back_on = state == "on" && (from.empty() || from == back);
        if (!back_on && now < back_deadline) continue;
        trial_.state = "rolled-back";
        trial_.fallback = back_on ? "on" : "unreachable";
        trial_.active = false;
        switched_at_ = now;
        wake_.notify_all();
        return;
      }
    }
  }
}

Json Gadget::network_trial() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (trial_.state.empty()) return Json();
  Json out = Json::object().set("n", (double)trial_.generation).set("ssid", trial_.ssid).set("state", trial_.state);
  if (!trial_.fallback.empty()) out.set("fallback", trial_.fallback);
  return out;
}

/** What the owner's page shows: the network in use, the saved names, the signal. Never a password. */
Json Gadget::wifi_report() {
  Json saved = Json::array();
  std::string current;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& network : networks_) saved.push(network.first);
    if (network_at_ < networks_.size()) current = networks_[network_at_].first;
  }
  Json report = Json::object().set("saved", std::move(saved));
  if (!current.empty() && std::string(board_.network->state()) == "on") report.set("network", current);
  const int signal = board_.network->signal();
  if (signal < 0) report.set("signal", signal);
  return report;
}

/** Networks the owner added or asked to forget. The one in use stays in use, so the link isn't cut. */
void Gadget::apply_wifi(Link& link, const std::vector<Json>& changes) {
  Json done = Json::array();
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string current = network_at_ < networks_.size() ? networks_[network_at_].first : "";
    for (const Json& change : changes) {
      const std::string added = change["add"]["ssid"].str();
      const std::string forget = added.empty() ? change["forget"].str() : added;
      networks_.erase(std::remove_if(networks_.begin(), networks_.end(), [&forget](const auto& network) { return network.first == forget; }), networks_.end());
      if (!added.empty()) networks_.emplace_back(added, change["add"]["password"].str());
      done.push(change["id"].str());
    }
    while (networks_.size() > kMaxNetworks) networks_.erase(networks_.begin() + 1);
    network_at_ = 0;
    for (size_t i = 0; i < networks_.size(); i++)
      if (networks_[i].first == current) network_at_ = i;
    save_networks();
  }
  link.call("link.gadget.set", args(Json::object().set("wifiDone", std::move(done))), 15000);
  report_wifi_ = true;
}

// ── What the person does ────────────────────────────────────────────────────────────────────────

void Gadget::post(Job job) {
  std::lock_guard<std::mutex> lock(mutex_);
  jobs_.push_back(std::move(job));
  wake_.notify_all();
}

void Gadget::work_loop() {
  while (running_) {
    Job job;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      wake_.wait(lock, [this] { return !running_ || !jobs_.empty(); });
      if (!running_) break;
      job = std::move(jobs_.front());
      jobs_.pop_front();
    }
    std::shared_ptr<Link> link = this->link();
    if (link) job(*link);
  }
}

void Gadget::say(const std::string& text) {
  stop_speaking();
  post([this, text](Link& link) {
    change([](View& view) { view.sending = true; view.notice.clear(); });
    Link::Result result = link.call("link.gadget.say", args(Json::object().set("text", text)));
    change([&](View& view) {
      view.sending = false;
      if (result.ok()) view.heard = text;
    });
    fail(result);
  });
}

void Gadget::start_listening() {
  bool muted;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    muted = view_.settings.mute;
  }
  if (muted) {
    notice("The microphone is off. Turn it on in quick controls.");
    return;
  }
  stop_speaking();
  // Live voice when the computer has one this gadget speaks; else the turn path, a recording sent to the computer.
  const bool live = live_ && live_->usable();
  {
    std::lock_guard<std::mutex> lock(audio_);
    if (recording_) return;
    uint8_t salt[4];
    random_bytes(salt, 4);
    take_ = "t" + std::to_string(++takes_) + "-" + b64u(salt, 4);
    pending_.clear();
    recording_ = true;
    uploading_ = false;
    live_take_ = live;
    if (live) live_->press();
  }
  change([](View& view) { view.listening = true; view.notice.clear(); view.heard.clear(); });
}

void Gadget::feed(const int16_t* samples, size_t count) {
  bool send = false, stalled = false;
  std::string take;
  {
    std::lock_guard<std::mutex> lock(audio_);
    if (!recording_ || take_ == failed_take_) return;
    if (live_take_) {
      live_->feed(samples, count);
      return;
    }
    // A link that stalled must not grow this without end on a board with little memory: the recording is given up.
    if (pending_.size() + count > (size_t)board_.mic_rate * kAheadSeconds) {
      failed_take_ = take_;
      pending_ = std::vector<int16_t>();
      stalled = true;
    } else {
      pending_.insert(pending_.end(), samples, samples + count);
      if (!uploading_ && pending_.size() >= (size_t)(board_.mic_rate * kPieceSeconds)) send = uploading_ = true;
      take = take_;
    }
  }
  if (stalled) notice("Your computer can't be reached right now.");
  if (send) post([this, take](Link& link) { upload(link, take, {}, false, false); });
}

void Gadget::stop_listening(bool send) {
  // What is left of the recording goes with the job, under the recording's own name: a button pressed
  // again before this was sent starts another recording and must not change this one.
  std::vector<int16_t> rest;
  std::string take;
  bool live;
  {
    std::lock_guard<std::mutex> lock(audio_);
    if (!recording_) return;
    recording_ = false;
    live = live_take_;
    rest.swap(pending_);
    take = take_;
  }
  if (live) {
    // The turn ends on the provider (a live turn can't be given up: what was said is heard). It shows as
    // sending until the turn's end went, which the live thread says after this.
    change([](View& view) { view.listening = false; view.sending = true; });
    std::lock_guard<std::mutex> lock(audio_);
    // Unless the session couldn't open meanwhile: then the sound already went the turn path.
    if (live_take_) live_->release(send);
    return;
  }
  change([send](View& view) { view.listening = false; view.sending = send; });
  auto shared = std::make_shared<std::vector<int16_t>>(std::move(rest));
  post([this, take, shared, send](Link& link) { upload(link, take, std::move(*shared), true, !send); });
}

/**
 * Live voice couldn't open a session for this press: its sound goes the turn path, as a recording, so
 * nothing the person said is lost. From the live thread.
 */
void Gadget::live_failed() {
  std::vector<int16_t> audio;
  std::string take;
  bool last = false, piece = false;
  {
    std::lock_guard<std::mutex> lock(audio_);
    audio = live_->surrender();
    if (!live_take_) return;
    live_take_ = false;
    take = take_;
    if (recording_) {
      // Still held: the recording goes on from what was said so far.
      pending_ = std::move(audio);
      if (!uploading_ && pending_.size() >= (size_t)(board_.mic_rate * kPieceSeconds)) piece = uploading_ = true;
    } else last = true;
  }
  if (last && audio.empty()) {
    // A press with no speech in it: nothing to send down the turn path either.
    change([](View& view) { view.sending = false; });
    return;
  }
  if (last) {
    auto shared = std::make_shared<std::vector<int16_t>>(std::move(audio));
    post([this, take, shared](Link& link) { upload(link, take, std::move(*shared), true, false); });
  } else if (piece) post([this, take](Link& link) { upload(link, take, {}, false, false); });
}

/**
 * Sends a piece of the recording `take`: what the microphone gave so far, or for the last piece
 * `rest`, which asks the computer to hear the whole recording.
 */
void Gadget::upload(Link& link, const std::string& take, std::vector<int16_t> rest, bool last, bool cancel) {
  std::vector<int16_t> samples = std::move(rest);
  bool failed;
  {
    std::lock_guard<std::mutex> lock(audio_);
    failed = take == failed_take_;
    if (!last && take == take_) {
      samples.swap(pending_);
      uploading_ = false;
    }
  }
  if (failed || take.empty() || (!last && samples.empty())) {
    if (last) change([](View& view) { view.sending = false; });
    return;
  }
  Json piece = Json::object().set("take", take).set("rate", board_.mic_rate);
  if (cancel) piece.set("cancel", true);
  else {
    // Samples are little-endian on the wire, as they are in memory on every chip a gadget runs on.
    piece.set("audio", b64u((const uint8_t*)samples.data(), samples.size() * 2));
    if (last) piece.set("last", true);
  }
  samples = std::vector<int16_t>();
  Link::Result result = link.call("link.gadget.hear", args(std::move(piece)), last ? 90000 : 30000);
  if (!result.ok()) {
    std::lock_guard<std::mutex> lock(audio_);
    failed_take_ = take;
  }
  if (last || !result.ok()) {
    change([&](View& view) {
      view.sending = false;
      if (!result.ok()) view.listening = false;
      if (result.ok() && !cancel) view.heard = result.value["text"].str();
    });
  }
  if (!cancel) fail(result);
}

void Gadget::stop_speaking() {
  quiet_++;
  if (live_) live_->quiet();
  bool speaking;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    speaking = view_.speaking;
  }
  // The reader stops at its next slice; the sound already queued stops now.
  if (speaking && board_.speaker) board_.speaker->cut();
}

/** Reads a reply aloud: each part's samples a slice at a time, played as they come. */
void Gadget::read_aloud(Link& link, const std::string& reply, int parts, uint32_t quiet) {
  // `quiet` is from when the reply came: the person asking for quiet since then stops it, also before it started.
  auto cut = [this, quiet] { return quiet_ != quiet; };
  if (cut() || !board_.speaker || !board_.speaker->begin(board_.speaker_rate)) return;
  change([](View& view) { view.speaking = true; });
  bool failed = false;
  for (int part = 0; part < parts && !cut() && !failed && running_; part++) {
    size_t from = 0, total = 1;
    while (from < total && !cut() && running_) {
      Json ask = Json::object().set("reply", reply).set("part", part).set("from", from).set("max", board_.slice_bytes).set("rate", board_.speaker_rate);
      Link::Result result = link.call("link.gadget.speak", args(std::move(ask)), 60000);
      if (!result.ok()) {
        // A reply that was replaced while it was read just stops; anything else is said.
        if (!(result.error == Link::Error::Remote && result.message.find("reply") != std::string::npos)) fail(result);
        failed = true;
        break;
      }
      total = (size_t)result.value["total"].num();
      Bytes pcm;
      {
        std::string audio = result.value.take("audio").take_str();
        result = Link::Result();
        if (!unb64(audio, pcm)) pcm.clear();
      }
      if (pcm.size() < 2) break;
      from += pcm.size();
      // The bytes are 16-bit samples, least significant first. Copied so they are aligned for the speaker.
      std::vector<int16_t> samples(pcm.size() / 2);
      memcpy(samples.data(), pcm.data(), samples.size() * 2);
      pcm = Bytes();
      if (!cut()) board_.speaker->write(samples.data(), samples.size());
    }
  }
  board_.speaker->end(cut());
  change([](View& view) { view.speaking = false; });
}

void Gadget::answer(const std::string& action, const std::string& value) {
  std::string request;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    request = view_.request.id;
  }
  if (request.empty()) return;
  post([this, request, action, value](Link& link) {
    Json answer = Json::object().set("action", action);
    if (action == "answer") answer.set("value", value);
    fail(link.call("respond", Json::array().push(request).push(std::move(answer))));
  });
}

void Gadget::stop_turn() {
  stop_speaking();
  std::string chat;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    chat = chat_id_;
  }
  if (!chat.empty()) post([this, chat](Link& link) { fail(link.call("stop", Json::array().push(chat))); });
}

void Gadget::new_chat() {
  stop_speaking();
  // A live session talks in the chat it was opened for: the next press opens one for the new chat.
  if (live_) live_->end();
  post([this](Link& link) { fail(link.call("link.gadget.set", args(Json::object().set("newChat", true)))); });
}

void Gadget::next_bot() {
  std::string next;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (bots_.size() < 2) return;
    size_t at = 0;
    for (size_t i = 0; i < bots_.size(); i++)
      if (bots_[i].first == bot_id_) at = i;
    next = bots_[(at + 1) % bots_.size()].first;
  }
  stop_speaking();
  if (live_) live_->end();
  post([this, next](Link& link) { fail(link.call("link.gadget.set", args(Json::object().set("botId", next)))); });
}

// ── Setup over the USB port ─────────────────────────────────────────────────────────────────────

std::string Gadget::console(const std::string& line) {
  const size_t mark = line.find(kMark);
  if (mark == std::string::npos) return "";
  Json ask;
  if (!Json::parse(line.substr(mark + strlen(kMark)), ask) || !ask.is_object()) return reply_line(Json::object().set("error", "That line isn't JSON."));
  const std::string what = ask["do"].str();
  auto status = [this] {
    View now = view();
    bool has_link;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      has_link = intro_.valid();
    }
    const char* link = !has_link ? "off" : now.stage == View::Stage::Online ? "online" : now.stage == View::Stage::Removed ? "removed" : "connecting";
    Json status = Json::object().set("wifi", board_.network->state()).set("link", link);
    const std::string address = board_.network->address();
    if (!address.empty()) status.set("ip", address);
    if (!now.computer.empty()) status.set("computer", now.computer);
    if (!now.notice.empty()) status.set("error", now.notice);
    return status;
  };
  if (what == "hello") {
    bool paired;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      paired = intro_.valid();
    }
    // "wifi" says whether it has a network: one that was saved, or (a board on a cable) one it is on anyway.
    std::string wifi;
    const bool has_network = board_.storage->load(kWifi, wifi) || std::string(board_.network->state()) == "on";
    return reply_line(Json::object().set("hello", 1).set("publicKey", public_key()).set("board", board_.name).set("firmware", board_.firmware).set("mac", board_.mac).set("paired", paired).set("wifi", has_network));
  }
  if (what == "status") return reply_line(Json::object().set("status", status()));
  if (what == "setup") {
    const Json& wifi = ask["wifi"];
    const Json& link = ask["link"];
    if (!wifi.is_object() && !link.is_object()) return reply_line(Json::object().set("error", "Setup needs a Wi-Fi network, a computer, or both."));
    Introduction introduction;
    if (link.is_object() && !Introduction::from_json(link, introduction)) return reply_line(Json::object().set("error", "That isn't a computer's introduction."));
    if (wifi.is_object()) {
      const std::string ssid = wifi["ssid"].str(), password = wifi["password"].str();
      if (!valid_network(ssid, password)) return reply_line(Json::object().set("error", "That isn't a Wi-Fi network's name and password."));
      {
        // The network given over the cable goes first, ahead of the ones saved before.
        std::lock_guard<std::mutex> lock(mutex_);
        cancel_trial();
        networks_.erase(std::remove_if(networks_.begin(), networks_.end(), [&ssid](const auto& network) { return network.first == ssid; }), networks_.end());
        networks_.insert(networks_.begin(), {ssid, password});
        if (networks_.size() > kMaxNetworks) networks_.pop_back();
        network_at_ = 0;
        switched_at_ = std::chrono::steady_clock::now();
        save_networks();
        board_.network->join(ssid, password);
        report_wifi_ = true;
      }
    }
    if (link.is_object()) adopt(introduction);
    return reply_line(Json::object().set("ok", true));
  }
  if (what == "forget" || what == "erase") {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      cancel_trial();
      networks_.clear();
      network_at_ = 0;
      save_networks();
      board_.network->join("", "");
    }
    board_.storage->erase(kSettings);
    forget_link();
    if (what == "erase") {
      // A new key: to every computer this is another gadget from now on.
      keys_ = new_key_pair();
      board_.storage->save(kKey, b64u(keys_.secret, 32));
    }
    return reply_line(Json::object().set("ok", true));
  }
  // For trying a gadget from the cable, with nobody at its buttons (a test, or a person at a terminal).
  if (what == "view") {
    View now = view();
    static const char* stages[] = {"setup", "joining", "no-network", "connecting", "online", "removed"};
    Json json = Json::object().set("stage", stages[(int)now.stage]).set("phase", now.phase).set("bot", now.bot).set("text", now.text).set("heard", now.heard).set("notice", now.notice);
    json.set("listening", now.listening).set("sending", now.sending).set("speaking", now.speaking).set("live", now.live).set("hear", now.can_hear).set("speak", now.can_speak);
    if (!now.request.id.empty()) json.set("request", Json::object().set("kind", now.request.kind).set("title", now.request.title));
    const auto& s = now.settings;
    json.set("settings", Json::object().set("volume", s.volume).set("mic", s.mic).set("mute", s.mute).set("brightness", s.brightness).set("dimAfter", s.dim_after).set("offAfter", s.off_after));
    json.set("look", now.look).set("faces", now.faces ? now.faces->size() : 0).set("steps", now.steps);
    return reply_line(Json::object().set("view", std::move(json)));
  }
  if (what == "settings") {
    // What the quick controls change: the same names as the part's settings.
    Json patch = Json::object();
    for (const auto& field : ask.fields())
      if (field.first != "do") patch.set(field.first, field.second);
    change_settings(patch);
    return reply_line(Json::object().set("ok", true));
  }
  if (what == "say") {
    say(ask["text"].str());
    return reply_line(Json::object().set("ok", true));
  }
  if (what == "listen") {
    // Holds the talk button for `ms` (10 seconds at most), as a finger would.
    int ms = (int)ask["ms"].num();
    ms = ms < 300 ? 300 : ms > 10000 ? 10000 : ms;
    if (hold_thread_.joinable()) hold_thread_.join();
    start_listening();
    auto hold = [this, ms] {
      for (int waited = 0; waited < ms && running_; waited += 50) std::this_thread::sleep_for(std::chrono::milliseconds(50));
      stop_listening();
    };
    hold_thread_ = board_.thread ? board_.thread("hold", hold) : std::thread(hold);
    return reply_line(Json::object().set("ok", true));
  }
  if (what == "answer") {
    answer(ask["action"].str(), ask["value"].str());
    return reply_line(Json::object().set("ok", true));
  }
  if (what == "quiet") {
    stop_speaking();
    return reply_line(Json::object().set("ok", true));
  }
  return reply_line(Json::object().set("error", "This gadget doesn't know that."));
}

}  // namespace botkins

