#include "botkins/gadget.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>

namespace botkins {

namespace {
const char* kKey = "key";
const char* kLink = "link";
const char* kWifi = "wifi";
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

Gadget::Gadget(Board board) : board_(std::move(board)) {}
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
  if (board_.storage->load(kWifi, saved) && Json::parse(saved, json) && !json["ssid"].str().empty()) board_.network->join(json["ssid"].str(), json["password"].str());
  running_ = true;
  sync_thread_ = std::thread([this] { sync_loop(); });
  work_thread_ = std::thread([this] { work_loop(); });
}

void Gadget::stop() {
  if (!running_.exchange(false)) return;
  quiet_++;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    wake_.notify_all();
  }
  if (sync_thread_.joinable()) sync_thread_.join();
  if (work_thread_.joinable()) work_thread_.join();
  if (hold_thread_.joinable()) hold_thread_.join();
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
    link_ = std::make_shared<Link>(*board_.transport, keys_, intro_);
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
      link->reset();
      if (!wait(300)) break;
      continue;
    }

    Link::Result result;
    if (!greeted_) {
      Json hello = Json::object().set("board", board_.name).set("firmware", board_.firmware).set("rate", board_.speaker_rate);
      if (board_.screen_width > 0) hello.set("screen", Json::object().set("width", board_.screen_width).set("height", board_.screen_height).set("round", board_.screen_round));
      if (!board_.speaker) hello.set("speaker", false);
      result = link->call("link.gadget.hello", args(std::move(hello)), 15000);
      if (result.ok()) greeted_ = true;
    }
    if (greeted_) {
      Json request = Json::object().set("epoch", epoch_).set("have", have_).set("wait", 25000);
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
        {
          std::lock_guard<std::mutex> lock(mutex_);
          computer = intro_.name.empty() ? "your computer" : intro_.name;
        }
        unreachable_ = "Can't reach " + computer + ". Check that Botkins is open there, on the same Wi-Fi.";
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
    if (!reply.empty() && reply != last_reply_ && !first_part_ && board_.speaker && part["voice"]["speak"].truthy()) {
      speak_reply = reply;
      speak_parts = (int)part["reply"]["parts"].num();
      if (speak_parts > 64) speak_parts = 64;
    }
    last_reply_ = reply;
    first_part_ = false;
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
      if (part["reply"].is_object()) view.text = part["reply"]["text"].str();
      else if (view.phase == "working" || view.phase == "writing") view.text = stream_;
      // A turn that started clears what was said about the one before.
      if (view.phase != "idle") view.notice.clear();
    } else if (texted && (view.phase == "working" || view.phase == "writing")) view.text = stream_;
  });
  if (!speak_reply.empty() && speak_parts > 0) {
    const std::string reply = speak_reply;
    const uint32_t quiet = quiet_;
    post([this, reply, speak_parts, quiet](Link& link) { read_aloud(link, reply, speak_parts, quiet); });
  }
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
  stop_speaking();
  {
    std::lock_guard<std::mutex> lock(audio_);
    if (recording_) return;
    uint8_t salt[4];
    random_bytes(salt, 4);
    take_ = "t" + std::to_string(++takes_) + "-" + b64u(salt, 4);
    pending_.clear();
    recording_ = true;
    uploading_ = false;
  }
  change([](View& view) { view.listening = true; view.notice.clear(); view.heard.clear(); });
}

void Gadget::feed(const int16_t* samples, size_t count) {
  bool send = false, stalled = false;
  std::string take;
  {
    std::lock_guard<std::mutex> lock(audio_);
    if (!recording_ || take_ == failed_take_) return;
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
  {
    std::lock_guard<std::mutex> lock(audio_);
    if (!recording_) return;
    recording_ = false;
    rest.swap(pending_);
    take = take_;
  }
  change([send](View& view) { view.listening = false; view.sending = send; });
  auto shared = std::make_shared<std::vector<int16_t>>(std::move(rest));
  post([this, take, shared, send](Link& link) { upload(link, take, std::move(*shared), true, !send); });
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
      if (ssid.empty() || ssid.size() > 32 || password.size() > 64) return reply_line(Json::object().set("error", "That isn't a Wi-Fi network's name and password."));
      board_.storage->save(kWifi, Json::object().set("ssid", ssid).set("password", password).dump());
      board_.network->join(ssid, password);
    }
    if (link.is_object()) adopt(introduction);
    return reply_line(Json::object().set("ok", true));
  }
  if (what == "forget" || what == "erase") {
    board_.storage->erase(kWifi);
    board_.network->join("", "");
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
    json.set("listening", now.listening).set("sending", now.sending).set("speaking", now.speaking).set("hear", now.can_hear).set("speak", now.can_speak);
    if (!now.request.id.empty()) json.set("request", Json::object().set("kind", now.request.kind).set("title", now.request.title));
    return reply_line(Json::object().set("view", std::move(json)));
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
    hold_thread_ = std::thread([this, ms] {
      for (int waited = 0; waited < ms && running_; waited += 50) std::this_thread::sleep_for(std::chrono::milliseconds(50));
      stop_listening();
    });
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
