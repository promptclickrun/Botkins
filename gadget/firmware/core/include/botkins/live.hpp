// Live voice on a gadget, push to talk: the gadget opens a session with the computer's live provider
// itself and streams sound both ways, as the phone's "Live voice" does (mobile/src/features/voice/live,
// gemini.ts the closest). The provider's voice speaks for the bot and hands real work to the bot through
// its one tool, `ask_bot`, which the gadget runs by sending the words to its chat and waiting for the
// reply. gadget/docs/contract.md ("Live voice") has every rule.
//
// The Gadget runs this itself when its part names a live voice it speaks (`voice.live`, Gemini for now)
// and the board can open a WebSocket (`Board::socket`); a port changes nothing.
#pragma once
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "botkins/gadget.hpp"

namespace botkins {

/** Changes the rate of 16-bit mono sound a piece at a time, so the pieces join with no click. */
class Resampler {
 public:
  Resampler(int from = 16000, int to = 16000) : from_(from), to_(to) {}
  /** Starts over at these rates. */
  void reset(int from, int to);
  /** Appends `count` samples at `from`, made into `to`, to `out`. The last sample or two wait for the next piece. */
  void push(const int16_t* in, size_t count, std::vector<int16_t>& out);

 private:
  int from_, to_;
  std::vector<int16_t> held_;  // the input not used up yet; held_[0] is input sample `base_`
  uint64_t base_ = 0, made_ = 0;
};

/**
 * Samples waiting, taken from the front a piece at a time. One buffer that is not moved for each piece
 * taken (on a board a large one is in PSRAM: allocations over 16 KB go there).
 */
class SampleQueue {
 public:
  size_t size() const { return data_.size() - at_; }
  bool empty() const { return at_ == data_.size(); }
  void clear() {
    data_.clear();
    at_ = 0;
  }
  void append(const int16_t* samples, size_t count) { data_.insert(data_.end(), samples, samples + count); }
  /** Takes up to `count` samples from the front into `out`. */
  void take(size_t count, std::vector<int16_t>& out);
  /** Lets go of up to `count` samples from the front. */
  void drop(size_t count);
  /** Everything waiting, taken out. */
  std::vector<int16_t> take_all();

 private:
  std::vector<int16_t> data_;
  size_t at_ = 0;
};

/** One thing a live provider said, read off its socket. */
struct LiveEvent {
  enum class Kind {
    Ready,        // the session is set up: sound may go
    Audio,        // the bot's voice: `audio`, at the protocol's output rate
    Heard,        // more of the person's words (`text`)
    HeardDone,    // the person's words are whole
    Said,         // more of what the voice says (`text`)
    SaidDone,
    Interrupted,  // the voice stopped: drop what it sent and was not played
    TurnDone,     // the voice's turn is over
    Tool,         // a tool call: `id`, `name`, `args`
    ToolCancel,   // the call `id` is no longer wanted
    GoAway,       // the provider will end the session soon
  };
  Kind kind;
  std::string text, id, name;
  Json args;
  std::vector<int16_t> audio;
};

/** A tool's answer, for the provider. */
struct LiveAnswer {
  std::string id, name, result;
};

/**
 * One provider's wire: what the gadget sends on the socket and what it reads there. The session
 * runner (LiveVoice) is the same for every provider; only this differs.
 */
class LiveProtocol {
 public:
  virtual ~LiveProtocol() = default;
  /** Where the socket goes, and its subprotocol ("" for none). */
  std::string url, subprotocol;
  /** The sample rates the provider takes and sends. */
  int input_rate = 16000, output_rate = 24000;
  /** The first message, sent as the socket opens. */
  virtual std::string hello() = 0;
  /** Push to talk: the person's turn starts and ends. */
  virtual std::string start_turn() = 0;
  virtual std::string end_turn() = 0;
  /** A piece of the person's turn, at `input_rate`. */
  virtual std::string audio(const int16_t* samples, size_t count) = 0;
  /** The answers to one batch of tool calls. */
  virtual std::string answers(const std::vector<LiveAnswer>& answers) = 0;
  /** Reads one whole message from the provider. */
  virtual void read(const uint8_t* data, size_t size, std::vector<LiveEvent>& out) = 0;
};

/**
 * The protocol for what `link.voice.live` answered, or null for a kind this core does not speak.
 * Built: `gemini-ws`. Not yet: `openai-ws`, `elevenlabs-ws` (and Codex, which is WebRTC only).
 */
std::unique_ptr<LiveProtocol> live_protocol(Json session);

/** What live voice needs of the gadget part (and `meta`), handed over at each look. */
struct LivePart {
  std::string provider;  // voice.live: "gemini", …; "" for none
  std::string bot_id, chat_id;
  std::string phase = "idle";  // "idle", "working", "writing", "request"
  int queued = 0;
  std::string reply_id, reply_text;
  /** The computer records spoken lines in the chat: `voice-history-v1`, and `voice-turns-v1` for the bot's too. */
  bool history = false, turns = false;
};

/** The ask_bot answers: the same sentences as the phone's (askBot.ts), for a gadget. */
namespace ask_bot {
inline const char* const kName = "ask_bot";
inline const char* const kCutNote = " (The reply was cut here. The rest is in the chat.)";
// A request shows on the gadget, and is answered there.
inline const char* const kAnswerFirst = "The bot needs the person to answer something first. It is on the gadget's screen: ask them to answer it there, then ask again.";
inline const char* const kStillWorking = "The bot is still working on it. Tell the person the answer will be in the chat.";
inline const char* const kNoReply = "The bot finished without a written reply.";
inline const char* const kSayWhat = "Say what to ask the bot.";
}  // namespace ask_bot

/**
 * Live voice: one session at a time with the live provider, opened at the first press and closed after
 * `Board::live_idle_ms` with no press and no sound. Threads: the gadget's (press, release, the part),
 * the board's audio thread (`feed`), the socket's own (what the provider sends), and one of its own
 * while a session opens or is open (the microphone out, the speaker, the tools, the time).
 */
class LiveVoice {
 public:
  struct Hooks {
    /** The link now; null when there is none. */
    std::function<std::shared_ptr<Link>()> link;
    /** Runs a job beside the gadget's other calls (its worker thread). */
    std::function<void(std::function<void(Link&)>)> post;
    /** Changes what is on show. */
    std::function<void(const std::function<void(View&)>&)> change;
    /**
     * The session could not open in time: the press's sound goes the turn path. From the live thread,
     * holding no lock; the gadget takes the sound back with `surrender()`.
     */
    std::function<void()> failed;
  };
  LiveVoice(const Board& board, Hooks hooks);
  ~LiveVoice();

  /** What the part says now (the sync thread). A chat or a bot that changed under an open session ends it. */
  void part(const LivePart& part);
  /** Whether a press now goes live: the part names a voice this core speaks, the board has a socket and a speaker, and it hasn't just failed. */
  bool usable();
  /** A session is opening or open: the bot's replies are its to speak, not to be read aloud. */
  bool active();

  /**
   * The talk button. The press's sound is kept until the session is open and the microphone has heard
   * speech; then the person's turn starts on the provider and the sound goes. A press with no speech in
   * it sends nothing: a speech model given silence or a tap makes up a word ("¿Qué?") and answers it.
   */
  void press();
  /** Samples at `Board::mic_rate`, while pressed (the gadget calls it with its own audio lock held). */
  void feed(const int16_t* samples, size_t count);
  /** The button is up. `keep` false (a tap): the press is given up, unless its turn already reached the provider. */
  void release(bool keep = true);
  /** After `failed`: the press's sound, given back (with the gadget's audio lock held). */
  std::vector<int16_t> surrender();
  /** Stops what the voice says now; the rest of its turn is dropped. */
  void quiet();
  /** Ends the session (another chat or bot). The next press opens a new one. */
  void end();
  /** Ends the session and its thread, for good. */
  void stop();

 private:
  using Clock = std::chrono::steady_clock;
  enum class State { Closed, Opening, Open, Closing };
  struct Call {
    std::string id, name, message;
    bool started = false, sent = false, seen_busy = false;
    std::string before;  // the part's reply when the call came
    std::string result;  // set once answered
    bool done = false;
    Clock::time_point settle{}, deadline{};
  };
  struct Line {
    std::string id, text, after;
    bool final = false, bot = false;
    std::string chat, session;  // where it goes: filled in by put()
  };

  void run();
  void join_ended();
  bool open_session();
  void serve(std::unique_lock<std::mutex>& lock);
  void close_session();
  void received(const uint8_t* data, size_t size);
  bool step_tools(std::unique_lock<std::mutex>& lock, Clock::time_point now);
  std::function<void(Link&)> start_call(Call& call);
  void check_call(Call& call, Clock::time_point now);
  // The transcript, and the chat's copy of it (history.ts and useLiveSession.ts). Called with m_ held.
  void heard(const std::string& text, bool done, std::vector<std::function<void(View&)>>& edits);
  void said(const std::string& text, bool done, std::vector<std::function<void(View&)>>& edits);
  void close_lines();
  void put(Line line);
  void write_lines(Link& link);
  std::string claim(const std::string& message);

  Board board_;
  Hooks hooks_;
  int open_ms_ = 6000;

  std::mutex m_;  // guards everything below
  std::condition_variable wake_;
  std::thread thread_;
  bool running_ = false, want_ = false, stopping_ = false;
  State state_ = State::Closed;
  LivePart part_;
  std::string part_chat_seen_, part_bot_seen_;
  std::string last_reply_;  // the newest reply any look named: a look from before can't pass for a new one
  Clock::time_point backoff_until_{};

  // The session.
  std::unique_ptr<Socket> socket_;
  std::unique_ptr<LiveProtocol> proto_;
  std::string session_id_, chat_id_, bot_id_;
  bool history_ = false, turns_ = false;  // what the computer keeps of the talk, fixed when the session opens
  bool ready_ = false, closed_ = false, going_ = false;
  bool close_ = false;     // asked to end: another chat or bot, or the gadget stopping
  bool shutting_ = false;  // closing: nothing more is taken from the provider
  Clock::time_point active_at_{};  // the last press, sound or tool

  // The person's turn. `start_pending_`: a press whose turn hasn't started on the provider yet, which it
  // does once `speech_` (the microphone heard speech in this press).
  bool held_ = false, start_pending_ = false, release_pending_ = false, turn_open_ = false;
  bool speech_ = false;
  // How loud the press was, in frames of 20 ms (their RMS, 0 to 1): for the speech test, and for the log.
  double frame_sum_ = 0;
  size_t frame_count_ = 0;
  int loud_run_ = 0, loud_frames_ = 0;
  double press_peak_ = 0, press_floor_ = 1;
  Clock::time_point press_at_{};
  void hear(const int16_t* samples, size_t count);
  std::string press_summary(Clock::time_point now) const;
  SampleQueue mic_;  // at the microphone's rate, not sent yet
  Resampler mic_rate_;

  // The bot's voice, at the speaker's rate.
  SampleQueue play_;
  Resampler out_rate_;  // the socket thread's own
  bool playing_ = false, generating_ = false, cutting_ = false, turn_done_ = false, cut_now_ = false;
  Clock::time_point played_at_{};

  // Tool calls, a batch at a time.
  std::deque<std::vector<Call>> batches_;
  std::vector<std::string> cancelled_;

  // The transcript as it comes (gemini.ts) and as the chat keeps it (VoiceTurns in voice-history.mjs).
  int you_turn_ = 0, bot_line_ = 0;
  bool you_open_ = false, bot_open_ = false;
  std::string you_text_, bot_text_;
  std::map<std::string, std::string> inputs_;  // input item → its voice id
  std::map<std::string, std::string> outputs_;  // output item → the input it answers
  std::deque<std::string> awaiting_;
  std::string current_, claimed_, answered_;
  std::string last_speech_, last_speech_text_, last_claimed_;  // voice-history-v1 alone: the person's last line
  int sequence_ = 0;
  std::vector<Line> lines_;  // waiting to be written, the newest text of each
  bool writing_ = false;
};

}  // namespace botkins
