// What the StopWatch's round screen shows for each of the core's views. Drawn whole into the
// frame when the view changed; nothing moves on its own.
#include "screen.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "font5x7.hpp"

namespace stopwatch {
namespace {
constexpr int W = Display::kWidth, H = Display::kHeight, R = W / 2;
constexpr int kMargin = 20;  // kept clear inside the round edge

constexpr uint16_t rgb(int r, int g, int b) { return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)); }
constexpr uint16_t kWhite = rgb(255, 255, 255), kGray = rgb(150, 150, 150), kDim = rgb(100, 100, 100);
constexpr uint16_t kRed = rgb(255, 90, 90), kAmber = rgb(255, 190, 70), kBlue = rgb(100, 170, 255), kGreen = rgb(90, 220, 130), kYellow = rgb(255, 225, 90);
constexpr uint16_t kBlueKey = rgb(80, 150, 255), kYellowKey = rgb(255, 210, 60);

class Canvas {
 public:
  explicit Canvas(uint16_t* frame) : frame_(frame) {}
  void clear() { memset(frame_, 0, (size_t)W * H * 2); }
  void fill(int x, int y, int w, int h, uint16_t color) {
    const uint16_t c = (uint16_t)((color >> 8) | (color << 8));  // big-endian on the wire
    const int x0 = std::max(0, x), y0 = std::max(0, y), x1 = std::min(W, x + w), y1 = std::min(H, y + h);
    for (int yy = y0; yy < y1; yy++)
      for (int xx = x0; xx < x1; xx++) frame_[yy * W + xx] = c;
  }
  void glyph(int x, int y, char32_t cp, int scale, uint16_t color) {
    const char* bits = font::glyph(cp);
    for (int row = 0; row < font::kGlyphHeight; row++)
      for (int col = 0; col < font::kGlyphWidth; col++)
        if (bits[row * font::kGlyphWidth + col] == '#') fill(x + col * scale, y + row * scale, scale, scale, color);
  }
  void text(int x, int y, const std::u32string& line, int scale, uint16_t color) {
    for (char32_t cp : line) {
      glyph(x, y, cp, scale, color);
      x += 6 * scale;
    }
  }
  void centered(int y, const std::u32string& line, int scale, uint16_t color) { text((W - (int)line.size() * 6 * scale + scale) / 2, y, line, scale, color); }

 private:
  uint16_t* frame_;
};

/** UTF-8 to what the font draws: Latin-1 as it is, common punctuation as its ASCII look-alike. */
std::u32string decode(const std::string& s) {
  std::u32string out;
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = (unsigned char)s[i];
    size_t len = c < 0x80 ? 1 : c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC2 ? 2 : 0;
    char32_t cp = len == 1 ? c : len == 4 ? c & 0x07u : len == 3 ? c & 0x0Fu : c & 0x1Fu;
    bool ok = len > 0 && i + len <= s.size();
    for (size_t k = 1; ok && k < len; k++) {
      const unsigned char cc = (unsigned char)s[i + k];
      if ((cc & 0xC0) != 0x80) ok = false;
      cp = (cp << 6) | (cc & 0x3Fu);
    }
    i += ok ? len : 1;
    if (!ok) cp = '?';
    switch (cp) {
      case 0x2018: case 0x2019: case 0x201A: case 0x2032: out += U'\''; continue;
      case 0x201C: case 0x201D: case 0x201E: case 0x2033: out += U'"'; continue;
      case 0x2010: case 0x2011: case 0x2012: case 0x2013: case 0x2014: case 0x2212: out += U'-'; continue;
      case 0x2026: out += U"..."; continue;
      case 0x2022: case 0x00B7: out += U'*'; continue;
      case 0x203A: out += U'>'; continue;
      case 0x2039: out += U'<'; continue;
      case 0x00A0: case 0x2009: case 0x200A: case 0x202F: out += U' '; continue;
      case 0x200B: case 0xFE0F: continue;
      case '\t': out += U' '; continue;
      default: break;
    }
    if (cp == '\n' || (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA1 && cp <= 0xFF)) out += cp;
    else if (cp >= 0x1F000) continue;  // emoji: nothing to draw
    else out += U'?';
  }
  return out;
}

/** How many characters of `scale` fit across the round screen on a line from y to y + height. */
int capacity(int y, int height, int scale) {
  const int d = std::max(std::abs(y - R), std::abs(y + height - R));
  if (d >= R) return 0;
  const int half = (int)std::sqrt((double)(R * R - d * d)) - kMargin;
  return half <= 0 ? 0 : (2 * half + scale) / (6 * scale);
}

struct Block {
  int scale;
  uint16_t color;
  int top, bottom;  // the rows it may use
  int gap = 0;      // extra rows between lines
};
struct Placed {
  std::u32string text;
  int y;
};

/**
 * Wraps `text` into the block, a line at a time, each as wide as the circle is there. With
 * `newest`, a text too long for the block shows its end (the newest words), led by "...".
 * Returns the lines; `used` is the first row below them.
 */
std::vector<Placed> wrap(const std::u32string& text, const Block& block, bool newest, int* used = nullptr) {
  // Words, and line breaks as their own entries.
  std::vector<std::u32string> words;
  std::u32string word;
  for (char32_t c : text) {
    if (c == ' ' || c == '\n') {
      if (!word.empty()) words.push_back(word);
      word.clear();
      if (c == '\n') words.push_back(U"\n");
    } else word += c;
  }
  if (!word.empty()) words.push_back(word);
  const int pitch = 7 * block.scale + 3 * block.scale + block.gap;
  auto lay = [&](size_t start, bool lead, std::vector<Placed>& out) {
    out.clear();
    int y = block.top;
    std::u32string line = lead ? U"..." : U"";
    size_t i = start;
    while (i < words.size()) {
      if (y + 7 * block.scale > block.bottom) return false;
      const int room = capacity(y, 7 * block.scale, block.scale);
      if (room <= 0) {
        y += pitch;
        continue;
      }
      if (words[i] == U"\n") {
        out.push_back({line, y});
        line.clear();
        y += pitch;
        i++;
        continue;
      }
      std::u32string w = words[i];
      const size_t need = line.empty() ? w.size() : line.size() + 1 + w.size();
      if ((int)need <= room) {
        if (!line.empty()) line += U' ';
        line += w;
        i++;
        continue;
      }
      if (line.empty()) {
        // A word longer than the line: split it.
        line = w.substr(0, (size_t)room);
        words[i] = w.substr((size_t)room);
      }
      out.push_back({line, y});
      line.clear();
      y += pitch;
    }
    if (!line.empty()) {
      if (y + 7 * block.scale > block.bottom) return false;
      out.push_back({line, y});
      y += pitch;
    }
    if (used) *used = y;
    return true;
  };
  std::vector<Placed> lines;
  const std::vector<std::u32string> all = words;
  if (lay(0, false, lines)) return lines;
  if (!newest) {
    // The start, cut: the last line that fits ends with "...".
    if (!lines.empty()) {
      std::u32string& last = lines.back().text;
      if (last.size() > 3) last = last.substr(0, last.size() - 3);
      last += U"...";
    }
    if (used) *used = lines.empty() ? block.top : lines.back().y + pitch;
    return lines;
  }
  // The fewest words dropped from the start that let the rest fit.
  size_t lo = 1, hi = all.size();
  while (lo < hi) {
    const size_t mid = (lo + hi) / 2;
    words = all;
    if (lay(mid, true, lines)) hi = mid;
    else lo = mid + 1;
  }
  words = all;
  lay(lo, true, lines);
  return lines;
}

void draw_lines(Canvas& canvas, const std::vector<Placed>& lines, const Block& block) {
  for (const Placed& line : lines) canvas.centered(line.y, line.text, block.scale, block.color);
}

int paragraph(Canvas& canvas, const std::string& text, Block block, bool newest = false) {
  int used = block.top;
  draw_lines(canvas, wrap(decode(text), block, newest, &used), block);
  return used;
}

/** One centered line at `y`, cut with "..." to what fits there. */
void title(Canvas& canvas, int y, const std::string& text, int scale, uint16_t color) {
  std::u32string line = decode(text);
  for (char32_t& c : line)
    if (c == '\n') c = ' ';
  const int room = capacity(y, 7 * scale, scale);
  if ((int)line.size() > room) line = line.substr(0, room > 3 ? room - 3 : 0) + U"...";
  canvas.centered(y, line, scale, color);
}

void state_word(const botkins::View& view, std::string& word, uint16_t& color) {
  if (view.listening) word = "Listening", color = kRed;
  else if (view.sending) word = "Sending", color = kAmber;
  else if (view.speaking) word = "Speaking", color = kGreen;
  else if (view.phase == "request") word = "Asking", color = kYellow;
  else if (view.phase == "working" || view.phase == "writing") word = "Working", color = kBlue;
  else word = "Ready", color = kWhite;
}

void draw_online(Canvas& canvas, const botkins::View& view) {
  title(canvas, 40, view.bot.empty() ? "Botkins" : view.bot, 3, kGray);
  std::string word;
  uint16_t color;
  state_word(view, word, color);
  title(canvas, 76, word, 5, color);
  int y = 130;

  // The bottom: a notice, or why the gadget can't hear or speak.
  std::string bottom = view.notice;
  if (bottom.empty() && (!view.can_hear || !view.can_speak)) bottom = "Choose a speech provider in Settings > Voice on your computer.";
  int limit = 400;
  if (!bottom.empty()) {
    const Block notice{2, kAmber, 358, 440, 2};
    draw_lines(canvas, wrap(decode(bottom), notice, false), notice);
    limit = 350;
  }

  if (!view.request.id.empty()) {
    const botkins::View::Request& request = view.request;
    y = paragraph(canvas, request.title.empty() ? "The bot is asking" : request.title, {3, kWhite, y, y + 3 * 30, 2});
    if (!request.preview.empty()) y = paragraph(canvas, request.preview, {2, kGray, y + 4, limit - 60, 2});
    if (request.kind == "permission") {
      title(canvas, limit - 52, "Yellow: approve", 2, kYellowKey);
      title(canvas, limit - 28, "Hold yellow: deny", 2, kYellowKey);
    } else {
      paragraph(canvas, "Answer this on your phone or computer.", {2, kGray, limit - 52, limit, 2});
    }
    return;
  }

  if (!view.heard.empty()) {
    y = paragraph(canvas, "You: " + view.heard, {2, kDim, y, y + 2 * 22, 2});
    y += 6;
  }
  std::string text = view.text;
  if (text.empty() && (view.phase == "working" || view.phase == "writing")) text = view.doing;
  if (!text.empty()) {
    paragraph(canvas, text, {3, kWhite, y, limit, 2}, true);
  } else if (view.phase == "idle" && !view.listening && !view.sending) {
    title(canvas, 230, "Hold blue to talk", 3, kBlueKey);
    title(canvas, 270, "Yellow: new chat", 2, kGray);
  }
}

void draw_message(Canvas& canvas, const char* head, const std::string& body, uint16_t color, const std::string& notice) {
  title(canvas, 150, head, 4, color);
  paragraph(canvas, body, {3, kWhite, 210, 360, 4});
  if (!notice.empty()) paragraph(canvas, notice, {2, kAmber, 366, 440, 2});
}
}  // namespace

void draw_view(uint16_t* frame, const botkins::View& view) {
  Canvas canvas(frame);
  canvas.clear();
  switch (view.stage) {
    case botkins::View::Stage::Setup:
      draw_message(canvas, "Botkins", "Plug into your computer and add this gadget in Botkins", kWhite, view.notice);
      break;
    case botkins::View::Stage::Joining:
      draw_message(canvas, "Joining", "Joining the Wi-Fi network", kBlue, view.notice);
      break;
    case botkins::View::Stage::NoNetwork:
      draw_message(canvas, "No Wi-Fi", "The Wi-Fi network can't be joined. It keeps trying; or set it up again over USB.", kAmber, view.notice);
      break;
    case botkins::View::Stage::Connecting:
      draw_message(canvas, "Connecting", "Looking for your computer", kBlue, view.notice);
      break;
    case botkins::View::Stage::Online:
      draw_online(canvas, view);
      break;
    case botkins::View::Stage::Removed:
      draw_message(canvas, "Removed", "This gadget was removed. Plug it into your computer and add it in Botkins again.", kAmber, "");
      break;
  }
}

void draw_boot(uint16_t* frame) {
  Canvas canvas(frame);
  canvas.clear();
  title(canvas, 200, "Botkins", 5, kWhite);
  title(canvas, 260, "Starting", 3, kGray);
}

}  // namespace stopwatch
