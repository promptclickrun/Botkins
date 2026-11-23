// The StopWatch's screen: the core's Halo home screen and quick controls (core/src/home.cpp),
// drawn whole into the display's frame when something on it changed. Nothing moves on its own.
#include "screen.hpp"

#include <cstring>
#include <string>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "sdkconfig.h"

// The fonts, embedded by components/botkins_core (EMBED_FILES).
extern const uint8_t serif_start[] asm("_binary_DejaVuSerif_Bold_ttf_start");
extern const uint8_t serif_end[] asm("_binary_DejaVuSerif_Bold_ttf_end");
extern const uint8_t sans_start[] asm("_binary_OpenSans_Regular_ttf_start");
extern const uint8_t sans_end[] asm("_binary_OpenSans_Regular_ttf_end");

namespace stopwatch {
namespace {
const char* TAG = "stopwatch.screen";

/**
 * While the screen draws, every allocation prefers PSRAM, the small ones too. A bot's face is
 * about 117 KB of SVG with some 2,500 paths: NanoSVG parses it into thousands of small blocks,
 * which the allocator would otherwise put in internal RAM (measured: 286 KB of it, down to 8 KB
 * free, which Wi-Fi and the sockets need). This is the whole heap's setting, for the draw's
 * length: another task's allocation meanwhile lands in PSRAM too, which is only slower.
 */
struct PsramFirst {
  PsramFirst() { heap_caps_malloc_extmem_enable(0); }
  ~PsramFirst() { heap_caps_malloc_extmem_enable(CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL); }
};
}  // namespace

bool Screen::begin(uint16_t* frame, int width, int height) {
  canvas_.reset(new botkins::Canvas(frame, width, height, true));  // the panel takes big-endian pixels
  if (!canvas_->set_fonts(serif_start, (size_t)(serif_end - serif_start), sans_start, (size_t)(sans_end - sans_start))) {
    ESP_LOGE(TAG, "the fonts can't be read");
    canvas_.reset();
    return false;
  }
  return true;
}

void Screen::boot() {
  if (!canvas_) return;
  PsramFirst psram;
  // Words only: a face takes about 2 s to draw here, and the board starts its Wi-Fi after this.
  botkins::Canvas& c = *canvas_;
  c.clear(botkins::Rgb{});
  auto centred = [&c](const char* text, const botkins::Type& type, float top, botkins::Rgb colour) {
    const float w = c.measure(text, std::strlen(text), type);
    c.text((c.width() - w) / 2, c.baseline(top, type), text, std::strlen(text), type, colour);
  };
  botkins::Type name;
  name.face = botkins::Typeface::Serif;
  name.px = 40;
  botkins::Type small;
  small.px = 20;
  centred("Botkins", name, c.height() / 2.0f - 44, botkins::hex(0xF2EDE4));
  centred("Starting", small, c.height() / 2.0f + 12, botkins::hex(0x9AA5A0));
}

void Screen::draw(const botkins::View& view, Mode mode) {
  if (!canvas_) return;
  PsramFirst psram;
  paint(view, mode);
}

void Screen::paint(const botkins::View& view, Mode mode) {
  if (mode == Mode::Quick) {
    botkins::draw_quick(*canvas_, view, faces_);
    return;
  }
  botkins::HomeOptions options;  // the StopWatch's keys are the core's defaults
  options.dimmed = mode == Mode::Dimmed;
  botkins::draw_home(*canvas_, view, faces_, options);
}

bool Screen::warm(const botkins::View& shown, Mode shown_mode) {
  using botkins::View;
  if (!canvas_ || shown.stage != View::Stage::Online || !shown.faces || shown.faces->empty()) return false;
  // A new set of faces (another look, or one more pose of it arrived): from the start again. What
  // is drawn already costs a redraw only.
  if (shown.faces.get() != warm_faces_) {
    warm_faces_ = shown.faces.get();
    warm_next_ = 0;
  }
  // Each pose at the size it shows at: large on its own, small over a reply (writing, speaking).
  struct Ahead {
    const char* pose;
    const char* variant;
  };
  static const Ahead kAhead[] = {{"ready", ""},     {"listening", ""}, {"working", ""},   {"working", "writing"}, {"speaking", "reply"},
                                 {"needs", ""},     {"waiting", ""},   {"sleepy", ""},    {"ready", "quick"}};
  constexpr int kCount = sizeof kAhead / sizeof kAhead[0];
  for (; warm_next_ < kCount; warm_next_++) {
    const char* pose = kAhead[warm_next_].pose;
    const std::string variant = kAhead[warm_next_].variant;
    // A pose the bot sent no face for shows the original, which the boot screen drew already.
    if (!shown.faces->count(pose)) continue;
    View v = shown;
    v.listening = v.sending = v.speaking = false;
    v.phase = "idle";
    v.request = View::Request();
    v.text.clear();
    v.heard.clear();
    v.notice.clear();
    Mode mode = Mode::Home;
    const std::string p = pose;
    if (p == "listening") v.listening = true;
    else if (p == "working") v.phase = variant == "writing" ? "writing" : "working", v.steps = 1;
    else if (p == "speaking") v.speaking = true;
    else if (p == "needs") v.phase = "request", v.request.id = "ahead", v.request.kind = "permission", v.request.title = "Ahead";
    else if (p == "waiting") v.stage = View::Stage::Connecting;
    else if (p == "sleepy") mode = Mode::Dimmed;
    if (variant == "quick") mode = Mode::Quick;
    if (variant == "writing" || variant == "reply") v.text = "Ahead.";
    PsramFirst psram;
    paint(v, mode);
    paint(shown, shown_mode);
    warm_next_++;
    return true;
  }
  return false;
}

}  // namespace stopwatch
