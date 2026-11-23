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
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "botkins/hal.hpp"
#include "botkins/link.hpp"

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
};

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
  bool can_hear = false, can_speak = false;
  struct Request {
    std::string id, kind, title, preview;
    std::vector<std::string> choices;
    bool remember = false;
  } request;
  /** Goes up with every change. */
  uint32_t revision = 0;
};

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
  void read_aloud(Link& link, const std::string& reply, int parts, uint32_t quiet);
  bool wait(int ms);

  Board board_;
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

  // What the sync thread holds of the computer's state. Its own: no lock.
  Json have_ = Json::object();
  std::string epoch_, chat_id_, text_id_, stream_, last_reply_;
  size_t stream_units_ = 0, thinking_units_ = 0;
  bool greeted_ = false, first_part_ = true;
  std::string unreachable_;  // the sentence on show about not reaching the computer, while it is
  std::vector<std::pair<std::string, std::string>> bots_;
  std::string bot_id_;

  // The recording being sent. Guarded by audio_.
  std::mutex audio_;
  std::vector<int16_t> pending_;
  std::string take_, failed_take_;
  bool recording_ = false, uploading_ = false;
  uint32_t takes_ = 0;
  /** Goes up each time the person asks for quiet: a reply being read, or waiting to be, stops when it has moved on. */
  std::atomic<uint32_t> quiet_{0};
  std::thread hold_thread_;  // the console's "listen": a finger on the button for a while
};

}  // namespace botkins
