# The gadget on ESP32 boards

An ESP-IDF project that runs the shared core (`../core`) as a `botkins::Gadget` on a board.

- `main/` is what every ESP32 board shares: random numbers (`esp_fill_random`, after the radio is on), NVS storage in the namespace `botkins`, Wi-Fi as a station (`off | joining | on | failed`, rejoining by itself, its signal from the access point's RSSI; when the core moves to another saved network, the one left is not counted as a failure), the USB console (lines to the board's `console()`, then to `gadget.console()`), the core's thread stacks, `Board::restart` (`esp_restart`), the WebSocket (`Board::socket`, below), and a heap log.
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

The USB console carries the boot log and the setup protocol (`../../docs/contract.md`, "Setup over USB"). The board has lines of its own (below), and the port more: `heap` logs free internal RAM and PSRAM (now, least since `heap reset`, least since boot: the heap's own minimum, which no short dip escapes), `heap reset`, `tasks` (each task's least stack left since it started, and whether its stack is internal RAM or PSRAM), `heap tasks` (each task's internal RAM now and the most it held; only in a build with `CONFIG_HEAP_TASK_TRACKING`, and `CONFIG_HEAP_TRACK_DELETED_TASKS` for tasks that ended, which slows every allocation: for measuring only), and `socket <url> [subprotocol|-] [first message]` ("The WebSocket", below).

## The WebSocket

`main/websocket.cpp` is the core's `Socket` (`../core/include/botkins/hal.hpp`) for every ESP32 board, on ESP-IDF's `esp_websocket_client` (a managed component, pinned in `main/idf_component.yml`). The core uses it for the relay (`wss://relay.botkins.app/v1/room/<room>`, subprotocol `botkins.phone.v1`) and for live voice (Gemini's `wss://` address with its token in the query, no subprotocol). What it adds to the client:

- `wss://` is checked against ESP-IDF's certificate bundle (`esp_crt_bundle_attach`); `ws://` is plain, for a local address.
- Whole messages: the client hands over a frame 20 KB at a time, and a message may come in several frames. They are joined, text or binary, up to `max_message`; a longer one closes the socket with 1009 (fragments out of order: 1002), and the core hears `closed`.
- The subprotocol: the one offered goes in the upgrade, and the server's answer must name it; with none offered no `Sec-WebSocket-Protocol` header goes, and an answer that names one fails the open. (The public relay refuses a wrong or missing one itself, with HTTP 400.)
- No reconnecting: a socket that ends is over, and the core is told once (`closed`: the server's close code, or 0 when the connection broke or a ping went unanswered for 45 s; the client pings every 15 s).
- `close()` sends a close frame, waits up to 1 s for the server's, and returns once the client's task has ended: no event follows. A message being sent finishes first.
- Sends take a lock of their own (`CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK`), not the one the client's task reads under: the core may hold the socket's task for a while in a message (live voice waits there for room to play), and a send from another thread must not wait for it.
- The upgrade request is built in the transport's buffer, which is 4 KB (`CONFIG_WS_BUFFER_SIZE`, freed once open), so a long token fits. The log names an address without its query, so a token never shows.

Memory (`sdkconfig.defaults`, the board's): allocations over 4 KB go to PSRAM (`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=4096`; drivers that need DMA ask for internal RAM themselves). mbedTLS allocates in PSRAM (`CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC`), so a TLS connection's 16 KB in and 4 KB out buffers and its handshake are not in internal RAM; the client's two 20 KB buffers are in PSRAM too. What stays internal is the client's task (an 8 KB stack, of which a TLS handshake and its messages used 3.8 KB) and its small parts: an open socket holds about 14 KB of internal RAM, and about 20 KB at the moment it opens. Each socket logs, as it opens, the time it took (DNS, TCP, TLS and the upgrade) and the memory free; as it closes, the least stack its task had left.

`socket <url> [subprotocol|-] [first message]` on the console opens one socket there, on a thread of its own (its stack in PSRAM), and logs each step: DNS, TCP and the TLS handshake alone (`esp_tls`, the bundle), the WebSocket's open or why it didn't open (`HTTP 400`, a TLS error), the first message or the server's close (its code and words), with the memory at each step. With `-`, no subprotocol is offered. Measured on the StopWatch (Wi-Fi at -38 dBm):

| | |
| --- | --- |
| `relay.botkins.app`: TCP and TLS handshake | 1.49 s |
| relay socket open (DNS, TCP, TLS, upgrade) | 1.58–1.67 s |
| Gemini's address: TCP and TLS handshake | 1.49–1.50 s |
| Gemini's socket open | 1.48–1.52 s; with `access_token=invalid` the upgrade is accepted, and a setup is closed with 1007 ("Missing or malformed auth token…") |
| internal RAM free, relay socket open, idle | 107–111 KB |
| internal RAM, a second TLS socket opening beside the relay's | least 88.5 KB (from 107.8 KB) |
| internal RAM, least since boot, online through the relay | 60.5–60.9 KB (the boot's first sync and the faces drawn ahead, with the relay socket open; 71–73 KB on the computer's own network) |
| PSRAM free, relay socket open | 5.0–5.1 MB (least 4.57 MB) |

A live session adds the core's live thread and the second socket while it is open. The board makes the thread (`Board::thread` in `main.cpp`): a 10 KB stack in internal RAM, since a call on it may save the computer's addresses to flash, which a task with its stack in PSRAM must not do. A session with `ask_bot` used 4.1 KB of it. When the session ends the gadget's worker joins the thread, so its stack is freed then rather than at the next press. Measured on the StopWatch, paired with a computer through the relay, live voice through Gemini, a spoken request that Gemini hands to the bot with `ask_bot`:

| | |
| --- | --- |
| internal RAM free, idle on the relay | 104–108 KB |
| a live session open, between turns | 78–87 KB |
| least during the turn | 76 KB |
| after the session ended | 97.9 KB (the console's `listen` hold keeps its 6 KB stack until the next `listen`) |

Before, with allocations up to 16 KB in internal RAM and 16 KB stacks for the live and hold threads, the least during such a turn was 18–28 KB. `heap tasks` showed why: the live thread's own buffers (the session's setup, each 100 ms of the microphone as base64 and as JSON) are 4–16 KB each, and it held up to 31 KB of internal RAM at once. With 4 KB, that was 18 KB, nearly all in PSRAM.

Gemini ends a session itself after about 2 minutes with nothing sent (close code 1008, "Session closed due to client inactivity"), before the gadget's own 3 minutes. The gadget sees its socket close, and the next press opens another session.

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
