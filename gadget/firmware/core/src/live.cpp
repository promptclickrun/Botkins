#include "botkins/live.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace botkins {

namespace {
using Clock = std::chrono::steady_clock;
using std::chrono::milliseconds;

// The longest message taken from a provider: a few seconds of its voice as base64 in JSON.
const size_t kMaxMessage = 512 * 1024;
// The person's turn goes in pieces of this long, and the voice is played in slices of it.
const int kPieceMs = 100;
// The voice's sound held at most before the provider's socket is made to wait.
const int kAheadSeconds = 4;
// The microphone held at most while the session opens.
const int kMicSeconds = 12;
// Played out with no word that the voice's turn is over: the speaker stops after this.
const int kQuietMs = 1500;
// A reply is taken after this long with nothing more (another reply may follow, in a group chat).
const int kSettleMs = 800;
// What `ask_bot` waits for the bot at most (askBot.ts).
const int kToolMs = 10 * 60 * 1000;
// After a session failed to open, presses go the turn path for this long.
const int kBackoffMs = 30000;

/** Base64 with its padding, as JSON carries a provider's bytes. */
std::string base64(const uint8_t* data, size_t size) {
  static const char* digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  for (size_t i = 0; i < size; i += 3) {
    const uint32_t n = (uint32_t)data[i] << 16 | (i + 1 < size ? data[i + 1] << 8 : 0) | (i + 2 < size ? data[i + 2] : 0);
    out += digits[n >> 18 & 63];
    out += digits[n >> 12 & 63];
    out += i + 1 < size ? digits[n >> 6 & 63] : '=';
    out += i + 2 < size ? digits[n & 63] : '=';
  }
  return out;
}

std::string trim(const std::string& text) {
  size_t start = 0, end = text.size();
  while (start < end && (unsigned char)text[start] <= ' ') start++;
  while (end > start && (unsigned char)text[end - 1] <= ' ') end--;
  return text.substr(start, end - start);
}

Json args(Json one) { return Json::array().push(std::move(one)); }

/** Arguments a model sent as a JSON string, or as an object already. */
Json args_of(const Json& value) {
  Json out;
  if (value.is_string() && Json::parse(value.str(), out) && out.is_object()) return out;
  return value.is_object() ? value : Json::object();
}

// ── Gemini Live ─────────────────────────────────────────────────────────────────────────────────
// Message shapes as the phone's gemini.ts sends and reads them (the Live API pages, read 2026-11-19):
// audio in as `realtimeInput.audio`, the voice in `serverContent.modelTurn`, a tool call in
// `toolCall.functionCalls`. Push to talk turns Gemini's own activity detection off and marks the
// person's turn with `activityStart` and `activityEnd`.

class Gemini : public LiveProtocol {
 public:
  explicit Gemini(Json session) {
    url = session["url"].str();
    if (session["input"]["sampleRate"].num() > 0) input_rate = (int)session["input"]["sampleRate"].num();
    if (session["output"]["sampleRate"].num() > 0) output_rate = (int)session["output"]["sampleRate"].num();
    // The computer's whole first message, with Gemini's activity detection off (withActivity in gemini.ts).
    Json setup = session.take("setup");
    if (!setup.is_object()) setup = Json::object();
    Json inner = setup.take("setup");
    if (!inner.is_object()) inner = Json::object();
    Json config = inner.take("realtimeInputConfig");
    if (!config.is_object()) config = Json::object();
    Json detection = config.take("automaticActivityDetection");
    if (!detection.is_object()) detection = Json::object();
    detection.set("disabled", true);
    config.set("automaticActivityDetection", std::move(detection));
    inner.set("realtimeInputConfig", std::move(config));
    setup.set("setup", std::move(inner));
    setup_ = std::move(setup);
  }

  std::string hello() override {
    std::string text = setup_.dump();
    setup_ = Json();
    return text;
  }
  std::string start_turn() override { return R"({"realtimeInput":{"activityStart":{}}})"; }
  std::string end_turn() override { return R"({"realtimeInput":{"activityEnd":{}}})"; }
  std::string audio(const int16_t* samples, size_t count) override {
    // Samples are little-endian on the wire, as they are in memory on every chip a gadget runs on.
    return "{\"realtimeInput\":{\"audio\":{\"data\":\"" + base64((const uint8_t*)samples, count * 2) + "\",\"mimeType\":\"audio/pcm;rate=" + std::to_string(input_rate) + "\"}}}";
  }
  std::string answers(const std::vector<LiveAnswer>& answers) override {
    Json list = Json::array();
    for (const LiveAnswer& answer : answers) list.push(Json::object().set("id", answer.id).set("name", answer.name).set("response", Json::object().set("result", answer.result)));
    return Json::object().set("toolResponse", Json::object().set("functionResponses", std::move(list))).dump();
  }

  void read(const uint8_t* data, size_t size, std::vector<LiveEvent>& out) override {
    Json message;
    if (!Json::parse(std::string_view((const char*)data, size), message) || !message.is_object()) return;
    auto event = [&out](LiveEvent::Kind kind) -> LiveEvent& {
      out.push_back(LiveEvent{kind, {}, {}, {}, Json(), {}});
      return out.back();
    };
    if (message.has("setupComplete")) event(LiveEvent::Kind::Ready);
    Json content = message.take("serverContent");
    if (content.is_object()) {
      const Json& input = content["inputTranscription"];
      if (!input["text"].str().empty()) event(LiveEvent::Kind::Heard).text = input["text"].str();
      if (input["finished"].truthy()) event(LiveEvent::Kind::HeardDone);
      Json turn = content.take("modelTurn");
      Json parts = turn.take("parts");
      for (const Json& part : parts.items()) {
        const std::string& sound = part["inlineData"]["data"].str();
        if (sound.empty()) continue;
        Bytes pcm;
        if (!unb64(sound, pcm) || pcm.size() < 2) continue;
        LiveEvent& audio = event(LiveEvent::Kind::Audio);
        audio.audio.resize(pcm.size() / 2);
        memcpy(audio.audio.data(), pcm.data(), audio.audio.size() * 2);
      }
      const Json& output = content["outputTranscription"];
      if (!output["text"].str().empty()) event(LiveEvent::Kind::Said).text = output["text"].str();
      if (output["finished"].truthy()) event(LiveEvent::Kind::SaidDone);
      if (content["interrupted"].truthy()) event(LiveEvent::Kind::Interrupted);
      if (content["turnComplete"].truthy()) event(LiveEvent::Kind::TurnDone);
    }
    for (const Json& call : message["toolCall"]["functionCalls"].items()) {
      LiveEvent& tool = event(LiveEvent::Kind::Tool);
      tool.id = call["id"].str();
      tool.name = call["name"].str();
      tool.args = args_of(call["args"]);
    }
    for (const Json& id : message["toolCallCancellation"]["ids"].items()) event(LiveEvent::Kind::ToolCancel).id = id.str();
    if (message.has("goAway")) event(LiveEvent::Kind::GoAway);
  }

 private:
  Json setup_;
};
}  // namespace

std::unique_ptr<LiveProtocol> live_protocol(Json session) {
  const std::string kind = session["kind"].str();
  if (kind == "gemini-ws" && !session["url"].str().empty()) return std::unique_ptr<LiveProtocol>(new Gemini(std::move(session)));
  // "openai-ws" and "elevenlabs-ws" go here, each a LiveProtocol of its own.
  return nullptr;
}

/** The live voices this core speaks, by the part's name for them. */
static bool speaks(const std::string& provider) { return provider == "gemini"; }

// ── Resampler ───────────────────────────────────────────────────────────────────────────────────
// The same arithmetic as the computer's `resample` (mobile/link-host/gadget.mjs): an average of the
// samples each output covers when the rate goes down, a straight line between two when it goes up.
// Positions are counted from the start of the stream, so a long one never drifts.

void Resampler::reset(int from, int to) {
  from_ = from;
  to_ = to;
  held_.clear();
  base_ = made_ = 0;
}

void Resampler::push(const int16_t* in, size_t count, std::vector<int16_t>& out) {
  if (from_ == to_ || from_ <= 0 || to_ <= 0) {
    out.insert(out.end(), in, in + count);
    return;
  }
  held_.insert(held_.end(), in, in + count);
  const uint64_t from = (uint64_t)from_, to = (uint64_t)to_;
  for (;;) {
    const uint64_t first = made_ * from / to;
    if (first < base_) break;  // never: what is still needed is held
    const size_t at = (size_t)(first - base_);
    double value;
    if (from > to) {
      const uint64_t last = std::max(first + 1, (made_ + 1) * from / to);
      const size_t end = (size_t)(last - base_);
      if (end > held_.size()) break;
      long sum = 0;
      for (size_t i = at; i < end; i++) sum += held_[i];
      value = (double)sum / (double)(end - at);
    } else {
      if (at + 1 >= held_.size()) break;
      const double fraction = (double)(made_ * from - first * to) / (double)to;
      value = held_[at] + (held_[at + 1] - held_[at]) * fraction;
    }
    const long rounded = std::lround(value);
    out.push_back((int16_t)(rounded > 32767 ? 32767 : rounded < -32768 ? -32768 : rounded));
    made_++;
  }
  // What no later sample needs goes.
  const uint64_t needed = made_ * from / to;
  if (needed > base_) {
    const size_t drop = (size_t)std::min<uint64_t>(needed - base_, held_.size());
    held_.erase(held_.begin(), held_.begin() + drop);
    base_ += drop;
  }
}

// ── Samples waiting ─────────────────────────────────────────────────────────────────────────────

void SampleQueue::take(size_t count, std::vector<int16_t>& out) {
  count = std::min(count, size());
  out.assign(data_.begin() + at_, data_.begin() + at_ + count);
  at_ += count;
  if (at_ == data_.size()) clear();
  // What was taken is let go now and then, not with every piece.
  else if (at_ >= 16384 && at_ * 2 >= data_.size()) {
    data_.erase(data_.begin(), data_.begin() + at_);
    at_ = 0;
  }
}

std::vector<int16_t> SampleQueue::take_all() {
  if (at_ > 0) data_.erase(data_.begin(), data_.begin() + at_);
  std::vector<int16_t> out;
  out.swap(data_);
  at_ = 0;
  return out;
}

// ── The session ─────────────────────────────────────────────────────────────────────────────────

LiveVoice::LiveVoice(const Board& board, Hooks hooks) : board_(board), hooks_(std::move(hooks)) {}
LiveVoice::~LiveVoice() { stop(); }

void LiveVoice::part(const LivePart& part) {
  bool end_now = false;
  {
    std::lock_guard<std::mutex> lock(m_);
    if (state_ == State::Opening || state_ == State::Open) {
      // The gadget's chat or bot moved away from the session's (a new chat, another bot, from the gadget or
      // its owner), or the computer's live voice changed: the session ends, and the next press opens one for
      // what is there now. A look from before the session's own chat was made is not a move.
      const bool chat_left = !chat_id_.empty() && part_chat_seen_ == chat_id_ && part.chat_id != chat_id_;
      const bool bot_left = !bot_id_.empty() && part_bot_seen_ == bot_id_ && part.bot_id != bot_id_;
      end_now = chat_left || bot_left || part.provider != part_.provider;
    }
    part_ = part;
    part_chat_seen_ = part.chat_id;
    part_bot_seen_ = part.bot_id;
    if (!part.reply_id.empty()) last_reply_ = part.reply_id;
    // A tool may be waiting on this.
    wake_.notify_all();
  }
  if (end_now) end();
}

bool LiveVoice::usable() {
  std::lock_guard<std::mutex> lock(m_);
  if (stopping_ || !board_.socket || !board_.speaker || !speaks(part_.provider) || part_.bot_id.empty()) return false;
  return state_ == State::Opening || state_ == State::Open || Clock::now() >= backoff_until_;
}

bool LiveVoice::active() {
  std::lock_guard<std::mutex> lock(m_);
  return state_ != State::Closed;
}

void LiveVoice::press() {
  bool cut;
  {
    std::lock_guard<std::mutex> lock(m_);
    if (stopping_) return;
    held_ = true;
    active_at_ = Clock::now();
    // Pressed again before the turn went: it goes on as the same turn (gemini.ts, press()).
    if (release_pending_) release_pending_ = false;
    else {
      start_pending_ = true;
      mic_.clear();
    }
    // A press while the voice speaks is how a person interrupts it: the sound stops now, and the rest of its turn is dropped.
    cut = playing_;
    if (playing_ || generating_ || !play_.empty()) {
      cutting_ = generating_;
      play_.clear();
      cut_now_ = true;
    }
    if (state_ == State::Closed || state_ == State::Closing) want_ = true;
    if (!running_) {
      // The thread before this one has returned (it says so last): joined at once.
      if (thread_.joinable()) thread_.join();
      running_ = true;
      // The board may make it (its stack): Board::thread.
      if (board_.thread) thread_ = board_.thread("live", [this] { run(); });
      else thread_ = std::thread([this] { run(); });
    }
    wake_.notify_all();
  }
  if (cut) board_.speaker->cut();
}

void LiveVoice::feed(const int16_t* samples, size_t count) {
  std::lock_guard<std::mutex> lock(m_);
  if (!held_) return;
  // A session that is slow to open must not grow this without end on a board with little memory.
  if (mic_.size() + count > (size_t)board_.mic_rate * kMicSeconds) return;
  mic_.append(samples, count);
  active_at_ = Clock::now();
  if (state_ == State::Open && mic_.size() >= (size_t)board_.mic_rate * kPieceMs / 1000) wake_.notify_all();
}

void LiveVoice::release() {
  std::lock_guard<std::mutex> lock(m_);
  if (!held_) return;
  held_ = false;
  release_pending_ = true;
  active_at_ = Clock::now();
  wake_.notify_all();
}

std::vector<int16_t> LiveVoice::surrender() {
  std::lock_guard<std::mutex> lock(m_);
  std::vector<int16_t> out = mic_.take_all();
  held_ = start_pending_ = release_pending_ = want_ = false;
  // Not tried again for a while: the presses until then go straight down the turn path.
  backoff_until_ = Clock::now() + milliseconds(kBackoffMs);
  return out;
}

void LiveVoice::quiet() {
  bool cut;
  {
    std::lock_guard<std::mutex> lock(m_);
    cut = playing_;
    if (playing_ || generating_ || !play_.empty()) {
      cutting_ = generating_;
      play_.clear();
      cut_now_ = true;
      wake_.notify_all();
    }
  }
  if (cut) board_.speaker->cut();
}

void LiveVoice::end() {
  std::lock_guard<std::mutex> lock(m_);
  if (state_ == State::Opening || state_ == State::Open) close_ = true;
  want_ = false;
  wake_.notify_all();
}

void LiveVoice::stop() {
  bool cut;
  {
    std::lock_guard<std::mutex> lock(m_);
    stopping_ = close_ = true;
    want_ = false;
    cut = playing_;
    wake_.notify_all();
  }
  if (cut) board_.speaker->cut();
  if (thread_.joinable()) thread_.join();
}

/** The live thread: opens a session for a press, serves it until it closes, and again for the next press. */
void LiveVoice::run() {
  for (;;) {
    {
      std::lock_guard<std::mutex> lock(m_);
      if (!want_ || stopping_) {
        // The last thing this thread does: a press may join it as soon as it says so.
        running_ = false;
        return;
      }
      want_ = false;
      state_ = State::Opening;
      ready_ = closed_ = going_ = close_ = shutting_ = false;
      session_id_.clear();
      chat_id_.clear();
      bot_id_ = part_.bot_id;
      history_ = part_.history;
      turns_ = part_.turns;
      you_turn_ = bot_line_ = sequence_ = 0;
      you_open_ = bot_open_ = false;
      you_text_.clear();
      bot_text_.clear();
      inputs_.clear();
      outputs_.clear();
      awaiting_.clear();
      current_.clear();
      claimed_.clear();
      answered_.clear();
      last_speech_.clear();
      last_speech_text_.clear();
      last_claimed_.clear();
    }
    if (!open_session()) {
      bool stopping;
      {
        std::lock_guard<std::mutex> lock(m_);
        state_ = State::Closed;
        stopping = stopping_;
      }
      // The press's sound goes the turn path (the gadget takes it back with surrender()).
      if (!stopping) hooks_.failed();
      continue;
    }
    hooks_.change([](View& view) { view.live = true; });
    {
      std::unique_lock<std::mutex> lock(m_);
      serve(lock);
    }
    close_session();
  }
}

/** Asks the computer for a session, opens the provider's socket and waits for the setup to take, all within `open_ms_`. */
bool LiveVoice::open_session() {
  const Clock::time_point deadline = Clock::now() + milliseconds(open_ms_);
  auto left = [&deadline] { return std::max(1, (int)std::chrono::duration_cast<milliseconds>(deadline - Clock::now()).count()); };
  std::shared_ptr<Link> link = hooks_.link();
  if (!link) return false;
  std::string chat, bot;
  {
    std::lock_guard<std::mutex> lock(m_);
    chat = part_.chat_id;
    bot = part_.bot_id;
  }
  if (chat.empty()) {
    // No chat yet: one is started with the gadget's bot, as the apps do, and made the gadget's.
    Link::Result made = link->call("createChat", Json::array().push(bot), left());
    if (!made.ok() || made.value.str().empty()) return false;
    chat = made.value.str();
    if (!link->call("link.gadget.set", args(Json::object().set("chatId", chat)), left()).ok()) return false;
  }
  {
    std::lock_guard<std::mutex> lock(m_);
    chat_id_ = chat;
    if (stopping_ || close_) return false;
  }
  Link::Result result = link->call("link.voice.live", args(Json::object().set("chatId", chat).set("botId", bot)), left());
  if (!result.ok()) return false;
  const std::string id = result.value["id"].str();
  // A session that was made and not used: the computer forgets it.
  auto give_up = [this, &id] {
    if (!id.empty()) hooks_.post([id](Link& link) { link.call("link.voice.endLive", Json::array().push(id), 15000); });
    std::lock_guard<std::mutex> lock(m_);
    proto_.reset();
    return false;
  };
  std::unique_ptr<LiveProtocol> proto = live_protocol(std::move(result.value));
  if (!proto) return give_up();
  {
    // The socket's thread reads the protocol without a lock: it is set before the socket opens and goes after it closed.
    std::lock_guard<std::mutex> lock(m_);
    session_id_ = id;
    mic_rate_.reset(board_.mic_rate, proto->input_rate);
    out_rate_.reset(proto->output_rate, board_.speaker_rate);
    proto_ = std::move(proto);
  }
  std::unique_ptr<Socket> socket = board_.socket();
  Socket::Events events;
  events.message = [this](const uint8_t* data, size_t size, bool) { received(data, size); };
  events.closed = [this](int) {
    std::lock_guard<std::mutex> lock(m_);
    closed_ = true;
    wake_.notify_all();
  };
  if (!socket || !socket->open(proto_->url, proto_->subprotocol, left(), kMaxMessage, events)) return give_up();
  const std::string hello = proto_->hello();
  if (!socket->send((const uint8_t*)hello.data(), hello.size(), false)) {
    socket->close();
    return give_up();
  }
  {
    // Sound goes once the provider says the setup took.
    std::unique_lock<std::mutex> lock(m_);
    wake_.wait_until(lock, deadline, [this] { return ready_ || closed_ || stopping_ || close_; });
    if (ready_ && !closed_ && !stopping_ && !close_) {
      socket_ = std::move(socket);
      state_ = State::Open;
      active_at_ = Clock::now();
      return true;
    }
  }
  socket->close();
  return give_up();
}

/** The open session, until it ends: the person's turns out, the voice to the speaker, the tools, the time. */
void LiveVoice::serve(std::unique_lock<std::mutex>& lock) {
  const size_t piece = (size_t)board_.mic_rate * kPieceMs / 1000;
  const size_t slice = (size_t)board_.speaker_rate * kPieceMs / 1000;
  auto send = [this, &lock](const std::string& message) {
    lock.unlock();
    socket_->send((const uint8_t*)message.data(), message.size(), false);
    lock.lock();
  };
  while (!stopping_ && !close_ && !closed_) {
    if (cut_now_) {
      // A press or quiet stopped the voice: its sound goes at once.
      cut_now_ = false;
      if (playing_) {
        playing_ = false;
        lock.unlock();
        board_.speaker->cut();
        board_.speaker->end(true);
        hooks_.change([](View& view) { view.speaking = false; });
        lock.lock();
        continue;
      }
    }
    // A press: the person's turn starts, which stops the voice on the provider's side too.
    if (start_pending_) {
      start_pending_ = false;
      turn_open_ = true;
      send(proto_->start_turn());
      continue;
    }
    // The microphone: whole pieces while the button is held, then the rest and the turn's end.
    if (turn_open_ && !mic_.empty() && (mic_.size() >= piece || release_pending_)) {
      const size_t count = std::min(piece, mic_.size());
      std::vector<int16_t> samples;
      mic_.take(count, samples);
      active_at_ = Clock::now();
      lock.unlock();
      std::vector<int16_t> rated;
      mic_rate_.push(samples.data(), samples.size(), rated);
      const std::string message = rated.empty() ? std::string() : proto_->audio(rated.data(), rated.size());
      if (!message.empty()) socket_->send((const uint8_t*)message.data(), message.size(), false);
      lock.lock();
      continue;
    }
    if (turn_open_ && release_pending_ && mic_.empty()) {
      release_pending_ = turn_open_ = false;
      send(proto_->end_turn());
      // The turn went whole: nothing waits on the gadget.
      lock.unlock();
      hooks_.change([](View& view) { view.sending = false; });
      lock.lock();
      continue;
    }
    if (step_tools(lock, Clock::now())) continue;
    // The voice, a slice at a time: the speaker's write paces this thread.
    if (!play_.empty()) {
      const size_t count = std::min(slice, play_.size());
      std::vector<int16_t> samples;
      play_.take(count, samples);
      const bool begin = !playing_;
      playing_ = true;
      played_at_ = active_at_ = Clock::now();
      wake_.notify_all();  // the socket's thread may wait for room
      lock.unlock();
      if (begin) {
        board_.speaker->begin(board_.speaker_rate);
        hooks_.change([](View& view) { view.speaking = true; });
      }
      board_.speaker->write(samples.data(), samples.size());
      lock.lock();
      continue;
    }
    const Clock::time_point now = Clock::now();
    if (playing_ && (turn_done_ || now - played_at_ > milliseconds(kQuietMs))) {
      // Played out: what the speaker holds still plays.
      playing_ = false;
      lock.unlock();
      board_.speaker->end(false);
      hooks_.change([](View& view) { view.speaking = false; });
      lock.lock();
      continue;
    }
    const bool still = !held_ && !turn_open_ && !start_pending_ && batches_.empty() && play_.empty() && !playing_;
    // The provider is going away: the session ends once nothing is under way, and the next press opens another.
    if (going_ && still) break;
    // No press, no sound and no tool for the idle time.
    if (still && now - active_at_ > milliseconds(board_.live_idle_ms)) break;
    wake_.wait_for(lock, milliseconds(50));
  }
}

void LiveVoice::close_session() {
  std::unique_ptr<Socket> socket;
  std::string id;
  bool turn;
  {
    std::lock_guard<std::mutex> lock(m_);
    state_ = State::Closing;
    shutting_ = true;
    socket = std::move(socket_);
    // A turn under way is given up; a press from now on is for the next session.
    turn = held_ || start_pending_ || release_pending_ || turn_open_;
    mic_.clear();
    held_ = start_pending_ = release_pending_ = turn_open_ = false;
    wake_.notify_all();
  }
  // Waits for the socket's thread: nothing more comes from the provider after this.
  if (socket) socket->close();
  socket.reset();
  bool was_playing;
  {
    std::lock_guard<std::mutex> lock(m_);
    was_playing = playing_;
    playing_ = generating_ = cutting_ = turn_done_ = cut_now_ = false;
    play_.clear();
    batches_.clear();
    cancelled_.clear();
    // Lines still open are kept as they are (LiveBase.end in types.ts).
    close_lines();
    proto_.reset();
    id = session_id_;
    state_ = State::Closed;
    shutting_ = false;
  }
  if (was_playing) board_.speaker->end(true);
  hooks_.change([turn](View& view) {
    view.live = false;
    view.speaking = false;
    if (turn) view.sending = false;
  });
  // The computer forgets the session once its lines are written (the same worker, in order).
  if (!id.empty()) hooks_.post([id](Link& link) { link.call("link.voice.endLive", Json::array().push(id), 15000); });
}

/** One message from the provider, on the socket's thread. */
void LiveVoice::received(const uint8_t* data, size_t size) {
  std::vector<LiveEvent> events;
  proto_->read(data, size, events);
  if (events.empty()) return;
  std::vector<std::function<void(View&)>> edits;
  bool cut = false;
  {
    std::unique_lock<std::mutex> lock(m_);
    std::vector<Call> batch;
    for (LiveEvent& event : events) {
      switch (event.kind) {
        case LiveEvent::Kind::Ready:
          ready_ = true;
          break;
        case LiveEvent::Kind::Audio: {
          if (cutting_ || shutting_) break;
          generating_ = true;
          turn_done_ = false;
          std::vector<int16_t> rated;
          rated.reserve(event.audio.size() * (size_t)board_.speaker_rate / (size_t)proto_->output_rate + 2);
          out_rate_.push(event.audio.data(), event.audio.size(), rated);
          event.audio = std::vector<int16_t>();
          // Too much waiting to play: the socket waits with it, and the provider behind it.
          const size_t room = (size_t)board_.speaker_rate * kAheadSeconds;
          wake_.wait(lock, [&] { return play_.size() < room || cutting_ || shutting_ || stopping_; });
          if (cutting_ || shutting_ || stopping_) break;
          play_.append(rated.data(), rated.size());
          active_at_ = Clock::now();
          break;
        }
        case LiveEvent::Kind::Heard:
          heard(event.text, false, edits);
          break;
        case LiveEvent::Kind::HeardDone:
          heard("", true, edits);
          break;
        case LiveEvent::Kind::Said:
          said(event.text, false, edits);
          break;
        case LiveEvent::Kind::SaidDone:
          said("", true, edits);
          break;
        case LiveEvent::Kind::Interrupted:
          // The voice stopped: what it sent and was not played goes.
          generating_ = cutting_ = false;
          play_.clear();
          if (playing_) cut = cut_now_ = true;
          said("", true, edits);
          break;
        case LiveEvent::Kind::TurnDone:
          generating_ = cutting_ = false;
          turn_done_ = true;
          heard("", true, edits);
          said("", true, edits);
          break;
        case LiveEvent::Kind::Tool: {
          Call call;
          call.id = event.id;
          call.name = event.name;
          call.message = event.args["message"].str();
          batch.push_back(std::move(call));
          break;
        }
        case LiveEvent::Kind::ToolCancel:
          cancelled_.push_back(event.id);
          break;
        case LiveEvent::Kind::GoAway:
          going_ = true;
          break;
      }
    }
    if (!batch.empty()) {
      batches_.push_back(std::move(batch));
      active_at_ = Clock::now();
    }
    wake_.notify_all();
  }
  if (cut) board_.speaker->cut();
  if (!edits.empty())
    hooks_.change([&edits](View& view) {
      for (auto& edit : edits) edit(view);
    });
}

// ── ask_bot ─────────────────────────────────────────────────────────────────────────────────────
// askBot.ts: the words go to the chat, the turn is waited out, and the reply is what the voice hears.
// The gadget's part is what it knows of the chat: the phase, a request, and the newest reply as plain words.

/** Works on the first batch of tool calls, one call at a time. True when it did something. */
bool LiveVoice::step_tools(std::unique_lock<std::mutex>& lock, Clock::time_point now) {
  if (batches_.empty()) return false;
  std::vector<Call>& batch = batches_.front();
  auto gone = [this](const Call& call) { return std::find(cancelled_.begin(), cancelled_.end(), call.id) != cancelled_.end(); };
  for (Call& call : batch) {
    if (call.done || gone(call)) continue;
    if (!call.started) {
      std::function<void(Link&)> job = start_call(call);
      if (job) {
        lock.unlock();
        hooks_.post(std::move(job));
        lock.lock();
      }
      return true;
    }
    check_call(call, now);
    if (!call.done) return false;
  }
  // Every call is answered (or no longer wanted): the answers go together.
  std::vector<LiveAnswer> answers;
  for (const Call& call : batches_.front())
    if (!gone(call)) answers.push_back(LiveAnswer{call.id, call.name, call.result});
  batches_.pop_front();
  active_at_ = now;
  if (!answers.empty()) {
    const std::string message = proto_->answers(answers);
    lock.unlock();
    socket_->send((const uint8_t*)message.data(), message.size(), false);
    lock.lock();
  }
  return true;
}

/** Starts a call: a tool that isn't ask_bot is answered at once; ask_bot's words go to the chat (the job). */
std::function<void(Link&)> LiveVoice::start_call(Call& call) {
  call.started = true;
  if (call.name != ask_bot::kName) {
    call.result = "There is no tool named " + call.name + ".";
    call.done = true;
    return nullptr;
  }
  const std::string message = trim(call.message);
  if (message.empty()) {
    call.result = ask_bot::kSayWhat;
    call.done = true;
    return nullptr;
  }
  call.before = last_reply_;
  call.deadline = Clock::now() + milliseconds(kToolMs);
  // With the chat's history recorded, the words run on the person's own spoken line (VOICE.md, "Spoken
  // messages in chat history"), which takes the app's `send` and its voiceId: `link.gadget.say` has none.
  const std::string voice = claim(message);
  const std::string chat = chat_id_, id = call.id;
  return [this, chat, message, voice, id](Link& link) {
    Link::Result result = voice.empty() ? link.call("link.gadget.say", args(Json::object().set("text", message)), 30000)
                                        : link.call("send", Json::array().push(chat).push(message).push(Json::object().set("voiceId", voice)), 30000);
    std::lock_guard<std::mutex> lock(m_);
    for (auto& batch : batches_)
      for (Call& call : batch)
        if (call.id == id && call.started && !call.done) {
          if (result.ok()) call.sent = true;
          else {
            call.result = "The message didn't reach the bot: " + (result.error == Link::Error::Remote && !result.message.empty() ? result.message : std::string("your computer didn't answer."));
            call.done = true;
          }
        }
    wake_.notify_all();
  };
}

/** Whether the bot answered a call whose words were sent: a new reply once the turn is over, or a request. */
void LiveVoice::check_call(Call& call, Clock::time_point now) {
  if (call.sent) {
    const LivePart& part = part_;
    if (part.phase == "request") {
      call.result = ask_bot::kAnswerFirst;
      call.done = true;
      return;
    }
    const bool busy = part.phase == "working" || part.phase == "writing" || part.queued > 0;
    const bool replied = !part.reply_id.empty() && part.reply_id != call.before;
    if (busy) {
      call.seen_busy = true;
      call.settle = Clock::time_point();
    } else if (replied || call.seen_busy) {
      // A moment of quiet first, in case another reply follows (a group chat).
      if (call.settle == Clock::time_point()) call.settle = now + milliseconds(kSettleMs);
      else if (now >= call.settle) {
        if (!replied) call.result = ask_bot::kNoReply;
        else {
          call.result = part.reply_text;
          // The computer cut a long reply for the gadget ("…" at 2,000 characters): the voice says the rest is in the chat.
          const std::string ellipsis = "\xE2\x80\xA6";
          if (utf16_units(call.result) >= 1990 && call.result.size() >= 3 && call.result.compare(call.result.size() - 3, 3, ellipsis) == 0) call.result += ask_bot::kCutNote;
          if (trim(call.result).empty()) call.result = ask_bot::kNoReply;
        }
        call.done = true;
        return;
      }
    }
  }
  if (now > call.deadline && call.deadline != Clock::time_point()) {
    call.result = ask_bot::kStillWorking;
    call.done = true;
  }
}

// ── The transcript, and the chat's copy of it ───────────────────────────────────────────────────
// gemini.ts makes the lines ("you-N" for the person's turn, "bot-N" for the voice's); useLiveSession.ts
// and session.ts say how they are kept in the chat; VoiceTurns (mobile/link-host/voice-history.mjs) ties
// the person's line, the ask_bot request and the voice's answer together by id.

void LiveVoice::heard(const std::string& text, bool done, std::vector<std::function<void(View&)>>& edits) {
  if (!text.empty()) {
    if (!you_open_) {
      you_turn_++;
      you_open_ = true;
      you_text_.clear();
    }
    you_text_ += text;
    const std::string shown = trim(you_text_);
    edits.push_back([shown](View& view) { view.heard = shown; });
  } else if (!done || !you_open_) return;
  const std::string item = "you-" + std::to_string(you_turn_);
  if (turns_) {
    // VoiceTurns.input: a request that came before its words keeps the id it was given.
    const std::string key = "input-" + item;
    std::string id;
    auto known = inputs_.find(key);
    if (known != inputs_.end()) id = known->second;
    else {
      const bool reserved = !awaiting_.empty();
      id = reserved ? awaiting_.front() : session_id_ + ":" + key;
      if (reserved) awaiting_.pop_front();
      inputs_[key] = id;
      if (!reserved) current_ = id;
    }
    put(Line{id, you_text_, "", done, false, "", ""});
  } else if (history_) {
    last_speech_ = session_id_ + ":" + item;
    last_speech_text_ = you_text_;
    put(Line{last_speech_, you_text_, "", done, false, "", ""});
  }
  if (done) {
    you_open_ = false;
    you_text_.clear();
  }
}

void LiveVoice::said(const std::string& text, bool done, std::vector<std::function<void(View&)>>& edits) {
  if (!text.empty()) {
    if (!bot_open_) {
      bot_line_++;
      bot_open_ = true;
      bot_text_.clear();
    }
    bot_text_ += text;
    const std::string shown = trim(bot_text_);
    edits.push_back([shown](View& view) { view.text = shown; });
  } else if (!done || !bot_open_) return;
  if (turns_) {
    // VoiceTurns.output: the voice's line answers the person's line that was current when it began.
    const std::string item = "bot-" + std::to_string(bot_line_);
    auto known = outputs_.find(item);
    if (known == outputs_.end()) known = outputs_.emplace(item, current_).first;
    put(Line{session_id_ + ":output-" + item, bot_text_, known->second, done, true, "", ""});
    if (done && known->second == current_) answered_ = current_;
  }
  if (done) bot_open_ = false;
}

/** The lines still open, kept as they are (the session ends). */
void LiveVoice::close_lines() {
  std::vector<std::function<void(View&)>> unused;
  heard("", true, unused);
  said("", true, unused);
}

/** The voice id an ask_bot request runs on: the person's line it answers, or none. */
std::string LiveVoice::claim(const std::string& message) {
  if (turns_ && !session_id_.empty()) {
    // VoiceTurns.claim: a request after the line was answered, or a second one, belongs to words still to come.
    const bool previous_answer = !current_.empty() && current_ == answered_;
    if (current_.empty() || current_ == claimed_ || previous_answer) {
      current_ = session_id_ + ":request-" + std::to_string(++sequence_);
      awaiting_.push_back(current_);
    }
    claimed_ = current_;
    return current_;
  }
  // Only the person's line (voice-history-v1): when the request is the same words.
  if (!history_ || last_speech_.empty() || last_speech_ == last_claimed_ || trim(last_speech_text_) != trim(message)) return "";
  last_claimed_ = last_speech_;
  return last_claimed_;
}

/** Keeps the newest text of a line for the chat, and writes them one at a time on the gadget's worker (history.ts). */
void LiveVoice::put(Line line) {
  if (trim(line.text).empty() || chat_id_.empty() || session_id_.empty()) return;
  line.chat = chat_id_;
  line.session = session_id_;
  auto same = std::find_if(lines_.begin(), lines_.end(), [&line](const Line& held) { return held.id == line.id; });
  if (same != lines_.end()) *same = std::move(line);
  else lines_.push_back(std::move(line));
  if (writing_) return;
  writing_ = true;
  hooks_.post([this](Link& link) { write_lines(link); });
}

void LiveVoice::write_lines(Link& link) {
  for (;;) {
    Line line;
    {
      std::lock_guard<std::mutex> lock(m_);
      if (lines_.empty()) {
        writing_ = false;
        return;
      }
      line = std::move(lines_.front());
      lines_.erase(lines_.begin());
    }
    Json call = Json::array().push(line.chat).push(line.id).push(line.text).push(line.final);
    // The voice's own line names its session, and the person's line it answers: the link checks both.
    if (line.bot) {
      Json options = Json::object().set("role", "assistant").set("sessionId", line.session);
      if (!line.after.empty()) options.set("afterVoiceId", line.after);
      call.push(std::move(options));
    }
    // A final line is tried twice: the same id is safe to write again.
    if (!link.call("recordVoiceLine", call, 15000).ok() && line.final) link.call("recordVoiceLine", call, 15000);
  }
}

}  // namespace botkins
