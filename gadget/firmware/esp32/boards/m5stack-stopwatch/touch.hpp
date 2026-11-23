// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/drivers/cst816.hpp (the report at register 0x02, the release
// after five failed polls), firmware/esp32/main/port_touch.cpp (the CST816 path: 400 kHz, the
// 0xFE = 1 write, a 20 ms poll) and firmware/esp32/main/port_stopwatch.cpp (the CST820 at 0x15 on
// the StopWatch's internal bus, told to stay awake).
//
// The StopWatch's touch controller, a CST820 (it sends the CST816's report). It has no ESP32 pin
// for reset: the M5IOE1 pulses it in stopwatch::Power::begin. Its INT line (GPIO 13) is not used;
// the controller is polled.
#pragma once
#include <cstdint>

#include "driver/i2c_master.h"

namespace stopwatch {

class Touch {
 public:
  static constexpr int kWidth = 466, kHeight = 466;
  /** After Power::begin. False when the controller doesn't answer. */
  bool begin(i2c_master_bus_handle_t bus);
  /**
   * One poll (every 20 ms). True when a finger was lifted: (x, y) is where it first came down, in
   * panel pixels.
   */
  bool poll(int& x, int& y);

 private:
  bool read(bool& down, int& x, int& y);
  i2c_master_dev_handle_t dev_ = nullptr;
  bool held_ = false;
  int down_x_ = 0, down_y_ = 0;
  uint8_t failures_ = 0;
};

}  // namespace stopwatch
