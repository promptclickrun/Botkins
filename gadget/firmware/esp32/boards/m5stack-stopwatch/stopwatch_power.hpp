// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/drivers/stopwatch.hpp and firmware/esp32/main/port.hpp (StopWatchBoard),
// and StopWatchControl::take_key_press for the red key.
//
// The M5Stack StopWatch's two helper chips on the internal I2C bus. Neither its panel, its
// touch controller, its codec nor its amplifier has an ESP32 pin for power or reset: the M5IOE1
// I/O expander (0x4F) switches the audio and AMOLED supplies, pulses the touch and panel resets
// and enables the AW8737A amplifier. The M5PM1 power manager (0x6E) manages the red power key,
// status LED, and hardware power-off.
#pragma once
#include <cstddef>
#include <cstdint>

#include "driver/i2c_master.h"

namespace stopwatch {

class Power {
 public:
  enum class RedEvent { None, ShortPress, LongHold };

  /** The supplies come on, the touch controller and the panel get their reset pulse, and the amplifier stays off. */
  bool begin(i2c_master_bus_handle_t bus);
  /** Writes only on a change. */
  bool set_amplifier(bool on);
  /** Controls the M5PM1 green status LED (LED_EN). Off uses open-drain low so the PM1 cannot blink it. */
  bool set_status_led(bool on);
  /**
   * The red key, read from the M5PM1 (call every 100 ms):
   * - LongHold fires once while held (~800 ms), well before the PM1's 4 s download-mode hold.
   * - ShortPress fires on release of a press shorter than ~800 ms.
   */
  RedEvent poll_red();
  /** Powers the board off via the M5PM1 (cuts 3.3V DC/DC; holding/pressing the red key boots it back up). */
  bool power_off();

 private:
  bool pm1_read(uint8_t reg, uint8_t* data, size_t size);
  bool pm1_write(uint8_t reg, uint8_t value);
  bool ioe_read(uint8_t reg, uint8_t* data, size_t size);
  bool ioe_write(uint8_t reg, uint16_t value);
  bool pm1_change(uint8_t reg, uint8_t mask, uint8_t value);
  bool ioe_change(uint8_t reg, uint16_t mask, uint16_t value);
  i2c_master_dev_handle_t pm1_ = nullptr, ioe_ = nullptr;
  bool amplifier_ = false;
  bool red_down_ = false;
  bool red_hold_fired_ = false;
  uint8_t red_polls_ = 0;  // polls the red key has been down for, saturating
};

}  // namespace stopwatch
