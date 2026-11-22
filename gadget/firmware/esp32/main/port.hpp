// What every ESP32 board shares: NVS storage, Wi-Fi as a station, the USB console.
#pragma once
#include <atomic>
#include <mutex>
#include <string>

#include "botkins/gadget.hpp"
#include "nvs.h"

namespace port {

/** The core's few named values, as blobs in the NVS namespace "botkins". */
class NvsStorage : public botkins::Storage {
 public:
  bool begin();
  bool load(const char* name, std::string& value) override;
  void save(const char* name, const std::string& value) override;
  void erase(const char* name) override;

 private:
  std::mutex mutex_;
  nvs_handle_t handle_ = 0;
  bool open_ = false;
};

/** Reads the Wi-Fi network an earlier firmware saved (NVS namespace "hgadget"), read-only. */
bool earlier_wifi(std::string& ssid, std::string& password);

/** Wi-Fi as a station: "off", "joining", "on" or "failed", and it rejoins by itself. */
class WifiNetwork : public botkins::Network {
 public:
  /** Starts the driver with no network (the radio is on: the chip's random numbers are true ones from here). */
  bool begin();
  void join(const std::string& ssid, const std::string& password) override;
  const char* state() override;
  std::string address() override;

 private:
  static void on_event(void* self, const char* base, int32_t id, void* data);
  void retry_later();
  std::mutex mutex_;
  std::string ssid_, password_;
  std::atomic<int> state_{0};  // 0 off, 1 joining, 2 on, 3 failed
  std::string address_;
  int failures_ = 0;
  void* timer_ = nullptr;
};

/** Reads lines from the USB-Serial-JTAG port, hands each to `gadget.console()` and prints the answer. */
void start_console(botkins::Gadget& gadget);

/** Free internal heap and PSRAM, now and the least since boot, as one log line. */
void log_heap(const char* when);

}  // namespace port
