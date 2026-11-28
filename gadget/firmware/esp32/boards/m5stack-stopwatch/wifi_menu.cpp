#include "wifi_menu.hpp"

#include <algorithm>
#include <array>
#include <string_view>
#include <tuple>

namespace stopwatch {
namespace {
using Page = WifiMenu::Page;
constexpr int kRows = 3;
struct Box {
  int x, y, w, h;
  bool hit(int px, int py) const { return px >= x && px < x + w && py >= y && py < y + h; }
};
constexpr Box row(int i) { return {57, 118 + i * 49, 352, 44}; }
constexpr Box previous{91, 318, 84, 40}, forward{291, 318, 84, 40};
constexpr Box back{119, 367, 106, 42}, next{241, 367, 106, 42};
constexpr Box mode{64, 313, 104, 43}, space{176, 313, 114, 43}, erase{298, 313, 104, 43};
constexpr std::array<std::array<std::string_view, 3>, 4> layouts{{
    {{"qwertyuiop", "asdfghjkl", "zxcvbnm"}},
    {{"QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"}},
    {{"1234567890", "@#$%&-+()", "!?.,'\"/"}},
    {{"[]{}<>\\|^~", "`_=*:;", ""}},
}};
Box key_box(int row_at, int col, int count) { return {233 - count * 20 + col * 40, 170 + row_at * 47, 37, 43}; }
const char* const mode_words[] = {"a-z", "A-Z", "123", "#+="};

void erase_password(std::string& value) {
  volatile char* bytes = value.data();
  for (size_t i = 0; i < value.size(); ++i) bytes[i] = 0;
  value.clear();
}
}  // namespace

bool WifiMenu::Shown::operator!=(const Shown& b) const {
  return std::tie(page, keys, more, names, current, input, note, state, fallback) !=
         std::tie(b.page, b.keys, b.more, b.names, b.current, b.input, b.note, b.state, b.fallback);
}

bool WifiMenu::is_open() {
  std::lock_guard<std::mutex> lock(mutex_);
  return page_ != Page::Closed;
}

void WifiMenu::list(botkins::Gadget& gadget) {
  page_ = Page::Networks;
  offset_ = 0;
  names_ = gadget.saved_networks(&current_);
  note_.clear();
}

void WifiMenu::open(botkins::Gadget& gadget) {
  std::lock_guard<std::mutex> lock(mutex_);
  last_touch_ = std::chrono::steady_clock::now();
  const std::string state = gadget.network_trial()["state"].str();
  if (state == "trying" || state == "rolling-back") page_ = Page::Result;
  else list(gadget);
}

void WifiMenu::close_locked() {
  page_ = Page::Closed;
  erase_password(password_);
  name_.clear();
  note_.clear();
}
void WifiMenu::close() {
  std::lock_guard<std::mutex> lock(mutex_);
  close_locked();
}
void WifiMenu::expire() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (page_ != Page::Closed && std::chrono::steady_clock::now() - last_touch_ > std::chrono::minutes(3)) close_locked();
}

void WifiMenu::start(botkins::Gadget& gadget, const std::string& ssid, const std::string* password) {
  note_ = gadget.try_network(ssid, password);
  if (note_.empty()) {
    erase_password(password_);
    page_ = Page::Result;
  }
}

void WifiMenu::tap(int x, int y, botkins::Gadget& gadget) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (page_ == Page::Closed) return;
  last_touch_ = std::chrono::steady_clock::now();
  if (page_ == Page::Result) {
    if (back.hit(x, y)) list(gadget);
    else if (next.hit(x, y)) close_locked();
    return;
  }
  note_.clear();
  if (page_ == Page::Networks) {
    if (back.hit(x, y)) close_locked();
    else if (next.hit(x, y)) {
      name_.clear();
      erase_password(password_);
      keys_ = 0;
      page_ = Page::Name;
    } else if (previous.hit(x, y) && offset_ >= kRows) offset_ -= kRows;
    else if (forward.hit(x, y) && offset_ + kRows < (int)names_.size()) offset_ += kRows;
    else for (int i = 0; i < kRows && offset_ + i < (int)names_.size(); ++i) {
      if (row(i).hit(x, y)) {
        start(gadget, names_[offset_ + i], nullptr);
        break;
      }
    }
    return;
  }
  std::string& text = page_ == Page::Name ? name_ : password_;
  const auto append = [&](char ch) {
    if (text.size() < (page_ == Page::Name ? 32u : 64u)) text += ch;
  };
  if (back.hit(x, y)) {
    if (page_ == Page::Password) {
      erase_password(password_);
      page_ = Page::Name;
      keys_ = 0;
    } else list(gadget);
  } else if (next.hit(x, y)) {
    if (page_ == Page::Name) {
      if (name_.empty()) note_ = "Enter a network name";
      else {
        page_ = Page::Password;
        keys_ = 0;
      }
    } else start(gadget, name_, &password_);
  } else if (mode.hit(x, y)) keys_ = (keys_ + 1) % (int)layouts.size();
  else if (space.hit(x, y)) append(' ');
  else if (erase.hit(x, y) && !text.empty()) {
    text.back() = '\0';
    text.pop_back();
  } else for (int r = 0; r < 3; ++r) {
    const auto chars = layouts[keys_][r];
    for (int col = 0; col < (int)chars.size(); ++col) if (key_box(r, col, chars.size()).hit(x, y)) append(chars[col]);
  }
}

WifiMenu::Shown WifiMenu::shown(botkins::Gadget& gadget) {
  std::lock_guard<std::mutex> lock(mutex_);
  Shown view;
  view.page = page_;
  view.keys = keys_;
  view.note = note_;
  if (page_ == Page::Networks) {
    view.current = current_;
    view.more = offset_ + kRows < (int)names_.size();
    for (int i = offset_; i < std::min(offset_ + kRows, (int)names_.size()); ++i) view.names.push_back(names_[i]);
    // The paint code doesn't need to know the page number, only whether Back is available.
    view.keys = offset_;
  } else if (page_ == Page::Name) {
    view.input = name_;
  } else if (page_ == Page::Password) {
    view.input.assign(std::min<size_t>(password_.size(), 22), '*');
    if (password_.size() > 22) view.input += "...";
  } else if (page_ == Page::Result) {
    const auto trial = gadget.network_trial();
    view.state = trial["state"].str();
    view.fallback = trial["fallback"].str();
    view.input = trial["ssid"].str();
  }
  return view;
}

void WifiMenu::draw(botkins::Canvas& c, const Shown& view) {
  const auto cream = botkins::hex(0xFFF8EA), muted = botkins::hex(0xB9AE9C), tide = botkins::hex(0x6FA596);
  const auto fill = botkins::hex(0x2A2522), rim = botkins::hex(0x3A332E);
  c.clear({});
  c.annulus(233, 233, 233, 230, rim);
  auto text = [&](std::string value, Box b, int px, botkins::Rgb color) {
    botkins::Type type;
    type.px = px;
    float width = c.measure(value, type);
    if (width > b.w - 8) {
      while (!value.empty() && c.measure(value + "...", type) > b.w - 8) {
        size_t end = value.size() - 1;
        while (end > 0 && ((unsigned char)value[end] & 0xC0) == 0x80) --end;
        value.resize(end);
      }
      value += "...";
      width = c.measure(value, type);
    }
    c.text(b.x + (b.w - width) / 2.0f, c.baseline(b.y, type, b.h), value.data(), value.size(), type, color);
  };
  auto button = [&](Box b, const std::string& words, bool primary = false, int px = 18) {
    c.fill_round_rect(b.x, b.y, b.w, b.h, 9, primary ? botkins::hex(0x27483F) : fill);
    text(words, b, px, cream);
  };
  if (view.page == Page::Networks) {
    text("Wi-Fi", {75, 58, 316, 52}, 30, cream);
    if (view.names.empty()) text("No saved networks", row(0), 19, muted);
    for (int i = 0; i < (int)view.names.size(); ++i) {
      const bool current = view.names[i] == view.current;
      button(row(i), view.names[i] + (current ? "  (current)" : ""), current);
    }
    if (!view.note.empty()) text(view.note, {47, 268, 372, 33}, 15, tide);
    if (view.keys > 0) button(previous, "Prev");
    if (view.more) button(forward, "More");
    button(back, "Close");
    button(next, "Add", true);
  } else if (view.page == Page::Name || view.page == Page::Password) {
    const bool password = view.page == Page::Password;
    text(password ? "Wi-Fi password" : "Network name", {78, 70, 310, 39}, 25, cream);
    const Box field{59, 112, 348, 45};
    c.fill_round_rect(field.x, field.y, field.w, field.h, 10, fill);
    text(!view.note.empty() ? view.note : view.input.empty() ? (password ? "Empty for open Wi-Fi" : "Type the exact network name") : view.input,
         field, 17, view.input.empty() || !view.note.empty() ? muted : cream);
    for (int r = 0; r < 3; ++r) {
      const auto chars = layouts[view.keys][r];
      for (int i = 0; i < (int)chars.size(); ++i) button(key_box(r, i, chars.size()), std::string(1, chars[i]), false, 21);
    }
    button(mode, mode_words[(view.keys + 1) % layouts.size()]);
    button(space, "Space");
    button(erase, "Delete");
    button(back, "Back");
    button(next, password ? "Join" : "Next", true);
  } else if (view.page == Page::Result) {
    text("Wi-Fi", {75, 68, 316, 52}, 30, cream);
    text(view.input, {55, 134, 356, 40}, 20, muted);
    const char* heading = "Joining...";
    const char* detail = "The previous network stays saved";
    if (view.state == "joined") {
      heading = "Connected";
      detail = "Network saved";
    } else if (view.state == "rolling-back") {
      heading = "Couldn't connect";
      detail = "Reconnecting to previous Wi-Fi...";
    } else if (view.state == "rolled-back") {
      heading = "Couldn't connect";
      detail = view.fallback == "on" ? "Back on previous Wi-Fi" : view.fallback == "unreachable" ? "Previous Wi-Fi is also unavailable" : "No previous Wi-Fi was saved";
    } else if (view.state == "cancelled") {
      heading = "Switch cancelled";
      detail = "Wi-Fi settings changed elsewhere";
    }
    text(heading, {48, 190, 370, 50}, 27, cream);
    text(detail, {48, 243, 370, 45}, 17, muted);
    button(back, "Networks");
    button(next, "Done", true);
  }
}

}  // namespace stopwatch
