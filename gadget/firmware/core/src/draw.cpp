// The canvas: an RGB565 frame, anti-aliased shapes, and text through stb_truetype with a glyph
// cache allocated once. No allocation and no trigonometry per pixel.
#include "botkins/draw.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "utf8.hpp"

#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wsign-compare"
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wunused-variable"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#pragma GCC diagnostic ignored "-Wimplicit-fallthrough"
#endif
#define STBTT_STATIC
#define STB_TRUETYPE_IMPLEMENTATION
#include "../third_party/stb/stb_truetype.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace botkins {
namespace {

/** To RGB565, rounded to the nearest level (cutting off the low bits turns dark warm greys green). */
inline uint16_t pack(Rgb c) {
  // round(v * 31 / 255) and round(v * 63 / 255) without a division
  const int r = (c.r * 249 + 1014) >> 11, g = (c.g * 253 + 505) >> 10, b = (c.b * 249 + 1014) >> 11;
  return (uint16_t)(r << 11 | g << 5 | b);
}
inline uint16_t swap16(uint16_t v) { return (uint16_t)((v >> 8) | (v << 8)); }
inline int clamp255(float v) { return v <= 0 ? 0 : v >= 1 ? 255 : (int)(v * 255.0f + 0.5f); }
inline float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** `c` over the stored pixel `*p` with `a` (1 to 254). */
inline uint16_t mix(uint16_t stored, Rgb c, int a) {
  const int r = ((stored >> 11) & 0x1F) << 3 | ((stored >> 13) & 0x7);
  const int g = ((stored >> 5) & 0x3F) << 2 | ((stored >> 9) & 0x3);
  const int b = (stored & 0x1F) << 3 | ((stored >> 2) & 0x7);
  const int na = 255 - a;
  // x / 255 as (x + 128 + ((x + 128) >> 8)) >> 8: exact for 0 to 65025.
  auto div = [](int x) { x += 128; return (x + (x >> 8)) >> 8; };
  return pack(Rgb{(uint8_t)div(c.r * a + r * na), (uint8_t)div(c.g * a + g * na), (uint8_t)div(c.b * a + b * na)});
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// Pixels and shapes

Canvas::Canvas(uint16_t* pixels, int width, int height, bool swap_bytes)
    : pixels_(pixels), width_(width), height_(height), swap_(swap_bytes) {}

void Canvas::clear(Rgb color) { fill_rect(0, 0, width_, height_, color); }

void Canvas::fill_rect(int x, int y, int w, int h, Rgb color) {
  uint16_t v = pack(color);
  if (swap_) v = swap16(v);
  const int x0 = std::max(0, x), y0 = std::max(0, y), x1 = std::min(width_, x + w), y1 = std::min(height_, y + h);
  for (int yy = y0; yy < y1; yy++) std::fill(pixels_ + (size_t)yy * width_ + x0, pixels_ + (size_t)yy * width_ + x1, v);
}

void Canvas::blend(int x, int y, Rgb color, int alpha) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= width_ || y >= height_) return;
  uint16_t* p = pixels_ + (size_t)y * width_ + x;
  if (alpha >= 255) {
    *p = swap_ ? swap16(pack(color)) : pack(color);
    return;
  }
  const uint16_t stored = swap_ ? swap16(*p) : *p;
  const uint16_t v = mix(stored, color, alpha);
  *p = swap_ ? swap16(v) : v;
}

namespace {
/**
 * Visits the pixels of a ring (outer radius, inner radius; inner < 0 for a disc) with their
 * coverage. Pixels well inside get 1 without a square root; only the edges are measured.
 */
template <typename Visit>
void ring_pixels(int width, int height, float cx, float cy, float outer, float inner, Visit visit) {
  const int y0 = std::max(0, (int)std::floor(cy - outer - 1)), y1 = std::min(height - 1, (int)std::ceil(cy + outer + 1));
  for (int y = y0; y <= y1; y++) {
    const float dy = (float)y + 0.5f - cy, dy2 = dy * dy;
    const float reach2 = (outer + 1) * (outer + 1) - dy2;
    if (reach2 <= 0) continue;
    const float reach = std::sqrt(reach2);
    // |dx| in [solid_lo, solid_hi]: wholly inside the ring.
    const float so = (outer - 1) * (outer - 1) - dy2;
    const float solid_hi = so > 0 ? std::sqrt(so) : -1.0f;
    float solid_lo = 0, hole = -1;  // |dx| < hole: wholly inside the inner circle
    if (inner > 0) {
      const float si = (inner + 1) * (inner + 1) - dy2;
      solid_lo = si > 0 ? std::sqrt(si) : 0;
      const float hi = (inner - 1) * (inner - 1) - dy2;
      hole = inner > 1 && hi > 0 ? std::sqrt(hi) : -1.0f;
    }
    const int x0 = std::max(0, (int)std::floor(cx - reach)), x1 = std::min(width - 1, (int)std::ceil(cx + reach));
    for (int x = x0; x <= x1; x++) {
      const float dx = (float)x + 0.5f - cx, ax = std::fabs(dx);
      if (ax < hole) {  // jump over the hole
        const int skip = (int)std::floor(cx + hole - 0.5f);
        if (skip > x) x = skip - 1;
        continue;
      }
      float cover;
      if (ax >= solid_lo && ax <= solid_hi) cover = 1;
      else {
        const float d = std::sqrt(dx * dx + dy2);
        cover = clamp01(outer - d + 0.5f);
        if (inner > 0) cover *= clamp01(d - inner + 0.5f);
      }
      if (cover > 0) visit(x, y, dx, dy, cover);
    }
  }
}
}  // namespace

void Canvas::fill_circle(float cx, float cy, float r, Rgb color, int alpha) {
  ring_pixels(width_, height_, cx, cy, r, -1, [&](int x, int y, float, float, float cover) { blend(x, y, color, clamp255(cover * alpha / 255.0f)); });
}

void Canvas::annulus(float cx, float cy, float outer, float inner, Rgb color, int alpha) {
  ring_pixels(width_, height_, cx, cy, outer, inner, [&](int x, int y, float, float, float cover) { blend(x, y, color, clamp255(cover * alpha / 255.0f)); });
}

void Canvas::arc(float cx, float cy, float outer, float inner, float start, float turns, Rgb color, int alpha) {
  if (turns <= 0) return;
  if (turns >= 1) return annulus(cx, cy, outer, inner, color, alpha);
  // A ray at angle a (clockwise from the top) points along (sin a, -cos a); a point (dx, dy) lies
  // past it, clockwise, by dx cos a + dy sin a (y grows downwards). Two half-planes make the wedge.
  const float a = start * 6.2831853f, b = (start + turns) * 6.2831853f;
  const float ca = std::cos(a), sa = std::sin(a), cb = std::cos(b), sb = std::sin(b);
  const bool small = turns <= 0.5f;
  ring_pixels(width_, height_, cx, cy, outer, inner, [&](int x, int y, float dx, float dy, float cover) {
    const float past_start = clamp01(dx * ca + dy * sa + 0.5f);
    const float before_end = clamp01(0.5f - (dx * cb + dy * sb));
    // Under half a turn: inside both half-planes. Over: outside the wedge that is left.
    const float in = small ? past_start * before_end : 1 - (1 - before_end) * (1 - past_start);
    blend(x, y, color, clamp255(cover * in * alpha / 255.0f));
  });
}

void Canvas::fill_round_rect(float x, float y, float w, float h, float r, Rgb color, int alpha) {
  r = std::min(r, std::min(w, h) / 2);
  const float hx = w / 2, hy = h / 2, cx = x + hx, cy = y + hy;
  const int y0 = std::max(0, (int)std::floor(y)), y1 = std::min(height_ - 1, (int)std::ceil(y + h));
  const int x0 = std::max(0, (int)std::floor(x)), x1 = std::min(width_ - 1, (int)std::ceil(x + w));
  for (int py = y0; py <= y1; py++) {
    const float qy = std::fabs((float)py + 0.5f - cy) - (hy - r);
    for (int px = x0; px <= x1; px++) {
      const float qx = std::fabs((float)px + 0.5f - cx) - (hx - r);
      float outside;
      if (qx > 0 && qy > 0) outside = std::sqrt(qx * qx + qy * qy) - r;
      else outside = std::max(qx, qy) - r;
      const float cover = clamp01(0.5f - outside);
      if (cover > 0) blend(px, py, color, clamp255(cover * alpha / 255.0f));
    }
  }
}

void Canvas::blit_rgba(int x, int y, const uint8_t* rgba, int w, int h, int opacity) {
  if (!rgba) return;
  for (int row = std::max(0, -y); row < h && y + row < height_; row++) {
    const uint8_t* src = rgba + (size_t)row * w * 4;
    for (int col = std::max(0, -x); col < w && x + col < width_; col++) {
      const uint8_t* s = src + col * 4;
      const int a = opacity >= 255 ? s[3] : (s[3] * opacity + 127) / 255;
      if (a) blend(x + col, y + row, Rgb{s[0], s[1], s[2]}, a);
    }
  }
}

void Canvas::blit_mask(int x, int y, const uint8_t* mask, int w, int h, int stride, Rgb color, int opacity) {
  if (!mask) return;
  for (int row = std::max(0, -y); row < h && y + row < height_; row++) {
    const uint8_t* src = mask + (size_t)row * stride;
    for (int col = std::max(0, -x); col < w && x + col < width_; col++) {
      const int a = opacity >= 255 ? src[col] : (src[col] * opacity + 127) / 255;
      if (a) blend(x + col, y + row, color, a);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Text

struct Canvas::Glyph {
  uint32_t codepoint = 0;
  uint32_t style = 0;  // 0: empty slot
  int index = 0;       // the glyph in its font; 0 when neither font has it
  uint8_t face = 0;    // the font it came from (the other one when the asked one lacks it)
  int16_t left = 0, top = 0;
  uint16_t w = 0, h = 0;
  float advance = 0;
  uint32_t offset = 0;  // its coverage in the arena
};

struct Canvas::Fonts {
  static constexpr int kSlots = 1024;            // a power of two
  static constexpr size_t kArena = 160 * 1024;   // coverage bytes
  stbtt_fontinfo info[2];
  float ascent[2], descent[2], gap[2], units[2];  // font units
  Glyph slots[kSlots];
  int used = 0;
  uint8_t* arena = nullptr;
  size_t arena_used = 0;
  ~Fonts() { std::free(arena); }
  void flush() {
    for (Glyph& g : slots) g.style = 0;
    used = 0;
    arena_used = 0;
  }
};

Canvas::~Canvas() = default;

bool Canvas::set_fonts(const uint8_t* serif, size_t serif_size, const uint8_t* sans, size_t sans_size) {
  std::unique_ptr<Fonts> fonts(new Fonts());
  const uint8_t* data[2] = {serif, sans};
  const size_t size[2] = {serif_size, sans_size};
  for (int i = 0; i < 2; i++) {
    if (!data[i] || size[i] < 12 || !stbtt_InitFont(&fonts->info[i], data[i], stbtt_GetFontOffsetForIndex(data[i], 0))) return false;
    int a, d, g;
    stbtt_GetFontVMetrics(&fonts->info[i], &a, &d, &g);
    fonts->ascent[i] = (float)a, fonts->descent[i] = (float)-d, fonts->gap[i] = (float)g;
    fonts->units[i] = 1.0f / stbtt_ScaleForMappingEmToPixels(&fonts->info[i], 1.0f);
  }
  fonts->arena = (uint8_t*)std::malloc(Fonts::kArena);
  if (!fonts->arena) return false;
  fonts_ = std::move(fonts);
  return true;
}
bool Canvas::has_fonts() const { return fonts_ != nullptr; }

namespace {
/** Capitals for Latin-1 and the commonest accents; the rest as they are. */
uint32_t upper(uint32_t c) {
  if (c >= 'a' && c <= 'z') return c - 32;
  if (c >= 0xE0 && c <= 0xFE && c != 0xF7) return c - 32;
  if (c >= 0x100 && c <= 0x17F && (c & 1) && c != 0x131 && c != 0x138 && c != 0x149 && c != 0x17F) return c - 1;
  return c;
}
int strike(float px) { return px < 22 ? 1 : 2; }
}  // namespace

const Canvas::Glyph* Canvas::glyph(const Type& type, uint32_t codepoint) {
  Fonts& f = *fonts_;
  const uint32_t q = (uint32_t)std::lround(type.px * 4);
  const uint32_t style = 1u | (type.face == Typeface::Sans ? 2u : 0u) | (type.bold ? 4u : 0u) | (q << 3);
  uint32_t at = (codepoint * 2654435761u ^ style * 40503u) & (Fonts::kSlots - 1);
  for (;; at = (at + 1) & (Fonts::kSlots - 1)) {
    Glyph& g = f.slots[at];
    if (g.style == 0) break;
    if (g.style == style && g.codepoint == codepoint) return &g;
  }
  // Not cached: make room, then rasterize.
  if (f.used >= Fonts::kSlots * 3 / 4) {
    f.flush();
    return glyph(type, codepoint);
  }
  int face = type.face == Typeface::Sans ? 1 : 0;
  int index = stbtt_FindGlyphIndex(&f.info[face], (int)codepoint);
  if (!index) {
    face = 1 - face;
    index = stbtt_FindGlyphIndex(&f.info[face], (int)codepoint);
  }
  Glyph g;
  g.codepoint = codepoint, g.style = style, g.face = (uint8_t)face, g.index = index;
  if (index) {
    const float scale = type.px / f.units[face];
    int adv, lsb, x0, y0, x1, y1;
    stbtt_GetGlyphHMetrics(&f.info[face], index, &adv, &lsb);
    stbtt_GetGlyphBitmapBox(&f.info[face], index, scale, scale, &x0, &y0, &x1, &y1);
    const int bold = type.bold ? strike(type.px) : 0;
    g.advance = adv * scale + (float)bold;
    g.left = (int16_t)x0, g.top = (int16_t)y0;
    const int w = x1 - x0, h = y1 - y0;
    if (w > 0 && h > 0) {
      const size_t need = (size_t)(w + bold) * h;
      if (need > Fonts::kArena) return nullptr;
      if (f.arena_used + need > Fonts::kArena) {
        f.flush();
        return glyph(type, codepoint);
      }
      uint8_t* out = f.arena + f.arena_used;
      g.w = (uint16_t)(w + bold), g.h = (uint16_t)h, g.offset = (uint32_t)f.arena_used;
      f.arena_used += need;
      std::memset(out, 0, need);
      stbtt_MakeGlyphBitmap(&f.info[face], out, w, h, w + bold, scale, scale, index);
      // A double strike: the coverage of the glyph and of itself moved right, joined.
      for (int s = 0; s < bold; s++)
        for (int row = 0; row < h; row++) {
          uint8_t* line = out + (size_t)row * (w + bold);
          for (int col = w + s; col > 0; col--) {
            const int a = line[col], b = line[col - 1];
            line[col] = (uint8_t)(a + b - a * b / 255);
          }
        }
    }
  }
  f.slots[at] = g;
  f.used++;
  return &f.slots[at];
}

float Canvas::measure(const char* text, size_t length, const Type& type) {
  if (!fonts_) return 0;
  float pen = 0;
  int last_index = 0, last_face = -1;  // copies: a later lookup may reuse the slot
  for (const char *p = text, *end = text + length; p < end;) {
    uint32_t c = utf8::next(p, end);
    if (c == utf8::kSkip) continue;
    if (type.caps) c = upper(c);
    const Glyph* g = glyph(type, c);
    if (!g || !g->index) continue;
    if (last_face == g->face) pen += stbtt_GetGlyphKernAdvance(&fonts_->info[g->face], last_index, g->index) * type.px / fonts_->units[g->face];
    pen += g->advance + type.tracking;
    last_index = g->index, last_face = g->face;
  }
  return last_face >= 0 ? pen - type.tracking : 0;
}

float Canvas::text(float x, float y, const char* text, size_t length, const Type& type, Rgb color, int opacity) {
  if (!fonts_) return x;
  float pen = x;
  const int base = (int)std::lround(y);
  uint32_t last_index = 0;
  int last_face = -1;
  for (const char *p = text, *end = text + length; p < end;) {
    uint32_t c = utf8::next(p, end);
    if (c == utf8::kSkip) continue;
    if (type.caps) c = upper(c);
    const Glyph* g = glyph(type, c);
    if (!g || !g->index) continue;
    if (last_face == g->face) pen += stbtt_GetGlyphKernAdvance(&fonts_->info[g->face], (int)last_index, g->index) * type.px / fonts_->units[g->face];
    if (g->w) blit_mask((int)std::lround(pen) + g->left, base + g->top, fonts_->arena + g->offset, g->w, g->h, g->w, color, opacity);
    pen += g->advance + type.tracking;
    last_index = (uint32_t)g->index, last_face = g->face;
  }
  return pen;
}

float Canvas::line_height(const Type& type) {
  if (!fonts_) return type.px;
  const int i = type.face == Typeface::Sans ? 1 : 0;
  return (fonts_->ascent[i] + fonts_->descent[i] + fonts_->gap[i]) * type.px / fonts_->units[i];
}

float Canvas::baseline(float top, const Type& type, float line_height) {
  if (!fonts_) return top + type.px;
  const int i = type.face == Typeface::Sans ? 1 : 0;
  const float k = type.px / fonts_->units[i];
  const float content = (fonts_->ascent[i] + fonts_->descent[i]) * k;
  const float box = line_height > 0 ? line_height : content + fonts_->gap[i] * k;
  return top + (box - content) / 2 + fonts_->ascent[i] * k;
}

}  // namespace botkins
