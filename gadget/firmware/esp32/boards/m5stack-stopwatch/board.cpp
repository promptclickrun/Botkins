// The M5Stack StopWatch (SKU C152): ESP32-S3R8 (16 MB flash, 8 MB octal PSRAM), a round 1.75"
// 466x466 CO5300 AMOLED, one ES8311 for the speaker and the microphone, an M5PM1 power manager and
// an M5IOE1 I/O expander, a blue and a yellow key.
//
// Pins (I2C SDA 47 / SCL 48; the blue key on GPIO 1, the yellow on GPIO 2, both active low) are
// hardware facts as the Hermes Gadget firmware has them for this board (firmware/esp32/main/board.cpp, MIT).
// Not used here: the touch controller (CST820), the BMI270, the RX8130 clock, the vibration motor
// and the PM1's red key.
//
// The blue key talks: held, it listens; let go, it sends (a press under 300 ms is given up). A
// press while it speaks stops the speaking. The yellow key approves a request on show (held for
// most of a second, it denies it), and otherwise starts a new chat.
#include <atomic>

#include "audio.hpp"
#include "display.hpp"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gadget_port/board.hpp"
#include "screen.hpp"
#include "stopwatch_power.hpp"

namespace board {
namespace {
const char* TAG = "stopwatch";
constexpr int kSda = 47, kScl = 48;
constexpr int kBlue = 1, kYellow = 2;
constexpr int kPollMs = 10, kDebouncePolls = 3;  // the Hermes firmware's key debounce: 3 polls of ~10 ms
constexpr int64_t kShortestTalkMs = 300, kDenyHoldMs = 800;
// Redraws come at most this often: a reply that streams in changes the view many times a second.
constexpr int kRedrawMs = 150;

i2c_master_bus_handle_t g_bus = nullptr;
stopwatch::Power g_power;
stopwatch::Display g_display;
stopwatch::Audio g_audio;
bool g_display_ok = false, g_audio_ok = false;
botkins::Gadget* g_gadget = nullptr;
TaskHandle_t g_draw_task = nullptr;

int64_t now_ms() { return esp_timer_get_time() / 1000; }

// ── The screen, and how bright it is ────────────────────────────────────────────────────────────
// An AMOLED left showing the same thing burns in. Online and idle (not listening, sending, working,
// writing or speaking, no request on show), with nothing changed and no key pressed: after 30 s the
// panel dims, after 5 minutes of that (counted from the last activity) its output goes off. A view
// that changes, or a key, brings it back at once; the key still does its own job. Only the panel's
// brightness (0x51) and display on/off (0x29/0x28) commands are used.
constexpr int64_t kDimAfterMs = 30 * 1000, kDarkAfterMs = 5 * 60 * 1000;
constexpr uint8_t kBright = 100, kDim = 10;  // percent of the panel's brightness range
enum class Light { Bright, Dim, Dark };
const char* const kLightNames[] = {"bright", "dim", "dark"};
Light g_light = Light::Bright;           // the draw task's own
std::atomic<int64_t> g_key_at{0};        // when a key was last pressed (keys task)

/** The draw task's only way to change the panel's light, with one log line for each change. */
void set_light(Light next, const char* why) {
  if (next == g_light) return;
  bool ok = true;
  if (next == Light::Dark) {
    ok = g_display.brightness(0) && g_display.output(false);
  } else {
    if (g_light == Light::Dark) ok = g_display.output(true);
    ok = g_display.brightness(next == Light::Bright ? kBright : kDim) && ok;
  }
  ESP_LOGI(TAG, "screen %s -> %s (%s)%s", kLightNames[(int)g_light], kLightNames[(int)next], why, ok ? "" : ", panel command failed");
  g_light = next;
}

bool idle(const botkins::View& view) {
  return view.stage == botkins::View::Stage::Online && !view.listening && !view.sending && !view.speaking && view.phase == "idle" && view.request.id.empty();
}

/** What the screen shows is the same (the revision goes up for changes that show nothing new). */
bool same(const botkins::View& a, const botkins::View& b) {
  return a.stage == b.stage && a.name == b.name && a.computer == b.computer && a.bot == b.bot && a.phase == b.phase && a.doing == b.doing && a.text == b.text &&
         a.heard == b.heard && a.notice == b.notice && a.listening == b.listening && a.sending == b.sending && a.speaking == b.speaking &&
         a.can_hear == b.can_hear && a.can_speak == b.can_speak && a.request.id == b.request.id && a.request.kind == b.request.kind &&
         a.request.title == b.request.title && a.request.preview == b.request.preview && a.request.choices == b.request.choices &&
         a.request.remember == b.request.remember;
}

void draw_task(void*) {
  botkins::View shown;
  bool drawn = false;
  int64_t active_at = now_ms(), key_seen = 0;
  for (;;) {
    // Woken by a change or a key; otherwise once a second, to see whether it is time to dim.
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
    const botkins::View view = g_gadget->view();
    const int64_t key = g_key_at;
    if (key != key_seen) {
      key_seen = key;
      active_at = now_ms();
      set_light(Light::Bright, "a key");
    }
    if (!drawn || !same(view, shown)) {
      // Drawn first, then lit: a dark panel comes back with the new frame, not the old one.
      stopwatch::draw_view(g_display.frame(), view);
      g_display.flush();
      shown = view;
      drawn = true;
      active_at = now_ms();
      set_light(Light::Bright, "the view changed");
      vTaskDelay(pdMS_TO_TICKS(kRedrawMs));
      // A change while this one was drawn left its notification: the loop draws it next.
      continue;
    }
    if (!idle(view)) active_at = now_ms();
    const int64_t quiet = now_ms() - active_at;
    if (quiet >= kDarkAfterMs) set_light(Light::Dark, "5 minutes idle");
    else if (quiet >= kDimAfterMs) set_light(Light::Dim, "30 s idle");
  }
}

struct Key {
  int gpio;
  bool down = false;
  int stable = 0;
  int64_t since = 0;
  /** True once per change of the debounced level. */
  bool poll() {
    const bool level = gpio_get_level(static_cast<gpio_num_t>(gpio)) == 0;
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

/** A key went down: the screen lights up at once, and the key goes on to do its own job. */
void key_pressed() {
  g_key_at = now_ms();
  if (g_draw_task) xTaskNotifyGive(g_draw_task);
}

void keys_task(void*) {
  Key blue{kBlue}, yellow{kYellow};
  bool talking = false;
  int64_t blue_down_at = 0, yellow_down_at = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(kPollMs));
    if (blue.poll()) {
      if (blue.down) {
        key_pressed();
        blue_down_at = blue.since;
        const botkins::View view = g_gadget->view();
        if (view.speaking || g_audio.playing()) {
          // A press while it speaks only stops the speaking.
          g_gadget->stop_speaking();
          g_audio.cut();
          talking = false;
        } else if (view.stage == botkins::View::Stage::Online) {
          g_gadget->start_listening();
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
        key_pressed();
        yellow_down_at = yellow.since;
        continue;
      }
      const int64_t held = yellow.since - yellow_down_at;
      const botkins::View view = g_gadget->view();
      if (view.stage != botkins::View::Stage::Online) continue;
      if (!view.request.id.empty()) {
        // A question or a form is answered on the phone or the computer (the screen says so).
        if (view.request.kind == "permission") g_gadget->answer(held >= kDenyHoldMs ? "deny" : "approve");
      } else {
        g_gadget->new_chat();
      }
    }
  }
}

}  // namespace

bool begin() {
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
  g_display_ok = g_display.begin();
  if (g_display_ok) {
    stopwatch::draw_boot(g_display.frame());
    g_display.flush();
  }
  g_audio_ok = g_audio.begin(g_bus, &g_power);
  for (int pin : {kBlue, kYellow}) {
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << pin;
    io.mode = GPIO_MODE_INPUT;
    io.pull_up_en = GPIO_PULLUP_ENABLE;
    gpio_config(&io);
  }
  ESP_LOGI(TAG, "display %s, audio %s", g_display_ok ? "ready" : "MISSING", g_audio_ok ? "ready" : "MISSING");
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

void redraw() {
  if (g_draw_task) xTaskNotifyGive(g_draw_task);
}

void run(botkins::Gadget& gadget) {
  g_gadget = &gadget;
  // The microphone always runs; the core keeps only what comes while it listens.
  if (g_audio_ok) g_audio.on_samples = [](const int16_t* samples, size_t count) { g_gadget->feed(samples, count); };
  if (g_display_ok) xTaskCreatePinnedToCore(draw_task, "draw", 6144, nullptr, 3, &g_draw_task, 0);
  xTaskCreate(keys_task, "keys", 4096, nullptr, 5, nullptr);
  redraw();
}

}  // namespace board
