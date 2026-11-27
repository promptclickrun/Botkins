// The StopWatch's screen: the core's Halo home screen, quick controls, and slide-to-power-off
// overlay, drawn whole into the display's frame when something on it changed.
#include "screen.hpp"

#include <algorithm>
#include <cmath>
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

const char kPowerIcon[] =
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"24\" height=\"24\">"
    "<g fill=\"none\" stroke=\"#fff\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">"
    "<path d=\"M12 3v8\"/><path d=\"M6.34 6.34a8 8 0 1 0 11.32 0\"/></g></svg>";
const char kCloseIcon[] =
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"24\" height=\"24\">"
    "<g fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">"
    "<path d=\"M7 7l10 10M17 7L7 17\"/></g></svg>";

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

void Screen::paint_power_off(float slider_pos, bool powering_off) {
  botkins::Canvas& c = *canvas_;
  constexpr float kMid = 233.0f;
  const botkins::Rgb kBlack = botkins::hex(0x000000);
  const botkins::Rgb kCream = botkins::hex(0xFFF8EA);
  const botkins::Rgb kMuted = botkins::hex(0xB9AE9C);
  const botkins::Rgb kHairline = botkins::hex(0x3A332E);
  const botkins::Rgb kTrack = botkins::hex(0x2A2522);
  const botkins::Rgb kRed = botkins::hex(0xE05245);
  const botkins::Rgb kRedFill = botkins::hex(0x6E221D);

  c.clear(kBlack);
  auto centred = [&c](const char* text, const botkins::Type& type, float top, botkins::Rgb colour, int opacity = 255) {
    const float w = c.measure(text, std::strlen(text), type);
    c.text((c.width() - w) / 2.0f, c.baseline(top, type), text, std::strlen(text), type, colour, opacity);
  };

  if (powering_off) {
    c.annulus(kMid, kMid, 233.0f, 223.0f, kRed);
    botkins::Type title;
    title.face = botkins::Typeface::Serif;
    title.px = 30;
    centred("Powering off...", title, 214.0f, kCream);
    return;
  }

  const float p = std::max(0.0f, std::min(1.0f, slider_pos));
  c.annulus(kMid, kMid, 233.0f, 230.0f, p > 0.05f ? kRed : kHairline);

  botkins::Type title;
  title.face = botkins::Typeface::Serif;
  title.px = 30;
  centred("Power off", title, 114.0f, kCream);

  // Horizontal pill track: x=63..403 (w=340), y=195..271 (h=76), r=38.
  constexpr float kTrackX = 63.0f, kTrackY = 195.0f, kTrackW = 340.0f, kTrackH = 76.0f, kTrackR = 38.0f;
  constexpr float kMinCx = 101.0f, kMaxCx = 365.0f, kThumbR = 32.0f;
  const float thumb_cx = kMinCx + p * (kMaxCx - kMinCx);

  c.fill_round_rect(kTrackX, kTrackY, kTrackW, kTrackH, kTrackR, kTrack);
  if (p > 0.01f) {
    const float fill_w = (thumb_cx + kThumbR + 6.0f) - kTrackX;
    c.fill_round_rect(kTrackX, kTrackY, std::min(kTrackW, fill_w), kTrackH, kTrackR, kRedFill);
  }

  // Track prompt text fades out as the thumb slides right.
  const int label_alpha = (int)std::lround(255.0f * std::max(0.0f, 1.0f - p * 1.8f));
  if (label_alpha > 8) {
    botkins::Type prompt;
    prompt.px = 18;
    const char* msg = "slide to power off";
    const float w = c.measure(msg, std::strlen(msg), prompt);
    c.text(kMid + 26.0f - w / 2.0f, c.baseline(kTrackY, prompt, kTrackH), msg, std::strlen(msg), prompt, kMuted, label_alpha);
  }

  // Draggable red thumb with white power icon.
  c.fill_circle(thumb_cx, kMid, kThumbR, kRed);
  const uint8_t* pwr = faces_.icon(kPowerIcon, 30);
  if (pwr) c.blit_mask((int)std::lround(thumb_cx - 15.0f), (int)std::lround(kMid - 15.0f), pwr, 30, 30, 30, kCream);

  // Bottom Cancel button: cx=233, cy=352, r=32.
  constexpr float kCancelY = 352.0f, kCancelR = 32.0f;
  c.annulus(kMid, kCancelY, kCancelR, kCancelR - 2.0f, kHairline);
  const uint8_t* xicon = faces_.icon(kCloseIcon, 24);
  if (xicon) c.blit_mask((int)std::lround(kMid - 12.0f), (int)std::lround(kCancelY - 12.0f), xicon, 24, 24, 24, kCream);
  botkins::Type cancel_lbl;
  cancel_lbl.px = 15;
  centred("Cancel", cancel_lbl, 392.0f, kMuted);
}

void Screen::draw(const botkins::View& view, Mode mode, float slider_pos, bool powering_off) {
  if (!canvas_) return;
  PsramFirst psram;
  paint(view, mode, slider_pos, powering_off);
}

void Screen::paint(const botkins::View& view, Mode mode, float slider_pos, bool powering_off) {
  if (mode == Mode::PowerOff) {
    paint_power_off(slider_pos, powering_off);
    return;
  }
  if (mode == Mode::Wifi) {
    WifiMenu::draw(*canvas_, wifi_);
    return;
  }
  if (mode == Mode::Quick) {
    botkins::QuickOptions options;
    options.wifi = true;  // this board has a local Wi-Fi editor
    botkins::draw_quick(*canvas_, view, faces_, options);
    return;
  }
  botkins::HomeOptions options;
  options.dimmed = mode == Mode::Dimmed;
  options.stop_hint = "Tap or blue stops it";
  botkins::draw_home(*canvas_, view, faces_, options);
}

bool Screen::warm(const botkins::View& shown, Mode shown_mode) {
  using botkins::View;
  if (!canvas_ || shown.stage != View::Stage::Online || !shown.faces || shown.faces->empty()) return false;
  if (shown_mode == Mode::PowerOff || shown_mode == Mode::Wifi) return false;
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
