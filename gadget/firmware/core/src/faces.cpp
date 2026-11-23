// The Botkin's faces and the panel's icons: SVG drawn with nanosvg at the size asked, kept as
// rasters until the look changes. A parsed SVG is let go once drawn; only the rasters stay.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "botkins/draw.hpp"

#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wsign-compare"
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wunused-variable"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#pragma GCC diagnostic ignored "-Wimplicit-fallthrough"
#pragma GCC diagnostic ignored "-Wshadow"
#endif
#define NANOSVG_IMPLEMENTATION
#include "../third_party/nanosvg/nanosvg.h"
#define NANOSVGRAST_IMPLEMENTATION
#include "../third_party/nanosvg/nanosvgrast.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#include "default_face.inc"

namespace botkins {
namespace {

constexpr Rgb kShellFallback = hex(0x6FA596);

/**
 * The shell colour of a face: the fill of its largest `data-role="shell"` path (the body, not
 * the outline or a shadow), a fifth of the way to white so it reads on black.
 */
bool shell_colour(const char* svg, Rgb* out) {
  size_t best = 0;
  bool found = false;
  for (const char* at = std::strstr(svg, "data-role=\"shell\""); at; at = std::strstr(at + 1, "data-role=\"shell\"")) {
    const char* open = at;
    while (open > svg && *open != '<') open--;
    const char* close = std::strchr(at, '>');
    if (!close) break;
    const std::string tag(open, close);
    const size_t fill = tag.find(" fill=\"#");
    const size_t d = tag.find(" d=\"");
    if (fill == std::string::npos || d == std::string::npos) continue;
    const size_t d_end = tag.find('"', d + 4);
    const size_t length = d_end == std::string::npos ? 0 : d_end - d;
    unsigned value = 0;
    if (length <= best || std::sscanf(tag.c_str() + fill + 8, "%6x", &value) != 1 || tag.compare(fill + 14, 1, "\"") != 0) continue;
    best = length;
    found = true;
    *out = hex(value);
  }
  if (found) {
    auto lift = [](uint8_t c) { return (uint8_t)(c + (255 - c) / 5); };
    *out = Rgb{lift(out->r), lift(out->g), lift(out->b)};
  }
  return found;
}

NSVGimage* parse(const char* svg) {
  std::vector<char> text(svg, svg + std::strlen(svg) + 1);  // nanosvg parses in place
  return nsvgParse(text.data(), "px", 96.0f);
}

}  // namespace

struct Faces::Impl {
  struct Raster {
    std::string pose;  // "" for the Botkin in its original colours
    bool fallback = false;
    int size = 0;
    uint8_t* rgba = nullptr;
  };
  struct Shell {
    std::string pose;
    Rgb colour;
  };
  struct Icon {
    const char* svg;
    int size;
    uint8_t* alpha;
  };
  NSVGrasterizer* rasterizer = nullptr;
  std::string look;
  std::vector<Raster> rasters;  // for `look`
  std::vector<Shell> shells;    // for `look`
  std::vector<Icon> icons;

  ~Impl() {
    forget();
    for (Icon& i : icons) std::free(i.alpha);
    if (rasterizer) nsvgDeleteRasterizer(rasterizer);
  }
  void forget() {
    for (Raster& r : rasters) std::free(r.rgba);
    rasters.clear();
    shells.clear();
  }
  void follow(const View& view) {
    if (view.look == look) return;
    forget();
    look = view.look;
  }
  /** The SVG the view has for `pose`, or null. */
  static const char* svg_for(const View& view, const char* pose) {
    if (!view.faces) return nullptr;
    auto it = view.faces->find(pose);
    return it == view.faces->end() || it->second.empty() ? nullptr : it->second.c_str();
  }
  /**
   * The raster of `pose` at `size` from `svg` (null: the original Botkin), drawn on first use: the
   * SVG is parsed, drawn and let go. One buffer for each pose and size; it is drawn again in place
   * when the pose's own face arrives after the original stood in for it.
   */
  const uint8_t* raster(const char* svg, const char* pose, int size) {
    bool fallback = svg == nullptr;
    Raster* slot = nullptr;
    for (Raster& r : rasters)
      if (r.size == size && r.pose == pose) slot = &r;
    if (slot && slot->rgba && slot->fallback == fallback) return slot->rgba;
    NSVGimage* image = parse(svg ? svg : kDefaultFace);
    if (!image && svg) {  // a face that can't be read: the original instead
      fallback = true;
      image = parse(kDefaultFace);
    }
    if (!slot) {
      rasters.push_back(Raster());
      slot = &rasters.back();
      slot->pose = pose;
      slot->size = size;
      slot->rgba = (uint8_t*)std::malloc((size_t)size * size * 4);
    }
    slot->fallback = fallback;
    const bool ok = slot->rgba && rasterize(image, size, slot->rgba);
    nsvgDelete(image);
    return ok ? slot->rgba : nullptr;
  }
  bool rasterize(NSVGimage* image, int size, uint8_t* rgba) {
    if (!rasterizer) rasterizer = nsvgCreateRasterizer();
    if (!rasterizer || !image || image->width <= 0 || image->height <= 0) return false;
    const float scale = (float)size / std::fmax(image->width, image->height);
    const float tx = ((float)size - image->width * scale) / 2, ty = ((float)size - image->height * scale) / 2;
    std::memset(rgba, 0, (size_t)size * size * 4);
    nsvgRasterize(rasterizer, image, tx, ty, scale, rgba, size, size, size * 4);
    return true;
  }
};

Faces::Faces() : impl_(new Impl()) {}
Faces::~Faces() = default;

const uint8_t* Faces::face(const View& view, const char* pose, int size) {
  if (size <= 0) return nullptr;
  impl_->follow(view);
  return impl_->raster(Impl::svg_for(view, pose), pose, size);
}

const uint8_t* Faces::original(int size) { return size > 0 ? impl_->raster(nullptr, "", size) : nullptr; }

Rgb Faces::shell(const View& view, const char* pose) {
  Impl& m = *impl_;
  m.follow(view);
  // A pose with no face of its own still takes the bot's colour, from its resting face.
  if (!Impl::svg_for(view, pose) && Impl::svg_for(view, "ready")) pose = "ready";
  for (const Impl::Shell& s : m.shells)
    if (s.pose == pose) return s.colour;
  const char* svg = Impl::svg_for(view, pose);
  Rgb colour = kShellFallback;
  shell_colour(svg ? svg : kDefaultFace, &colour);
  m.shells.push_back(Impl::Shell{pose, colour});
  return colour;
}

const uint8_t* Faces::icon(const char* svg, int size) {
  Impl& m = *impl_;
  for (Impl::Icon& i : m.icons)
    if (i.svg == svg && i.size == size) return i.alpha;
  NSVGimage* image = parse(svg);
  std::vector<uint8_t> rgba((size_t)size * size * 4);
  uint8_t* alpha = (uint8_t*)std::malloc((size_t)size * size);
  if (!image || !alpha || !m.rasterize(image, size, rgba.data())) {
    nsvgDelete(image);
    std::free(alpha);
    return nullptr;
  }
  nsvgDelete(image);
  for (size_t i = 0; i < (size_t)size * size; i++) alpha[i] = rgba[i * 4 + 3];
  m.icons.push_back(Impl::Icon{svg, size, alpha});
  return alpha;
}

size_t Faces::memory() const {
  size_t bytes = 0;
  for (const Impl::Raster& r : impl_->rasters) bytes += (size_t)r.size * r.size * 4;
  for (const Impl::Icon& i : impl_->icons) bytes += (size_t)i.size * i.size;
  return bytes;
}

}  // namespace botkins
