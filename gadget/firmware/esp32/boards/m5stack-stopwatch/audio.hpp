// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/esp32/main/port_codec.cpp (CodecAudio, CodecSpeaker), for the
// StopWatch's one ES8311 (speaker and microphone on one duplex I2S bus) only.
#pragma once
#include <atomic>
#include <functional>
#include <mutex>

#include "botkins/hal.hpp"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "stopwatch_power.hpp"

namespace stopwatch {

/** The ES8311: speaker out and microphone in, both 16-bit mono at kRate (they share the I2S clocks). */
class Audio : public botkins::Speaker {
 public:
  static constexpr int kRate = 16000;
  bool begin(i2c_master_bus_handle_t bus, Power* power);
  /** Called from the microphone task with each 20 ms of samples. */
  std::function<void(const int16_t*, size_t)> on_samples;

  // botkins::Speaker
  bool begin(int rate) override;
  void write(const int16_t* samples, size_t count) override;
  void end(bool cut) override;
  /** Drops what is queued at once (a button press while it speaks, or the core asking for quiet). */
  void cut() override;
  bool playing() const { return playing_; }

  /** The output volume, 0 to 100 (0 is silent). Taken by the speaker task before its next write. */
  void set_volume(int percent);
  /** The microphone's gain in dB (the ES8311 has 6 dB steps: 18, 24, 30 ...). Taken by the microphone task. */
  void set_mic_gain(int db);
  /** 100 ms of a 1 kHz tone at the volume set, so a volume step is heard. Nothing when something else plays. */
  void tick();

 private:
  static void mic_task(void* self);
  static void speaker_task(void* self);
  void amplifier(bool on);
  Power* power_ = nullptr;
  i2s_chan_handle_t tx_ = nullptr, rx_ = nullptr;
  esp_codec_dev_handle_t dev_ = nullptr;
  StreamBufferHandle_t queue_ = nullptr;
  SemaphoreHandle_t drained_ = nullptr;
  std::atomic<bool> open_{false}, closing_{false}, flush_{false}, playing_{false}, writing_{false};
  std::atomic<int> volume_{60}, mic_gain_{24};
  std::mutex send_;  // the queue takes one writer at a time: the core's reply, or a tick
};

}  // namespace stopwatch
