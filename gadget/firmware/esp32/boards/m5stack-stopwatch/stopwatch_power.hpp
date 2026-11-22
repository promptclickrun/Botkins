// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/drivers/stopwatch.hpp and firmware/esp32/main/port.hpp (StopWatchBoard).
//
// The M5Stack StopWatch's two helper chips on the internal I2C bus. Neither its panel, its
// touch controller, its codec nor its amplifier has an ESP32 pin for power or reset: the M5IOE1
// I/O expander (0x4F) switches the audio and AMOLED supplies, pulses the touch and panel resets
// and enables the AW8737A amplifier. The M5PM1 power manager (0x6E) is configured once (no I2C
// idle sleep, no watchdog, its key's single-click reset off, its interrupts masked) and otherwise
// left alone: no rail voltage or charger setting is written.
#pragma once
#include <cstddef>
#include <cstdint>

#include "driver/i2c_master.h"

namespace stopwatch {

class Power {
 public:
  /** The supplies come on, the touch controller and the panel get their reset pulse, and the amplifier stays off. */
  bool begin(i2c_master_bus_handle_t bus);
  /** Writes only on a change. */
  bool set_amplifier(bool on);

 private:
  bool pm1_read(uint8_t reg, uint8_t* data, size_t size);
  bool pm1_write(uint8_t reg, uint8_t value);
  bool ioe_read(uint8_t reg, uint8_t* data, size_t size);
  bool ioe_write(uint8_t reg, uint16_t value);
  bool pm1_change(uint8_t reg, uint8_t mask, uint8_t value);
  bool ioe_change(uint8_t reg, uint16_t mask, uint16_t value);
  i2c_master_dev_handle_t pm1_ = nullptr, ioe_ = nullptr;
  bool amplifier_ = false;
};

}  // namespace stopwatch
