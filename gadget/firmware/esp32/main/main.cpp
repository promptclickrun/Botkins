// The Botkins gadget on an ESP32 board: the shared core (gadget/firmware/core) with the chip's
// random numbers, NVS, Wi-Fi, the USB console and a WebSocket, and one board from boards/<name>.
// gadget/docs/contract.md has every rule; gadget/firmware/host/main.cpp is the same port for a computer.
#include <cstdio>

#include "botkins/crypto.hpp"
#include "botkins/gadget.hpp"
#include "botkins/sockets.hpp"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_pthread.h"
#include "esp_random.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gadget_port/board.hpp"
#include "nvs_flash.h"
#include "port.hpp"
#include "websocket.hpp"

namespace {
const char* TAG = "botkins";
const char* kWifi = "wifi";  // the core's name for the saved network (core/src/gadget.cpp)
// The live voice's thread stack (Board::thread, below).
const int kLiveStack = 16 * 1024;

// esp_fill_random gives true random numbers once the radio is on (WifiNetwork::begin runs first).
void fill_random(uint8_t* out, size_t size) { esp_fill_random(out, size); }

port::NvsStorage g_storage;
port::WifiNetwork g_wifi;
botkins::SocketTransport g_transport;
}  // namespace

extern "C" void app_main(void) {
  // The Wi-Fi driver's own lines name the network; the port's say only whether it is on it.
  esp_log_level_set("wifi", ESP_LOG_WARN);
  const char* version = esp_app_get_description()->version;
  ESP_LOGI(TAG, "Botkins gadget %s", version);

  // NVS holds the Wi-Fi network another firmware saved: it is never erased here, even when it
  // can't be opened (then nothing is kept across a restart, and the log says so).
  esp_err_t nvs = nvs_flash_init();
  if (nvs != ESP_OK) ESP_LOGE(TAG, "NVS can't be opened (%s): nothing will be kept across a restart", esp_err_to_name(nvs));

  if (!board::begin()) ESP_LOGE(TAG, "the board didn't come up fully");

  // Wi-Fi first: with the radio on, the chip's random numbers are true ones (the gadget's key).
  if (!g_wifi.begin()) ESP_LOGE(TAG, "Wi-Fi didn't start");
  botkins::set_random(fill_random);
  const bool crypto_ok = botkins::crypto_self_test();
  if (crypto_ok) ESP_LOGI(TAG, "crypto self test passed");
  else ESP_LOGE(TAG, "crypto self test FAILED");

  if (nvs == ESP_OK) g_storage.begin();
  // A board that another firmware put on the Wi-Fi network keeps it: when this firmware has no
  // network of its own yet, that one is adopted, in the form a setup over USB saves.
  std::string saved;
  if (!g_storage.load(kWifi, saved)) {
    std::string ssid, password;
    if (port::earlier_wifi(ssid, password) && ssid.size() <= 32 && password.size() <= 64) {
      g_storage.save(kWifi, botkins::Json::object().set("ssid", ssid).set("password", password).dump());
      ESP_LOGI(TAG, "adopted the Wi-Fi network the earlier firmware had saved");
    }
  }

  // The core's threads: 16 KB stacks, and the threads they start get the same.
  esp_pthread_cfg_t threads = esp_pthread_get_default_config();
  threads.stack_size = 16 * 1024;
  threads.prio = 5;
  threads.inherit_cfg = true;
  threads.thread_name = "botkins";
  esp_pthread_set_cfg(&threads);

  // The longest answer taken from the network. The largest the gadget asks for is a speak slice:
  // 32,000 bytes of samples as base64 inside a sealed answer, about 43 KB. A sync answer carries the
  // reply's text as it streams, with no cap of its own in the contract, so a long reply sent whole
  // after a restart can be much longer. 512 KiB is twelve slices; answers over 16 KB land in PSRAM
  // (CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL), where even a few copies of one fit in 7.8 MB free.
  g_transport.max_answer = 512 * 1024;

  botkins::Board config;
  config.transport = &g_transport;
  config.storage = &g_storage;
  config.network = &g_wifi;
  config.firmware = version;
  config.slice_bytes = 32000;
  // The relay's socket and live voice's (websocket.cpp): wss:// checked against the certificate bundle.
  config.socket = [] { return std::unique_ptr<botkins::Socket>(new port::EspSocket()); };
  // The owner's restart (the part's `restart`): the core says it is restarting, then calls this.
  config.restart = [] { esp_restart(); };
  // The live voice's thread, made while a session is open beside the relay's socket and the live one.
  // Its stack is internal RAM: a call it makes may open a link session and save the computer's
  // addresses to flash, which a task with its stack in PSRAM must not do. As the thread ends, the log
  // says how much of the stack it never used.
  config.thread = [](const char* name, std::function<void()> run) {
    esp_pthread_cfg_t before = esp_pthread_get_default_config();
    if (esp_pthread_get_cfg(&before) != ESP_OK) before = esp_pthread_get_default_config();
    esp_pthread_cfg_t own = esp_pthread_get_default_config();
    own.stack_size = kLiveStack;
    own.prio = 5;
    own.inherit_cfg = false;
    own.thread_name = name;
    esp_pthread_set_cfg(&own);
    std::string label = name;
    std::thread thread([run = std::move(run), label] {
      run();
      ESP_LOGI(TAG, "%s thread ended; its stack had at least %u of %d bytes left", label.c_str(), (unsigned)uxTaskGetStackHighWaterMark(nullptr), kLiveStack);
    });
    // Only this one: the calling task's own threads are made as before.
    esp_pthread_set_cfg(&before);
    return thread;
  };
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char text[18];
  snprintf(text, sizeof text, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  config.mac = text;
  board::describe(config);
  ESP_LOGI(TAG, "board %s, firmware %s, speaker %d Hz, microphone %d Hz, screen %dx%d%s", config.name.c_str(), config.firmware.c_str(), config.speaker_rate,
           config.mic_rate, config.screen_width, config.screen_height, config.screen_round ? " round" : "");

  static botkins::Gadget gadget(config);
  gadget.on_change = [] { board::redraw(); };
  gadget.begin();
  board::run(gadget);
  port::start_console(gadget);
  port::log_heap("started");

  // Now and then, a line about memory: free internal RAM and PSRAM, and the least since boot.
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(60000));
    port::log_heap("every minute");
  }
}
