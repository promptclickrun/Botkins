#pragma once

#include <chrono>
#include <mutex>
#include <string>
#include <vector>

#include "botkins/draw.hpp"

namespace stopwatch {

// Local touchscreen Wi-Fi editor. Rendering receives only masked password text.
class WifiMenu {
 public:
  enum class Page { Closed, Networks, Name, Password, Result };
  struct Shown {
    Page page = Page::Closed;
    int keys = 0;
    bool more = false;
    std::vector<std::string> names;
    std::string current, input, note, state, fallback;
    bool operator!=(const Shown& other) const;
  };

  bool is_open();
  void open(botkins::Gadget& gadget);
  void close();
  void expire();
  void tap(int x, int y, botkins::Gadget& gadget);
  Shown shown(botkins::Gadget& gadget);
  static void draw(botkins::Canvas& canvas, const Shown& shown);

 private:
  void close_locked();
  void list(botkins::Gadget& gadget);
  void start(botkins::Gadget& gadget, const std::string& ssid, const std::string* password);

  std::mutex mutex_;
  Page page_ = Page::Closed;
  std::vector<std::string> names_;
  std::string current_, name_, password_, note_;
  int offset_ = 0, keys_ = 0;
  std::chrono::steady_clock::time_point last_touch_;
};

}  // namespace stopwatch
