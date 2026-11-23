// A gadget on a computer: the same core as a board runs, with a folder for its flash, the
// computer's own network, and WAV files for its microphone and speaker. It is how the core is
// tested against a real link (gadget/tests), and how to try a gadget with no board at all.
//
//   botkins-gadget-sim <folder>
//
// Lines on standard input:
//   @botkins {...}          the setup protocol, as on a board's USB port
//   say <words>             typed words
//   hear <file.wav>         a recording: 16-bit mono WAV at the microphone's rate (16 kHz)
//   answer <action> [text]  answers the request on show
//   new | next | stop       a new chat, the next bot, stop the turn
//   away | home             away from the computer's network (none of its own addresses answers), or back
//   quit
// Each change of what a board would draw is printed as one line: "view {json}". What the speaker
// plays is written to <folder>/spoken-<n>.wav when the reply has been read.
//
// The relay is reached over ws:// (host/websocket.cpp), so only a relay on this computer. In the
// environment, BOTKINS_SIM_AWAY=1 starts away, and BOTKINS_SIM_PROBE_MS sets how soon a gadget on the
// relay looks for its computer's own addresses again.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>

#include "botkins/gadget.hpp"
#include "botkins/sockets.hpp"
#include "websocket.hpp"

using namespace botkins;

/** The computer's own network, which the gadget can leave: away, no address of the computer's answers. */
struct HostTransport : SocketTransport {
  std::atomic<bool> away{false};
  HttpResponse request(const std::string& host, const char* method, const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, const std::string& body, int timeout_ms) override {
    if (away) return HttpResponse();
    return SocketTransport::request(host, method, path, headers, body, timeout_ms);
  }
};

static void fill_random(uint8_t* out, size_t size) {
  FILE* file = fopen("/dev/urandom", "rb");
  if (!file || fread(out, 1, size, file) != size) abort();
  fclose(file);
}

struct FileStorage : Storage {
  std::string folder;
  std::string path(const char* name) { return folder + "/" + name + ".txt"; }
  bool load(const char* name, std::string& value) override {
    std::ifstream file(path(name), std::ios::binary);
    if (!file) return false;
    std::stringstream text;
    text << file.rdbuf();
    value = text.str();
    return true;
  }
  void save(const char* name, const std::string& value) override { std::ofstream(path(name), std::ios::binary | std::ios::trunc) << value; }
  void erase(const char* name) override { remove(path(name).c_str()); }
};

struct HostNetwork : Network {
  void join(const std::string&, const std::string&) override {}
  const char* state() override { return "on"; }
  std::string address() override { return "127.0.0.1"; }
};

/** The speaker: what was played is kept, and written as a WAV file when the reply ends. */
struct FileSpeaker : Speaker {
  std::string folder;
  std::mutex mutex;
  std::vector<int16_t> played;
  int rate = 16000, files = 0;
  bool begin(int next) override {
    std::lock_guard<std::mutex> lock(mutex);
    rate = next;
    played.clear();
    return true;
  }
  void write(const int16_t* samples, size_t count) override {
    std::lock_guard<std::mutex> lock(mutex);
    played.insert(played.end(), samples, samples + count);
  }
  void end(bool cut) override {
    std::lock_guard<std::mutex> lock(mutex);
    const std::string path = folder + "/spoken-" + std::to_string(++files) + ".wav";
    uint32_t bytes = (uint32_t)played.size() * 2;
    auto u32 = [](uint32_t v) { return std::string((const char*)&v, 4); };
    auto u16 = [](uint16_t v) { return std::string((const char*)&v, 2); };
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file << "RIFF" << u32(36 + bytes) << "WAVEfmt " << u32(16) << u16(1) << u16(1) << u32((uint32_t)rate) << u32((uint32_t)rate * 2) << u16(2) << u16(16) << "data" << u32(bytes);
    file.write((const char*)played.data(), bytes);
    printf("spoken %s %u bytes at %d%s\n", path.c_str(), bytes, rate, cut ? " (cut)" : "");
    fflush(stdout);
  }
};

static std::string view_line(const View& view) {
  static const char* stages[] = {"setup", "joining", "no-network", "connecting", "online", "removed"};
  Json json = Json::object().set("stage", stages[(int)view.stage]).set("phase", view.phase);
  auto text = [&json](const char* name, const std::string& value) {
    if (!value.empty()) json.set(name, value);
  };
  text("name", view.name);
  text("computer", view.computer);
  text("bot", view.bot);
  text("doing", view.doing);
  text("text", view.text);
  text("heard", view.heard);
  text("notice", view.notice);
  if (view.listening) json.set("listening", true);
  if (view.sending) json.set("sending", true);
  if (view.speaking) json.set("speaking", true);
  json.set("hear", view.can_hear).set("speak", view.can_speak);
  const auto& s = view.settings;
  json.set("settings", Json::object().set("volume", s.volume).set("mic", s.mic).set("mute", s.mute).set("brightness", s.brightness).set("dimAfter", s.dim_after).set("offAfter", s.off_after));
  if (!view.look.empty()) json.set("look", view.look).set("faces", view.faces ? view.faces->size() : 0);
  if (view.steps > 0) json.set("steps", view.steps);
  if (!view.request.id.empty()) json.set("request", Json::object().set("kind", view.request.kind).set("title", view.request.title).set("preview", view.request.preview).set("remember", view.request.remember));
  return "view " + json.dump();
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: botkins-gadget-sim <folder>\n");
    return 2;
  }
  set_random(fill_random);
  if (!crypto_self_test()) {
    fprintf(stderr, "crypto self test failed\n");
    return 1;
  }
  HostTransport transport;
  const char* away = getenv("BOTKINS_SIM_AWAY");
  transport.away = away && strcmp(away, "1") == 0;
  FileStorage storage;
  storage.folder = argv[1];
  HostNetwork network;
  FileSpeaker speaker;
  speaker.folder = argv[1];

  Board board;
  board.transport = &transport;
  board.storage = &storage;
  board.network = &network;
  board.speaker = &speaker;
  board.name = "sim";
  board.firmware = "0.1.0";
  board.mac = "00:00:00:00:00:00";
  board.screen_width = 240;
  board.screen_height = 240;
  // A restart asked for from the owner's page: said, so a test can see it, and nothing else on a computer.
  board.restart = [] {
    puts("restart");
    fflush(stdout);
  };
  board.socket = [] { return std::unique_ptr<Socket>(new HostSocket()); };
  if (const char* probe = getenv("BOTKINS_SIM_PROBE_MS")) board.relay_probe_ms = atoi(probe) > 0 ? atoi(probe) : board.relay_probe_ms;

  Gadget gadget(board);
  std::mutex printing;
  gadget.on_change = [&] {
    const std::string line = view_line(gadget.view());
    std::lock_guard<std::mutex> lock(printing);
    puts(line.c_str());
    fflush(stdout);
  };
  gadget.begin();

  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string answer = gadget.console(line);
    if (!answer.empty()) {
      std::lock_guard<std::mutex> lock(printing);
      puts(answer.c_str());
      fflush(stdout);
      continue;
    }
    std::istringstream words(line);
    std::string verb, rest;
    words >> verb;
    std::getline(words, rest);
    if (!rest.empty() && rest[0] == ' ') rest.erase(0, 1);
    if (verb == "quit") break;
    else if (verb == "say") gadget.say(rest);
    else if (verb == "new") gadget.new_chat();
    else if (verb == "next") gadget.next_bot();
    else if (verb == "stop") gadget.stop_turn();
    else if (verb == "quiet") gadget.stop_speaking();
    else if (verb == "away" || verb == "home") transport.away = verb == "away";
    else if (verb == "answer") {
      size_t space = rest.find(' ');
      gadget.answer(rest.substr(0, space), space == std::string::npos ? "" : rest.substr(space + 1));
    } else if (verb == "hear") {
      // The file's samples go in as a microphone gives them: a tenth of a second at a time, in real time or faster.
      std::ifstream file(rest, std::ios::binary);
      std::stringstream bytes;
      bytes << file.rdbuf();
      const std::string wav = bytes.str();
      if (wav.size() <= 44) {
        puts("error no such recording");
        fflush(stdout);
        continue;
      }
      std::vector<int16_t> samples((wav.size() - 44) / 2);
      memcpy(samples.data(), wav.data() + 44, samples.size() * 2);
      gadget.start_listening();
      const size_t step = (size_t)board.mic_rate / 10;
      for (size_t at = 0; at < samples.size(); at += step) {
        gadget.feed(samples.data() + at, std::min(step, samples.size() - at));
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      gadget.stop_listening();
    }
  }
  gadget.stop();
  return 0;
}
