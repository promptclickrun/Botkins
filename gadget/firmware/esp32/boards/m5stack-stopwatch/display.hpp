#pragma once
#include <cstdint>

#include "esp_lcd_types.h"

namespace stopwatch {

/** The round 466x466 AMOLED. Pixels are RGB565 with their two bytes swapped (big-endian on the wire). */
class Display {
 public:
  static constexpr int kWidth = 466, kHeight = 466;
  bool begin();
  uint16_t* frame() { return frame_; }
  /** Sends the whole frame (about 30 ms): bands through two DMA buffers, one filled while the other goes. */
  void flush();
  /** The panel's own brightness (DCS 0x51, Write Display Brightness), 0 to 100. */
  bool brightness(uint8_t percent);
  /** The panel's output on or off (DCS 0x29 / 0x28). Off keeps the panel's memory: drawing goes on. */
  bool output(bool on);

 private:
  uint16_t* frame_ = nullptr;
  uint16_t* band_[2] = {nullptr, nullptr};
  esp_lcd_panel_handle_t panel_ = nullptr;
};

}  // namespace stopwatch
