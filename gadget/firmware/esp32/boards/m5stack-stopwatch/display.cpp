// The StopWatch's round 1.75" 466x466 AMOLED: a CO5300 on QSPI, driven by Espressif's
// esp_lcd_co5300 component (Apache-2.0, a managed dependency). The frame is drawn in PSRAM and
// sent in bands through a small DMA buffer.
//
// Pins and clock (CS 39, SCLK 40, D0-D3 41/42/46/45, 40 MHz, column gap 6, no reset pin: the
// M5IOE1 pulses the panel's reset in stopwatch::Power::begin) are hardware facts as the Hermes
// Gadget firmware has them for this board (firmware/esp32/main/board.cpp, MIT).
//
// The panel's start-up commands (kInit) are Waveshare's, from the board support package
// "waveshare/esp32_s3_touch_amoled_1_75" version 2.0.6 (repository
// github.com/waveshareteam/Waveshare-ESP32-components, commit e81486c57b63352692382053496ee24a9ab74574,
// bsp/esp32_s3_touch_amoled_1_75/esp32_s3_touch_amoled_1_75.c, `lcd_init_cmds`), licensed under
// the Apache License 2.0 (gadget/firmware/LICENSES/Apache-2.0.txt). They are used unchanged.
// esp_lcd_co5300 sends MADCTL 0x00 and COLMOD 0x55 before them; the whole sequence is then the
// same bytes the Hermes firmware sends this panel.
#include "display.hpp"

#include <cstring>

#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_co5300.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace stopwatch {
namespace {
const char* TAG = "stopwatch.display";
constexpr spi_host_device_t kHost = SPI2_HOST;
constexpr int kCs = 39, kSclk = 40, kD0 = 41, kD1 = 42, kD2 = 46, kD3 = 45;
constexpr int kGapX = 6;  // the controller's RAM is 480 wide; the glass starts at column 6
constexpr int kMhz = 40;
// Even, so every band starts on an even row and spans an even count (the CO5300 wants both).
// Two of 8 rows: as much internal RAM as one band of 16, and one fills while the other is sent.
constexpr int kBand = 8;

// Waveshare esp32_s3_touch_amoled_1_75 2.0.6, lcd_init_cmds (Apache-2.0).
const uint8_t k20[] = {0x20}, k10[] = {0x10}, kA0[] = {0xA0}, k00[] = {0x00}, k80[] = {0x80}, k55[] = {0x55}, kFF[] = {0xFF};
const uint8_t kCaset[] = {0x00, 0x06, 0x01, 0xD7}, kRaset[] = {0x00, 0x00, 0x01, 0xD1};
const co5300_lcd_init_cmd_t kInit[] = {
    {0xFE, k20, 1, 0},
    {0x19, k10, 1, 0},
    {0x1C, kA0, 1, 0},
    {0xFE, k00, 1, 0},
    {0xC4, k80, 1, 0},
    {0x3A, k55, 1, 0},
    {0x35, k00, 1, 0},
    {0x53, k20, 1, 0},
    {0x51, kFF, 1, 0},
    {0x63, kFF, 1, 0},
    {0x2A, kCaset, 4, 0},
    {0x2B, kRaset, 4, 600},
    {0x11, nullptr, 0, 600},
    {0x29, nullptr, 0, 0},
};

SemaphoreHandle_t g_done = nullptr;
bool on_done(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void*) {
  BaseType_t woken = pdFALSE;
  xSemaphoreGiveFromISR(g_done, &woken);
  return woken == pdTRUE;
}
}  // namespace

bool Display::begin() {
  const size_t pixels = (size_t)kWidth * kHeight;
  frame_ = static_cast<uint16_t*>(heap_caps_calloc(pixels, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  for (auto& band : band_) band = static_cast<uint16_t*>(heap_caps_malloc((size_t)kWidth * kBand * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  g_done = xSemaphoreCreateCounting(2, 0);  // one count per band sent
  if (!frame_ || !band_[0] || !band_[1] || !g_done) {
    ESP_LOGE(TAG, "no memory for the frame");
    return false;
  }
  spi_bus_config_t bus = {};
  bus.sclk_io_num = kSclk;
  bus.data0_io_num = kD0;
  bus.data1_io_num = kD1;
  bus.data2_io_num = kD2;
  bus.data3_io_num = kD3;
  bus.data4_io_num = -1;
  bus.data5_io_num = -1;
  bus.data6_io_num = -1;
  bus.data7_io_num = -1;
  bus.max_transfer_sz = kWidth * kBand * 2 + 16;
  bus.flags = SPICOMMON_BUSFLAG_QUAD;
  if (spi_bus_initialize(kHost, &bus, SPI_DMA_CH_AUTO) != ESP_OK) {
    ESP_LOGE(TAG, "spi bus failed");
    return false;
  }
  // What CO5300_PANEL_IO_QSPI_CONFIG gives (the macro isn't C++), at the board's clock.
  esp_lcd_panel_io_spi_config_t io_config = {};
  io_config.cs_gpio_num = static_cast<gpio_num_t>(kCs);
  io_config.dc_gpio_num = GPIO_NUM_NC;
  io_config.spi_mode = 0;
  io_config.pclk_hz = kMhz * 1000 * 1000;
  io_config.trans_queue_depth = 10;
  io_config.on_color_trans_done = on_done;
  io_config.lcd_cmd_bits = 32;
  io_config.lcd_param_bits = 8;
  io_config.flags.quad_mode = 1;
  esp_lcd_panel_io_handle_t io = nullptr;
  if (esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)kHost, &io_config, &io) != ESP_OK) {
    ESP_LOGE(TAG, "panel io failed");
    return false;
  }
  co5300_vendor_config_t vendor = {};
  vendor.init_cmds = kInit;
  vendor.init_cmds_size = sizeof(kInit) / sizeof(kInit[0]);
  vendor.flags.use_qspi_interface = 1;
  esp_lcd_panel_dev_config_t panel_config = {};
  panel_config.reset_gpio_num = GPIO_NUM_NC;
  panel_config.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
  panel_config.bits_per_pixel = 16;
  panel_config.vendor_config = &vendor;
  if (esp_lcd_new_panel_co5300(io, &panel_config, &panel_) != ESP_OK) {
    ESP_LOGE(TAG, "panel failed");
    return false;
  }
  // No esp_lcd_panel_reset(): with no reset pin it would send a software reset, which the
  // board's proven sequence doesn't. The M5IOE1 has just reset the panel.
  if (esp_lcd_panel_init(panel_) != ESP_OK) {
    ESP_LOGE(TAG, "panel init failed");
    return false;
  }
  esp_lcd_panel_set_gap(panel_, kGapX, 0);
  flush();  // the panel's memory starts out as noise
  ESP_LOGI(TAG, "CO5300 %dx%d ready", kWidth, kHeight);
  return true;
}

void Display::flush() {
  if (!panel_) return;
  // Band n is copied into one buffer while band n - 1 goes out of the other; a buffer is filled
  // again only after its band has gone.
  int queued = 0;
  bool ok = true;
  for (int y = 0, n = 0; y < kHeight; y += kBand, n++) {
    if (queued == 2) {
      if (xSemaphoreTake(g_done, pdMS_TO_TICKS(200)) != pdTRUE) {
        ESP_LOGW(TAG, "band before row %d timed out", y);
        ok = false;
        break;
      }
      queued--;
    }
    uint16_t* band = band_[n & 1];
    const int rows = y + kBand <= kHeight ? kBand : kHeight - y;
    memcpy(band, frame_ + (size_t)y * kWidth, (size_t)rows * kWidth * 2);
    if (esp_lcd_panel_draw_bitmap(panel_, 0, y, kWidth, y + rows, band) != ESP_OK) {
      ESP_LOGW(TAG, "band at row %d not sent", y);
      ok = false;
      break;
    }
    queued++;
  }
  // Every band sent is waited for: the next flush starts with both buffers free.
  while (queued > 0 && xSemaphoreTake(g_done, pdMS_TO_TICKS(200)) == pdTRUE) queued--;
  if (queued > 0 && ok) ESP_LOGW(TAG, "the last bands timed out");
}

// Both go through esp_lcd_co5300's own calls. Only the draw task calls them, as it does flush():
// one task talks to the panel.
bool Display::brightness(uint8_t percent) { return panel_ && esp_lcd_panel_co5300_set_brightness(panel_, percent) == ESP_OK; }
bool Display::output(bool on) { return panel_ && esp_lcd_panel_disp_on_off(panel_, on) == ESP_OK; }

}  // namespace stopwatch
