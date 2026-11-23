// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/drivers/cst816.hpp (cst816_touch, Cst816Fault) and
// firmware/esp32/main/port_touch.cpp and port_stopwatch.cpp (the CST816 set-up and poll). What
// changed: one controller only, and a tap (where the finger came down, reported on its lift)
// instead of every sample.
#include "touch.hpp"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace stopwatch {
namespace {
const char* TAG = "stopwatch.touch";
constexpr uint8_t kAddress = 0x15;
constexpr uint8_t kReport = 0x02;     // count, X high/low, Y high/low
constexpr uint8_t kStayAwake = 0xFE;  // 1: no auto sleep (asleep, the CST820 answers no read)
constexpr uint8_t kReleaseAfter = 5;  // failed polls before a held touch is let go
}  // namespace

bool Touch::begin(i2c_master_bus_handle_t bus) {
  if (!bus || i2c_master_probe(bus, kAddress, 50) != ESP_OK) {
    ESP_LOGW(TAG, "no touch controller at 0x%02x", kAddress);
    return false;
  }
  i2c_device_config_t cfg = {};
  cfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
  cfg.device_address = kAddress;
  cfg.scl_speed_hz = 400000;
  if (i2c_master_bus_add_device(bus, &cfg, &dev_) != ESP_OK) return false;
  const uint8_t stay_awake[] = {kStayAwake, 0x01};
  if (i2c_master_transmit(dev_, stay_awake, sizeof stay_awake, 50) != ESP_OK) ESP_LOGW(TAG, "touch controller kept its auto sleep");
  vTaskDelay(pdMS_TO_TICKS(10));
  ESP_LOGI(TAG, "CST820 ready");
  return true;
}

bool Touch::read(bool& down, int& x, int& y) {
  const uint8_t reg = kReport;
  uint8_t data[5] = {};
  if (i2c_master_transmit_receive(dev_, &reg, 1, data, sizeof data, 20) != ESP_OK) return false;
  down = (data[0] & 0x0F) != 0;
  x = ((data[1] & 0x0F) << 8) | data[2];
  y = ((data[3] & 0x0F) << 8) | data[4];
  return !down || (x < kWidth && y < kHeight);
}

bool Touch::poll(int& x, int& y) {
  if (!dev_) return false;
  bool down = false;
  int at_x = 0, at_y = 0;
  if (!read(down, at_x, at_y)) {
    // Five failed polls (about 100 ms): a touch still held is let go, once.
    if (failures_ < kReleaseAfter) failures_++;
    if (held_ && failures_ >= kReleaseAfter) {
      held_ = false;
      ESP_LOGW(TAG, "held touch released after %d failed polls", kReleaseAfter);
      x = down_x_, y = down_y_;
      return true;
    }
    return false;
  }
  failures_ = 0;
  if (down && !held_) {
    held_ = true;
    down_x_ = at_x, down_y_ = at_y;
    return false;
  }
  if (!down && held_) {
    held_ = false;
    x = down_x_, y = down_y_;
    return true;
  }
  return false;
}

}  // namespace stopwatch
