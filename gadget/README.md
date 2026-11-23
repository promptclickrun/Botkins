# Botkins gadgets

A gadget is a small device with a microphone, a speaker and maybe a screen that talks with one of your bots. Hold a button, say something, hear the answer. It runs on an ESP32 board and uses the same sealed link as the phone app, so it needs no account, no cloud and no certificate.

This folder is the SDK: the contract, the firmware's portable core, and a build of the gadget that runs on a computer.

| Path | What it holds |
| --- | --- |
| [`docs/contract.md`](docs/contract.md) | What a gadget builds against: pairing by introduction, what it is sent, its calls, the link's bytes, and setup over USB. Start here. |
| `firmware/core/` | The gadget in portable C++17, with no board in it: the link (X25519, HKDF-SHA256, ChaCha20-Poly1305), keeping in step with the computer, recording, reading replies aloud, the setup lines on the USB port, and the screen (`include/botkins/draw.hpp`: the home screen and the quick-controls panel, drawn into any RGB565 frame). |
| `firmware/host/` | A gadget on a computer: the same core with a folder for its flash and WAV files for its microphone and speaker; and `botkins-gadget-screens`, which draws every screen to PNG files. |
| `firmware/esp32/` | The ESP-IDF project for real boards. |
| `tests/` | The compiled gadget against the computer's real link (`mobile/link-host`) with the demo backend, directly and through the real relay (`mobile/relay/node`). |

The computer's side is `mobile/link-host/gadget.mjs` and `gadget-setup.mjs` (copied into the desktop app as `desktop/desktop/link/`), with its own tests in `mobile/tests/gadget.test.ts`.

## How pairing works

Nobody types a code.

1. The gadget makes a key pair on first start. The secret half never leaves it.
2. You plug the gadget into your computer. Botkins reads the gadget's public key over the cable, pairs it, and hands it your Wi-Fi network and where to find the computer.
3. The gadget joins the network and opens a sealed session. Done.

On a server: `botkins gadgets add /dev/ttyACM0 --wifi "Home network"`. With the demo computer: `BOTKINS_DEV_GADGET=<serial port> npm run dev-host` in `mobile/`.

Pairing a gadget is a full-trust step, as pairing a phone is. A gadget is one of your own devices: a bot may do in its chats what it may do in any of yours, and the gadget answers a bot's requests itself. Its key is in its flash memory, so whoever holds the gadget can talk to your bots until you remove it from your devices.

## Try it without a board

```sh
sh firmware/build-host.sh          # needs a C and a C++17 compiler; CC and CXX name them
node --test tests/*.test.mjs       # the gadget against the real link and relay (after `npm ci` in ../mobile and ../mobile/relay)
```

Then run it by hand against the demo computer (`cd ../mobile && npm run dev-host`): `firmware/build/botkins-gadget-sim <folder>` and type the lines its header describes (`firmware/host/main.cpp`).

## Write a port for a board

A port fills in four small interfaces (`firmware/core/include/botkins/hal.hpp`): `Transport` (the core's own `SocketTransport` works on lwIP), `Storage`, `Network` and `Speaker`. A fifth, `Socket` (a WebSocket client, made by `Board::socket`), lets the gadget reach its computer through the computer's relay when none of its own addresses answers: away from home, or a computer that is reachable only that way, such as a server in the cloud. Then it makes one `Gadget`, tells it what the person does, and draws `view()` when `on_change` fires:

```cpp
botkins::Gadget gadget(board);
gadget.on_change = [] { redraw(); };
gadget.begin();
// button down: gadget.start_listening();   microphone: gadget.feed(samples, count);
// button up:   gadget.stop_listening();
```

`firmware/host/main.cpp` is a whole port in 200 lines, with its WebSocket (plain `ws://`, for a relay on the same computer) in `firmware/host/websocket.cpp`.

## What is not built yet

- Setup over Bluetooth from the phone app, and a Gadgets page in the desktop app's window. Setup today is the USB cable with `botkins gadgets add` or the demo computer.
- The relay on a board. The core speaks the relay ("Through the relay" in the contract) and the computer build tries it against the real relay over `ws://` (`tests/relay.test.mjs`), but the ESP32 port has no `Socket` yet: there it will be ESP-IDF's `esp_websocket_client` over `wss://`, checked with the certificate bundle (`esp_crt_bundle_attach`). Until then a board reaches its computer on its own network or a tailnet.
- Live voice on a gadget. The contract says how it will work; the core reads replies aloud by turns.
- Device tools (a bot switching a gadget's light), and firmware updates over the air.
- The StopWatch board still draws its own screen; it moves to the core's (`draw.hpp`) next.

## Licenses

The SDK is MIT, like the rest of Botkins. `firmware/core/third_party/monocypher` is Monocypher 4.0.2 by Loup Vaillant and others, under the 2-clause BSD license or CC0 (`LICENCE.md` there). The screen uses NanoSVG (zlib), stb_truetype (MIT or public domain) and the design kit's DejaVu Serif Bold and Open Sans fonts. Those, and board support that was adapted from other projects, are listed in `firmware/THIRD_PARTY.md`.
