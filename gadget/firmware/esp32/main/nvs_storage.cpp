#include <vector>

#include "botkins/json.hpp"
#include "esp_log.h"
#include "port.hpp"

namespace port {
namespace {
const char* TAG = "botkins.nvs";
const char* kNamespace = "botkins";
}  // namespace

bool NvsStorage::begin() {
  esp_err_t err = nvs_open(kNamespace, NVS_READWRITE, &handle_);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "nvs_open(%s) failed: %s", kNamespace, esp_err_to_name(err));
    return false;
  }
  open_ = true;
  return true;
}

bool NvsStorage::load(const char* name, std::string& value) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!open_) return false;
  size_t size = 0;
  if (nvs_get_blob(handle_, name, nullptr, &size) != ESP_OK) return false;
  std::string out(size, '\0');
  if (size && nvs_get_blob(handle_, name, out.data(), &size) != ESP_OK) return false;
  out.resize(size);
  value = std::move(out);
  return true;
}

void NvsStorage::save(const char* name, const std::string& value) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!open_) return;
  // Unchanged values are not written again: the introduction's addresses come with every session.
  size_t size = 0;
  if (nvs_get_blob(handle_, name, nullptr, &size) == ESP_OK && size == value.size()) {
    std::string held(size, '\0');
    if (nvs_get_blob(handle_, name, held.data(), &size) == ESP_OK && held == value) return;
  }
  esp_err_t err = nvs_set_blob(handle_, name, value.data(), value.size());
  if (err == ESP_OK) err = nvs_commit(handle_);
  // The name only: the values include the key and the Wi-Fi password.
  if (err != ESP_OK) ESP_LOGE(TAG, "saving '%s' failed: %s", name, esp_err_to_name(err));
}

void NvsStorage::erase(const char* name) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!open_) return;
  if (nvs_erase_key(handle_, name) == ESP_OK) nvs_commit(handle_);
}

// The earlier firmware (Hermes Gadget) keeps its first Wi-Fi network as the strings "wifi_ssid"
// and "wifi_pass", and all of them as "wifi_nets" ([{ssid, pass, tested}]), in the namespace
// "hgadget". Opened read-only: nothing of it is changed.
bool earlier_wifi(std::string& ssid, std::string& password) {
  nvs_handle_t handle;
  if (nvs_open("hgadget", NVS_READONLY, &handle) != ESP_OK) return false;
  auto get = [handle](const char* key, std::string& out) {
    size_t size = 0;
    if (nvs_get_str(handle, key, nullptr, &size) != ESP_OK || size == 0) return false;
    std::vector<char> text(size);
    if (nvs_get_str(handle, key, text.data(), &size) != ESP_OK) return false;
    out.assign(text.data());
    return true;
  };
  bool found = false;
  std::string name, pass;
  if (get("wifi_ssid", name) && !name.empty()) {
    if (!get("wifi_pass", pass)) pass.clear();
    found = true;
  } else {
    std::string list;
    botkins::Json json;
    if (get("wifi_nets", list) && botkins::Json::parse(list, json)) {
      for (const botkins::Json& entry : json.items()) {
        if (!entry["ssid"].str().empty()) {
          name = entry["ssid"].str();
          pass = entry["pass"].str();
          found = true;
          break;
        }
      }
    }
  }
  nvs_close(handle);
  if (found) {
    ssid = std::move(name);
    password = std::move(pass);
  }
  return found;
}

}  // namespace port
