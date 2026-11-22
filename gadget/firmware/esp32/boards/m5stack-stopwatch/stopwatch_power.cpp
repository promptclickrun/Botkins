// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/drivers/stopwatch.cpp (StopWatchControl::begin, set_amplifier)
// and firmware/esp32/main/port_stopwatch.cpp (StopWatchBoard::begin). The register sequence is
// theirs, unchanged; the battery, key and power-off parts are left out.
#include "stopwatch_power.hpp"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace stopwatch {
namespace {
const char* TAG = "stopwatch.power";
constexpr uint8_t kPm1 = 0x6E, kIoe = 0x4F;

// M5PM1 registers, from M5Stack's M5PM1 library (src/M5PM1.h, commit 315d2899).
constexpr uint8_t kI2cConfig = 0x09;  // 0 = no I2C idle sleep
constexpr uint8_t kWatchdog = 0x0A;   // 0 = watchdog off
constexpr uint8_t kIrqMask1 = 0x43, kIrqMask2 = 0x44, kIrqMask3 = 0x45;  // 1 = masked
constexpr uint8_t kButtonConfig = 0x49;
// The PM1 acts on its key by itself: a single click resets the ESP32, a double click powers
// off, a long press enters download mode. The single-click reset goes; the long press is put
// at its longest, 4 s.
constexpr uint8_t kNoClickReset = 1 << 0, kLongPressMask = 0x18, kLongPress4s = 0x18;

// M5IOE1 registers, from M5Stack's M5IOE1 library (src/M5IOE1.h, commit 8401119b): the pin
// registers are two bytes, low first, one bit per pin (M5Stack's labels PYG1.. are bits 0..).
constexpr uint8_t kIoeMode = 0x03;       // 1 = output
constexpr uint8_t kIoeOut = 0x05;
constexpr uint8_t kIoeOpenDrain = 0x13;  // 0 = push-pull
constexpr uint8_t kIoePwm1 = 0x1B;       // the vibration motor's duty, bit 15 enables; 0 = off
constexpr uint8_t kIoeI2cConfig = 0x23;  // one byte, low nibble = I2C idle sleep in seconds
constexpr uint16_t kAudioSupply = 1 << 2;  // PYG3, AU_EN: codec and microphone
constexpr uint16_t kTouchReset = 1 << 3;   // PYG4, active low
constexpr uint16_t kPanelReset = 1 << 4;   // PYG5, active low
constexpr uint16_t kPanelSupply = 1 << 7;  // PYG8, L3B_EN
constexpr uint16_t kMotor = 1 << 8;        // PYG9
constexpr uint16_t kAmplifier = 1 << 9;    // PYG10, SPK_EN
constexpr uint16_t kOutputs = kAudioSupply | kTouchReset | kPanelReset | kPanelSupply | kMotor | kAmplifier;

bool add(i2c_master_bus_handle_t bus, uint8_t addr, uint32_t hz, i2c_master_dev_handle_t* dev) {
  if (i2c_master_probe(bus, addr, 50) != ESP_OK) return false;
  i2c_device_config_t cfg = {};
  cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
  cfg.device_address = addr;
  cfg.scl_speed_hz = hz;
  return i2c_master_bus_add_device(bus, &cfg, dev) == ESP_OK;
}
void delay(uint32_t ms) { vTaskDelay(pdMS_TO_TICKS(ms)); }
}  // namespace

bool Power::pm1_read(uint8_t reg, uint8_t* data, size_t size) { return i2c_master_transmit_receive(pm1_, &reg, 1, data, size, 50) == ESP_OK; }
bool Power::pm1_write(uint8_t reg, uint8_t value) {
  const uint8_t data[] = {reg, value};
  return i2c_master_transmit(pm1_, data, sizeof(data), 50) == ESP_OK;
}
bool Power::ioe_read(uint8_t reg, uint8_t* data, size_t size) { return i2c_master_transmit_receive(ioe_, &reg, 1, data, size, 50) == ESP_OK; }
// The expander's registers are 16 bits wide, low byte first.
bool Power::ioe_write(uint8_t reg, uint16_t value) {
  const uint8_t data[] = {reg, static_cast<uint8_t>(value & 0xFF), static_cast<uint8_t>(value >> 8)};
  return i2c_master_transmit(ioe_, data, sizeof(data), 50) == ESP_OK;
}

bool Power::pm1_change(uint8_t reg, uint8_t mask, uint8_t value) {
  uint8_t previous;
  if (!pm1_read(reg, &previous, 1)) return false;
  const auto next = static_cast<uint8_t>((previous & ~mask) | (value & mask));
  return next == previous || pm1_write(reg, next);
}

bool Power::ioe_change(uint8_t reg, uint16_t mask, uint16_t value) {
  uint8_t raw[2];
  if (!ioe_read(reg, raw, 2)) return false;
  const auto previous = static_cast<uint16_t>(raw[0] | (raw[1] << 8));
  const auto next = static_cast<uint16_t>((previous & ~mask) | (value & mask));
  return next == previous || ioe_write(reg, next);
}

bool Power::begin(i2c_master_bus_handle_t bus) {
  // 100 kHz for both, the vendor's clock for them.
  if (!bus || !add(bus, kPm1, 100000, &pm1_) || !add(bus, kIoe, 100000, &ioe_)) {
    ESP_LOGE(TAG, "M5PM1 or M5IOE1 not found");
    return false;
  }
  // Both chips stay powered through an ESP32 reset, so an earlier firmware may
  // have left their I2C idle sleep or the PM1's watchdog on.
  if (!pm1_write(kI2cConfig, 0x00) || !pm1_write(kWatchdog, 0x00)) return false;
  if (!pm1_change(kButtonConfig, kNoClickReset | kLongPressMask, kNoClickReset | kLongPress4s)) return false;
  // Nothing may pull the PM1's interrupt line.
  if (!pm1_write(kIrqMask1, 0x1F) || !pm1_write(kIrqMask2, 0x3F) || !pm1_write(kIrqMask3, 0x07)) return false;

  // Levels before directions: supplies on, both resets released, motor and
  // amplifier off. The expander's other pins keep their configuration.
  if (!ioe_change(kIoeI2cConfig, 0x000F, 0) || !ioe_write(kIoePwm1, 0x0000)) return false;
  if (!ioe_change(kIoeOpenDrain, kOutputs, 0) || !ioe_change(kIoeOut, kOutputs, kAudioSupply | kPanelSupply | kTouchReset | kPanelReset) ||
      !ioe_change(kIoeMode, kOutputs, kOutputs))
    return false;
  amplifier_ = false;
  delay(20);  // the panel's rail settles before its reset
  if (!ioe_change(kIoeOut, kTouchReset | kPanelReset, 0)) return false;
  delay(10);
  if (!ioe_change(kIoeOut, kTouchReset | kPanelReset, kTouchReset | kPanelReset)) return false;
  delay(120);  // the CO5300 wakes
  ESP_LOGI(TAG, "supplies on, panel and touch reset");
  return true;
}

bool Power::set_amplifier(bool on) {
  if (on == amplifier_) return true;
  if (!ioe_change(kIoeOut, kAmplifier, on ? kAmplifier : 0)) return false;
  amplifier_ = on;
  return true;
}

}  // namespace stopwatch
