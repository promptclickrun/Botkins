# The gadget contract

This is what a gadget builds against: a small device with a microphone, a speaker and maybe a screen (an ESP32 board) that talks with a bot on a Botkins computer. The computer's side is `mobile/link-host/gadget.mjs` (copied into the desktop app as `desktop/desktop/link/gadget.mjs`). The firmware's side is `gadget/firmware/`. `mobile/tests/gadget.test.ts` holds every rule below.

A gadget speaks the same link as a phone (`mobile/docs/link-contract.md`): the same keys, sessions, sealed calls and relay. Read that first. This page says what is different for a gadget, and gives the link's bytes exactly, because firmware has no client library to copy.

The computer names `gadgets-v1` in `meta.capabilities` when it has all of this.

## Words

- **Gadget**: a paired device of kind `"gadget"`.
- **Introducer**: a device that is already trusted and names a gadget to the computer: the computer's own app, or a paired owner device (a phone).
- **Samples**: sound as 16-bit signed little-endian numbers, one channel. A gadget sends and gets nothing else.

## What a gadget is, and what it may do

A gadget is the owner's device, like the owner's phone.

- **Nothing is cut from it.** A chat started from a gadget is an ordinary chat of the owner's. The bot may do in it what it may do in any of the owner's chats, with the chat's own approval settings. A gadget may make every call an owner device may make.
- **It answers a bot's requests itself.** An approval or a question shows on the gadget, and the gadget answers with the app's `respond` call. Nothing is sent to a phone first.
- **So pairing a gadget is a full-trust step**, as pairing a phone is. A gadget's key is in its flash memory. Someone who takes the gadget can use it until it is removed (Settings › Devices on a phone, or the computer's own page). Say so where a gadget is added.

What differs is what a gadget is **sent**. A phone follows the whole app. A gadget has a few hundred kilobytes of memory, so it follows two small parts and the text of one reply, and the computer does the work a phone does for itself: speech to text, text to samples at the gadget's rate, Markdown to plain words.

## Pairing by introduction

No code is typed, and no code is open on the computer.

1. The gadget makes an X25519 key pair on first start and keeps the secret key in its flash. It never leaves the gadget.
2. The introducer reads the gadget's public key over a short, local path: the USB cable, or Bluetooth from a few meters (see "Setup over USB").
3. The introducer names the gadget to the computer:
   - an owner device calls `link.gadgets.add({ publicKey, name?, board?, botId? })`;
   - the computer's own app calls `link.addGadget({ … })` with the same fields (`botkins gadgets add` on a server).
4. The answer is the introduction: `{ deviceId, serverId, serverKey, name, hosts }`. The introducer hands it to the gadget, with the Wi-Fi network's name and password.
5. The gadget opens a session ("The link's bytes" below). It is paired.

- `publicKey` is 32 bytes as base64url. Anything else answers "That isn't a gadget's key."
- `name` is what the device list shows (60 characters). Without one the gadget is named by its `board`, else "Gadget".
- `botId` is the bot the gadget talks with first. Without one it is the first bot on show. An id that is gone answers "This bot no longer exists."
- A gadget that is introduced again (its settings were erased, or it is given another bot) replaces its own earlier entry. The earlier entry's sessions end at once. A key that a phone or a computer paired with is refused ("That key belongs to another paired device."), and so is a key no session could be opened with.
- Only the owner's devices may introduce a gadget. A team member's device is refused ("Only the owner can do that."), and a member's device that pairs saying it is a gadget is kept as a phone, with a member's cut of everything.
- The introduction holds nothing secret. It is still for the gadget only: `serverKey` is how the gadget knows it reached the right computer.

**Pairing with a code still works.** A gadget that can show or read a pairing link may pair as a phone does (`POST /botkins/v1/pair`) and send `kind: "gadget"`. Introduction is the way without a code.

### The device list

`link.devices.list` names a gadget with `kind: "gadget"`, `platform: "esp32"`, and `gadget: { board?, firmware?, botId? }`. Rename and remove work as for any device. Removing a gadget ends its sessions; its next session request answers `unknown_device`, and the gadget says it was removed until it is set up again.

## What a gadget is sent

A gadget calls `link.sync` as a phone does, with `watch: [chatId]` for its own chat and `appends` cursors. It is sent:

- `meta`: `{ app, version, name, serverId, protocol, capabilities, you: { kind: "gadget", deviceId } }`.
- `gadget`: everything it shows, in one object (below). A few hundred bytes to a few kilobytes.
- `text:<chatId>`: the reply as it is written, for the gadget's own chat only, as appends (`stream-appends-v1` in the link contract). A gadget that wants fewer messages sends `text: "chunks"`.

It is never sent `bots`, `chats`, `settings`, `chat:<id>`, `run:<id>` or any other part.

```ts
type GadgetPart = {
  name: string;                                   // the gadget's own name
  bot: { id: string; name: string; look?: BotkinLook } | null;   // who it talks with
  bots: { id: string; name: string }[];           // the bots it can switch to (24 at most)
  chat: { id: string; title: string } | null;     // null until the first words are sent
  phase: "idle" | "working" | "writing" | "request";
  doing?: string;                                 // while working: what the bot is doing, in a few words
  request?: { id: string; kind: "permission" | "question" | "form" | "secure"; title: string; preview?: string; choices?: string[]; remember?: true; freeform?: true };
  queued?: number;                                // messages waiting for the turn to end
  reply?: { id: string; text: string; parts: number };  // the newest reply, once the turn is over
  voice: { hear: boolean; speak: boolean; live?: "codex" | "openai" | "gemini" | "elevenlabs" };
  steps?: number;                                 // while working: the steps the turn has taken
  settings: { volume: number; mic: "low" | "normal" | "high"; mute: boolean; brightness: number; dimAfter: number; offAfter: number };
  face?: { look: string };                        // names the bot's Botkin; a new name means new faces
  wifi?: { changes: ({ id: string } & ({ add: { ssid: string; password: string } } | { forget: string }))[] };
  restart?: string;                               // a restart the owner asked for
};
```

- `phase`: `request` when the bot waits on the person (it comes first), `writing` when the reply has text, `working` before that, `idle` otherwise.
- `reply.text` is plain words: no Markdown marks, a code block is "Code block.", an address is "a link to example.com". It is cut to 2,000 characters with `…`. The whole reply is still read aloud.
- `reply` is absent while a turn runs (the text comes in `text:<chatId>`), and when the person spoke last.
- `request` is cut for a small screen: a title of 120 characters, a preview of 200, six choices of 80 each. Answer it with the app's call `respond(request.id, answer)`: `{ action: "approve" }`, `{ action: "remember" }` (always allow in this chat, when `remember` is set), `{ action: "deny" }`, `{ action: "answer", value }` for a question, `{ action: "cancel" }`. A `form` or `secure` request can't be filled in on a gadget: show its title and say to answer on the phone or computer.
- `voice.hear` and `voice.speak` say whether the computer has a speech provider for each. `false` means Settings › Voice says "This device", which a gadget is not: show "Choose a speech provider in Settings › Voice on your computer."

## A gadget's own calls

Each is refused for a device that is not a gadget ("Only a gadget can do that.").

| Call | Answer |
| --- | --- |
| `link.gadget.hello({ board?, firmware?, rate?, screen?, mic?, speaker? })` | `{ botId?, chatId?, rate? }` |
| `link.gadget.set({ botId? } \| { chatId? } \| { newChat: true })` | `{ botId?, chatId?, rate? }` |
| `link.gadget.say({ text })` | `{ chatId }` |
| `link.gadget.hear({ take, rate, audio, last?, cancel?, language? })` | `{ got }`, and for the last piece `{ text, chatId }` |
| `link.gadget.speak({ reply, part, from?, max?, rate? })` | `{ audio, from, total, rate, part, parts }` |
| `link.gadget.face({ pose })` | `{ look, pose, svg }` |

- **`hello`** says what the gadget is, once after each start. `board` and `firmware` are short labels (letters, digits and `` .:+()/- ``, 40 characters). `rate` is the speaker's sample rate, one of 8000, 16000, 22050, 24000, 32000, 44100, 48000; replies are read at it. `screen` is `{ width, height, round? }`.
- **`set`** changes the bot (the chat with the bot before is left), goes to another chat, or with `newChat` starts a new chat with the next thing said.
- **`say`** sends typed words to the gadget's chat. With no chat yet, it starts one with the gadget's bot. While a turn runs the words steer it, as the apps' message boxes do. At most 8,000 characters.
- **`hear`** sends a recording in pieces, while the button is held. `take` names the recording (1 to 40 of `A-Z a-z 0-9 _ -`); a new name starts over. `audio` is samples as base64, an even number of bytes. `rate` is the microphone's rate, from the list above; it is read from the first piece. The piece with `last: true` turns the whole recording into words and sends them as `say` does. `cancel: true` gives the recording up. A recording holds at most 4,500,000 bytes (a minute and a half at 24 kHz), and one left for a minute is dropped.
  - "That was too short to hear." (under a quarter of a second), "I didn't catch that." (no words), "That recording is too long. Say it in shorter parts."
- **`speak`** reads a reply aloud. `reply` is `gadget.reply.id`, and `part` counts from 0 to `gadget.reply.parts - 1`. The answer's `audio` is samples from byte `from`, at most `max` bytes (2,000 to 512,000; 32,000 without one, about a second at 16 kHz). `total` is the part's whole length in bytes: ask again with `from` moved on until it is reached, then go to the next part. A part's samples are made once and kept five minutes, and the part after it is made ahead, so a gadget plays as it fetches.
  - The first part is short (40 to 80 characters) so sound starts soon. Later parts hold up to 240 characters.
  - "That reply is gone.", "That reply has no more to read.", "Your speech provider sent audio a gadget can't play."

- **`face`** answers the bot's Botkin in one pose as SVG text, for the gadget to draw (`gadget/firmware/core` uses nanosvg). The poses: `ready`, `listening`, `working`, `speaking`, `needs`, `waiting`, `sleepy`. The SVG has a 256 by 256 view box and only paths, ellipses, circles and groups with plain fills; nothing moves. `look` names the set and is the part's `face.look`: fetch each pose once for a look, `ready` first, one at a time so talking never waits behind them. A computer without the design kit sends no `face` in the part, and the call answers "This computer can't draw Botkins."; the gadget then shows its own default Botkin.

Everything else is the link's and the app's own calls: `respond`, `stop(chatId)`, `link.voice.live`, and the rest.

## Settings (`gadget-settings-v1`)

The computer keeps each gadget's settings, and the part carries them whole. The gadget applies them, keeps a copy so it starts with them, and changes them itself from its quick controls.

| Setting | Values | Before anyone changes it |
| --- | --- | --- |
| `volume` | 0 to 100 | 60 |
| `mic` | `"low"`, `"normal"`, `"high"`: how sensitive the microphone is | `"normal"` |
| `mute` | the microphone is off: holding talk says "The microphone is off." and sends nothing | `false` |
| `brightness` | 5 to 100 | 80 |
| `dimAfter` | seconds idle before the screen dims; 0 is never | 30 |
| `offAfter` | seconds idle before it goes dark; 0 is never | 300 |

- **On the gadget.** `link.gadget.set({ settings: { … } })` with any of them. The gadget shows its change at once, and holds it against the part until the computer took it; one made while the computer is away goes when it is back.
- **From the owner** (a phone's Settings › Devices, the app's own page, `botkins gadgets set`): `link.gadgets.configure(id, patch)` with any of them and `botId` (another bot, in a new chat). It answers the device list. A bad value changes nothing ("Volume is from 0 to 100.").
- **Wi-Fi from the owner.** `link.gadgets.wifi(id, { add: { ssid, password } })` or `{ forget: ssid }` answers `{ queued: true }`. The change waits in the part's `wifi.changes` (sealed for that gadget, and kept nowhere else: never in a file, never in the device list) until the gadget says `link.gadget.set({ wifiDone: [ids] })`, for at most 10 minutes. A password has 8 to 63 characters, or none for an open network. The gadget keeps up to 8 networks, stays on the one it is on, and tries the next saved one when its network refuses it for 20 seconds.
- **What the gadget reports.** `link.gadget.hello` takes `wifi: { network?, saved: [names], signal? }` (dBm), and a gadget says hello again when its saved networks change. Never a password.
- **Restart.** `link.gadgets.restart(id)` puts `restart: id` in the part; the gadget says `link.gadget.set({ restarting: id })`, then restarts.
- **The device list** shows a gadget's `settings`, its `wifi` report, `wifiWaiting` (the names of changes not taken yet) and `restarting`.

### Live voice

A gadget starts a live session as a phone does: `link.voice.live({ chatId, botId })` answers what it needs to connect to the provider, and the sound then goes between the gadget and the provider (`mobile/link-host/VOICE.md`, "Live sessions"). The gadget runs the one tool, `ask_bot`, by calling `link.gadget.say` and waiting for `gadget.reply`. A gadget asks without an `sdp`, so it gets a socket session: `openai-ws`, `gemini-ws` or `elevenlabs-ws`. Codex is WebRTC only and is not offered to a gadget yet.

## The link's bytes

All of it is in `mobile/link-host/server.mjs` and `crypto.mjs`. This is the part a gadget needs.

- **Transport**: HTTP/1.1 to `http://<host>:<port>/botkins/v1/…`. The default port is 47610. No TLS: every message is sealed by the link. Away from the computer's network, the same requests go over the relay's socket (`mobile/relay/README.md`, "Wire format"; the gadget uses the phone's side, `botkins.phone.v1`, which does need TLS).
- **Text forms**: keys, nonces and boxes are base64url without padding. JSON is UTF-8.
- **Primitives**: X25519; HKDF-SHA256 with 32 bytes out; ChaCha20-Poly1305 (IETF, 12-byte nonce, 16-byte tag after the ciphertext).
- **A box** is `base64url(nonce(12, random) + seal(key, nonce, JSON, aad))`.

**Who is there.** `GET hello` answers `{ botkins: 1, serverId, publicKey, … }`. A gadget checks `serverId` and `publicKey` against its introduction before it sends anything else to that address.

**The device key**, made once and kept in memory:

```
deviceKey = HKDF(ikm = X25519(gadget secret, serverKey), salt = utf8(deviceId), info = "botkins/device/v1")
```

**A session.** The gadget makes a one-time X25519 pair `eph` and 16 random bytes `nonce`:

```
POST session   { "device": deviceId, "eph": b64u(eph.public),
                 "box": box(deviceKey, { "eph": b64u(eph.public), "nonce": b64u(nonce) }, aad "session:" + serverId) }
answer         { "box": … }  opened with deviceKey, aad "session-ok:" + serverId:
               { "session": id, "eph": b64u(host eph), "nonce": b64u(host nonce(16)), "epoch": text, "hosts": [ … ] }

salt    = nonce + host nonce
master  = HKDF(ikm = X25519(eph.secret, host eph) + deviceKey, salt, info "botkins/session/v1")
toHost  = HKDF(master, salt, "botkins/c2s/v1")
toPhone = HKDF(master, salt, "botkins/s2c/v1")
```

- `403 { "error": "unknown_device" }`: the gadget was removed. Say so ("This gadget was removed. Set it up again to use it."), keep the introduction, and ask again every half minute. Do not erase anything: this answer is not sealed, so any device on the network could give it, and it must not be able to make a gadget forget its computer. Setup replaces the introduction.
- `403 { "error": "bad_session" }`, `429`: wait and try again; do not forget anything.
- Nobody answering at any address: wait and try again, 0.4 s growing to 15 s. After the second try, tell the person what to check ("Can't reach Demo Mac. Check that Botkins is open there, on the same Wi-Fi."), and take that sentence away once the computer answers.
- `hosts` are the computer's addresses now, best first, with a `relay!<room>@<host>` entry when the relay is on. Keep them in flash: this is how a gadget finds a computer whose address changed.
- A new `epoch` means the computer's app restarted: forget the versions held (`have`) and every text cursor.

**A call.** Calls are numbered from 1 in each session, and each number is used once:

```
POST rpc       headers  content-type: application/octet-stream,  x-botkins-session: <session id>
               body     seq (8 bytes, big-endian) + seal(toHost, nonce(seq), utf8(JSON { "m": method, "a": [args…] }), aad "rpc:" + session id)
answer         seal(toPhone, nonce(seq), utf8(JSON { "r": result } or { "e": { "message": sentence } }), aad "ok:" + session id)

nonce(seq) = 4 zero bytes + seq (8 bytes, big-endian)
```

- `401`: the computer forgot the session. Open a new one and make the call again.
- `e.message` is a sentence for a person. Show it as it comes.
- A call's body is at most 6 MiB. A gadget's are far smaller: send a recording in pieces of a second or so.

**Keeping in step.**

```
link.sync  [{ "epoch": epoch, "have": versions, "watch": [chatId], "appends": cursors, "wait": 25000 }]
answer     { "epoch": epoch, "v": versions | null, "parts": { name: value, … } }
```

- `have` is the `v` of the answer before (`{}` at first). `v: null` means nothing changed: ask again with the same `have`.
- `wait` is how long the computer may hold the call for news, in milliseconds (30,000 at most). Give the request itself 15 seconds more.
- `appends` is `{ [chatId]: { id, stream, thinking } }`: the text id held and how many UTF-16 units of each body. `{}` asks from the start. A part `text:<chatId>` is `{ id, stream: { from, add }, thinking: { from, add } }`, or `null` when there is no text. Append `add` at `from`; an `id` or `from` that does not fit what is held means start over from `{}`.
- One `link.sync` waits at a time. Other calls go beside it on the same session, on a second connection.

## Setup over USB

A gadget with no introduction waits for setup on its USB serial port (115200 baud, 8N1). Every line of the setup protocol starts with `@botkins ` and is one JSON object, so it can share the port with the boot log. The introducer writes a line and reads lines until one answers.

| The introducer writes | The gadget answers |
| --- | --- |
| `@botkins {"do":"hello"}` | `@botkins {"hello":1,"publicKey":"…","board":"…","firmware":"…","mac":"…","paired":false,"wifi":false}` |
| `@botkins {"do":"setup","wifi":{"ssid":"…","password":"…"},"link":{ the introduction }}` | `@botkins {"ok":true}`, then `status` lines |
| `@botkins {"do":"status"}` | `@botkins {"status":{"wifi":"off" \| "joining" \| "on" \| "failed","ip":"…","link":"off" \| "connecting" \| "online" \| "removed","computer":"…","error":"…"}}` |
| `@botkins {"do":"forget"}` | `@botkins {"ok":true}`: the Wi-Fi network and the introduction are erased; the key stays |
| `@botkins {"do":"erase"}` | `@botkins {"ok":true}`: everything is erased, the key too |

- `publicKey` in `hello` is what the introducer hands to the computer. `mac` is for the person to tell two gadgets apart.
- `setup` may hold only `wifi` (another network) or only `link` (another computer). Text is UTF-8, with JSON's escapes.
- The gadget answers `{"error":"…"}` to a line it can't read. It never prints the password or its secret key, in an answer or in its log.
- A person at a terminal can type the same lines.

**For trying a gadget from the cable**, with nobody at its buttons (a test, or a person at a terminal):

| Line | What it does |
| --- | --- |
| `@botkins {"do":"view"}` | answers `{"view":{ stage, phase, bot, text, heard, notice, listening, sending, speaking, hear, speak, request? }}`: what the screen shows now |
| `@botkins {"do":"say","text":"…"}` | sends typed words, as `link.gadget.say` |
| `@botkins {"do":"listen","ms":3000}` | holds the talk button for that long (300 to 10,000 ms), then sends the recording |
| `@botkins {"do":"answer","action":"approve"}` | answers the request on show (`value` for an `answer`) |
| `@botkins {"do":"quiet"}` | stops reading aloud |
| `@botkins {"do":"settings","volume":40}` | changes settings as the quick controls do (any of the part's settings) |

These do nothing a person holding the gadget can't do: whoever has the cable has the gadget.

Setup over Bluetooth carries the same objects. It is not built yet.

## Limits

- A gadget counts as one of the computer's paired owner devices (20 at most).
- Sessions, call sizes and the limits on tries are the link's (`mobile/link-host/README.md`, "Limits").
- One recording at a time for each gadget. The samples of 12 reply parts are kept, for five minutes.

## What was checked, and what was not

- `mobile/tests/gadget.test.ts` runs a gadget's key through the phone's own link client against the demo computer: introduction, the two parts, a typed turn, a recording in pieces, samples back at another rate, a request answered on the gadget, and each refusal.
- Speech providers: asking each provider for samples (`samples: true` in `voice.mjs`: OpenAI and Azure OpenAI `response_format: "wav"`, Azure Speech `riff-24khz-16bit-mono-pcm`, ElevenLabs `output_format=pcm_24000`) was not tried with a real key. The local model and Gemini already answer with WAV.
