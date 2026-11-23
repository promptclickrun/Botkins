// The gadget's screen, drawn by the core: the "Halo" home screen and the quick-controls panel, over
// any RGB565 frame. A board allocates its frame once, makes one Canvas and one Faces, hands in the
// fonts, and draws whenever the view changed. Nothing moves on its own.
//
//   static botkins::Canvas canvas(frame, 466, 466, true);   // true: bytes swapped for the panel
//   static botkins::Faces faces;
//   canvas.set_fonts(serif_ttf, serif_len, sans_ttf, sans_len);
//   botkins::draw_home(canvas, gadget.view(), faces, {dimmed});
//   // or, while the panel is open:  botkins::draw_quick(canvas, view, faces);
//   // a touch on the panel:         switch (botkins::quick_hit(x, y, 466, 466)) { ... }
//
// Everything is laid out for a 466-pixel round screen and scaled to the canvas; a rectangular
// canvas gets the same layout centred in the circle of its shorter side.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

#include "botkins/gadget.hpp"

namespace botkins {

struct Rgb {
  uint8_t r = 0, g = 0, b = 0;
};
constexpr Rgb hex(uint32_t value) { return Rgb{(uint8_t)(value >> 16), (uint8_t)(value >> 8), (uint8_t)value}; }

enum class Typeface : uint8_t { Serif, Sans };
/** How a run of text looks. `px` is the CSS font size in canvas pixels. */
struct Type {
  Typeface face = Typeface::Sans;
  float px = 16;
  bool bold = false;      // the sans has no bold file: a double strike, 1 pixel (2 from 22 pixels up)
  bool caps = false;      // drawn in capitals
  float tracking = 0;     // extra space after each letter, in canvas pixels
};

/** An RGB565 frame and what draws into it. Holds the fonts and a cache of their glyphs. */
class Canvas {
 public:
  /** `swap_bytes`: store each pixel big-endian, as an SPI panel takes it. The canvas never owns `pixels`. */
  Canvas(uint16_t* pixels, int width, int height, bool swap_bytes);
  ~Canvas();
  Canvas(const Canvas&) = delete;
  Canvas& operator=(const Canvas&) = delete;

  int width() const { return width_; }
  int height() const { return height_; }
  uint16_t* pixels() const { return pixels_; }

  /**
   * The fonts' TrueType bytes, which must outlive the canvas (a port's embedded files). The glyph
   * cache (about 200 KB) is allocated here, once. False when a font can't be read.
   */
  bool set_fonts(const uint8_t* serif, size_t serif_size, const uint8_t* sans, size_t sans_size);
  bool has_fonts() const;

  void clear(Rgb color);
  void fill_rect(int x, int y, int w, int h, Rgb color);
  /** One pixel, `alpha` 0 to 255 over what is there. */
  void blend(int x, int y, Rgb color, int alpha);
  // Shapes, anti-aliased at their edges. Coordinates are canvas pixels; (0, 0) is the top-left corner of the top-left pixel.
  void fill_circle(float cx, float cy, float r, Rgb color, int alpha = 255);
  void annulus(float cx, float cy, float outer, float inner, Rgb color, int alpha = 255);
  /** Part of an annulus with square ends: `turns` (0 to 1) of it clockwise from `start` (turns from the top). */
  void arc(float cx, float cy, float outer, float inner, float start, float turns, Rgb color, int alpha = 255);
  void fill_round_rect(float x, float y, float w, float h, float r, Rgb color, int alpha = 255);
  /** A straight-alpha RGBA image, scaled by `opacity` (0 to 255). */
  void blit_rgba(int x, int y, const uint8_t* rgba, int w, int h, int opacity = 255);
  /** An alpha mask (one byte a pixel, `stride` bytes a row) painted in `color`. */
  void blit_mask(int x, int y, const uint8_t* mask, int w, int h, int stride, Rgb color, int opacity = 255);

  // Text: UTF-8 in; a character neither font has is skipped.
  float measure(const char* text, size_t length, const Type& type);
  float measure(const std::string& text, const Type& type) { return measure(text.data(), text.size(), type); }
  /** Draws from the pen at `x` on the baseline `y`; returns the pen after it. */
  float text(float x, float y, const char* text, size_t length, const Type& type, Rgb color, int opacity = 255);
  /** The baseline of a line box of `line_height` (0: the font's own) whose top is at `top`. */
  float baseline(float top, const Type& type, float line_height = 0);
  /** The font's own line height (ascent + descent + gap) at `type.px`. */
  float line_height(const Type& type);

 private:
  struct Fonts;
  struct Glyph;
  const Glyph* glyph(const Type& type, uint32_t codepoint);
  uint16_t* pixels_;
  int width_, height_;
  bool swap_;
  std::unique_ptr<Fonts> fonts_;
};

/**
 * The Botkin's faces and the panel's icons, as rasters. A pose's SVG (for `View::look`) is parsed
 * and drawn once for each size asked; the raster is kept and the parse let go. When the look
 * changes the old rasters are freed. A pose the view has no face for gets the Botkin in its
 * original colours (the design kit's "setup" face, built in).
 */
class Faces {
 public:
  Faces();
  ~Faces();
  Faces(const Faces&) = delete;
  Faces& operator=(const Faces&) = delete;

  /** The pose's raster, `size` pixels square, straight-alpha RGBA; null if it can't be drawn. */
  const uint8_t* face(const View& view, const char* pose, int size);
  /** The Botkin in its original colours (first start), `size` pixels square. */
  const uint8_t* original(int size);
  /** The Botkin's shell colour, lightened to read on black (#6FA596 when the face has none). */
  Rgb shell(const View& view, const char* pose);
  /** An icon of the panel (`svg` a 24-unit view box), `size` pixels square, as an alpha mask. */
  const uint8_t* icon(const char* svg, int size);
  /** Bytes held by rasters now. */
  size_t memory() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

struct HomeOptions {
  /** The screen is dimmed: the sleepy Botkin, faint, and nothing else. */
  bool dimmed = false;
  // What the board's keys are called on screen (the StopWatch's by default).
  const char* stop_hint = "Blue stops it";
  const char* allow_hint = "Yellow: allow";
  const char* deny_hint = "Hold: deny";
};

/** The home screen for every stage and phase of `view`. */
void draw_home(Canvas& canvas, const View& view, Faces& faces, const HomeOptions& options = {});

/** The quick-controls panel. */
enum class QuickAction { None, VolumeDown, VolumeUp, Mute, Brightness, NewChat, Close };
void draw_quick(Canvas& canvas, const View& view, Faces& faces);
/** What a touch at (x, y) on a `width` by `height` screen showing the panel does. */
QuickAction quick_hit(int x, int y, int width, int height);
/**
 * The settings after `action`: volume in steps of 10 (0 to 100), the microphone muted or not,
 * brightness 40, 70, 100 and round. Hand the change to Gadget::change_settings.
 */
View::Settings quick_apply(QuickAction action, View::Settings settings);

}  // namespace botkins
