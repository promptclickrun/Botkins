// The StopWatch's screen as the core draws it (botkins/draw.hpp): one Canvas over the display's
// frame, the two fonts the core component embeds, and the Botkin's faces.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>

#include "botkins/draw.hpp"

namespace stopwatch {

class Screen {
 public:
  enum class Mode { Home, Dimmed, Quick };
  /** `frame` is the display's (466x466, byte-swapped RGB565, in PSRAM). False when the fonts can't be read. */
  bool begin(uint16_t* frame, int width, int height);
  /** "Botkins / Starting", before the gadget has a view. */
  void boot();
  void draw(const botkins::View& view, Mode mode);
  /**
   * Draws one screen the gadget hasn't shown yet with the bot's faces (a pose, dimmed, the quick
   * controls) into the frame, then `shown` again over it, so the first time that pose comes up it
   * isn't held up by drawing its face (about 2 s each on this chip). Call while nothing else waits,
   * and not between a draw and its flush. False when there is nothing left to draw ahead.
   */
  bool warm(const botkins::View& shown, Mode shown_mode);
  /** Bytes the faces' rasters hold. */
  size_t face_memory() const { return faces_.memory(); }

 private:
  void paint(const botkins::View& view, Mode mode);
  std::unique_ptr<botkins::Canvas> canvas_;
  botkins::Faces faces_;
  const void* warm_faces_ = nullptr;  // the face set drawn ahead
  int warm_next_ = 0;
};

}  // namespace stopwatch
