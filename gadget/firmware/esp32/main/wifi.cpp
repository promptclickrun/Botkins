#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "port.hpp"

namespace port {
namespace {
const char* TAG = "botkins.wifi";
enum { kOff = 0, kJoining = 1, kOn = 2, kFailed = 3 };
// "failed" after this many tries in a row (the screen says so), but it keeps trying, more slowly.
const int kFailedAfter = 4;
esp_netif_t* g_netif = nullptr;
}  // namespace

bool WifiNetwork::begin() {
  if (esp_netif_init() != ESP_OK) return false;
  esp_err_t err = esp_event_loop_create_default();
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return false;
  g_netif = esp_netif_create_default_wifi_sta();
  wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
  config.nvs_enable = 0;  // the network lives in the port's own namespace
  if (esp_wifi_init(&config) != ESP_OK) return false;
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, (esp_event_handler_t)&WifiNetwork::on_event, this);
  esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, (esp_event_handler_t)&WifiNetwork::on_event, this);
  esp_timer_create_args_t timer = {};
  timer.callback = [](void*) { esp_wifi_connect(); };
  timer.name = "wifi-retry";
  esp_timer_handle_t handle = nullptr;
  if (esp_timer_create(&timer, &handle) != ESP_OK) return false;
  timer_ = handle;
  if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK || esp_wifi_start() != ESP_OK) return false;
  // On a cable, and replies stream: no modem sleep, so a reply's samples are not held at the access point.
  esp_wifi_set_ps(WIFI_PS_NONE);
  return true;
}

void WifiNetwork::join(const std::string& ssid, const std::string& password) {
  esp_timer_stop((esp_timer_handle_t)timer_);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    ssid_ = ssid;
    password_ = password;
    failures_ = 0;
    address_.clear();
    connected_.clear();
  }
  state_ = ssid.empty() ? kOff : kJoining;
  // Leaving the network in use (the core moving on to the next saved one, or a setup over USB):
  // its "disconnected" event names it, and is not counted against the new one (on_event).
  esp_wifi_disconnect();
  if (ssid.empty()) return;
  wifi_config_t config = {};
  memcpy(config.sta.ssid, ssid.data(), ssid.size() < sizeof(config.sta.ssid) ? ssid.size() : sizeof(config.sta.ssid));
  memcpy(config.sta.password, password.data(), password.size() < sizeof(config.sta.password) ? password.size() : sizeof(config.sta.password));
  config.sta.threshold.authmode = password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
  config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
  config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
  config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
  esp_wifi_set_config(WIFI_IF_STA, &config);
  // Neither the name nor the password goes in the log.
  ESP_LOGI(TAG, "joining a network");
  esp_wifi_connect();
}

void WifiNetwork::retry_later() {
  int failures;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    failures = failures_;
  }
  // 1, 2, 4, 8 s, then every 15 s.
  const int64_t ms = failures < 4 ? 1000LL << (failures > 0 ? failures - 1 : 0) : 15000;
  esp_timer_stop((esp_timer_handle_t)timer_);
  esp_timer_start_once((esp_timer_handle_t)timer_, ms * 1000);
}

void WifiNetwork::on_event(void* arg, const char* base, int32_t id, void* data) {
  auto* self = static_cast<WifiNetwork*>(arg);
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    const auto* event = static_cast<wifi_event_sta_disconnected_t*>(data);
    bool have, other = false;
    int failures = 0;
    {
      std::lock_guard<std::mutex> lock(self->mutex_);
      have = !self->ssid_.empty();
      // The network that was left when join() switched: not a failure of the one being joined,
      // and no retry of its own (join() has already asked for the new one).
      if (have && event && event->ssid_len > 0)
        other = self->ssid_.size() != event->ssid_len || memcmp(self->ssid_.data(), event->ssid, event->ssid_len) != 0;
      if (!other) failures = ++self->failures_;
      self->address_.clear();
    }
    if (!have) {
      self->state_ = kOff;
      return;
    }
    if (other) {
      ESP_LOGI(TAG, "left the earlier network (reason %d)", event->reason);
      return;
    }
    ESP_LOGW(TAG, "not on the network (reason %d, try %d)", event ? event->reason : -1, failures);
    self->state_ = failures >= kFailedAfter ? kFailed : kJoining;
    self->retry_later();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
    const auto* event = static_cast<wifi_event_sta_connected_t*>(data);
    std::lock_guard<std::mutex> lock(self->mutex_);
    self->connected_.assign((const char*)event->ssid, event->ssid_len < sizeof(event->ssid) ? event->ssid_len : sizeof(event->ssid));
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    const auto* event = static_cast<ip_event_got_ip_t*>(data);
    char text[16];
    esp_ip4addr_ntoa(&event->ip_info.ip, text, sizeof text);
    {
      std::lock_guard<std::mutex> lock(self->mutex_);
      // An address that comes after join() switched, from the network being left, is not the new one's
      // (a network a person is trying must not count as working on the old one's address).
      if (self->connected_ != self->ssid_) {
        ESP_LOGI(TAG, "an address from the network being left: not counted");
        return;
      }
      self->address_ = text;
      self->failures_ = 0;
    }
    ESP_LOGI(TAG, "on the network as %s", text);
    self->state_ = kOn;
  } else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
    {
      std::lock_guard<std::mutex> lock(self->mutex_);
      self->address_.clear();
    }
    if (self->state_ == kOn) self->state_ = kJoining;
  }
}

const char* WifiNetwork::state() {
  static const char* names[] = {"off", "joining", "on", "failed"};
  return names[state_.load()];
}

int WifiNetwork::signal() {
  if (state_ != kOn) return 0;
  wifi_ap_record_t ap = {};
  if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) return 0;
  return ap.rssi < 0 ? ap.rssi : 0;
}

std::string WifiNetwork::joined_ssid() {
  std::lock_guard<std::mutex> lock(mutex_);
  return state_ == kOn ? connected_ : std::string();
}

std::string WifiNetwork::address() {
  std::lock_guard<std::mutex> lock(mutex_);
  return address_;
}

}  // namespace port
