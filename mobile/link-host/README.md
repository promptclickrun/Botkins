# The Botkins link, desktop side

These modules let a paired phone running Botkins use a desktop app over the local network or a tailnet. On plain Node 22 or newer they need nothing else. On Electron they need the package `@noble/ciphers`: Electron's Node has no ChaCha20-Poly1305 of its own, so `crypto.mjs` seals with that library there (`CIPHER` says which is in use, and `BOTKINS_LINK_CIPHER=noble npm test` runs the whole suite on the library). Run the link's tests on the runtime the app ships with, not only on Node.

| File | What it does |
| --- | --- |
| `server.mjs` | `LinkHost`: the HTTP endpoints, pairing, encrypted sessions, calls, and keeping phones in step. The protocol is described at the top of the file. |
| `crypto.mjs` | X25519, HKDF-SHA256 and ChaCha20-Poly1305 on Node's own crypto. |
| `store.mjs` | `link.json`: this computer's identity, the paired phones, the Botkin each bot is shown as, the relay's settings and key, and what each phone set up (where its notifications go, which sources bots may use on it). |
| `parts.mjs` | Turns the app's whole state into the named parts a phone follows. |
| `team.mjs` | Pure team roles, authorization, member part filtering and invite-code helpers. |
| `methods.mjs` | The app's calls a phone may make, what a message from a phone may attach, and the shape of each call that stands in for a file or folder dialog on the computer (a file as text out and in, the folder browser). |
| `credentials.mjs` | Credentials: an encrypted vault (`credentials.json`) and links to password-manager fields, with eTLD+1/alias discovery, TOTP, and explicit copy vs on-demand link. A call can use one without the phone seeing it. |
| `domain-match.mjs` | Registrable domain (eTLD+1), subdomain, alias matching, and strict origin pinning helpers for credential lookup and autofill. |
| `totp.mjs` | Pure RFC 6238 / RFC 4226 TOTP generator and `otpauth://` URI parser for 2FA delivery under credential grants. |
| `managers.mjs` | The password-manager drivers: 1Password (`op`), Bitwarden (`bw`) and Proton Pass (`pass-cli`), including site URLs and TOTP reads. |
| `screen.mjs` | Showing the screen to a phone: frames with change numbers, who is watching, and clicks and typing when the person allows them. |
| `grant.mjs` | On a headless host only: a phone sets what phones may do with the screen (`screen-grant-v1`). A ticket, the phone's signature made after Face ID or the passcode, a direct connection, a phone. A server behind its own relay (`relay.own`) takes the calls through that relay too (`screen-grant-relay-v1`). The file's header has the rules. |
| `input.mjs` | Checks what a phone sends to control the screen, and posts it on macOS, Windows and Linux. |
| `prs.mjs` | Pull requests of a chat's project, read with the GitHub CLI (`gh`). |
| `uploads.mjs` | Files a phone sends for a message, kept per phone. A photo a phone tool brings over is one of these. |
| `relay.mjs` | `RelayHost`: the active and standby v3 sockets (with v2 fallback) that let a phone away from the network reach the computer. `RelayLink` remains for legacy callers. Also signs what is sent to the relay's push route. |
| `push.mjs` | `Push`: notifications and Live Activities for phones that asked. See "Push notifications". |
| `device.mjs` | `DeviceTools`: tools that run on a paired phone, and the list of them. See "Tools that run on a phone". |
| `gadget.mjs` | Gadgets: small devices that talk with a bot. Pairing by introduction, the two small parts a gadget follows, and speech in and out as plain samples. The contract is `gadget/docs/contract.md`. See "Gadgets". |
| `gadget-setup.mjs` | Setting a gadget up over its USB port: the introducer's half, for the app's own page and `botkins gadgets add`. |
| `botkin-svg.mjs` | A bot's Botkin in each pose a gadget shows, as SVG from the design kit found beside the link (`new LinkHost({ botkins })` replaces it; `null` is none). |
| `voice.mjs` | `Voice`: speech to text, text to speech and live voice sessions, through providers the person chose. `VOICE.md` has the contract and every provider. See "Voice". |
| `tools.mjs` | Runs the computer's command-line tools without a shell, with a time limit and a small environment. |
| `net.mjs` | Which addresses to offer a phone, and which callers count as nearby. |
| `qr.mjs` | The pairing QR code (the generator in `vendor/` is MIT licensed). |
| `mock-backend.mjs`, `dev-host.mjs` | A made-up computer for developing the phone app: `npm run dev-host`. |

## Adopting it in a desktop app

Copy every file except `mock-backend.mjs` and `dev-host.mjs` into the app (the Botkins desktop app keeps them in `desktop/link/`), then create one `LinkHost` in the main process:

```js
import { LinkHost } from "./link/index.mjs";

const link = new LinkHost({
  dir: join(dataDir, "link"),
  backend: {
    info: () => ({ app: "botkins", version: app.getVersion(), platform: process.platform }),
    snapshot: () => workspace.snapshot(),
    call: (name, args, { principal }) => handlers[name](...args), // principal is owner or a named member
    subscribe: (listener) => onChange(listener), // returns a function that stops it
    extras: {}, // more calls, reached from the phone as "link.<name>"
    capabilities: ["looks-v2", "botkin-heads-v2", "botkin-heads-v3", "routine-delivery-v1", "models-v2", "board-mentions-v1"], // what the app supports itself
    attention: () => ({ focused: win.isFocused(), chatId: openChatId }), // optional: see "Push notifications"
    voice: { local, codex }, // optional: the app's own speech helpers (VOICE.md)
    screen, // optional: how to take pictures of the screen (see below)
  },
  protect, reveal, // optional: the system keychain, see "Keeping secrets" below
});
await link.start(); // listens only when the person has turned phone access on
```

What the app may put on `backend`, besides the first four (`info`, `snapshot`, `call`, `subscribe`):

- `extras`: more calls, reached from the phone as `link.<name>`. Each name is also listed as a capability (`adoptMcpSignIn` is one).
- `capabilities`: more names for `meta().capabilities`, for what the app supports itself. A phone shows a feature only when its name is there. `looks-v2`: the app saves a look's eyes and custom colors (see "Bot looks"). `botkin-heads-v2`: the app saves Drip, Orbit and Pebble alongside the original 20. `botkin-heads-v3`: the app saves all 30 characters. `routine-delivery-v1`: routines take `deliver` (where a run's result lands) and `notify`. `models-v2`: `models()` carries the optional facts of `ModelInfo` (context window and more). `board-mentions-v1`: `send` takes a mention `{ kind: "board", id }`, a Today card being discussed. The link adds its own names (`credentials-v1`, `screen-v1`, `prs-v1`, `uploads-v1`, `relay-v1`, `sync-push-v1`, `push-v1`, `device-v1`, `voice-v1`) and, when it keeps the looks itself, `looks-v2` and `botkin-heads-v2`.
- `attention()`: `{ focused, chatId? }`, whether the person is looking at the app's own window and at which chat. A reply in that chat then needs no notification on a phone.
- `voice`: `{ local?, codex? }`, the app's own speech helpers for `voice.mjs` (`VOICE.md`, "What the desktop app provides").
- `screen`: how to take pictures of the screen (see "The screen").
- `setLook(botId, look)`: see "Bot looks".
- `frames`: `{ page(id) → { html, data }, chatFor?(id) → chat id or null }`, the custom views (html blocks) of panels and cards as their bots wrote them. With it the link has `frames-v1` and answers `link.frame.page` and `link.frame.chat`. See "Custom views".

The app's own page turns phone access on with `link.setEnabled(true)`, opens a pairing code with `link.startPairing()` (show `link.status().pairing.url` as a QR code with `qrPath`, and the code and address for typing), lists `link.status().devices`, and removes one with `link.removeDevice(id)`. `link.on("status", …)` fires when any of that changes. Call `link.stop()` when the app quits.

More of `link` that the app uses:

- `link.deviceTools()` and `link.callDeviceTool(name, args, { botId, chatId, signal })`, and the `"tools"` event: the tools a paired phone offers the app's bots (see "Tools that run on a phone").
- `link.voice`: the `Voice` instance. The app's own Settings page and its own speech use it, and the phone's `link.voice.*` calls reach the same one. A change to its settings or keys reaches phones in the `voice` part; the link emits no event for the app's own page, so that page reads `link.voice.settings()` itself (see "Voice").
- `link.status().push`: the phones that get notifications, as `[{ deviceId, name, prefs }]` (never a token). `link.status().sources`: what bots may use on each phone, by device id. Both are for the app's page.
- `new LinkHost({ fetch })` replaces the `fetch` that notifications and speech providers are called with. Tests pass one that only records.

**Bot looks.** A phone shows each bot as a Botkin: `{ head, palette }`, and optionally `eyes` (one of `LOOK_EYES` in `store.mjs`; `"oval"`, each character's own, is left out) and, with the palette `"custom"`, `colors` (`[shell, accent, faceplate, eyes]`, each `#rrggbb`, kept in lower case). `cleanLook` in `store.mjs` is the check: a look it can't read is refused with "That look can't be saved." An app that draws Botkins itself keeps `look` on each bot in its state and gives the backend a `setLook(botId, look)` function; the link then stores no looks, and the app has to save and return `eyes` and `colors` too and name `looks-v2` in `backend.capabilities`, because the link adds `looks-v2` only when it keeps the looks itself. Apps supporting the first three extra heads advertise `botkin-heads-v2`. Apps supporting all ten also advertise `botkin-heads-v3`. Without either capability, the phone offers the original 20. When the link keeps looks in `link.json` it advertises the full catalog.

A paired phone can do what the person can do in the app, so pairing is a full-trust step: say so where the code is shown.

## Teams

Invite-based member devices are persisted beside owner devices but are not full trust. `LinkHost.team()` returns the owner view; `saveRole`, `deleteRole`, `saveGroup`, `deleteGroup`, `createInvite`, `revokeInvite`, `approve`, `deny`, `moveMember`, `removeMember`, `renameMember` and `renameTeam` manage it. The `"joinRequest"` event contains `{ id, name, platform, kind, at, inviteId }`; `"status"` follows every team change. Roles are enforced before `backend.call`, which receives `{ principal }` as its third argument so the app can stamp `createdBy` and message authors. Member parts are filtered independently, including change versions, so an update for one principal cannot send another principal's data.

`MEMBER_PREFERENCE_FIELDS` is deliberately limited to `appearance`, `foldTools`, `showThinking`, `linkPreviews` and `readAloud`; no approval, access, teamwork, link, provider or voice setting is member-writable.

`createInvite` returns the invite and a join link. Its public invite card is published only when the relay is on; a failed publication is reported as `published: false` and does not cancel the invite. The demo host prints both an owner pairing code and a seven-day team invite.

On the client, `parseJoinUrl(text)` reads an app or web link, and `findInvite(fetch, code, relayBase?, serverKey?)` opens the relay's card. Use `startJoin(fetch, target, { name, platform, kind })` once and keep its `attempt`; `checkJoin(fetch, attempt)` polls pending status with the same X25519 key. `join(...)` is the convenience form and returns the result with `attempt` for the next call. An approved answer's `Pairing` has `member: true`.

## Relay

A phone that is away from this computer's network can't open a connection to it. So the computer opens an active WebSocket and a standby to a v3 relay, and the phone opens one too. The relay passes the link's own requests and answers between them. Phones keep their socket and request IDs when the relay switches host connections. A brief loss of both host connections allows requests to resume on reconnect. The same Worker has a second, separate job: `POST /v1/push` forwards notifications to Apple (see "Push notifications"). It uses the same relay key and address, and works whether or not the relay is switched on for phone traffic.

**What the relay can and can't see.** Everything it passes is already sealed end to end (the pairing code, the device keys and the session keys are all between the phone and this computer), so the relay learns sizes, timing and a network tag for each phone. It never learns a message, a pairing code or a key, and nothing secret is ever sent to it. It can refuse to pass messages, and it can delay them. It can't make a phone pair or make a call: the computer's own checks still decide that. A phone that knows the room can ask a `hello`, which over the relay says only `{ botkins, serverId, publicKey }`: not the computer's name, app or version, and not whether a pairing code is open (so a stranger can't watch for one).

**The key and the room.** The computer makes an Ed25519 key pair the first time the relay is needed and keeps the private key in `link.json`, wrapped by `protect`/`reveal` like the link's own private key. The room is `base64url(SHA-256("botkins-relay-room-v1:" + base64url(public key)))`. A v3 socket's subprotocols are `["botkins.host.v3", "k." + public key, "g." + group, "t." + seconds, "s." + signature]`, where `group` is one random 32-byte base64url value shared by the active and standby sockets and the signature is over `"botkins-relay-host-v3:" + room + ":" + group + ":" + seconds`. A v2 socket uses `["botkins.host.v2", "k." + public key, "t." + seconds, "s." + signature]` with the v2 challenge. The clock has to be within 5 minutes of the relay's. A v3 relay keeps phone sessions through a short loss, replays missed requests, and acknowledges accepted answers with `[conn][from][0x06][requestId]`; the host keeps only a bounded duplicate tombstone after that. Older relays are detected by the failed v3 handshake and use v2. A phone learns the room from the pairing link: `hosts()` has one more entry, last, when the relay is on: `relay!<room>@<relay host[:port]>`. That is the whole change phones see. `status().addresses` stays real network addresses only. An older `link.json` with a `relay.token` simply gets a key (and so a new room); the token is ignored.

**Settings.** `link.status().relay` is `{ enabled, connected, url }`, plus `problem: "taken"` in that state (below), and the `host` part has `relay: boolean` (enabled). The relay is **off until someone turns it on**. The desktop page should offer:

- `link.setRelay({ enabled, url })`, saved in `link.json` and applied at once. `url` defaults to `DEFAULT_RELAY_URL` in `relay.mjs`. An address has to be `https:` (or `http:` for `127.0.0.1`, `localhost` or `[::1]`, for local development) and an origin only; anything else throws "That relay address isn't valid."
- `link.resetRelay()`: a new key, so a new room. The old socket closes, the new entry is in `hosts()` at once, and the key is saved. Every session ends, and so does what each has waiting, so a connected phone opens a new session and learns the new entry at once (a phone learns the relay's entry only from a session reply). `setRelay` does the same when it makes the entry appear, disappear or change (`enabled` or `url`). Use it if the old room's name leaked or a copy of `link.json` is in use elsewhere. It returns the new room's name.
- `new LinkHost({ relay: false })` keeps the relay off for that instance whatever is saved (tests and the demo computer). An object, `relay: { url, WebSocket, timers }`, only overrides the address, the socket class and the clock (`timers` is `{ setTimeout, clearTimeout, random, now }`); the saved on/off still decides, so call `setRelay({ enabled: true })` to turn it on.
- The relay runs only while phone access is on: it starts when listening starts and stops when phone access is turned off. `link.on("status")` fires when `connected` or `problem` changes.

**The "taken" state.** If another computer holds the same key (a cloned `link.json`, say) and takes the room three times in a row (close code 4000), `status().relay` becomes `{ enabled: true, connected: false, url, problem: "taken" }`, one line is logged and "status" is emitted. This computer keeps trying, but only every 10 minutes (with the usual jitter), so it never ends for good: someone who replays a seat proof can slow it down, not shut it out. The problem clears when a connection has lasted 30 seconds. `setRelay`, `resetRelay`, or turning phone access off and on try again at once. A single takeover is only logged, and retried after a minute.

**Behavior and limits.** The active socket reconnects with a backoff of 1 second doubling to 60 seconds, with jitter, starting over after 30 seconds connected; the standby has the same bounded backoff. On v3, each host socket sends an application ping every 5 seconds. If 4 seconds pass without a pong or other traffic after a ping, the computer replaces that socket. The v2 heartbeat remains 25 seconds with a 10-second deadline. A computer can reconnect to its own v3 room even when both previous connections still appear open at the relay. A v3 loss of both sockets retains pending calls and bounded replies for 15 seconds, then releases each phone; v2 keeps the older immediate-drop behavior. A phone has at most 8 requests in flight and all phones 256; at most 64 phones are known at once; more are answered 429 at once. A request frame over 6 MiB + 64 KiB (plus 16 bytes of addressing) is dropped unread. Bodies are limited as over HTTP (64 KB for pairing, 6 MiB for a call, else 413), and an answer larger than the relay's 8 MiB message limit is replaced by a 413. Duplicate request IDs never run the handler twice. The host reserves at most 48 full-size results (8 MiB each) until the room acknowledges them or their five-minute replay window expires; a new call over that bound gets 429 rather than evicting an unacknowledged result.

**Throttling and pairing tries.** Pairing and session attempts are limited the same way over HTTP and over the relay, with separate counts for each way in, so what comes over the relay can never use up HTTP's allowance, or the other way round:

- Only failures count (a wrong code, an unknown device, a bad box, a replayed session, a malformed or oversize body, an attempt when no code is open). A success costs nothing and never trips anything.
- One source (an HTTP address, or a relay `from` tag) may fail 20 times in 10 seconds; after that its failing requests get 429 until its count runs down, and no other source is affected. This gate holds back only requests that fail, or are for an unknown device, or are pairing attempts. A session request for a known device whose box opens is served whatever its source's count is, so a stranger who shares a source with a real phone (a carrier's NAT, a café) can't keep it out.
- Each way in also has a backstop on failures only: 200 in 10 seconds over HTTP and 400 over the relay, so a flood from many sources can't burn CPU without limit. While it is tripped, pairing attempts and sessions for **unknown** devices get 429. A session for a **known** device whose box opens with that device's key is never held back by the backstop: the cheap checks (device known, box valid) come first, and only a failure is counted. (A source that has itself failed 20 times is still refused, whatever it sends.)
- A session request that was recorded and is played again is refused like a bad box: the last 64 nonces of each phone are remembered, so a replay can't take another of the phone's session slots.
- Wrong pairing codes are counted for each source: after 8 wrong tries for one open code, that source gets **429 `{ "error": "pair_wait" }`** for that code, **even with the right code afterwards** (the same answer a source over the 20-failures gate gets while pairing), so the phone can say "too many tries" instead of "that code isn't right". That is the trade: a phone whose person mistyped 8 times from one address has to wait for a new code (or use another network). The code itself is withdrawn only after 200 wrong tries from everyone together; it has 60 bits, so this stays safe, and a stranger can't close a code by guessing.
- Every table is bounded (256 sources at most) and the pairing counts are cleared when the code closes.

The demo computer (`npm run dev-host`) opens no relay socket unless `BOTKINS_DEV_RELAY=<url>` is set. It still calls the relay's push route when a phone paired with it has turned notifications on (see "Push notifications"), at `BOTKINS_DEV_RELAY` if set, else at the default relay.

## Push notifications

`push.mjs` tells phones that asked about what happens on the computer: a bot needs an answer, a reply finished, a routine ran, a turn is under way. It can't reach Apple itself, so it sends through the relay's push route (`relay/README.md`, "Push notifications"). The header of `push.mjs` is the contract; this is how to use it and what it costs.

**What the phone sets.** A phone calls `link.push.register` with its token and Apple environment (and, on iOS 17.2 or later, a second token that can start a Live Activity), `link.push.prefs` to change its choices (`replies`, `requests`, `routines`, `previews`, `activities`, all on by default), `link.push.unregister` to turn notifications off, `link.push.presence` to say whether the app is in front and which chat is on screen, `link.push.activity` with the token of one chat's Live Activity (or `null` when it ended), and `link.push.test` to send itself one notification. The computer keeps this per phone in `link.json` (`push`). The `phones` part carries each phone's choices and never a token. `link.status().push` lists the phones with notifications on, for the app's page.

**What it watches.** The app's state, through `backend.subscribe` (a burst of changes is one look, 250 ms later). The first look, when the link starts, only notes what is going on, so nothing old is announced. After that:

- A request (an approval or a question) sends an alert marked time sensitive. Apple shows that as an ordinary notification until the app has the Time Sensitive Notifications entitlement (`app.config.ts`).
- A run that finishes sends an alert, if that phone wants that kind (`replies` or `routines`), unless it was stopped, the chat is temporary, or it is a routine run whose routine has `notify: false` (quiet on the computer and on phones). A run for a Today panel notifies only when a scheduled one fails.
- A turn the person started gets a Live Activity: started by a push (only when the phone has a start token and isn't in front), updated while it runs, and ended when it finishes, whatever the notification choices are. A scheduled turn gets none.
- A phone that is in front and was heard from recently gets nothing about what it is showing. The computer's own window counts too: when `backend.attention()` says the person is reading a chat there, a reply in it isn't sent.

**What is sealed and what is not.** An alert's title and text never cross the relay in the clear. The payload Apple carries says only "Botkins" and "New message", "A bot needs you" or "An update is available", and the real text is in `b`, sealed for one phone and opened by the phone's notification extension:

```
key  = HKDF-SHA256(device key, salt = device id, info = "botkins/push/v1")
b    = base64(nonce(12) + ChaCha20-Poly1305(key, nonce, JSON, aad "botkins-push-v1"))
JSON = { t: title, m: text, c: chat id, k: kind, r?: request id }
```

The key is derived each time from the phone's pairing key, so the computer stores no extra secret. The phone derives the same key and keeps it in the keychain group it shares with the extension. With `previews` off, the text is "New message" (or "Open Botkins to answer."). The thread id and the collapse id (one banner per chat) are hashes of the chat id, so Apple never sees a chat id in an alert. What is not sealed: the token, the kind of alert (its category), when it was sent, and everything about a Live Activity. Apple hands a Live Activity's state straight to the Lock Screen, so it can't be sealed: it is a phase, a step count, a start time and a short label, which is the step's name only with `previews` on (otherwise "Working"). A push that starts an activity also carries the chat's id, the bot's id, the bot's name and its look, and its alert is the bot's name and "Working on it".

**When something fails.** Nothing throws into the caller. A failed send is logged and forgotten: a late notification is worse than a missing one. `link.push.test` is the exception: it says why it failed ("The notification service isn't set up yet.", "Apple no longer knows this phone. Turn notifications off and on again."). When Apple says a token is dead (410, or `BadDeviceToken`), the token is dropped from `link.json`, and that phone gets no more notifications until it registers again (turning notifications off and on in the phone app does it).

**Which relay.** `link.relayUrl()`, the same address the relay socket uses, and the same relay key signs every request. Notifications don't need the relay switched on for phone traffic, and they work whether or not a phone is connected. The relay forwards up to 8 items a call and answers per item.

**Not tested for real.** The relay's route to Apple has been tried only against a stand-in (`relay/README.md`), and the simulator can't get a real notification address or run the notification extension for a locally delivered notification. The first real push has to be a real phone.

## Tools that run on a phone

`device.mjs` lets a bot use a paired phone: its calendar, contacts, Health data, location, photos, Apple Music and a draft email. The header of `device.mjs` is the contract; `DEVICE_TOOLS` in it is the list of tools, with the source and level each needs and the JSON Schema a bot is shown.

**The switches are the consent.** In the phone app the person switches each source (Calendar, Contacts, Health, Location, Photos, Mail) off, to read, or to read and interact, after iOS has been asked for what that needs. The phone tells the computer (`link.device.sources`), which keeps the switches per phone in `link.json` (`sources`). A tool exists only while some paired phone allows its source at the level it needs; Location offers only read, and Mail only interact (`cleanSources` lowers Location to read and drops Mail's read). The phone checks its own switch again before it acts, so a stale list here can't reach past a switch.

**How the app uses it.**

- `link.deviceTools()` is the list now: `[{ name, description, parameters, readOnly, source }]`. `readOnly` tools only look, so an app can allow them without asking; the rest add or change something on the phone. The `"tools"` event fires when the list changes (a phone changed a switch or was removed), so the app updates its bots' tools.
- `link.callDeviceTool(name, args, { botId, chatId, signal })` runs one and resolves with its result (JSON). It rejects with an `Error` whose message a bot can read (no phone allows it, the phone didn't answer, the phone said no, `Stopped.`). Give the bot that message as the tool's error.
- Which phone: the most recently seen of those that allow the source at that level.

**The wait.** A call waits in the `asks` part, addressed to a phone, until that phone answers with `link.device.answer`. A phone that isn't in front is woken with a push it doesn't show (`Push.wake`). If it still hasn't answered after a few seconds, the person gets a visible notification that a bot is waiting on their phone. A tool the person finishes by hand (`hands`: today `phone_mail_compose`, which opens a compose sheet for them to read and send) works only while the app is in front, so the person is told at once and has longer to finish. Only the phone an ask is addressed to may answer it or fetch its file; anything else is refused ("That question is no longer open."). Removing a phone fails its asks.

**Files.** A photo a bot asks for (`phone_photos_get`) is sent by the phone as one of its own uploads (`uploads.mjs`), and the bot is given the real path of that file; a path the phone makes up is refused ("The photo didn't arrive."). That file stays with the phone's other uploads and goes with them (see "What a paired phone can now do"). A picture a bot saves to Photos (`phone_photos_save`) is read from the path the bot gave, which has to be absolute, a picture (PNG, JPEG, HEIC, GIF or WebP) and small enough; the phone is told only its name and fetches the bytes with `link.device.file` while the ask is open. The path stays on this computer.

**What a tool returns** is the person's own data on its way to a bot they chose to give it to. It is carried through the link sealed like everything else, and the computer neither writes it to disk (a brought-over photo is the one exception, as an upload) nor logs it. The phone's side holds it only in the answer: never in a log, a toast, its store or its list of what bots used.

**To add a tool**, add it to `DEVICE_TOOLS` here, give the phone a runner for it (`src/device/`), and add it to the phone's own table (`src/device/tools.ts`). `tests/device.test.ts` fails when the two lists differ in a tool, its source, its level, `hands`, or its arguments. A new source goes in `DEVICE_SOURCES` too.

## Voice

`voice.mjs` is the one place that talks to speech providers, for the desktop app and for paired phones: speech to text, text to speech, and the set-up of a live (realtime, full duplex) voice session. `VOICE.md` is its full contract with every provider's routes, what was read, and what stayed unclear. Read it there; it is not repeated here.

**What the link adds.** The calls `link.voice.set`, `link.voice.key`, `link.voice.options`, `link.voice.transcribe`, `link.voice.speak`, `link.voice.live` and `link.voice.endLive` reach the same `Voice` as `link.voice`, and the `voice` part carries its settings (never a key: each provider says only `hasKey`). The settings are the computer's, shared by every phone. `voice.json`, in the same folder as `link.json`, holds the settings and the keys; each key is wrapped with `protect`/`reveal`. `link.voice.key` takes the key as text or as a saved credential (`{ "$credential": id }`; the key itself is the one place in that call), and never sends it back. The app gives `backend.voice` for local models and for Codex.

**Live voice.** `link.voice.live` sets up a session for a chat with a bot. The voice model is told whom it speaks for (the bot's name, role and the start of its instructions) and gets one tool, `ask_bot`; the phone runs that tool by sending the message to the chat and returning the bot's reply. The voice is told to say one short sentence out loud that it is on it before it calls the tool (`ackFirstRule` in `voice.mjs`, in the instructions every provider gets, and again in `ASK_BOT_DESCRIPTION`, the tool's own description), so a slow reply never leaves the person in silence. For a provider that uses WebRTC the computer takes the phone's offer to the provider and returns the answer, so no secret reaches the phone. The others return a short-lived secret or signed address for one session.

**A voice of a bot's own.** An app that keeps `voice` on each bot (`bot-voice-v1`, named in `backend.capabilities`) lets a phone give a bot its own reading and live voice. `link.voice.speak` takes a `botId`, `link.voice.live` applies the bot's `live` part, and the bot's choices go over the shared settings (see VOICE.md, "A voice of a bot's own").

**Limits at the link.** A `link.voice.transcribe` call carries at most 5 MiB of audio, and `link.voice.speak` at most 4,000 characters. `voice.mjs` itself limits recordings to 25 MB, answers to 40 MB, requests to 60 seconds, and lists and tokens to 15 seconds (`VOICE.md`, "Errors and limits").

**Not tested for real.** No call to any provider has been made with a real key. Every route was read in documentation and run against a fake provider. `VOICE.md` lists where to try first.

## Gadgets

A gadget (an ESP32 board with a microphone and a speaker) is a paired device of kind `"gadget"`. `gadget/docs/contract.md` is its whole contract; this is what an app does with it.

- **Add one.** `link.addGadget({ publicKey, name?, board?, botId? })` pairs a gadget by its key, with no code, and answers the introduction the gadget needs. `introduce()` in `gadget-setup.mjs` does the whole of setup over a USB port: it reads the gadget's key, calls `add`, hands the gadget the answer and the Wi-Fi network, and waits until the gadget is online. `serialLines(path)` opens a serial port for it on macOS and Linux; an app with a serial API of its own passes its own `io`.
- **It is the owner's device.** Nothing is cut from what a bot may do in a gadget's chat, and the gadget answers a bot's requests itself. So adding a gadget is a full-trust step, like pairing a phone: say so where one is added. A team member can't add one.
- **What it is sent.** Two small parts, `meta` and `gadget` (`gadgetPart`), and the reply's text for its own chat. The app's own parts never go to a gadget.
- **Speech.** `link.gadget.hear` takes a recording in pieces and `link.gadget.speak` reads a reply as 16-bit samples at the gadget's rate. Both use the providers of Settings › Voice, so a gadget needs a provider there that is not "This device". `Voice.speak({ samples: true })` asks each provider for plain samples in place of MP3 (`VOICE.md`).
- **In the device list** a gadget has `gadget: { board, firmware, botId, settings, wifi, wifiWaiting?, restarting? }`. `link.status().devices` has the whole record. `removeDevice` works as for a phone.
- **Settings, Wi-Fi and restart** (`gadget-settings-v1`): `link.configureGadget(id, patch)`, `link.gadgetWifi(id, change)` and `link.restartGadget(id)` for the app's own page, the same as a phone's `link.gadgets.*` calls. A Wi-Fi password is held in memory for the gadget, for 10 minutes at most, and written nowhere.
- **The Botkin's faces.** A gadget draws its bot's Botkin itself, from SVG the link makes with the design kit (`botkin-svg.mjs`). The link finds the kit at `design/botkins-kit` beside it (one or two folders up), so an app that ships the link ships that folder's `customize.js`, `motion/` and `avatars/` too. Without them a gadget shows its own default Botkin.

## Limits

The host takes at most 256 connections, and at most 24 from one address. A connection that sends nothing is dropped after 10 seconds. A call without a known session, or with a body larger than 6 MB (64 KB for pairing), is refused before any of its body is read, and a call from a phone that was removed while its body was on the way is refused too.

A sync follows up to four chats. With `stream-appends-v1`, each cursor has a chat ID and text ID of up to 128 UTF-16 units, plus two non-negative safe integer offsets. On direct connections, text-only changes flush to a waiting session at most every 200 ms. Other changes use the 60 ms pump, including stream starts, first text and ends. A relay session polls at 250 ms or uses one open `sync-push-v1` follow with updates spaced by 100 ms. Chunked text keeps its own timing. See [the sync contract](../docs/link-contract.md#streaming-text). `snapshot()` is called once for each rebuild of the parts, and what that rebuild builds is shared with the views and notifications made from it. A rebuild writes a chat's page and a running turn again only for the steps and messages whose own values changed (`json-cache.mjs`; the app may change its records in place, which is why a record is compared by what it holds and not by identity); a part whose pieces are all as before is not joined or compared, and a phone that is sent indicators is not given a new view for a reply that only grew.

Pairing and session tries are counted per address: 20 in 10 seconds, then that address is told to slow down. A phone keeps at most 6 sessions (its oldest end first) and may have two `link.sync` waits open in each; a newer wait ends the oldest. A phone may have 8 unfinished uploads at once.

A message's mentions are checked for shape, and a path in one may not climb with `..`; a wiki page is named from the wiki's own top. The desktop app itself checks that a mentioned file is inside the chat's own folders. A mention is a project, a Today card (`board`), a file or a wiki page.

**Notifications.** A phone's tokens: one for its notifications, one that can start a Live Activity, and up to 4 for the activities it is showing (the oldest go first). A push takes at most 8 items a call, and each call has 15 seconds. Ordinary Live Activity progress uses low priority at most once every 15 seconds (requests and completion update immediately), counts as stale after 15 minutes, and stays on the Lock Screen for 4 minutes after it ends (10 if it failed). A phone that said it is in front is believed for 45 seconds after it was last heard from. An alert's text is cut to 180 characters. An alert expires after 15 minutes if Apple can't deliver it (5 minutes for a request). The relay limits what a computer may send (`relay/README.md`).

**Phone tools.** At most 16 asks wait at once. A phone has 45 seconds to answer a tool, and 150 seconds for one the person finishes by hand; it is nudged after 9 seconds. An answer is at most 256 KiB as JSON, and a picture sent to a phone at most 5 MiB.

**Voice.** See "Voice" above and `VOICE.md`.

## Trust

Pairing a phone is a full-trust step. A paired phone can add a tool (MCP) server, which names a program the computer runs or an address it calls, and it can point a saved credential at that tool. So a paired phone can, by design, do what the person could do in the app on the computer. The link's limits protect the computer from other devices on the network, not from a phone the person paired.

The newer features keep that rule, and add these facts:

- **Notifications.** What a notification says is sealed for one phone, so the relay and Apple never read it. They do see a phone's token, when a push was sent, that it is an alert or a Live Activity, and a Live Activity's plain state. The relay holds Apple's signing key; whoever can change the Worker could send notifications to the app as its team, though never read one (`relay/README.md`). A computer's push tokens sit in `link.json`, readable only by the person; unlike the keys, `protect` does not wrap them. They go when a phone is removed or turns notifications off.
- **Phone tools.** Each phone's switches decide what its bots may do there, and a phone sets only its own (the call uses the phone's session, not a device id it names). A paired phone's answer is data for a bot: a phone that was paired by the person can say anything about its own calendar. What a tool reads reaches the bot and, through it, whichever model provider that bot uses; the person chose to give the bot that data.
- **Speech keys.** A phone can set, replace or remove a provider's key, and can change a provider's address (OpenAI's, the person's own `custom` server, Azure's endpoint). The computer sends text, recordings and that provider's saved key to the address that is saved, and changing an address does not clear the key. This is the same trust as adding a tool server. A key is never sent to a phone; a live session may hand a phone a short-lived secret for that one session.

## Keeping secrets

The link's own file (`link.json`) is read once at start. A file that isn't there is a new identity. A file that is there but can't be read or understood is left exactly as it is and the link stays off ("locked"), so a new identity never overwrites it and strands the paired phones.

`protect(text)` and `reveal(text)` (the system keychain, such as Electron's `safeStorage`) wrap the link's private key, the relay's private key, the credential vault's data key, and each speech provider's key in `voice.json`. Without them all of these sit in their files, which is fine for development only. If a wrapped key can't be opened in a run, the link stays off, and the vault is *locked*: its list still shows, but nothing in it can be read, saved or removed, and its file is left as it is. The speech settings lock the same way.

`link.json` also holds each phone's notification tokens and its device-access switches. These are not wrapped. A token is an address Apple delivers to, and sending to it takes the Apple key that only the relay holds, but treat the file as private anyway: it is readable only by the person (mode 0600).

A phone never reads a credential. It saves one, or links a field of a password manager, and then puts `{ "$credential": id }` where the value belongs. The link swaps in the value on the computer, at these places only:

- `respond`: the answer's `value`, and the values directly inside its `content`.
- `saveMcpServer`: the values directly inside `env` and `headers`, and `oauth.clientSecret`.
- `connectProviderService`: the `key`.
- `link.voice.key`: the key itself (the second argument), to save a speech provider's key from a saved credential. The link keeps it in `voice.json` and the call answers with nothing.

A reference may also carry `prefix` (a scheme word and a space, such as `"Bearer "`). It is honored for `headers` values and `key` only, and is not added twice when the saved value already starts with it. A reference anywhere else, in these calls or in any other, stops the call with "A credential can't be used there.", so a phone can't name a credential where the app would show it back (a server's name, say). A value that can't be read stops the call too. For the first three calls every value that was put in is also replaced by `•••` in the desktop's answer and in its error message before either goes to the phone.

Any other error that comes from a system problem (a file that is missing, a refused connection) reaches a phone only as "That didn't work on your computer."; the detail goes to the `log` function. The link's own sentences, and the desktop's own messages (which are written for people), pass as they are.

Password managers are found on `PATH` and in the usual folders (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, and the common Windows ones). Each command has 30 seconds and 4 MB, runs without a shell, and gets only `PATH`, `HOME` and the manager's own variables. At most 4 tools run at once and 32 wait; beyond that a call fails with "Your computer is busy. Try again." Bitwarden needs its master password from the phone. It goes to `bw` in the environment, five tries a minute at most, and the session it returns is kept in memory for 8 idle hours and handed to `bw` in `BW_SESSION`, never on a command line. Every `bw` call is non-interactive. On Windows only real programs (`.exe`) are run; a `.cmd` or `.bat` shim is reported as unsupported, because quoting arguments for `cmd.exe` can't be made safe. Pass `searchPath: [dir, …]` to `LinkHost` to look in other folders (tests do).

**Bot autofill, standing grants and audit log (owner only).** Bots in a private owner chat can discover saved credentials across the Botkins vault and linked 1Password / Bitwarden / Proton Pass items via `find_saved_credentials` (matching registrable domain / eTLD+1 and saved aliases, returning only metadata such as `id`, `name`, `kind`, `source`, `website`, `aliases` and `hasTotp` — never values). They deliver credentials via `use_credential` across `page_fill`, `page_fill_submit`, `extension_fill` (sent host → Chrome/Edge extension over the existing encrypted channel using native setters + events, never readable back), `https_form`, `bearer_get`, `https_header`, `env_exec`, TOTP 2FA codes, and experimental `app_fill` (disabled by default behind `BOTKINS_ENABLE_APP_FILL=1`).

**Credential destination & execution threat model:**

- **Browser delivery fail-closed origin pinning:** Both browser delivery paths (`page_fill` / `page_fill_submit` and `extension_fill`) fail closed before writing any field value unless the document and every effective HTTPS submit destination resolve to the user-approved HTTPS origin — checking `<form action>`, `<base href>`, associated submitter `formaction`/`form` overrides, and explicit submit targets via prototype DOM accessors (defending against DOM clobbering such as `<input name="action">` or `<input name="form">`). Look-alike domains, HTTP downgrades, non-HTTPS schemes, redirects, and cross-origin iframes are refused.
- **Browser-boundary submit enforcement:** In the host screen browser (`ScreenBrowser` / CDP) and desktop webviewer (`Electron`), `page_fill` / `page_fill_submit` enforce the approved HTTPS origin at the browser network boundary via CDP `Fetch.enable` interception (failing any off-origin or non-HTTPS request or redirect with `BlockedByClient`) and Electron `will-navigate`/`will-redirect`/`webRequest.onBeforeRequest` origin pinning; auto-submit fails closed if browser-boundary interception is unavailable. In the Chrome/Edge MV3 extension (`extension_fill`), auto-submit is disabled (`submit` fails closed in host, controller, and DOM driver) because MV3 extensions cannot enforce exact-origin submit destinations at the browser network boundary without `chrome.debugger`; `extension_fill` validates submit destinations and fills only, leaving submission to the person.
- **`env_exec` verified executable identity & output isolation:** `env_exec` requires an absolute path inside trusted non-writable executable directories (never ambient `PATH` lookup or relative paths), verifies canonical `realpath`, rejects symlinks escaping trusted roots, rejects blocked shells/interpreters/exfil utilities (checked on both requested and resolved names), rejects writable/setuid/foreign-owned binaries or directories, opens the target with `O_NOFOLLOW`, and computes its SHA-256 digest from the open descriptor. Standing `env_exec` grants are bound strictly to `(resolvedPath, exeSha256, args, envVar, cwd)` — never lookup name or bare command text — and legacy unverified `env_exec` grants are discarded on load. Replacing a binary at the same path invalidates prior standing grants and requires re-approval, and the worker thread re-verifies canonical path and SHA-256 immediately before `spawn(..., { shell: false })`. Child `stdout` and `stderr` are discarded at the OS level (`stdio: "ignore"`) so credential-bearing output (raw, transformed, or newly exchanged tokens) never enters worker memory, host logs, error messages, or model context.

Standing approvals are stored in `credential-grants.json` (`desktop/credential-grants.mjs`) keyed by `(bot, credential, pinned destination, operation)` with levels `ask` (default), `today` (expires at local midnight), `always`, and `deny`. Group chats and non-owner team members never receive standing grants. Owner-only link RPCs `link.credentials.copy` (explicit copy into the Botkins vault marked `copied: true`), `link.credentials.grants`, `link.credentials.setGrant`, `link.credentials.revokeGrant` and `link.credentials.audit` expose grants and audit history (who, what, where, when, outcome — never secret values) to desktop Settings › Credentials and paired owner phones. Every bot has a per-bot rate limit, values are zeroed in memory after use, all returned text and errors are scrubbed (including URL-encoded and base64 variants), a locked vault fails closed with a clear message, and nothing new on the relay can read a credential value.

**Proton Pass setup (`proton-pass-setup-v1`, owner only).** `link.credentials.protonPassInstallPlan` provides the pinned URL, SHA-256 and destination. `protonPassInstall` accepts only that SHA-256 after consent. An existing standalone CLI is accepted if `pass-cli agent --help` succeeds. A Botkins-managed installation verifies the download and every installed file, including both Windows ZIP entries. Maintainers run `node desktop/scripts/update-pass-cli.mjs <version>` from the repo to compare Proton's release checksums and update both pin tables; the app never runs it.

`link.credentials.protonPassSignInStart` opens a temporary Proton session, `protonPassSignInRead` polls it and returns safe events, and `protonPassSignInInput` accepts a vault selection or one extra password. The password travels only to the login process over a private FIFO or Windows named pipe. `protonPassSignInCancel` cancels the session; sign-in also has an 11-minute deadline. Botkins keeps a viewer agent token and its session key in the encrypted credential vault and gives them to the CLI only through its environment. The Proton CLI does not need a system keyring to use its scoped session. New reads never use the owner's own Proton session after connecting. `protonPassDisconnect` starts a fresh Proton sign-in when needed to delete the agent before forgetting it; it never deletes a linked credential or the owner's own CLI session. Status shows when access ends and offers renewal from 14 days before expiry. The demo host simulates setup and browsing; `BOTKINS_DEV_PROTON=off` simulates an older host.

## The screen

The person chooses what phones may do with this computer's screen, and the app's page should offer it:

- `link.setScreenMode("off" | "view" | "control")`. The default is `"off"`. It is saved in `link.json`, and the phones' `host` part follows.
- `link.status().screen` is `{ mode, viewers: [{ deviceId, name, since }] }`. `link.on("screen", ({ device, started }) => …)` fires when a phone starts or stops watching, so the page can show who is.

Pictures come from an adapter the app passes as `backend.screen`:

```js
screen: {
  displays: async () => [{ id: "1", label: "Built-in display", width: 1512, height: 982, primary: true }],
  capture: async ({ display, maxWidth, quality }) => ({ jpeg: buffer, width, height }),
  permissions: async () => ({ screenRecording: true, accessibility: true }), // optional
}
```

The optional `openVideo({ display, maxWidth, fps, mimeTypes, signal })` adapter opens one continuous encoder. It returns `{ mimeType, read, close }`. Each read yields at most 256 KiB of ordered media. Abort and close release the recorder and any pending read. Screen permissions and the viewer indicator cover both video and stills.

A viewer can pass `wait: false` to `link.screen.frame` to sample the display once. An unchanged frame returns its sequence and dimensions. Omitting the option keeps the interactive long poll. Older hosts ignore the option.

Without an adapter, macOS falls back on its own `screencapture` and `sips` (one display), and other systems say that viewing isn't available. On macOS the app needs the Screen Recording permission to capture, and the Accessibility permission for clicks and typing. A phone is told which one is missing. Display ids should be numbers as text (`"1"` is the main display, then `"2"`, and so on), or clicks go to the main display. Frames are only sent while the mode allows it (a picture taken just as the person turned the screen off is dropped), and only if the adapter's picture is a JPEG of at most 3 MB. What `link.screen.info` learns about permissions and displays is reused for 5 seconds. Input is checked before anything is posted: at most 64 actions a call, at most 256 once text is split at new lines and tabs, and at most 8 calls waiting. A call whose phone has been removed, or that arrives after control was turned off, is skipped, and a mouse button a phone is holding is let go when the mode changes, when that phone stops watching, and when it is removed. In control mode, macOS posts input with a fixed `osascript` script, Windows with a fixed PowerShell script, and Linux with `xdotool` on an X11 session. In every case the events are data passed in, and no text from a phone is ever built into a script or a command.

## What a paired phone can now do

- Keep credentials: save an API key, a login or a note in the encrypted vault; link a field of 1Password, Bitwarden or Proton Pass; check it still reads; and use it in a call without seeing it.
- Watch the screen (mode `view`) and use it (mode `control`): live video for control, with sampled stills for previews and older hosts.
- Find pull requests (`link.pullRequests`) of the repository behind a chat's project. It needs `gh` installed and signed in on the computer.
- Send files (`link.upload`, up to 4 MB a call, 25 MB a file, 200 files and 200 MB per phone) and attach them to a message. Files are kept in `<dir>/uploads/<phone>/`. A file left unfinished for 10 minutes is dropped, finished files are removed after 7 days (checked at start and every 10 minutes), and a phone's files go when the phone is removed. A message may attach only a file its own phone sent, and its `mentions` are cut down to at most 12 of the exact shapes the composer sends (the desktop app itself checks that a mentioned file is inside the chat's own folders).
- A search for pull requests can't reach other repositories: `repo:`, `org:`, `user:` and `owner:` are removed from the search text. A failed lookup is remembered for 30 seconds, like a good one.
- Get notifications and Live Activities (`link.push.*`), and choose which of them it wants. See "Push notifications".
- Let bots use it: switch sources of its calendar, contacts, Health data, location, photos, Apple Music and mail on, and answer what bots ask of it (`link.device.*`). See "Tools that run on a phone".
- Set the speech providers and their keys, dictate and have replies read, and talk live with a bot (`link.voice.*`). See "Voice".

`meta().capabilities` lists `credentials-v1`, `screen-v1`, `prs-v1`, `uploads-v1`, `relay-v1`, `sync-push-v1`, `push-v1`, `device-v1` and `voice-v1`, then the names of the app's own `extras` and `backend.capabilities`, so a phone can tell an app that has a feature from an older one. A look's eyes and custom colors, `looks-v2`, is there when the link keeps the looks (the app gave no `setLook`) or the app names it.

## Custom views

A bot can put a page of its own (an html block) in a Today panel or a chat card. The app keeps the page apart from the state a phone follows: the state carries only the view's id and height. A phone that wants to draw one asks for it:

- `link.frame.page(id)` answers `{ html, data }`: the page as the bot wrote it and its data, from `backend.frames.page(id)`. The id must look like one (36 characters of hex and dashes). A page over 300,000 characters or data over 200,000 characters of JSON is not sent ("This view is too large for a phone."). A view that is gone answers "This view no longer exists."
- `link.frame.chat(id)` answers `{ chatId }`: the chat a view's answer goes to, from `backend.frames.chatFor(id)`.

Nothing of the computer goes with a page. The phone draws it in a web view that has no network and can't leave its page, and gives it the same `window.botkins` bridge the desktop app does (`src/ui/frame.ts` in the phone app has the rules, and `tests/frames.test.ts` the checks). The page is not trusted on either side.

## Several devices

One computer serves many paired devices at once: phones, and other computers' Botkins apps that use this one. Each has its own key (`link.json` keeps only its public key), a name, a `kind` (`"phone"` or `"desktop"`), when it was paired and when it was last heard from. Pairing one more, or removing one, changes nothing for the others. At most 20 devices are kept.

- For clients: `link.devices.list`, `link.devices.rename` and `link.devices.remove` (`devices-v1`). The contract a client builds against is `docs/link-contract.md` in the phone repo (`CONTRACT.md` beside these files in a desktop app).
- For the app's own Settings page: `link.status().devices`, `link.renameDevice(id, name)`, `link.removeDevice(id)`, and the events `"paired"` and `"status"`.
- A device paired before kinds were kept gets its kind from its platform when `link.json` is read. Nothing has to pair again.
- A paired device of kind `"desktop"` that says its window is in front (`link.push.presence`) counts like this computer's own window: a reply in the chat on that screen sends no notification to a phone (`LinkHost.attention()`).
