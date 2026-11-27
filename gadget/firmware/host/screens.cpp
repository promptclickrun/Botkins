// Every screen the gadget draws, as PNG files: each stage and phase of the home screen, a request,
// long and empty text, a missing face, another bot's Botkin, dimmed, the quick-controls panel, and
// smaller and rectangular screens. How the drawing is checked without a board (gadget/tests).
//
//   botkins-gadget-screens <folder> [faces folder]
//
// The faces folder (default: firmware/host/faces) holds one folder of pose SVGs per Botkin. One line
// per file is printed: "<name>.png <width>x<height> <milliseconds to draw>".
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "botkins/draw.hpp"

#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wsign-compare"
#endif
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "../core/third_party/stb/stb_image_write.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

using namespace botkins;

// The fonts, embedded at build time (build/fonts.cpp, from firmware/host/embed.c), as a port embeds them.
extern const unsigned char botkins_serif[];
extern const unsigned long botkins_serif_size;
extern const unsigned char botkins_sans[];
extern const unsigned long botkins_sans_size;

namespace {

using FaceSet = std::shared_ptr<const std::map<std::string, std::string>>;

FaceSet load_faces(const std::string& folder, std::initializer_list<const char*> skip = {}) {
  auto faces = std::make_shared<std::map<std::string, std::string>>();
  for (const char* pose : kPoses) {
    bool skipped = false;
    for (const char* s : skip) skipped = skipped || std::strcmp(s, pose) == 0;
    std::ifstream file(folder + "/" + pose + ".svg", std::ios::binary);
    if (skipped || !file) continue;
    std::stringstream text;
    text << file.rdbuf();
    (*faces)[pose] = text.str();
  }
  return faces;
}

bool write_png(const std::string& path, const std::vector<uint16_t>& frame, int w, int h) {
  std::vector<uint8_t> rgb((size_t)w * h * 3);
  for (size_t i = 0; i < (size_t)w * h; i++) {
    const uint16_t v = (uint16_t)((frame[i] >> 8) | (frame[i] << 8));  // the canvas swaps bytes, as for the panel
    const int r = (v >> 11) & 0x1F, g = (v >> 5) & 0x3F, b = v & 0x1F;
    rgb[i * 3] = (uint8_t)(r << 3 | r >> 2), rgb[i * 3 + 1] = (uint8_t)(g << 2 | g >> 4), rgb[i * 3 + 2] = (uint8_t)(b << 3 | b >> 2);
  }
  return stbi_write_png(path.c_str(), w, h, 3, rgb.data(), w * 3) != 0;
}

struct Case {
  std::string name;
  View view;
  HomeOptions options;
  bool quick = false;
  QuickOptions quick_options = {};
  int width = 466, height = 466;
};

const char kLong[] =
    "Here\xE2\x80\x99s launch week. Monday, freeze the copy at noon. Tuesday, two reviews, then the press note. Wednesday, the "
    "store pages go up \xE2\x80\x94 screenshots first, then the text. Thursday is for the newsletter and the last fixes. "
    "Friday we ship at ten, and I\xE2\x80\x99ll watch the numbers for you all afternoon.";

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: botkins-gadget-screens <folder> [faces folder]\n");
    return 2;
  }
  const std::string out = argv[1];
  std::string faces_dir;
  if (argc > 2) faces_dir = argv[2];
  else {  // next to the program: build/../host/faces
    std::string self = argv[0];
    const size_t slash = self.find_last_of('/');
    faces_dir = (slash == std::string::npos ? std::string(".") : self.substr(0, slash)) + "/../host/faces";
  }

  const FaceSet tidepool = load_faces(faces_dir + "/tidepool");
  const FaceSet spool = load_faces(faces_dir + "/spool");
  const FaceSet partial = load_faces(faces_dir + "/tidepool", {"listening", "working"});
  if (tidepool->size() != 7 || spool->empty()) {
    std::fprintf(stderr, "faces missing in %s\n", faces_dir.c_str());
    return 1;
  }

  View base;
  base.stage = View::Stage::Online;
  base.name = "Desk gadget";
  base.computer = "Demo Mac";
  base.bot = "Mira";
  base.can_hear = base.can_speak = true;
  base.look = "tidepool";
  base.faces = tidepool;
  base.network = "Home network";

  std::vector<Case> cases;
  auto add = [&](const std::string& name, const std::function<void(View&)>& edit, HomeOptions options = {}) {
    Case c{name, base, options};
    edit(c.view);
    cases.push_back(c);
  };
  // Before it is online.
  add("setup", [](View& v) { v.stage = View::Stage::Setup; v.bot.clear(); v.faces = nullptr; v.look.clear(); });
  add("joining", [](View& v) { v.stage = View::Stage::Joining; });
  add("no-network", [](View& v) { v.stage = View::Stage::NoNetwork; v.notice = "Can't join Home network. Check the password in Botkins."; });
  add("connecting", [](View& v) { v.stage = View::Stage::Connecting; v.notice = "Can't reach Demo Mac. Check that Botkins is open there, on the same Wi-Fi."; });
  add("connecting-first", [](View& v) { v.stage = View::Stage::Connecting; });
  add("removed", [](View& v) { v.stage = View::Stage::Removed; v.notice = "This gadget was removed. Set it up again to use it."; });
  // Online, each phase.
  add("ready", [](View&) {});
  add("ready-notice", [](View& v) { v.notice = "Your computer can't be reached right now."; });
  add("ready-muted", [](View& v) { v.settings.mute = true; });
  add("listening", [](View& v) { v.listening = true; });
  add("sending", [](View& v) { v.sending = true; v.heard = "What's on for launch week?"; });
  add("working", [](View& v) { v.phase = "working"; v.doing = "Reading the plan"; v.steps = 4; });
  add("working-first-step", [](View& v) { v.phase = "working"; });
  add("working-many-steps", [](View& v) { v.phase = "working"; v.doing = "Checking every page of the press kit against the plan"; v.steps = 14; });
  add("writing", [](View& v) { v.phase = "writing"; v.steps = 5; v.text = "Here\xE2\x80\x99s launch week. Monday, freeze the copy at noon."; });
  add("writing-long", [](View& v) { v.phase = "writing"; v.steps = 6; v.text = kLong; });
  add("speaking", [](View& v) { v.speaking = true; v.text = "Here\xE2\x80\x99s launch week. Monday, freeze the copy at noon. Tuesday, two reviews, then the press note."; });
  add("speaking-long", [](View& v) { v.speaking = true; v.text = kLong; });
  add("speaking-empty", [](View& v) { v.speaking = true; });
  add("reply-no-speaker", [](View& v) { v.can_speak = false; v.text = "Done: the press note is in your drafts, and Tuesday\xE2\x80\x99s reviews are on the calendar."; });
  add("text-utf8", [](View& v) {
    v.speaking = true;
    v.text = "\xE2\x80\x9C" "Caf\xC3\xA9 cr\xC3\xA8me br\xC3\xBBl\xC3\xA9" "e\xE2\x80\x9D \xE2\x80\x94 na\xC3\xAFve r\xC3\xA9sum\xC3\xA9, "
             "Z\xC3\xBCrich & S\xC3\xA3o Paulo \xF0\x9F\x8E\x89 \xE6\x97\xA5\xE6\x9C\xAC. It\xE2\x80\x99s 5\xC2\xB0" "C\xE2\x80\xA6 "
             "averyveryverylongwordthatcannotpossiblyfitononelineofthisroundscreen";
  });
  // Requests.
  add("needs-permission", [](View& v) {
    v.phase = "request";
    v.request.id = "r1", v.request.kind = "permission", v.request.title = "Run a command", v.request.preview = "npm run deploy -- --env production";
  });
  add("needs-long", [](View& v) {
    v.phase = "request";
    v.request.id = "r2", v.request.kind = "permission";
    v.request.title = "Write to a file outside the project folder, in your documents";
    v.request.preview = "/Users/mira/Documents/Launch/press-kit/final/press-note-v7-really-final.md and four more files in that folder";
  });
  add("needs-question", [](View& v) {
    v.phase = "request";
    v.request.id = "r3", v.request.kind = "question", v.request.title = "Which day should the press note go out?";
    v.request.choices = {"Tuesday", "Wednesday", "Thursday"};
  });
  add("needs-form", [](View& v) { v.phase = "request"; v.request.id = "r4", v.request.kind = "secure", v.request.title = "Sign in to the store"; });
  // Faces.
  add("missing-face", [&](View& v) { v.faces = partial; v.look = "tidepool-partial"; v.listening = true; });
  add("no-faces", [](View& v) { v.faces = nullptr; v.look.clear(); });
  add("spool-ready", [&](View& v) { v.bot = "Spool"; v.look = "spool"; v.faces = spool; });
  add("spool-speaking", [&](View& v) { v.bot = "Spool"; v.look = "spool"; v.faces = spool; v.speaking = true; v.text = "Your mix is ready: three tracks, forty minutes, no repeats."; });
  HomeOptions dim;
  dim.dimmed = true;
  add("dimmed", [](View&) {}, dim);
  // The quick-controls panel.
  add("quick", [](View& v) { v.settings.volume = 60; v.settings.brightness = 70; });
  cases.back().quick = true;
  add("quick-muted", [](View& v) { v.settings.volume = 0; v.settings.mute = true; v.settings.brightness = 100; });
  cases.back().quick = true;
  // A board that changes its Wi-Fi from a phone nearby: the Wi-Fi button at the centre.
  add("quick-wifi", [](View& v) { v.settings.volume = 60; v.settings.brightness = 70; });
  cases.back().quick = true;
  cases.back().quick_options.wifi = true;
  // Other screens: 240 round, 320 by 240.
  for (const char* name : {"ready", "speaking", "needs-permission", "working", "quick", "quick-wifi"})
    for (const Case& c : std::vector<Case>(cases))
      if (c.name == name) {
        Case small = c;
        small.name = c.name + "-240";
        small.width = small.height = 240;
        cases.push_back(small);
        if (c.name == "ready" || c.name == "quick") {
          Case wide = c;
          wide.name = c.name + "-320x240";
          wide.width = 320, wide.height = 240;
          cases.push_back(wide);
        }
      }

  Faces faces;
  std::map<std::pair<int, int>, std::unique_ptr<Canvas>> canvases;
  std::map<std::pair<int, int>, std::vector<uint16_t>> frames;
  int failed = 0;
  double slowest = 0;
  for (const Case& c : cases) {
    const auto key = std::make_pair(c.width, c.height);
    if (!canvases.count(key)) {
      frames[key].assign((size_t)c.width * c.height, 0);
      canvases[key].reset(new Canvas(frames[key].data(), c.width, c.height, true));
      if (!canvases[key]->set_fonts(botkins_serif, botkins_serif_size, botkins_sans, botkins_sans_size)) {
        std::fprintf(stderr, "fonts can't be read\n");
        return 1;
      }
    }
    Canvas& canvas = *canvases[key];
    double ms[2];
    for (int round = 0; round < 2; round++) {  // the first draws faces and glyphs; the second is a redraw
      const auto start = std::chrono::steady_clock::now();
      if (c.quick) draw_quick(canvas, c.view, faces, c.quick_options);
      else draw_home(canvas, c.view, faces, c.options);
      ms[round] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    }
    slowest = std::max(slowest, ms[1]);
    const std::string path = out + "/" + c.name + ".png";
    if (!write_png(path, frames[key], c.width, c.height)) {
      std::fprintf(stderr, "can't write %s\n", path.c_str());
      failed++;
      continue;
    }
    std::printf("%s.png %dx%d first %.2f ms, redraw %.2f ms, faces %zu KB\n", c.name.c_str(), c.width, c.height, ms[0], ms[1], faces.memory() / 1024);
  }
  std::printf("slowest redraw %.2f ms\n", slowest);

  // The panel's touches and what they change.
  struct Hit {
    int x, y, w, h;
    QuickAction want;
  } hits[] = {
      {159, 156, 466, 466, QuickAction::Mute},     {307, 156, 466, 466, QuickAction::Brightness}, {159, 288, 466, 466, QuickAction::NewChat},
      {307, 288, 466, 466, QuickAction::Close},    {143, 382, 466, 466, QuickAction::VolumeDown}, {323, 382, 466, 466, QuickAction::VolumeUp},
      {233, 233, 466, 466, QuickAction::None},     {10, 10, 466, 466, QuickAction::None},         {74, 197, 240, 240, QuickAction::VolumeDown},
      {166, 197, 240, 240, QuickAction::VolumeUp}, {160 + 74, 197, 320, 240, QuickAction::None},  {40 + 74, 197, 320, 240, QuickAction::VolumeDown},
  };
  for (const Hit& h : hits) {
    if (quick_hit(h.x, h.y, h.w, h.h) != h.want) {
      std::printf("quick_hit(%d, %d, %dx%d) is %d, not %d\n", h.x, h.y, h.w, h.h, (int)quick_hit(h.x, h.y, h.w, h.h), (int)h.want);
      failed++;
    }
  }
  // With the Wi-Fi button: the centre is Wi-Fi, the four around it are theirs still, and a touch just
  // outside the button is nothing.
  QuickOptions wifi;
  wifi.wifi = true;
  const Hit wifi_hits[] = {
      {233, 222, 466, 466, QuickAction::Wifi},   {233, 240, 466, 466, QuickAction::Wifi},       {159, 156, 466, 466, QuickAction::Mute},
      {307, 288, 466, 466, QuickAction::Close},  {233, 120, 466, 466, QuickAction::None},       {120, 115, 240, 240, QuickAction::Wifi},
      {233, 262, 466, 466, QuickAction::None},
  };
  for (const Hit& h : wifi_hits) {
    if (quick_hit(h.x, h.y, h.w, h.h, wifi) != h.want) {
      std::printf("with Wi-Fi, quick_hit(%d, %d, %dx%d) is %d, not %d\n", h.x, h.y, h.w, h.h, (int)quick_hit(h.x, h.y, h.w, h.h, wifi), (int)h.want);
      failed++;
    }
  }
  View::Settings s;
  s.volume = 65, s.brightness = 80, s.mute = false;
  const int volumes[] = {quick_apply(QuickAction::VolumeDown, s).volume, quick_apply(QuickAction::VolumeUp, s).volume};
  s.volume = 100;
  const int top = quick_apply(QuickAction::VolumeUp, s).volume;
  s.volume = 0;
  const int bottom = quick_apply(QuickAction::VolumeDown, s).volume;
  int brightness = 80, cycle[4];
  for (int& b : cycle) {
    s.brightness = brightness;
    b = brightness = quick_apply(QuickAction::Brightness, s).brightness;
  }
  const bool settings_ok = volumes[0] == 60 && volumes[1] == 70 && top == 100 && bottom == 0 && cycle[0] == 100 && cycle[1] == 40 &&
                           cycle[2] == 70 && cycle[3] == 100 && quick_apply(QuickAction::Mute, s).mute;
  if (!settings_ok) failed++;
  std::printf("quick checks %s\n", failed ? "failed" : "ok");
  return failed ? 1 : 0;
}
