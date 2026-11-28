// The "Halo" home screen and the quick-controls panel. Laid out for a 466-pixel round screen (the
// design kit's mockups, in their units) and scaled to the canvas. A ring at the edge says the state
// from across a room: a hairline at rest, cream while listening, a honey arc that grows a notch with
// each step while working, the Botkin's shell colour while speaking, clay when the bot needs you.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

#include "botkins/draw.hpp"

namespace botkins {
namespace {

constexpr float kSize = 466, kMid = kSize / 2, kEdge = kSize / 2;
constexpr float kMargin = 24;  // kept clear inside the round edge, at the height of each line

constexpr Rgb kBlack = hex(0x000000), kCream = hex(0xFFF8EA), kMuted = hex(0xB9AE9C), kHairline = hex(0x3A332E);
constexpr Rgb kTrack = hex(0x2A2522), kHoney = hex(0xE8A945), kClay = hex(0xE07A55), kBox = hex(0x1E1A17), kBoxText = hex(0xE9DFCF);
constexpr int kDimmed = 89;  // 35 % of full

const char kEllipsis[] = "\xE2\x80\xA6";

/** The layout's units (the 466 design) on this canvas. */
struct Frame {
  Canvas& canvas;
  float s, ox, oy;
  explicit Frame(Canvas& c)
      : canvas(c), s((float)std::min(c.width(), c.height()) / kSize), ox((c.width() - kSize * s) / 2), oy((c.height() - kSize * s) / 2) {}
  float x(float v) const { return ox + v * s; }
  float y(float v) const { return oy + v * s; }
  /** A type at a design size; never below 9 pixels on a small screen. */
  Type type(Typeface face, float size, bool bold = false, bool caps = false, float tracking = 0) const {
    Type t;
    t.face = face, t.bold = bold, t.caps = caps;
    t.px = std::max(size * s, std::min(size, 9.0f));
    t.tracking = tracking * s;
    return t;
  }
  /** How wide a line may be across the circle between design rows `top` and `bottom`. */
  float chord(float top, float bottom) const {
    const float d = std::max(std::fabs(top - kMid), std::fabs(bottom - kMid));
    if (d >= kEdge) return 0;
    return std::max(0.0f, 2 * (std::sqrt(kEdge * kEdge - d * d) - kMargin)) * s;
  }
};

// ---------------------------------------------------------------------------------------------
// Text that fits

bool space(char c) { return c == ' ' || c == '\n' || c == '\t' || c == '\r'; }
size_t next_char(const std::string& t, size_t at) {
  do at++;
  while (at < t.size() && ((unsigned char)t[at] & 0xC0) == 0x80);
  return at;
}
size_t prev_char(const std::string& t, size_t at) {
  do at--;
  while (at > 0 && ((unsigned char)t[at] & 0xC0) == 0x80);
  return at;
}

float width_of(Canvas& c, const std::string& t, size_t b, size_t e, const Type& type) { return c.measure(t.data() + b, e - b, type); }

/** The end of the longest run from `b` that fits `width`, broken between words (inside a word only when one word is too wide). */
size_t fit_forward(Canvas& c, const std::string& t, size_t b, size_t width_end, float width, const Type& type) {
  size_t best = b, pos = b;
  while (pos < width_end) {
    size_t we = pos;
    while (we < width_end && !space(t[we])) we++;
    if (width_of(c, t, b, we, type) > width) break;
    best = we;
    if (we >= width_end || t[we] == '\n') break;
    pos = we;
    while (pos < width_end && t[pos] == ' ') pos++;
    if (pos < width_end && t[pos] == '\n') break;
  }
  if (best == b && b < width_end) {  // one word wider than the line: break it
    best = next_char(t, b);
    for (size_t q = best; q < width_end && !space(t[q]);) {
      const size_t n = next_char(t, q);
      if (width_of(c, t, b, n, type) > width) break;
      best = q = n;
    }
  }
  return best;
}

/** The start of the longest run ending at `e` that fits `width`; the mirror of fit_forward. */
size_t fit_backward(Canvas& c, const std::string& t, size_t lo, size_t e, float width, const Type& type) {
  size_t best = e, pos = e;
  while (pos > lo) {
    size_t ws = pos;
    while (ws > lo && !space(t[ws - 1])) ws--;
    if (width_of(c, t, ws, e, type) > width) break;
    best = ws;
    if (ws <= lo || t[ws - 1] == '\n') break;
    pos = ws;
    while (pos > lo && t[pos - 1] == ' ') pos--;
    if (pos > lo && t[pos - 1] == '\n') break;
  }
  if (best == e && e > lo) {
    best = prev_char(t, e);
    for (size_t q = best; q > lo && !space(t[q - 1]);) {
      const size_t n = prev_char(t, q);
      if (width_of(c, t, n, e, type) > width) break;
      best = q = n;
    }
  }
  return best;
}

/** `t[b, e)` cut to `width`, ending with "…" when it was cut. */
std::string cut(Canvas& c, const std::string& t, size_t b, size_t e, float width, const Type& type, bool force_ellipsis = false) {
  if (!force_ellipsis && width_of(c, t, b, e, type) <= width) return t.substr(b, e - b);
  const float room = width - c.measure(kEllipsis, 3, type);
  size_t end = room > 0 ? fit_forward(c, t, b, e, room, type) : b;
  if (end > e) end = e;
  if (width_of(c, t, b, end, type) > room) end = b;
  // No space, comma or dash before the "…".
  for (bool more = true; more && end > b;) {
    more = false;
    if (space(t[end - 1]) || std::strchr(",.;:-", t[end - 1])) end--, more = true;
    else if (end - b >= 3 && (unsigned char)t[end - 3] == 0xE2 && (unsigned char)t[end - 2] == 0x80 &&
             ((unsigned char)t[end - 1] == 0x93 || (unsigned char)t[end - 1] == 0x94))  // – or —
      end -= 3, more = true;
  }
  return t.substr(b, end - b) + kEllipsis;
}

/** One line centred on the screen, its box's top at design row `top`; cut to fit the circle. */
void line(Frame& f, float top, const std::string& text, const Type& type, Rgb color, int opacity = 255, float max_width = 0) {
  if (text.empty()) return;
  Canvas& c = f.canvas;
  const float lh = c.line_height(type) / f.s;
  float width = f.chord(top, top + lh);
  if (max_width > 0) width = std::min(width, max_width * f.s);
  const std::string shown = cut(c, text, 0, text.size(), width, type);
  const float w = c.measure(shown, type);
  c.text(f.x(kMid) - w / 2, c.baseline(f.y(top), type), shown.data(), shown.size(), type, color, opacity);
}

struct Block {
  float top;            // design row of the first line's top
  float line_height;    // design units
  float width;          // the most a line may take, in design units (it may take less, near the edge)
  int max_lines;
  bool newest = false;  // too long: show the end, led by "…", instead of the start
};

/**
 * Wraps `text` in a centred block, each line as wide as the circle allows at its height.
 * Returns the number of lines drawn.
 */
int paragraph(Frame& f, const std::string& text, const Type& type, Rgb color, const Block& block, int opacity = 255) {
  Canvas& c = f.canvas;
  constexpr int kMaxLines = 12;
  const int slots = std::min(block.max_lines, kMaxLines);
  float widths[kMaxLines];
  for (int i = 0; i < slots; i++) {
    const float top = block.top + i * block.line_height;
    widths[i] = std::min(f.chord(top, top + block.line_height), block.width * f.s);
  }
  struct Span {
    size_t b, e;
  } spans[kMaxLines];
  int count = 0;
  size_t at = 0, end = text.size();
  while (end > 0 && space(text[end - 1])) end--;
  while (at < end && space(text[at])) at++;
  while (at < end && count < slots) {
    const size_t stop = fit_forward(c, text, at, end, widths[count], type);
    size_t e = stop;
    while (e > at && space(text[e - 1])) e--;
    spans[count++] = Span{at, e};
    at = stop;
    while (at < end && space(text[at])) at++;
  }
  std::string shown[kMaxLines];
  if (at >= end) {  // it all fits
    for (int i = 0; i < count; i++) shown[i] = text.substr(spans[i].b, spans[i].e - spans[i].b);
  } else if (!block.newest) {  // the start, cut on the last line
    for (int i = 0; i < count - 1; i++) shown[i] = text.substr(spans[i].b, spans[i].e - spans[i].b);
    const size_t b = spans[count - 1].b;
    shown[count - 1] = cut(c, text, b, std::min(end, b + 400), widths[count - 1], type, true);
  } else {  // the newest lines, filled from the bottom up, the first led by "…"
    size_t e = end;
    const float lead = c.measure(kEllipsis, 3, type);
    for (int i = slots - 1; i >= 0; i--) {
      const float room = i == 0 ? widths[0] - lead : widths[i];
      size_t b = fit_backward(c, text, 0, e, room, type);
      shown[i] = (i == 0 && b > 0 ? std::string(kEllipsis) : std::string()) + text.substr(b, e - b);
      e = b;
      while (e > 0 && space(text[e - 1])) e--;
      if (e == 0 && i > 0) {  // it ran out early (wide lines below): start at the top instead
        for (int k = 0; k < slots - i; k++) shown[k] = shown[i + k];
        count = slots - i;
        break;
      }
      count = slots;
    }
  }
  for (int i = 0; i < count; i++) {
    const float top = block.top + i * block.line_height;
    const float w = c.measure(shown[i], type);
    c.text(f.x(kMid) - w / 2, c.baseline(f.y(top), type, block.line_height * f.s), shown[i].data(), shown[i].size(), type, color, opacity);
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Pieces

void ring(Frame& f, float width, Rgb color) { f.canvas.annulus(f.x(kMid), f.y(kMid), kEdge * f.s, (kEdge - width) * f.s, color); }

void face(Frame& f, Faces& faces, const View& view, const char* pose, float left, float top, float size, int opacity = 255, bool original = false) {
  const int px = (int)std::lround(size * f.s);
  const uint8_t* rgba = original ? faces.original(px) : faces.face(view, pose, px);
  f.canvas.blit_rgba((int)std::lround(f.x(left)), (int)std::lround(f.y(top)), rgba, px, px, opacity);
}

/** The large layout: the Botkin, its name, a small label and a line under it. */
void big_face(Frame& f, Faces& faces, const View& view, const char* pose, int opacity = 255, bool original = false) {
  face(f, faces, view, pose, 123, 62, 220, opacity, original);
}
void name(Frame& f, const std::string& text, int opacity = 255) { line(f, 284, text, f.type(Typeface::Serif, 36), kCream, opacity); }
void label(Frame& f, const std::string& text, Rgb color) { line(f, 338, text, f.type(Typeface::Sans, 15, true, true, 2), color); }
void sub(Frame& f, const std::string& text, Rgb color, int lines = 1) {
  if (lines <= 1) return line(f, 366, text, f.type(Typeface::Sans, 18), color);
  paragraph(f, text, f.type(Typeface::Sans, 18), color, Block{366, 24, 340, lines});
}

/** The small layout: a small Botkin and its name over the reply. */
void reply(Frame& f, Faces& faces, const View& view, const char* pose, bool newest, const char* hint) {
  face(f, faces, view, pose, 173, 44, 120);
  line(f, 166, view.bot, f.type(Typeface::Serif, 24), kCream);
  paragraph(f, view.text, f.type(Typeface::Sans, 23), kCream, Block{208, 31, 354, 5, newest});
  if (hint) line(f, 386, hint, f.type(Typeface::Sans, 18), kMuted);
}

/** The honey arc while a turn works: a notch more with each step, never quite closed. */
void working_ring(Frame& f, int steps) {
  const float turns = 0.92f - 0.77f * std::pow(0.82f, (float)std::max(0, steps));
  ring(f, 10, kTrack);
  f.canvas.arc(f.x(kMid), f.y(kMid), kEdge * f.s, (kEdge - 10) * f.s, 0, turns, kHoney);
}

/** "Reading the plan · 4 steps": what the bot does, cut so the steps stay; or what it heard. */
void what_it_does(Frame& f, const View& view) {
  const Type type = f.type(Typeface::Sans, 18);
  if (view.doing.empty() && view.steps <= 0) {
    if (!view.heard.empty()) line(f, 366, "\xE2\x80\x9C" + view.heard + "\xE2\x80\x9D", type, kMuted);
    return;
  }
  std::string steps;
  if (view.steps > 0) steps = std::to_string(view.steps) + (view.steps == 1 ? " step" : " steps");
  if (view.doing.empty()) return line(f, 366, steps, type, kMuted);
  if (steps.empty()) return line(f, 366, view.doing, type, kMuted);
  Canvas& c = f.canvas;
  steps = " \xC2\xB7 " + steps;
  const float room = f.chord(366, 366 + c.line_height(type) / f.s) - c.measure(steps, type);
  line(f, 366, cut(c, view.doing, 0, view.doing.size(), room, type) + steps, type, kMuted);
}

void needs(Frame& f, Faces& faces, const View& view, const HomeOptions& options) {
  Canvas& c = f.canvas;
  const View::Request& r = view.request;
  ring(f, 10, kClay);
  face(f, faces, view, "needs", 173, 44, 120);
  line(f, 170, view.bot.empty() ? std::string("Needs you") : view.bot + " asks", f.type(Typeface::Sans, 15, true, true, 2), kClay);
  const int title_lines = paragraph(f, r.title, f.type(Typeface::Sans, 26, true), kCream, Block{196, 34, 354, 2});
  float y = 196 + 34 * std::max(1, title_lines) + 10;
  const bool permission = r.kind == "permission" || r.kind.empty();
  const bool question = r.kind == "question";
  if (!permission && !question) {  // a form or a secret: not on a gadget
    paragraph(f, "Answer this on your phone or computer.", f.type(Typeface::Sans, 18), kMuted, Block{y, 24, 322, 2});
    return;
  }
  // The preview (a command, a path), or a question's choices, in a dark box.
  std::string boxed = r.preview;
  if (question && !r.choices.empty()) {
    boxed.clear();
    for (const std::string& choice : r.choices) boxed += (boxed.empty() ? "" : "  \xC2\xB7  ") + choice;
  }
  const float hints_bottom = 400;  // the hint row's bottom, at most
  const float hint_gap = permission ? 24 + 44 : 0;
  if (!boxed.empty()) {
    const int room = (int)((hints_bottom - hint_gap - y - 20) / 22);
    if (room >= 1) {
      // The box is as tall as its text: count the lines at the box's inner width, then draw.
      const int lines = std::min(room, 3);
      const Type t = f.type(Typeface::Sans, 16);
      int used = 0;
      for (size_t at = 0, end = boxed.size(); at < end && used < lines; used++) {
        at = fit_forward(c, boxed, at, end, (322 - 28) * f.s, t);
        while (at < end && space(boxed[at])) at++;
      }
      const float h = 20 + 22 * used;
      c.fill_round_rect(f.x(72), f.y(y), 322 * f.s, h * f.s, 12 * f.s, kBox);
      paragraph(f, boxed, t, kBoxText, Block{y + 10, 22, 322 - 28, lines});
      y += h;
    }
  }
  if (!permission) return;
  // The keys: "Yellow: allow" in a honey pill, "Hold: deny" beside it.
  const float top = std::max(y + 24, 300.0f);
  const Type pill = f.type(Typeface::Sans, 18, true), plain = f.type(Typeface::Sans, 18);
  const std::string allow = options.allow_hint ? options.allow_hint : "", deny = options.deny_hint ? options.deny_hint : "";
  const float pill_w = c.measure(allow, pill) / f.s + 36, deny_w = deny.empty() ? 0 : c.measure(deny, plain) / f.s + 12;
  const float total = pill_w + (deny.empty() ? 0 : 14 + deny_w);
  float x = kMid - total / 2;
  if (!allow.empty()) {
    c.fill_round_rect(f.x(x), f.y(top), pill_w * f.s, 44 * f.s, 22 * f.s, kHoney);
    c.fill_round_rect(f.x(x + 2), f.y(top + 2), (pill_w - 4) * f.s, 40 * f.s, 20 * f.s, kBlack);
    c.text(f.x(x + 18), c.baseline(f.y(top), pill, 44 * f.s), allow.data(), allow.size(), pill, kCream);
    x += pill_w + 14;
  }
  if (!deny.empty()) c.text(f.x(x + 6), c.baseline(f.y(top), plain, 44 * f.s), deny.data(), deny.size(), plain, kMuted);
}

/** "Can't reach <computer>", and the rest of the core's sentence when it says more. */
void cant_reach(Frame& f, const View& view) {
  const std::string computer = view.computer.empty() ? "your computer" : view.computer;
  const std::string head = "Can't reach " + computer;
  line(f, 338, head, f.type(Typeface::Sans, 20, true), kHoney);
  std::string rest = view.notice;
  for (const std::string& lead : {head + ".", head, std::string("Can\xE2\x80\x99t reach ") + computer + "."})
    if (rest.compare(0, lead.size(), lead) == 0) {
      rest.erase(0, lead.size());
      break;
    }
  while (!rest.empty() && space(rest[0])) rest.erase(0, 1);
  paragraph(f, rest, f.type(Typeface::Sans, 17), kMuted, Block{370, 23, 320, 2});
}

}  // namespace

void draw_home(Canvas& canvas, const View& view, Faces& faces, const HomeOptions& options) {
  canvas.clear(kBlack);
  Frame f(canvas);
  if (options.dimmed) {  // asleep: the Botkin with its eyes closed, faint; no ring, nothing to read
    big_face(f, faces, view, "sleepy", kDimmed);
    name(f, view.bot, kDimmed);
    return;
  }
  const char* pose = pose_for(view);
  switch (view.stage) {
    case View::Stage::Setup:
      big_face(f, faces, view, pose, 255, true);
      name(f, "Hello");
      paragraph(f, "Plug me into your computer, then add me in Botkins.", f.type(Typeface::Sans, 19), kMuted, Block{338, 27, 322, 3});
      return;
    case View::Stage::Joining:
    case View::Stage::NoNetwork: {
      ring(f, 3, kHairline);
      big_face(f, faces, view, pose);
      const bool joining = view.stage == View::Stage::Joining;
      std::string say = joining ? (view.network.empty() ? "Joining the Wi-Fi network\xE2\x80\xA6" : "Joining " + view.network + "\xE2\x80\xA6")
                                : (!view.notice.empty() ? view.notice : view.network.empty() ? "Can't join the Wi-Fi network" : "Can't join " + view.network);
      paragraph(f, say, f.type(Typeface::Sans, 20), joining ? kMuted : kHoney, Block{296, 27, 340, 2});
      return;
    }
    case View::Stage::Connecting:
      ring(f, 3, kHoney);
      big_face(f, faces, view, pose);
      name(f, view.bot);
      if (!view.notice.empty()) cant_reach(f, view);
      else line(f, 338, "Finding " + (view.computer.empty() ? std::string("your computer") : view.computer) + "\xE2\x80\xA6", f.type(Typeface::Sans, 18), kMuted);
      return;
    case View::Stage::Removed:
      ring(f, 10, kClay);
      big_face(f, faces, view, pose);
      name(f, view.bot);
      paragraph(f, view.notice.empty() ? "This gadget was removed. Set it up again to use it." : view.notice, f.type(Typeface::Sans, 18), kMuted,
                Block{338, 24, 320, 3});
      return;
    case View::Stage::Online:
      break;
  }

  if (!view.request.id.empty()) return needs(f, faces, view, options);
  if (view.listening) {
    ring(f, 10, kCream);
    big_face(f, faces, view, pose);
    name(f, view.bot);
    label(f, "Listening", kCream);
    sub(f, view.settings.mute ? "The microphone is off" : "Let go to send", view.settings.mute ? kHoney : kMuted);
    return;
  }
  if (view.speaking) {
    const Rgb shell = faces.shell(view, pose);
    ring(f, 10, shell);
    if (!view.text.empty()) return reply(f, faces, view, pose, false, options.stop_hint);
    big_face(f, faces, view, pose);
    name(f, view.bot);
    label(f, "Speaking", shell);
    if (options.stop_hint) sub(f, options.stop_hint, kMuted);
    return;
  }
  if (view.phase == "writing" && !view.text.empty()) {
    working_ring(f, view.steps);
    return reply(f, faces, view, pose, true, nullptr);
  }
  if (view.sending || view.phase == "working" || view.phase == "writing") {
    working_ring(f, view.steps);
    big_face(f, faces, view, pose);
    name(f, view.bot);
    label(f, view.sending ? "Sending" : "Working", kHoney);
    what_it_does(f, view);
    return;
  }
  ring(f, 3, kHairline);
  if (!view.can_speak && !view.text.empty()) return reply(f, faces, view, pose, false, nullptr);  // no speaker: the reply stays on show
  big_face(f, faces, view, pose);
  name(f, view.bot);
  label(f, "Ready", kMuted);
  if (!view.notice.empty()) sub(f, view.notice, kHoney, 2);
  else if (view.settings.mute) sub(f, "The microphone is off", kMuted);
}

// ---------------------------------------------------------------------------------------------
// Quick controls

namespace {

#define ICON(body) \
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" width=\"24\" height=\"24\"><g fill=\"none\" stroke=\"#fff\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" body "</g></svg>"
const char kSpeaker[] = ICON("<path d=\"M4 9v6h4l5 4V5L8 9H4z\"/><path d=\"M16 9a4 4 0 0 1 0 6\"/>");
const char kMic[] = ICON("<rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5 11a7 7 0 0 0 14 0M12 18v3\"/>");
const char kMicOff[] = ICON("<rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\"/><path d=\"M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16\"/>");
const char kSun[] = ICON("<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/>");
const char kChat[] = ICON("<path d=\"M4 5h16v11H9l-5 4V5z\"/><path d=\"M12 8v5M9.5 10.5h5\"/>");
const char kClose[] = ICON("<path d=\"M7 7l10 10M17 7L7 17\"/>");
const char kMinus[] = ICON("<path d=\"M6 12h12\"/>");
const char kPlus[] = ICON("<path d=\"M12 6v12M6 12h12\"/>");
const char kWifi[] = ICON("<path d=\"M5 12.5a10 10 0 0 1 14 0\"/><path d=\"M2 9a15 15 0 0 1 20 0\"/><path d=\"M8.5 16a5 5 0 0 1 7 0\"/><path d=\"M12 19.5h.01\"/>");
#undef ICON

struct Button {
  QuickAction action;
  float cx, cy, r;  // design units: what is drawn
  float reach;      // what a touch may hit
};
// Four round buttons where the mockup has them, and volume down and up at the foot, between the dial's ends.
constexpr Button kButtons[] = {
    {QuickAction::Mute, 159, 156, 52, 60},       {QuickAction::Brightness, 307, 156, 52, 60},
    {QuickAction::NewChat, 159, 288, 52, 60},    {QuickAction::Close, 307, 288, 52, 60},
    {QuickAction::VolumeDown, 143, 382, 28, 36}, {QuickAction::VolumeUp, 323, 382, 28, 36},
};
// The Wi-Fi button (QuickOptions::wifi): small, in the gap at the centre, clear of the four around it.
constexpr Button kWifiButton = {QuickAction::Wifi, 233, 222, 22, 27};
// The volume dial: three quarters of a turn from the lower left, clockwise, open at the foot.
constexpr float kDialStart = 0.625f, kDialTurns = 0.75f;

void icon(Frame& f, Faces& faces, const char* svg, float cx, float cy, float size, Rgb color) {
  const int px = (int)std::lround(size * f.s);
  const uint8_t* mask = faces.icon(svg, px);
  f.canvas.blit_mask((int)std::lround(f.x(cx) - px / 2.0f), (int)std::lround(f.y(cy) - px / 2.0f), mask, px, px, px, color);
}

void round_button(Frame& f, const Button& b, Rgb border) {
  f.canvas.annulus(f.x(b.cx), f.y(b.cy), b.r * f.s, (b.r - 2) * f.s, border);
}

}  // namespace

void draw_quick(Canvas& canvas, const View& view, Faces& faces, const QuickOptions& options) {
  canvas.clear(kBlack);
  Frame f(canvas);
  const View::Settings& s = view.settings;
  const int volume = std::max(0, std::min(100, s.volume));
  // The edge is the volume: a dial with its level in cream.
  f.canvas.arc(f.x(kMid), f.y(kMid), kEdge * f.s, (kEdge - 10) * f.s, kDialStart, kDialTurns, kTrack);
  f.canvas.arc(f.x(kMid), f.y(kMid), kEdge * f.s, (kEdge - 10) * f.s, kDialStart, kDialTurns * volume / 100.0f, kMuted);
  line(f, 56, "Quick controls", f.type(Typeface::Sans, 18), kMuted);

  const Type small = f.type(Typeface::Sans, 15);
  auto cell = [&](const Button& b, const char* svg, const std::string& text, Rgb color, Rgb border) {
    round_button(f, b, border);
    // As the mockup's buttons: a 30-unit icon over a 15-unit label, the two centred together.
    const float group = 30 + 2 + canvas.line_height(small) / f.s, top = b.cy - group / 2;
    icon(f, faces, svg, b.cx, top + 15, 30, color);
    const float w = canvas.measure(text, small);
    canvas.text(f.x(b.cx) - w / 2, canvas.baseline(f.y(top + 32), small), text.data(), text.size(), small, color);
  };
  cell(kButtons[0], s.mute ? kMicOff : kMic, s.mute ? "Mic off" : "Mic on", s.mute ? kClay : kCream, s.mute ? kClay : kHairline);
  cell(kButtons[1], kSun, std::to_string(s.brightness) + "%", kCream, kHairline);
  cell(kButtons[2], kChat, "New chat", kCream, kHairline);
  cell(kButtons[3], kClose, "Close", kCream, kHairline);
  if (options.wifi) {
    round_button(f, kWifiButton, kHairline);
    icon(f, faces, kWifi, kWifiButton.cx, kWifiButton.cy + 1, 24, kCream);
  }

  // Volume: − and + either side of the level.
  const Button& down = kButtons[4];
  const Button& up = kButtons[5];
  round_button(f, down, kHairline);
  round_button(f, up, kHairline);
  icon(f, faces, kMinus, down.cx, down.cy, 24, volume > 0 ? kCream : kHairline);
  icon(f, faces, kPlus, up.cx, up.cy, 24, volume < 100 ? kCream : kHairline);
  const Type number = f.type(Typeface::Serif, 24);
  const std::string level = std::to_string(volume);
  const float nw = canvas.measure(level, number) / f.s, total = 24 + 6 + nw, left = kMid - total / 2;
  icon(f, faces, kSpeaker, left + 12, down.cy, 24, kMuted);
  canvas.text(f.x(left + 30), canvas.baseline(f.y(down.cy) - canvas.line_height(number) / 2, number), level.data(), level.size(), number, kCream);
}

QuickAction quick_hit(int x, int y, int width, int height, const QuickOptions& options) {
  const float s = (float)std::min(width, height) / kSize;
  if (s <= 0) return QuickAction::None;
  const float ox = (width - kSize * s) / 2, oy = (height - kSize * s) / 2;
  const float dx0 = ((float)x + 0.5f - ox) / s, dy0 = ((float)y + 0.5f - oy) / s;
  if (options.wifi) {
    const float dx = dx0 - kWifiButton.cx, dy = dy0 - kWifiButton.cy;
    if (dx * dx + dy * dy <= kWifiButton.reach * kWifiButton.reach) return QuickAction::Wifi;
  }
  for (const Button& b : kButtons) {
    const float dx = dx0 - b.cx, dy = dy0 - b.cy;
    const float reach = std::max(b.reach, 24 / s);  // never under 48 pixels across, on a small screen too
    if (dx * dx + dy * dy <= reach * reach) return b.action;
  }
  return QuickAction::None;
}

View::Settings quick_apply(QuickAction action, View::Settings s) {
  switch (action) {
    case QuickAction::VolumeDown: s.volume = s.volume <= 0 ? 0 : std::min(100, (s.volume - 1) / 10 * 10); break;
    case QuickAction::VolumeUp: s.volume = std::max(0, std::min(100, (s.volume / 10 + 1) * 10)); break;
    case QuickAction::Mute: s.mute = !s.mute; break;
    case QuickAction::Brightness: s.brightness = s.brightness < 40 ? 40 : s.brightness < 70 ? 70 : s.brightness < 100 ? 100 : 40; break;
    default: break;
  }
  return s;
}

}  // namespace botkins
