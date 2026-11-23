// Copyright (c) 2026 Hermes Gadget SDK contributors
// SPDX-License-Identifier: MIT
// Adapted from Hermes Gadget firmware/esp32/main/port_codec.cpp (CodecAudio::begin, the CodecMic
// and CodecSpeaker tasks). The I2S and ES8311 settings are theirs for this board (pins MCLK 18,
// BCLK 17, WS 15, DOUT 21, DIN 16; one ES8311 for both directions; its clock from MCLK; amplifier
// supply taken as 3.3 V; microphone gain 24 dB; the AW8737A amplifier through the M5IOE1). What
// changed: both directions run at 16 kHz (theirs at 24 kHz), the volume starts at 60 (theirs 70),
// the speaker follows the Botkins core's Speaker (write blocks while the queue is full, end()
// waits for the queue to play out), and the volume and the microphone's gain follow the gadget's
// settings (set_volume, set_mic_gain; volume 0 leaves the output muted), with a short tick.
#include "audio.hpp"

#include <cstring>

#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/task.h"

namespace stopwatch {
namespace {
const char* TAG = "stopwatch.audio";
constexpr int kMclk = 18, kBclk = 17, kWs = 15, kDout = 21, kDin = 16;
constexpr int kVolume = 60;         // percent until the settings arrive: moderate
constexpr float kMicGainDb = 24.0f;  // the Hermes firmware's gain for this microphone ("normal")
constexpr size_t kMicChunk = 320;    // 20 ms at 16 kHz
constexpr size_t kSpeakerChunk = 512;  // samples per codec write
constexpr int kTickSamples = Audio::kRate / 10;  // 100 ms
// Two seconds of speech: enough to ride over a slow fetch, short enough that `speaking` ends
// close to when the sound does.
constexpr size_t kQueueBytes = 2 * Audio::kRate * 2;
}  // namespace

bool Audio::begin(i2c_master_bus_handle_t bus, Power* power) {
  power_ = power;
  if (!bus) return false;
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
  chan.auto_clear = true;  // silence on underrun instead of repeating the last buffer
  if (i2s_new_channel(&chan, &tx_, &rx_) != ESP_OK) return false;
  i2s_std_config_t std_cfg = {};
  std_cfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(kRate);  // MCLK = 256 x fs
  std_cfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  std_cfg.gpio_cfg.mclk = static_cast<gpio_num_t>(kMclk);
  std_cfg.gpio_cfg.bclk = static_cast<gpio_num_t>(kBclk);
  std_cfg.gpio_cfg.ws = static_cast<gpio_num_t>(kWs);
  std_cfg.gpio_cfg.dout = static_cast<gpio_num_t>(kDout);
  std_cfg.gpio_cfg.din = static_cast<gpio_num_t>(kDin);
  if (i2s_channel_init_std_mode(tx_, &std_cfg) != ESP_OK || i2s_channel_init_std_mode(rx_, &std_cfg) != ESP_OK) {
    ESP_LOGE(TAG, "I2S setup failed");
    return false;
  }
  i2s_channel_enable(tx_);
  i2s_channel_enable(rx_);

  audio_codec_i2s_cfg_t i2s_cfg = {};
  i2s_cfg.port = I2S_NUM_1;
  i2s_cfg.rx_handle = rx_;
  i2s_cfg.tx_handle = tx_;
  const audio_codec_data_if_t* data_if = audio_codec_new_i2s_data(&i2s_cfg);
  const audio_codec_gpio_if_t* gpio_if = audio_codec_new_gpio();
  audio_codec_i2c_cfg_t i2c_cfg = {};
  i2c_cfg.port = I2C_NUM_0;
  i2c_cfg.addr = ES8311_CODEC_DEFAULT_ADDR;  // the 8-bit form; the driver shifts it
  i2c_cfg.bus_handle = bus;
  es8311_codec_cfg_t es8311 = {};
  es8311.ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
  es8311.gpio_if = gpio_if;
  es8311.codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH;  // its ADC is the microphone
  es8311.pa_pin = -1;  // the amplifier is the M5IOE1's (amplifier())
  es8311.pa_reverted = false;
  es8311.master_mode = false;
  es8311.use_mclk = true;
  es8311.hw_gain.pa_voltage = 3.3;  // the AW8737A runs from the cell or USB less a diode: the lowest is assumed
  es8311.hw_gain.codec_dac_voltage = 3.3;
  esp_codec_dev_cfg_t dev_cfg = {};
  dev_cfg.dev_type = ESP_CODEC_DEV_TYPE_IN_OUT;
  dev_cfg.codec_if = es8311_codec_new(&es8311);
  dev_cfg.data_if = data_if;
  dev_ = dev_cfg.codec_if ? esp_codec_dev_new(&dev_cfg) : nullptr;
  esp_codec_dev_sample_info_t fs = {};
  fs.sample_rate = kRate;
  fs.channel = 1;
  fs.bits_per_sample = 16;
  if (!dev_ || esp_codec_dev_open(dev_, &fs) != ESP_CODEC_DEV_OK) {
    ESP_LOGE(TAG, "ES8311 didn't open");
    dev_ = nullptr;
    return false;
  }
  esp_codec_dev_set_out_vol(dev_, kVolume);
  esp_codec_dev_set_out_mute(dev_, true);  // unmuted while something plays
  esp_codec_dev_set_in_gain(dev_, kMicGainDb);

  uint8_t* storage = static_cast<uint8_t*>(heap_caps_malloc(kQueueBytes + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  static StaticStreamBuffer_t control;
  queue_ = storage ? xStreamBufferCreateStatic(kQueueBytes, 1, storage, &control) : nullptr;
  drained_ = xSemaphoreCreateBinary();
  if (!queue_ || !drained_) return false;
  xTaskCreatePinnedToCore(&Audio::speaker_task, "speaker", 4096, this, 7, nullptr, 1);
  xTaskCreatePinnedToCore(&Audio::mic_task, "mic", 4096, this, 6, nullptr, 1);
  ESP_LOGI(TAG, "ES8311 ready: speaker and microphone at %d Hz, volume %d%%, microphone %d dB", kRate, kVolume, (int)kMicGainDb);
  return true;
}

void Audio::amplifier(bool on) {
  if (power_ && !power_->set_amplifier(on)) ESP_LOGW(TAG, "amplifier switch failed");
}

void Audio::mic_task(void* arg) {
  auto* self = static_cast<Audio*>(arg);
  int16_t pcm[kMicChunk];
  int gain = (int)kMicGainDb;
  for (;;) {
    const int want = self->mic_gain_;
    if (want != gain) {
      gain = want;
      esp_codec_dev_set_in_gain(self->dev_, (float)gain);
    }
    if (esp_codec_dev_read(self->dev_, pcm, sizeof pcm) != ESP_CODEC_DEV_OK) {
      ESP_LOGW(TAG, "microphone read failed");
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    if (self->on_samples) self->on_samples(pcm, kMicChunk);
  }
}

bool Audio::begin(int rate) {
  if (!dev_ || rate != kRate) {
    ESP_LOGW(TAG, "the speaker plays %d Hz only (asked %d)", kRate, rate);
    return false;
  }
  // A cut asked just before (the core's stop_speaking, a key) is carried out first, so it can't
  // drop the start of this reply.
  for (int i = 0; flush_ && i < 50; i++) vTaskDelay(pdMS_TO_TICKS(2));
  std::lock_guard<std::mutex> lock(send_);  // not while a tick is being queued
  xSemaphoreTake(drained_, 0);
  closing_ = false;
  open_ = true;
  return true;
}

void Audio::write(const int16_t* samples, size_t count) {
  const uint8_t* at = reinterpret_cast<const uint8_t*>(samples);
  size_t left = count * 2;
  // Blocks while the queue is full: this is what paces the reader. Whole samples only, and the
  // speaker task is the only reader, so the room can only grow between the check and the send.
  // `writing_` is set before `flush_` is looked at: the speaker task empties the queue only once
  // no send is under way (a cut can come from any thread).
  writing_ = true;
  while (left && open_ && !flush_) {
    size_t room = xStreamBufferSpacesAvailable(queue_) & ~static_cast<size_t>(1);
    if (!room) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    const size_t take = room < left ? room : left;
    size_t sent;
    {
      std::lock_guard<std::mutex> lock(send_);
      sent = xStreamBufferSend(queue_, at, take, 0);
    }
    at += sent;
    left -= sent;
  }
  writing_ = false;
}

void Audio::set_volume(int percent) { volume_ = percent < 0 ? 0 : percent > 100 ? 100 : percent; }
void Audio::set_mic_gain(int db) { mic_gain_ = db; }

void Audio::tick() {
  if (!queue_ || open_ || playing_ || volume_ == 0) return;
  // A 1 kHz sine at a quarter of full scale, 5 ms ramps at both ends so it doesn't click.
  static int16_t tone[kTickSamples];
  static bool made = false;
  if (!made) {
    static const int16_t kCycle[16] = {0, 3135, 5793, 7568, 8192, 7568, 5793, 3135, 0, -3135, -5793, -7568, -8192, -7568, -5793, -3135};
    const int ramp = kRate / 200;
    for (int i = 0; i < kTickSamples; i++) {
      const int edge = i < ramp ? i : kTickSamples - 1 - i < ramp ? kTickSamples - 1 - i : ramp;
      tone[i] = (int16_t)(kCycle[i % 16] * edge / ramp);
    }
    made = true;
  }
  {
    std::lock_guard<std::mutex> lock(send_);
    if (open_ || xStreamBufferSpacesAvailable(queue_) < sizeof tone) return;
    xStreamBufferSend(queue_, tone, sizeof tone, 0);
    closing_ = true;  // played out, then the amplifier goes off again
  }
}

// Safe from any thread, also when nothing plays: it only sets two flags; the speaker task does the rest.
void Audio::cut() {
  open_ = false;
  flush_ = true;
}

void Audio::end(bool cut) {
  if (cut) this->cut();
  open_ = false;
  // Played out (or dropped) before this returns, so `speaking` ends when the sound does.
  const size_t queued = xStreamBufferBytesAvailable(queue_);
  const TickType_t wait = pdMS_TO_TICKS(1000 + queued * 1000 / (kRate * 2) + 500);
  closing_ = true;
  if (xSemaphoreTake(drained_, wait) != pdTRUE) ESP_LOGW(TAG, "the speaker didn't drain in time");
}

void Audio::speaker_task(void* arg) {
  auto* self = static_cast<Audio*>(arg);
  int16_t chunk[kSpeakerChunk];
  int64_t started = 0, starved = 0;  // starved: time spent waiting for samples while playing
  uint64_t played = 0;
  auto finish = [&](bool cut) {
    if (self->playing_) {
      if (!cut) {
        // The last real audio may still sit in the I2S DMA ring: push silence past it before muting.
        memset(chunk, 0, sizeof chunk);
        for (int i = 0; i < 3; i++) esp_codec_dev_write(self->dev_, chunk, sizeof chunk);
      }
      esp_codec_dev_set_out_mute(self->dev_, true);
      vTaskDelay(pdMS_TO_TICKS(20));  // the DAC decays to silence before the amplifier goes off
      self->amplifier(false);
      const int64_t ms = (esp_timer_get_time() - started) / 1000;
      ESP_LOGI(TAG, "playback %s: %llu bytes (%llu ms of sound) in %lld ms, %lld ms of it waiting for samples", cut ? "cut" : "ended", (unsigned long long)played,
               (unsigned long long)(played * 1000 / (kRate * 2)), (long long)ms, (long long)(starved / 1000));
      self->playing_ = false;
    }
    played = 0;
    starved = 0;
    if (self->closing_.exchange(false)) xSemaphoreGive(self->drained_);
  };
  int volume = kVolume;  // what the codec has now
  for (;;) {
    // A volume the settings changed: written between two chunks, by the one task that writes the codec's output.
    const int want = self->volume_;
    if (want != volume) {
      volume = want;
      esp_codec_dev_set_out_vol(self->dev_, volume > 0 ? volume : 0);
      if (self->playing_) esp_codec_dev_set_out_mute(self->dev_, volume == 0);
    }
    if (self->flush_) {
      while (self->writing_) vTaskDelay(1);  // the writer sees flush_ and stops within one send
      xStreamBufferReset(self->queue_);
      self->flush_ = false;
      finish(true);
      continue;
    }
    const int64_t asked = esp_timer_get_time();
    const size_t got = xStreamBufferReceive(self->queue_, chunk, sizeof chunk, pdMS_TO_TICKS(20));
    if (got == 0) {
      if (self->playing_) starved += esp_timer_get_time() - asked;
      if (self->closing_) finish(false);
      continue;
    }
    if (!self->playing_) {
      self->amplifier(true);
      vTaskDelay(pdMS_TO_TICKS(20));  // the amplifier settles while the DAC is still muted
      if (volume > 0) esp_codec_dev_set_out_mute(self->dev_, false);  // volume 0: silent, muted all through
      self->playing_ = true;
      started = esp_timer_get_time();
    }
    if (esp_codec_dev_write(self->dev_, chunk, static_cast<int>(got & ~static_cast<size_t>(1))) != ESP_CODEC_DEV_OK) ESP_LOGW(TAG, "speaker write failed");
    played += got;
  }
}

}  // namespace stopwatch
