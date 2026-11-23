// The M5Stack StopWatch (SKU C152): ESP32-S3R8 (16 MB flash, 8 MB octal PSRAM), a round 1.75"
// 466x466 CO5300 AMOLED with a CST820 touch controller, one ES8311 for the speaker and the
// microphone, an M5PM1 power manager and an M5IOE1 I/O expander, a blue, a yellow and a red key.
//
// Pins (I2C SDA 47 / SCL 48; the blue key on GPIO 1, the yellow on GPIO 2, both active low; the
// touch controller at 0x15 and the red key read through the M5PM1) are hardware facts as the
// Hermes Gadget firmware has them for this board (firmware/esp32/main/board.cpp, MIT).
// Not used here: the touch INT line (GPIO 13), the BMI270, the RX8130 clock, the vibration motor.
//
// The blue key talks: held, it listens; let go, it sends (a press under 300 ms is given up). A
// press while it speaks stops the speaking. The yellow key approves a request on show (held for
// most of a second, it denies it), and otherwise starts a new chat. A tap on the home screen opens
// the quick controls (core/src/home.cpp), which the touch screen works; they close by themselves
// after 8 s without a touch, and the blue key closes them before it talks. The red key only wakes
// the screen: it is the StopWatch's power key, and its M5PM1 powers the board off on a double click,
// so a control that asks to be pressed twice quickly must never be on it.
#include <atomic>
#include <cstring>
#include <set>
#include <string>

#include "audio.hpp"
#include "display.hpp"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "gadget_port/board.hpp"
#include "screen.hpp"
#include "stopwatch_power.hpp"
#include "touch.hpp"

namespace board {
namespace {
const char* TAG = "stopwatch";
constexpr int kSda = 47, kScl = 48;
constexpr int kBlue = 1, kYellow = 2;
constexpr int kPollMs = 10, kDebouncePolls = 3;  // the Hermes firmware's key debounce: 3 polls of ~10 ms
constexpr int kRedEvery = 10;                     // the red key is read every 10th poll: 100 ms
constexpr int kTouchEvery = 2;                    // the touch controller every 2nd: 20 ms
constexpr int64_t kShortestTalkMs = 300, kDenyHoldMs = 800;
// Redraws come at most this often: a reply that streams in changes the view many times a second.
constexpr int kRedrawMs = 150;
constexpr int64_t kPanelCloseMs = 8000;  // the quick controls close after this long without a touch

i2c_master_bus_handle_t g_bus = nullptr;
stopwatch::Power g_power;
stopwatch::Display g_display;
stopwatch::Audio g_audio;
stopwatch::Touch g_touch;
stopwatch::Screen g_screen;
bool g_power_ok = false, g_display_ok = false, g_audio_ok = false, g_touch_ok = false;
botkins::Gadget* g_gadget = nullptr;
TaskHandle_t g_draw_task = nullptr;
// Held while the frame is drawn, and while the console copies it out.
SemaphoreHandle_t g_frame_lock = nullptr;
std::string g_kind = "boot";  // what the frame shows (under g_frame_lock)

int64_t now_ms() { return esp_timer_get_time() / 1000; }

// ── What the person did lately ──────────────────────────────────────────────────────────────────
std::atomic<int64_t> g_activity_at{0};   // a key or a touch: the screen lights up
std::atomic<bool> g_panel_open{false};   // the quick controls are on show
std::atomic<int64_t> g_panel_at{0};      // when they opened, or were last touched
enum class Light { Bright, Dim, Dark };
const char* const kLightNames[] = {"bright", "dim", "dark"};
std::atomic<int> g_light{(int)Light::Bright};  // the draw task's; read by the touch path

void wake_draw() {
  if (g_draw_task) xTaskNotifyGive(g_draw_task);
}
void activity() {
  g_activity_at = now_ms();
  wake_draw();
}
void set_panel(bool open, const char* why) {
  if (g_panel_open.exchange(open) == open) return;
  g_panel_at = now_ms();
  ESP_LOGI(TAG, "quick controls %s (%s)", open ? "open" : "closed", why);
  wake_draw();
}

// ── The settings, applied ───────────────────────────────────────────────────────────────────────
int mic_db(const std::string& mic) { return mic == "low" ? 18 : mic == "high" ? 30 : 24; }  // the ES8311's 6 dB steps

/** What the settings ask of the panel's brightness in each light. Dimmed: a fifth of it, at least 1. */
uint8_t panel_percent(const botkins::View::Settings& s, Light light) {
  const int bright = s.brightness < 1 ? 1 : s.brightness > 100 ? 100 : s.brightness;
  if (light == Light::Dark) return 0;
  return (uint8_t)(light == Light::Bright ? bright : (bright / 5 > 1 ? bright / 5 : 1));
}

// ── The screen, and how bright it is ────────────────────────────────────────────────────────────
// An AMOLED left showing the same thing burns in. Online and idle (not listening, sending, working,
// writing or speaking, no request on show), with nothing changed, no key pressed and no touch: after
// the settings' dimAfter seconds it dims (the sleepy Botkin, faint), after offAfter seconds (counted
// from the last activity) its output goes off; 0 is never. A view that changes, a key or a touch
// brings it back at once; a key still does its own job, a touch on a dim screen only wakes it.
// Only the panel's brightness (0x51) and display on/off (0x29/0x28) commands are used.
Light g_shown_light = Light::Bright;  // the draw task's own
uint8_t g_panel_percent = 100;       // what the panel was last told (kInit leaves it at 0xFF)

/** The draw task's only way to change the panel's light, with one log line for each change. */
void set_light(Light next, const botkins::View::Settings& s, const char* why) {
  const uint8_t percent = panel_percent(s, next);
  if (next == g_shown_light && (next == Light::Dark || percent == g_panel_percent)) return;
  bool ok = true;
  if (next == Light::Dark) {
    ok = g_display.brightness(0) && g_display.output(false);
  } else {
    if (g_shown_light == Light::Dark) ok = g_display.output(true);
    ok = g_display.brightness(percent) && ok;
  }
  g_panel_percent = percent;
  if (next != g_shown_light)
    ESP_LOGI(TAG, "screen %s -> %s at %u%% (%s)%s", kLightNames[(int)g_shown_light], kLightNames[(int)next], (unsigned)percent, why, ok ? "" : ", panel command failed");
  else
    ESP_LOGI(TAG, "screen brightness %u%% (%s)%s", (unsigned)percent, why, ok ? "" : ", panel command failed");
  g_shown_light = next;
  g_light = (int)next;
}

bool idle(const botkins::View& view) {
  return view.stage == botkins::View::Stage::Online && !view.listening && !view.sending && !view.speaking && view.phase == "idle" && view.request.id.empty();
}

/** What the screen shows is the same (the revision goes up for changes that show nothing new). */
bool same(const botkins::View& a, const botkins::View& b) {
  const auto& s = a.settings;
  const auto& t = b.settings;
  return a.stage == b.stage && a.name == b.name && a.computer == b.computer && a.bot == b.bot && a.phase == b.phase && a.doing == b.doing && a.text == b.text &&
         a.heard == b.heard && a.notice == b.notice && a.listening == b.listening && a.sending == b.sending && a.speaking == b.speaking &&
         a.can_hear == b.can_hear && a.can_speak == b.can_speak && a.request.id == b.request.id && a.request.kind == b.request.kind &&
         a.request.title == b.request.title && a.request.preview == b.request.preview && a.request.choices == b.request.choices &&
         a.request.remember == b.request.remember && a.steps == b.steps && a.look == b.look && a.faces == b.faces && a.network == b.network &&
         s.volume == t.volume && s.mute == t.mute && s.brightness == t.brightness;
}

/** A name for what is on screen, for the log's timings and the console's frame. */
std::string kind_of(const botkins::View& view, stopwatch::Screen::Mode mode) {
  using Mode = stopwatch::Screen::Mode;
  if (mode == Mode::Quick) return view.settings.mute ? "quick-muted" : "quick";
  if (mode == Mode::Dimmed) return "dimmed";
  static const char* const stages[] = {"setup", "joining", "no-network", "connecting", "online", "removed"};
  if (view.stage != botkins::View::Stage::Online) return stages[(int)view.stage];
  const std::string pose = botkins::pose_for(view);
  if (pose != "ready") return pose;
  return pose + (view.settings.mute ? "-muted" : "") + (view.notice.empty() ? "" : "-notice");
}

/** Applies what changed in the settings to the codec, with one log line for each. The panel follows in set_light. */
void apply_settings(const botkins::View::Settings& s, botkins::View::Settings& applied, bool first) {
  if (first || s.volume != applied.volume) {
    g_audio.set_volume(s.volume);
    ESP_LOGI(TAG, "volume %d%s", s.volume, s.volume == 0 ? " (silent)" : "");
  }
  if (first || s.mic != applied.mic) {
    g_audio.set_mic_gain(mic_db(s.mic));
    ESP_LOGI(TAG, "microphone %s: %d dB", s.mic.c_str(), mic_db(s.mic));
  }
  if (first || s.mute != applied.mute) ESP_LOGI(TAG, "microphone %s", s.mute ? "muted" : "on");
  if (first || s.brightness != applied.brightness) ESP_LOGI(TAG, "brightness %d%%", s.brightness);
  if (first || s.dim_after != applied.dim_after || s.off_after != applied.off_after) {
    const std::string dim = s.dim_after > 0 ? std::to_string(s.dim_after) + " s" : "never";
    const std::string off = s.off_after > 0 ? std::to_string(s.off_after) + " s" : "never";
    ESP_LOGI(TAG, "screen dims after %s, goes dark after %s", dim.c_str(), off.c_str());
  }
  applied = s;
}

void draw_task(void*) {
  using Mode = stopwatch::Screen::Mode;
  botkins::View shown;
  botkins::View::Settings applied;
  Mode shown_mode = Mode::Home;
  bool drawn = false, settings_seen = false;
  int64_t active_at = now_ms(), activity_seen = 0;
  std::set<std::string> timed;  // the screen kinds whose draw and flush were logged (first and second draw)
  std::set<std::string> timed_again;
  int wait_ms = 1000;
  for (;;) {
    // Woken by a change, a key or a touch; otherwise once a second, to see whether it is time to dim.
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms));
    wait_ms = 1000;
    const botkins::View view = g_gadget->view();
    const botkins::View::Settings& s = view.settings;
    apply_settings(s, applied, !settings_seen);
    settings_seen = true;
    const int64_t now = now_ms();
    const int64_t act = g_activity_at;
    if (act != activity_seen) {
      activity_seen = act;
      active_at = now;
    }
    const bool changed = !drawn || !same(view, shown);
    if (changed || !idle(view)) active_at = now;

    // The quick controls close by themselves.
    if (g_panel_open) {
      const int64_t left = kPanelCloseMs - (now - g_panel_at);
      if (left <= 0) set_panel(false, "8 s without a touch");
      else if (left < wait_ms) wait_ms = (int)left;
    }

    const int64_t quiet = now - active_at;
    Light want = Light::Bright;
    const char* why = "activity";
    if (s.off_after > 0 && quiet >= (int64_t)s.off_after * 1000) want = Light::Dark, why = "offAfter";
    else if (s.dim_after > 0 && quiet >= (int64_t)s.dim_after * 1000) want = Light::Dim, why = "dimAfter";
    if (want != Light::Bright) set_panel(false, "the screen dims");
    const Mode mode = g_panel_open ? Mode::Quick : want == Light::Dim ? Mode::Dimmed : Mode::Home;

    if (want != Light::Dark && (changed || mode != shown_mode || !drawn)) {
      // Drawn first, then lit: a dark panel comes back with the new frame, not the old one.
      const std::string kind = kind_of(view, mode);
      const size_t faces_before = g_screen.face_memory();
      xSemaphoreTake(g_frame_lock, portMAX_DELAY);
      const int64_t t0 = esp_timer_get_time();
      g_screen.draw(view, mode);
      const int64_t t1 = esp_timer_get_time();
      g_kind = kind;
      xSemaphoreGive(g_frame_lock);
      g_display.flush();
      const int64_t t2 = esp_timer_get_time();
      const size_t faces_after = g_screen.face_memory();
      const bool first = timed.insert(kind).second;
      if (first || timed_again.insert(kind).second || faces_after != faces_before) {
        ESP_LOGI(TAG, "screen %s: draw %lld ms (%s%s), flush %lld ms; faces %u KB; draw stack left %u bytes", kind.c_str(), (long long)((t1 - t0) / 1000),
                 first ? "first" : "again", faces_after != faces_before ? ", faces drawn" : "", (long long)((t2 - t1) / 1000), (unsigned)(faces_after / 1024),
                 (unsigned)uxTaskGetStackHighWaterMark(nullptr));
      }
      shown = view;
      shown_mode = mode;
      drawn = true;
      set_light(want, s, changed ? "the view changed" : why);
      vTaskDelay(pdMS_TO_TICKS(kRedrawMs));
      // A change while this one was drawn left its notification: the loop draws it next.
      continue;
    }
    set_light(want, s, want == Light::Bright ? "brightness" : why);
    // Nothing waits (no change, no key, no touch): one screen of the bot's faces drawn ahead.
    if (drawn && want != Light::Dark && idle(view) && ulTaskNotifyValueClear(nullptr, 0) == 0) {
      xSemaphoreTake(g_frame_lock, portMAX_DELAY);
      const int64_t t0 = esp_timer_get_time();
      const bool did = g_screen.warm(shown, shown_mode);
      const int64_t ms = (esp_timer_get_time() - t0) / 1000;
      xSemaphoreGive(g_frame_lock);
      if (did) {
        if (ms > 300) ESP_LOGI(TAG, "a face drawn ahead in %lld ms; faces %u KB", (long long)ms, (unsigned)(g_screen.face_memory() / 1024));
        // The next one soon, after a pause: this core's idle task must run (the task watchdog
        // watches it), and one face can take 3 s.
        wait_ms = 50;
      }
    }
  }
}

// ── The keys and the touch screen ───────────────────────────────────────────────────────────────
enum KeyId { kKeyBlue, kKeyYellow, kKeyRed, kKeys };
// A press from the console (`@botkins {"do":"key"}`): the key reads as down until this time.
std::atomic<int64_t> g_forced_until[kKeys];

struct Key {
  int gpio;
  KeyId id;
  bool down = false;
  int stable = 0;
  int64_t since = 0;
  /** True once per change of the debounced level. */
  bool poll() {
    const bool level = gpio_get_level(static_cast<gpio_num_t>(gpio)) == 0 || now_ms() < g_forced_until[id];
    if (level == down) {
      stable = 0;
      return false;
    }
    if (++stable < kDebouncePolls) return false;
    stable = 0;
    down = level;
    since = now_ms();
    return true;
  }
};

/** A tap on the screen (the touch controller's, or the console's). */
void tap(int x, int y) {
  if ((Light)g_light.load() != Light::Bright) {
    ESP_LOGI(TAG, "tap at %d,%d: wakes the screen", x, y);
    activity();
    return;
  }
  if (!g_panel_open) {
    // A tap on the home screen opens the quick controls, unless a request waits on the keys or the gadget is busy listening.
    activity();
    const botkins::View view = g_gadget->view();
    const bool opens = view.stage == botkins::View::Stage::Online && view.request.id.empty() && !view.listening && !view.sending;
    ESP_LOGI(TAG, "tap at %d,%d: %s", x, y, opens ? "opens the quick controls" : "nothing there");
    if (opens) set_panel(true, "a tap");
    return;
  }
  activity();
  g_panel_at = now_ms();
  const botkins::QuickAction action = botkins::quick_hit(x, y, stopwatch::Display::kWidth, stopwatch::Display::kHeight);
  static const char* const names[] = {"none", "volume down", "volume up", "mute", "brightness", "new chat", "close"};
  ESP_LOGI(TAG, "tap at %d,%d: %s", x, y, names[(int)action]);
  using A = botkins::QuickAction;
  switch (action) {
    case A::None:
      return;
    case A::Close:
      set_panel(false, "Close");
      return;
    case A::NewChat:
      g_gadget->new_chat();
      set_panel(false, "New chat");
      return;
    default:
      break;
  }
  const botkins::View::Settings before = g_gadget->view().settings;
  const botkins::View::Settings after = botkins::quick_apply(action, before);
  botkins::Json patch = botkins::Json::object();
  if (after.volume != before.volume) patch.set("volume", after.volume);
  if (after.mute != before.mute) patch.set("mute", after.mute);
  if (after.brightness != before.brightness) patch.set("brightness", after.brightness);
  if (after.mic != before.mic) patch.set("mic", after.mic);
  if (patch.size() > 0) g_gadget->change_settings(patch);
  if (action == A::VolumeDown || action == A::VolumeUp) {
    // Heard at the new volume: set here, before the tick, as the draw task would a moment later.
    g_audio.set_volume(after.volume);
    g_audio.tick();
  }
}

void keys_task(void*) {
  Key blue{kBlue, kKeyBlue}, yellow{kYellow, kKeyYellow};
  bool talking = false;
  int64_t blue_down_at = 0, yellow_down_at = 0;
  bool forced_red_down = false;
  int forced_red_polls = 0;
  for (unsigned tick = 0;; tick++) {
    vTaskDelay(pdMS_TO_TICKS(kPollMs));
    if (blue.poll()) {
      if (blue.down) {
        activity();
        set_panel(false, "the blue key");
        blue_down_at = blue.since;
        const botkins::View view = g_gadget->view();
        if ((view.speaking || g_audio.playing()) && !view.live) {
          // A press while it reads a reply aloud only stops the reading. With live voice it is how the person
          // interrupts: the core cuts the voice and starts their turn (below).
          g_gadget->stop_speaking();
          g_audio.cut();
          talking = false;
        } else if (view.stage == botkins::View::Stage::Online) {
          g_gadget->start_listening();  // muted: the core says the microphone is off, and records nothing
          talking = true;
        }
      } else if (talking) {
        talking = false;
        // Both edges are debounced alike, so this is how long the key was held.
        const int64_t held = blue.since - blue_down_at;
        g_gadget->stop_listening(held >= kShortestTalkMs);
        if (held < kShortestTalkMs) ESP_LOGI(TAG, "a press of %lld ms is given up", (long long)held);
      }
    }
    if (yellow.poll()) {
      if (yellow.down) {
        activity();
        yellow_down_at = yellow.since;
      } else {
        const int64_t held = yellow.since - yellow_down_at;
        const botkins::View view = g_gadget->view();
        if (view.stage == botkins::View::Stage::Online) {
          if (!view.request.id.empty()) {
            // A question or a form is answered on the phone or the computer (the screen says so).
            if (view.request.kind == "permission") g_gadget->answer(held >= kDenyHoldMs ? "deny" : "approve");
          } else {
            g_gadget->new_chat();
          }
        }
      }
    }
    if (tick % kRedEvery == 0) {
      // The red key, through the M5PM1; or a press from the console, read the same way (under a second).
      bool red = g_power_ok && g_power.take_red_press();
      if (now_ms() < g_forced_until[kKeyRed]) {
        forced_red_down = true;
        forced_red_polls++;
      } else if (forced_red_down) {
        red = red || forced_red_polls < 10;
        forced_red_down = false;
        forced_red_polls = 0;
      }
      // Only a wake: a double click on this key powers the StopWatch off (the M5PM1 does it itself).
      if (red) {
        ESP_LOGI(TAG, "the red key: wakes the screen");
        activity();
      }
    }
    if (g_touch_ok && tick % kTouchEvery == 0) {
      int x, y;
      if (g_touch.poll(x, y)) tap(x, y);
    }
  }
}

// ── The console's own lines ─────────────────────────────────────────────────────────────────────
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

void base64(const uint8_t* in, size_t size, std::string& out) {
  size_t i = 0;
  for (; i + 2 < size; i += 3) {
    const uint32_t v = (uint32_t)in[i] << 16 | (uint32_t)in[i + 1] << 8 | in[i + 2];
    out += kB64[v >> 18], out += kB64[(v >> 12) & 63], out += kB64[(v >> 6) & 63], out += kB64[v & 63];
  }
  if (i < size) {
    const uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < size ? (uint32_t)in[i + 1] << 8 : 0);
    out += kB64[v >> 18], out += kB64[(v >> 12) & 63];
    out += i + 1 < size ? kB64[(v >> 6) & 63] : '=';
    out += '=';
  }
}

/** The frame as it was last drawn: a header, one line per row (RGB565, big-endian, base64), an end line. */
void dump_frame(const std::function<void(const std::string&)>& print) {
  constexpr int W = stopwatch::Display::kWidth, H = stopwatch::Display::kHeight;
  const size_t bytes = (size_t)W * H * 2;
  uint8_t* copy = (uint8_t*)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!copy || !g_display_ok) {
    free(copy);
    print("@botkins {\"error\":\"No frame to show.\"}");
    return;
  }
  xSemaphoreTake(g_frame_lock, portMAX_DELAY);
  memcpy(copy, g_display.frame(), bytes);
  const std::string kind = g_kind;
  xSemaphoreGive(g_frame_lock);
  const int64_t started = esp_timer_get_time();
  print("@botkins {\"frame\":{\"width\":" + std::to_string(W) + ",\"height\":" + std::to_string(H) + ",\"format\":\"rgb565be\",\"kind\":\"" + kind +
        "\",\"light\":\"" + kLightNames[g_light.load()] + "\"}}");
  std::string line;
  line.reserve(16 + W * 2 * 4 / 3 + 4);
  for (int y = 0; y < H; y++) {
    line = "@frame " + std::to_string(y) + " ";
    base64(copy + (size_t)y * W * 2, (size_t)W * 2, line);
    print(line);
  }
  free(copy);
  print("@botkins {\"frame\":\"end\",\"ms\":" + std::to_string((esp_timer_get_time() - started) / 1000) + "}");
}

}  // namespace

bool begin() {
  g_frame_lock = xSemaphoreCreateMutex();
  i2c_master_bus_config_t bus_cfg = {};
  bus_cfg.i2c_port = I2C_NUM_0;
  bus_cfg.sda_io_num = static_cast<gpio_num_t>(kSda);
  bus_cfg.scl_io_num = static_cast<gpio_num_t>(kScl);
  bus_cfg.clk_source = I2C_CLK_SRC_DEFAULT;
  bus_cfg.glitch_ignore_cnt = 7;
  bus_cfg.flags.enable_internal_pullup = true;
  if (i2c_new_master_bus(&bus_cfg, &g_bus) != ESP_OK) {
    ESP_LOGE(TAG, "I2C bus failed");
    return false;
  }
  // The panel and the codec have no supply until the M5IOE1 switches it on.
  if (!g_power.begin(g_bus)) {
    ESP_LOGE(TAG, "power chips didn't answer: no display and no audio");
    return false;
  }
  g_power_ok = true;
  g_display_ok = g_display.begin() && g_screen.begin(g_display.frame(), stopwatch::Display::kWidth, stopwatch::Display::kHeight);
  if (g_display_ok) {
    g_screen.boot();
    g_display.flush();
  }
  g_audio_ok = g_audio.begin(g_bus, &g_power);
  g_touch_ok = g_touch.begin(g_bus);
  for (int pin : {kBlue, kYellow}) {
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << pin;
    io.mode = GPIO_MODE_INPUT;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    gpio_config(&io);
  }
  ESP_LOGI(TAG, "display %s, audio %s, touch %s", g_display_ok ? "ready" : "MISSING", g_audio_ok ? "ready" : "MISSING", g_touch_ok ? "ready" : "MISSING");
  return g_display_ok && g_audio_ok;
}

void describe(botkins::Board& out) {
  out.name = "m5stack-stopwatch";
  out.speaker = g_audio_ok ? &g_audio : nullptr;
  out.speaker_rate = stopwatch::Audio::kRate;
  out.mic_rate = stopwatch::Audio::kRate;
  out.screen_width = stopwatch::Display::kWidth;
  out.screen_height = stopwatch::Display::kHeight;
  out.screen_round = true;
}

void redraw() { wake_draw(); }

void run(botkins::Gadget& gadget) {
  g_gadget = &gadget;
  // The microphone always runs; the core keeps only what comes while it listens.
  if (g_audio_ok) g_audio.on_samples = [](const int16_t* samples, size_t count) { g_gadget->feed(samples, count); };
  // The draw task parses SVG and rasterizes glyphs on its stack: at most about 5.7 KB measured
  // (its log line says what is left).
  if (g_display_ok) xTaskCreatePinnedToCore(draw_task, "draw", 9216, nullptr, 3, &g_draw_task, 0);
  xTaskCreate(keys_task, "keys", 4096, nullptr, 5, nullptr);
  redraw();
}

bool console(const std::string& line, const std::function<void(const std::string&)>& print) {
  static const char kMark[] = "@botkins ";
  const size_t mark = line.find(kMark);
  if (mark == std::string::npos) return false;
  botkins::Json ask;
  if (!botkins::Json::parse(line.substr(mark + sizeof kMark - 1), ask) || !ask.is_object()) return false;
  const std::string what = ask["do"].str();
  if (what == "frame") {
    dump_frame(print);
    return true;
  }
  if (what == "key") {
    const std::string key = ask["key"].str();
    const KeyId id = key == "blue" ? kKeyBlue : key == "yellow" ? kKeyYellow : key == "red" ? kKeyRed : kKeys;
    if (id == kKeys) {
      print("@botkins {\"error\":\"The keys are blue, yellow and red.\"}");
      return true;
    }
    int ms = ask.has("ms") ? (int)ask["ms"].num() : 100;
    ms = ms < 50 ? 50 : ms > 10000 ? 10000 : ms;
    g_forced_until[id] = now_ms() + ms;
    print("@botkins {\"ok\":true}");
    return true;
  }
  if (what == "touch") {
    const int x = (int)ask["x"].num(), y = (int)ask["y"].num();
    if (x < 0 || y < 0 || x >= stopwatch::Display::kWidth || y >= stopwatch::Display::kHeight) {
      print("@botkins {\"error\":\"That point is off the screen.\"}");
      return true;
    }
    tap(x, y);
    print("@botkins {\"ok\":true}");
    return true;
  }
  return false;
}

}  // namespace board
