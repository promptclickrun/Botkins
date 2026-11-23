# The gadget on ESP32 boards

An ESP-IDF project that runs the shared core (`../core`) as a `botkins::Gadget` on a board.

- `main/` is what every ESP32 board shares: random numbers (`esp_fill_random`, after the radio is on), NVS storage in the namespace `botkins`, Wi-Fi as a station (`off | joining | on | failed`, rejoining by itself, its signal from the access point's RSSI; when the core moves to another saved network, the one left is not counted as a failure), the USB console (lines to the board's `console()`, then to `gadget.console()`), the core's thread stacks, `Board::restart` (`esp_restart`), and a heap log.
- `components/botkins_core/` builds `../core` unchanged, the screen's drawing too (`draw.cpp`, `faces.cpp`, `home.cpp` with NanoSVG and stb_truetype), and embeds the two fonts (`EMBED_FILES`) that a board hands to `Canvas::set_fonts`. The drawing is built `-O2`; the rest `-Os`. `components/gadget_port/board.hpp` is what a board gives `main/`.
- `boards/<name>/` is one board: one ESP-IDF component with its pins, power chips, codec, display, touch, keys and the screen (drawn by the core), plus its `sdkconfig.defaults` and `idf_component.yml`. A second board is a second folder.

Boards: `m5stack-stopwatch` (M5Stack StopWatch, the default).

## Build, flash, watch

```sh
. ~/esp/esp-idf/export.sh            # ESP-IDF 6.0.x
cd gadget/firmware/esp32
idf.py set-target esp32s3            # once
idf.py build                         # or: idf.py -DBOARD=<name> -B build-<name> build
idf.py -p /dev/cu.usbmodemXXXX flash # bootloader, partition table, otadata, app; nothing else is erased
idf.py -p /dev/cu.usbmodemXXXX monitor
```

The partition table keeps `nvs` at 0x9000 (0x6000), where earlier firmware kept the Wi-Fi network: on its first start the gadget adopts a network the Hermes Gadget firmware saved (namespace `hgadget`, read only) when it has none of its own. Two 4 MB app slots follow.

The USB console carries the boot log and the setup protocol (`../../docs/contract.md`, "Setup over USB"). The board has lines of its own (below), and the port two more: `heap` logs free internal RAM and PSRAM (now, least since `heap reset`, least since boot), and `heap reset`.

`main/main.cpp` sets `SocketTransport::max_answer` to 512 KiB: a 32,000-byte speak slice is about 43 KB sealed, and a sync answer can carry a long reply's whole text; anything over 16 KB is allocated in PSRAM.

## The StopWatch

The screen is the core's (`draw_home`, `draw_quick` in `../core/include/botkins/draw.hpp`), drawn whole into a 466×466 RGB565 frame in PSRAM when what it shows changes (at most every 150 ms; nothing moves on its own) and sent to the panel in 8-row bands through two DMA buffers. The log has the time of the draw and of the flush for the first two draws of each screen (`stopwatch: screen <kind>: draw … ms, flush … ms`). Measured: a redraw 33–90 ms, a flush 26–32 ms. A bot's face is about 117 KB of SVG; drawing one takes about 3 s on this chip, so while the gadget is idle the board draws each pose ahead, off screen (`a face drawn ahead in … ms`), and the first time a pose shows it is drawn in under 100 ms. While the screen draws, every allocation prefers PSRAM (`heap_caps_malloc_extmem_enable(0)` for the draw's length): NanoSVG parses a face into thousands of small blocks, which would otherwise take most of the internal RAM.

The gadget's settings (`../../docs/contract.md`, "Settings") are applied as they change, each with one log line: `volume` is the ES8311's output volume (0 leaves the output muted), `mic` its microphone gain (low 18 dB, normal 24 dB, high 30 dB: the codec's 6 dB steps), `brightness` the panel's (DCS 0x51). Online and idle with no key, touch or change, the screen dims after `dimAfter` seconds (the sleepy Botkin, faint, the panel at a fifth of `brightness`, at least 1 %) and goes dark after `offAfter` seconds; 0 is never. A change, a key or a touch lights it again; a touch on a dim screen only wakes it.

Keys: blue held talks (a press while it speaks stops it); yellow approves a request (held for most of a second, denies it), and otherwise starts a new chat; red, read through the M5PM1 every 100 ms, only wakes the screen. A tap on the home screen opens the quick controls (not while a request waits or the gadget listens), and the touch screen (a CST820 at 0x15, polled every 20 ms) works them: a tap is where the finger came down, mapped with `quick_hit`. Volume −/+ (with a 100 ms, 1 kHz tick at the new volume), Mute and Brightness go to `Gadget::change_settings`; New chat starts one; Close closes. The panel closes by itself after 8 s without a touch, when the screen dims, and when blue is pressed. The M5PM1 acts on the red key itself: a double click powers the StopWatch off, and a 4 s press puts it in download mode. That is why no control of the gadget's is on red.

## The board's own console lines

Handled by the board before a line reaches `gadget.console()`; for looking at and working the gadget from a computer, with nobody at it.

| Line | What it does |
| --- | --- |
| `@botkins {"do":"frame"}` | Prints the frame as last drawn: `@botkins {"frame":{"width":466,"height":466,"format":"rgb565be","kind":"<screen>","light":"bright"\|"dim"\|"dark"}}`, then one line per row, `@frame <y> <base64 of the row's RGB565, big-endian>`, then `@botkins {"frame":"end","ms":<time to print>}` (about 0.7 s). Log lines may come between rows; the row number places each. `tools/frame_to_png.py <captured console text> <out.png>` turns the last whole one into a PNG. It is what was drawn, not what the panel shows. |
| `@botkins {"do":"key","key":"blue"\|"yellow"\|"red","ms":<hold>}` | Presses a key for `ms` (50 to 10,000; 100 when left out), read as the real key is: blue held 3000 talks for 3 s, yellow held 1000 denies, red only wakes the screen. Answers `{"ok":true}` at once. |
| `@botkins {"do":"touch","x":<x>,"y":<y>}` | A tap at (x, y), in panel pixels (0 to 465), as the touch screen gives one. |

Opening the port from a program: the USB-Serial-JTAG resets the chip while DTR is low and RTS high. Open with DTR high and RTS low to keep it running (pyserial drops DTR before RTS unless told otherwise).

Third-party code: `../THIRD_PARTY.md`.
