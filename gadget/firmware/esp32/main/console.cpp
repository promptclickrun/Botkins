// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// The interrupt clean-up before the USB-Serial-JTAG driver is installed is adapted from Hermes
// Gadget firmware/esp32/main/port_console.cpp; the rest is this port's own.
//
// The USB console. The boot log and the setup protocol share the port (gadget/docs/contract.md,
// "Setup over USB"): each line that comes in goes to gadget.console(), and its answer, one line
// starting with "@botkins ", is printed whole.
//
// The port runs ESP-IDF's USB-Serial-JTAG driver, and stdout goes through it: a log write that no
// program on the computer reads gives up after 50 ms (usb_serial_jtag_vfs.c), so logging never
// holds a task. Answers are written to the driver directly and wait longer (answer_line).
#include <atomic>
#include <cstdio>
#include <string>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hal/usb_serial_jtag_ll.h"
#include "port.hpp"

namespace port {
namespace {
const char* TAG = "botkins.console";
const size_t kMaxLine = 8192;
botkins::Gadget* g_gadget = nullptr;

// The least free memory since `heap reset`, sampled by the heap task.
std::atomic<size_t> g_low_internal{SIZE_MAX}, g_low_psram{SIZE_MAX};

/**
 * One answer line, whole. The log's lines go through stdout, where a byte that can't be queued
 * within 50 ms is dropped (usb_serial_jtag_vfs.c), so a computer that is slow to read for a moment
 * loses part of a line: an answer would then not parse. Answers go to the driver itself and wait
 * up to a second for room, with stdout held so no log line lands inside one.
 */
void answer_line(const std::string& answer) {
  const std::string line = answer + "\n";
  flockfile(stdout);
  fflush(stdout);
  for (size_t at = 0; at < line.size();) {
    const size_t piece = line.size() - at < 512 ? line.size() - at : 512;
    if (usb_serial_jtag_write_bytes(line.data() + at, piece, pdMS_TO_TICKS(1000)) <= 0) break;  // no computer reading
    at += piece;
  }
  funlockfile(stdout);
}

void handle(const std::string& line) {
  const std::string answer = g_gadget->console(line);
  if (!answer.empty()) {
    answer_line(answer);
    return;
  }
  // Two lines of the port's own, for measuring: "heap" and "heap reset".
  if (line == "heap") log_heap("asked");
  else if (line == "heap reset") {
    g_low_internal = SIZE_MAX;
    g_low_psram = SIZE_MAX;
    log_heap("reset");
  }
}

void console_task(void*) {
  std::string line;
  bool too_long = false;
  char chunk[256];
  for (;;) {
    const int got = usb_serial_jtag_read_bytes(chunk, sizeof chunk, pdMS_TO_TICKS(1000));
    for (int i = 0; i < got; i++) {
      const char c = chunk[i];
      if (c == '\n' || c == '\r') {
        if (!line.empty() && !too_long) handle(line);
        if (too_long) answer_line("@botkins {\"error\":\"That line is too long.\"}");
        line.clear();
        too_long = false;
      } else if (line.size() < kMaxLine) line += c;
      else too_long = true;
    }
  }
}

/** Installs the driver and moves stdout onto it. */
bool install() {
  // The USB Serial/JTAG block keeps its interrupt enables and status through a software reset,
  // and the driver adds its two (bytes received, send buffer empty) without clearing the rest;
  // its handler acknowledges only those two. An M5Stack StopWatch came up with BUS_RESET
  // enabled as well after esptool had talked to it, and then restarted from the interrupt
  // watchdog (Hermes Gadget's finding). So only the driver's own interrupts stay enabled, and
  // whatever else is pending is acknowledged.
  constexpr uint32_t kDriverInterrupts = USB_SERIAL_JTAG_INTR_SERIAL_OUT_RECV_PKT | USB_SERIAL_JTAG_INTR_SERIAL_IN_EMPTY;
  const uint32_t enabled = usb_serial_jtag_ll_get_intr_ena_status();
  if (enabled & ~kDriverInterrupts) ESP_LOGW(TAG, "usb serial/jtag had interrupts enabled that nothing handles (0x%04x); disabling them", (unsigned)enabled);
  usb_serial_jtag_ll_disable_intr_mask(~kDriverInterrupts);
  usb_serial_jtag_ll_clr_intsts_mask(~kDriverInterrupts);
  usb_serial_jtag_driver_config_t config = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
  config.rx_buffer_size = 4096;
  config.tx_buffer_size = 8192;
  if (usb_serial_jtag_driver_install(&config) != ESP_OK) {
    ESP_LOGE(TAG, "the USB-Serial-JTAG driver didn't install: no console");
    return false;
  }
  usb_serial_jtag_vfs_use_driver();
  return true;
}

void heap_task(void*) {
  for (;;) {
    const size_t internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const size_t psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    if (internal < g_low_internal) g_low_internal = internal;
    if (psram < g_low_psram) g_low_psram = psram;
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}
}  // namespace

void log_heap(const char* when) {
  ESP_LOGI(TAG, "heap (%s): internal free %u (least %u since reset, %u since boot, largest block %u); psram free %u (least %u since reset, %u since boot)", when,
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)g_low_internal.load(), (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned)g_low_psram.load(),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
}

void start_console(botkins::Gadget& gadget) {
  g_gadget = &gadget;
  xTaskCreate(heap_task, "heap", 2048, nullptr, 1, nullptr);
  if (!install()) return;
  // The setup line holds the introduction and the network as JSON: the line is parsed on this stack.
  xTaskCreate(console_task, "console", 12288, nullptr, 4, nullptr);
}

}  // namespace port
