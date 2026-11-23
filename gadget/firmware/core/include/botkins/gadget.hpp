// A gadget: the whole of what one does, with no board in it. A port makes one `Gadget`, gives it
// the board (`Board`), calls `begin()`, then tells it what the person does (a button held, samples
// from the microphone, a line on the USB port) and draws `view()` whenever `on_change` fires.
//
//   botkins::Gadget gadget(board);
//   gadget.on_change = [] { redraw(); };
//   gadget.begin();
//   // button down:  gadget.start_listening();   microphone:  gadget.feed(samples, count);
//   // button up:    gadget.stop_listening();
//
// Setup (Wi-Fi and the introduction to a computer) arrives as lines on the USB port: hand each line
// to `console()` and print what it returns. gadget/docs/contract.md has every rule.
#pragma once
#include <atomic>
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

#include "botkins/hal.hpp"
#include "botkins/link.hpp"
#include "botkins/relay.hpp"

namespace botkins {

/** The board, as the core needs it. */
struct Board {
  Transport* transport = nullptr;
  Storage* storage = nullptr;
  Network* network = nullptr;
  /** Null on a board with no speaker: replies are shown, not read. */
  Speaker* speaker = nullptr;
  /** Short labels for the device list ("esp32-s3-box-3", "0.1.0"). */
  std::string name = "gadget";
  std::string firmware = "0";
  /** For the person to tell two gadgets apart during setup. */
  std::string mac;
  /** The speaker's and the microphone's sample rates: 8000, 16000, 22050, 24000, 32000, 44100 or 48000. */
  int speaker_rate = 16000;
  int mic_rate = 16000;
  /** Samples fetched for one call when a reply is read, in bytes. Smaller on a board with little memory. */
  int slice_bytes = 16000;
  int screen_width = 0, screen_height = 0;
  bool screen_round = false;
  /** Restarts the board, when the owner asks for it from the Botkins app. Null: a restart is refused. */
  std::function<void()> restart;
  /**
   * Makes a WebSocket (hal.hpp), for reaching the computer through its relay when none of its own
   * addresses answers. Null on a board without one: the relay's entry is skipped.
   */
  std::function<std::unique_ptr<Socket>()> socket;
  /** While on the relay, how soon the computer's own addresses are asked again; it doubles each time, to 10 minutes. */
  int relay_probe_ms = 30000;
  /** A live voice session closes after this long with no press and no sound (botkins/live.hpp). */
  int live_idle_ms = 180000;
};

/** The poses a gadget's Botkin takes. The computer draws each from the bot's own look. */
inline const char* const kPoses[] = {"ready", "listening", "working", "speaking", "needs", "waiting", "sleepy"};

/** Everything a board draws. Copied out whole, so a port never holds a lock while it draws. */
struct View {
  enum class Stage {
    Setup,       // no introduction yet: waiting for setup on the USB port
    Joining,     // joining the Wi-Fi network
    NoNetwork,   // the network refused or is gone
    Connecting,  // looking for the computer
    Online,
    Removed,     // the computer says it no longer knows this gadget: set it up again
  };
  Stage stage = Stage::Setup;
  std::string name;      // the gadget's own name, as the computer has it
  std::string computer;  // the computer's name
  std::string bot;       // who it talks with
  std::string phase = "idle";  // "idle", "working", "writing", "request" (the gadget's part)
  std::string doing;     // while working: what the bot is doing
  std::string text;      // the reply: as it is written, then whole
  std::string heard;     // what the computer made of the last recording
  std::string notice;    // one sentence for the person when something failed
  bool listening = false;
  bool sending = false;
  bool speaking = false;
  /** A live voice session is open: the talk button talks with the bot's live voice (botkins/live.hpp). */
  bool live = false;
  bool can_hear = false, can_speak = false;
  struct Request {
    std::string id, kind, title, preview;
    std::vector<std::string> choices;
    bool remember = false;
  } request;
  /** What the gadget's owner set for it. The computer keeps them and the gadget keeps a copy, so it starts with them. */
  struct Settings {
    int volume = 60;             // 0 to 100
    std::string mic = "normal";  // "low", "normal" or "high"
    bool mute = false;           // the microphone is off: holding talk says so
    int brightness = 80;         // 5 to 100
    int dim_after = 30;          // seconds idle before the screen dims; 0: never
    int off_after = 300;         // seconds idle before it goes dark; 0: never
  } settings;
  /** While a turn works: how many steps it has taken. The halo's arc grows with it. */
  int steps = 0;
  /**
   * The bot's Botkin, as SVG text (a 256 by 256 view box, nothing that moves), for each pose of
   * kPoses that has arrived. `look` names the set: it changes when the bot or its look does.
   */
  std::string look;
  std::shared_ptr<const std::map<std::string, std::string>> faces;
  /** The Wi-Fi network in use, when there is one. */
  std::string network;
  /** Goes up with every change. */
  uint32_t revision = 0;
};

/** The Botkin's pose for what is on show (a board shows "sleepy" itself while the screen is dimmed). */
inline const char* pose_for(const View& view) {
  if (view.stage != View::Stage::Online) return view.stage == View::Stage::Setup ? "ready" : "waiting";
  if (view.listening) return "listening";
  if (!view.request.id.empty()) return "needs";
  if (view.speaking) return "speaking";
  if (view.sending || view.phase == "working" || view.phase == "writing") return "working";
  return "ready";
}

class LiveVoice;
struct LivePart;

class Gadget {
 public:
  explicit Gadget(Board board);
  ~Gadget();
  void begin();
  void stop();

  View view();
  /** Called after the view changed, from one of the core's threads. Keep it short: set a flag, wake the display. */
  std::function<void()> on_change;

  // What the person does.
  void say(const std::string& text);
  void start_listening();
  /** Samples from the microphone at `Board::mic_rate`. Ignored unless listening. Safe from an audio thread. */
  void feed(const int16_t* samples, size_t count);
  /** `send` false gives the recording up. */
  void stop_listening(bool send = true);
  void stop_speaking();
  /** Answers the request on show: "approve", "remember", "deny", "cancel", or "answer" with `value`. */
  void answer(const std::string& action, const std::string& value = "");
  /** Stops the turn under way. */
  void stop_turn();
  void new_chat();
  /** The next bot on show, in the computer's order. */
  void next_bot();
  /**
   * Changes settings here at once and on the computer: an object with any of "volume", "mic",
   * "mute", "brightness", "dimAfter", "offAfter" (the part's names). Kept if the computer is away.
   */
  void change_settings(const Json& patch);

  /**
   * One line from the USB port. Returns the line to print, or "" when the line was not for the
   * gadget (it did not start with "@botkins "). Never holds a secret.
   */
  std::string console(const std::string& line);
  /** The gadget's public key as text: what an introducer hands to the computer. */
  std::string public_key() const;

 private:
  using Job = std::function<void(Link&)>;
  void sync_loop();
  void work_loop();
  void post(Job job);
  void apply(Json& parts);
  void apply_text(const Json& delta);
  void change(const std::function<void(View&)>& edit);
  void notice(const std::string& sentence);
  void fail(const Link::Result& result);
  std::shared_ptr<Link> link(uint32_t* generation = nullptr);
  void adopt(const Introduction& introduction);
  void forget_link();
  void upload(Link& link, const std::string& take, std::vector<int16_t> rest, bool last, bool cancel);
  void apply_settings(const Json& part);
  void send_settings();
  void ensure_faces();
  void fetch_face(Link& link, const std::string& look);
  void apply_wifi(Link& link, const std::vector<Json>& changes);
  void load_networks();
  void save_networks();
  Json wifi_report();
  void read_aloud(Link& link, const std::string& reply, int parts, uint32_t quiet);
  void live_failed();
  bool wait(int ms);

  Board board_;
  /** The board's transport with the relay in front of it, when the board can open a WebSocket. Outlives every Link. */
  std::unique_ptr<RelayTransport> relay_;
  KeyPair keys_{};
  std::atomic<bool> running_{false};
  std::thread sync_thread_, work_thread_;

  std::mutex mutex_;  // guards everything below except where noted
  std::condition_variable wake_;
  View view_;
  Introduction intro_;
  std::shared_ptr<Link> link_;
  uint32_t generation_ = 0;  // goes up when the introduction changes
  std::deque<Job> jobs_;
  std::string face_look_;  // the set of faces the computer names; fetched one pose at a time
  bool fetching_face_ = false;
  Json settings_unsent_ = Json::object();  // changed on the gadget, not yet taken by the computer
  int settings_sending_ = 0;
  std::vector<std::pair<std::string, std::string>> networks_;  // saved Wi-Fi networks, most recent first
  size_t network_at_ = 0;  // the one being joined
  std::atomic<bool> report_wifi_{false};

  // What the sync thread holds of the computer's state. Its own: no lock.
  Json have_ = Json::object();
  std::string epoch_, chat_id_, text_id_, stream_, last_reply_;
  size_t stream_units_ = 0, thinking_units_ = 0;
  bool greeted_ = false, first_part_ = true;
  std::string unreachable_;  // the sentence on show about not reaching the computer, while it is
  std::string restart_seen_;  // the restart the owner asked for, once it was taken
  std::vector<std::string> wifi_taken_;  // Wi-Fi changes taken, until the computer stops sending them
  std::chrono::steady_clock::time_point switched_at_{};  // when another saved network was last tried
  std::vector<std::pair<std::string, std::string>> bots_;
  std::string bot_id_;
  bool saves_history_ = false, saves_turns_ = false;  // the computer keeps spoken lines in the chat (meta.capabilities)

  // The recording being sent. Guarded by audio_.
  std::mutex audio_;
  std::vector<int16_t> pending_;
  std::string take_, failed_take_;
  bool recording_ = false, uploading_ = false;
  bool live_take_ = false;  // this press went to live voice; given back when its session couldn't open
  uint32_t takes_ = 0;
  /** Goes up each time the person asks for quiet: a reply being read, or waiting to be, stops when it has moved on. */
  std::atomic<uint32_t> quiet_{0};
  std::thread hold_thread_;  // the console's "listen": a finger on the button for a while
  /** Live voice, on a board with a socket and a speaker. Last, so it goes first: it uses the board and the hooks above. */
  std::unique_ptr<LiveVoice> live_;
};

}  // namespace botkins
