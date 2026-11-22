# The gadget on ESP32 boards

An ESP-IDF project that runs the shared core (`../core`) as a `botkins::Gadget` on a board.

- `main/` is what every ESP32 board shares: random numbers (`esp_fill_random`, after the radio is on), NVS storage in the namespace `botkins`, Wi-Fi as a station (`off | joining | on | failed`, rejoining by itself), the USB console (lines to `gadget.console()`), the core's thread stacks, and a heap log.
- `components/botkins_core/` builds `../core` unchanged; `components/gadget_port/board.hpp` is what a board gives `main/`.
- `boards/<name>/` is one board: one ESP-IDF component with its pins, power chips, codec, display, keys and screen drawing, plus its `sdkconfig.defaults` and `idf_component.yml`. A second board is a second folder.

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

The USB console carries the boot log and the setup protocol (`../../docs/contract.md`, "Setup over USB"). Two lines of its own: `heap` logs free internal RAM and PSRAM (now, least since `heap reset`, least since boot), and `heap reset`.

`main/main.cpp` sets `SocketTransport::max_answer` to 512 KiB: a 32,000-byte speak slice is about 43 KB sealed, and a sync answer can carry a long reply's whole text; anything over 16 KB is allocated in PSRAM.

The StopWatch's screen dims to 10 % after 30 s online and idle with nothing changed and no key pressed, and turns its output off after 5 minutes idle; a view change or a key lights it at once (the key still does its job). Each change is one log line, `stopwatch: screen <from> -> <to> (<why>)`.

Opening the port from a program: the USB-Serial-JTAG resets the chip while DTR is low and RTS high. Open with DTR high and RTS low to keep it running (pyserial drops DTR before RTS unless told otherwise).

Third-party code: `../THIRD_PARTY.md`.
