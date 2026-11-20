# The link contract for clients

This is what a client of a Botkins computer builds against: the phone app, and another computer's Botkins app that uses this one ("desktop as a client"). The host's side is `link-host/` (copied into the desktop app as `desktop/link/`). The client's side is `src/link/` in the phone repo. Both sides of every rule below have tests in `tests/` (`link.test.ts`, `devices.test.ts`, `relay.test.ts`).

A host serves many clients at once. Each client has its own credential. Pairing a new client, or removing one, changes nothing for the others.

## Words

- **Host**: the computer whose Botkins app holds the bots, chats and settings. It runs `LinkHost`.
- **Client**: a paired device. Its `kind` is `"phone"` or `"desktop"`.
- **Pairing**: the one step that makes a device a client. It is a full-trust step: a client can do what the person can do in the app on the host.

## Use the client library, do not write a second one

`src/link/` has no React Native imports. It runs in Node, in Electron and in a browser.

| File | What it gives a client |
| --- | --- |
| `client.ts` | `pair()`, `findHost()`, `LinkClient` (session, calls, sync), `LinkError`, `Pairing`. |
| `crypto.ts` | X25519, HKDF-SHA256, ChaCha20-Poly1305 (the `@noble` packages). |
| `relay.ts` | `relayFetch()`: the same sealed requests over the relay's socket. |
| `pairing.ts` | `parsePairingUrl()` (the QR code's link), `normalizeHost()`, `formatCode()`. |
| `types.ts` | Every part and every call, typed (`Parts`, `Calls`). |

A desktop client copies this folder as it is and keeps it in step with the phone repo. Do not edit the copy: ask the phone thread for a change.

## Pairing

1. On the host the person opens a code: Settings › Phone › Pair (`link.startPairing()` → `{ code, expiresAt, url }`). One code is open at a time, for a few minutes, and one device can use it.
2. The client gets the target in one of three ways:
   - The QR code or its link `botkins://pair?v=1&s=<serverId>&k=<host key>&c=<code>&h=<addresses>&n=<name>`. `parsePairingUrl(text)` reads it. It carries the host's real key, so nothing on the network can stand in for the host.
   - A host found on the network (`_botkins._tcp`, TXT `v` and `id`) and the typed code.
   - A typed address (`normalizeHost(input)`) and the typed code.
3. The client calls:

   ```ts
   const pairing = await pair(fetch, target, { name: "Studio Mac", platform: process.platform, kind: "desktop" });
   ```

   - `name` is what the host shows for this device (60 characters at most). The person can rename it later.
   - `platform` is free text (`"ios"`, `"android"`, `"darwin"`, `"win32"`, `"linux"`).
   - `kind` is `"phone"` or `"desktop"`. When it is missing the host derives it from `platform` (a desktop platform makes a desktop, everything else a phone). A desktop client must send `"desktop"`.
4. `pair()` returns the client's credential, a `Pairing`: `{ serverId, serverKey, deviceId, secretKey, hosts, name }`.

Errors are `LinkError` with a `code`: `"code"` (wrong code), `"closed"` (the code expired, or too many tries), `"protocol"` (different versions), `"offline"`.

### Where the credential lives

- `secretKey` is the client's own X25519 secret. The host never has it and no call returns it. The host keeps only the client's public key.
- Keep the whole `Pairing` in the client's secure storage: the Keychain on Apple systems (`safeStorage` in Electron), never a plain file, a log or a setting that syncs.
- A client that pairs again with the same key replaces only its own earlier entry.
- The host keeps at most 20 paired devices.

## Sessions and calls

```ts
const client = new LinkClient(pairing, {
  fetch,                         // or relayFetch(fetch, { WebSocket }) to also reach the host through the relay
  onParts(parts) { /* merge into the client's state */ },
  onState(state) { /* "connecting" | "online" | "offline" | "revoked" */ },
  onHosts(hosts) { /* save them into the stored Pairing */ },
  onRoute(route) { /* "direct" | "relay" | null */ },
});
client.start();
const id = await client.call<string>("createChat", botId);   // any name in `Calls`
client.watch([chatId]);                                       // at most 4 chats: their "chat:<id>" and "run:<id>" parts follow
```

- Transport: plain HTTP under `/botkins/v1/` (`hello`, `pair`, `session`, `rpc`). The link encrypts every message itself, so there is no certificate. A session mixes a one-time key exchange into the device's key; every message is ChaCha20-Poly1305 under a numbered nonce that is accepted once.
- A device may hold 6 sessions at once (so a client may run more than one window). The host keeps 48 sessions in all, and a device's own oldest goes first.
- **State arrives by itself.** The client follows named parts (`meta`, `settings`, `bots`, `chats`, `live`, `runs`, `panels`, `board`, `tasks`, `projects`, `mcp`, `skills`, `phones`, `asks`, `voice`, `credentials`, `host`, …). After any change on the host, every connected client is sent the parts that changed. Do not update state by hand after a call.
- **Every client is served alike.** A streaming reply (`live.streams[chatId]`, `run:<id>`), the task board (`tasks`) and Today (`board`, `panels`) reach every connected client, not only the one that acted.
- **Calls from two clients at the same moment** are handled one after another by the host's app. Each call is one change; no call spans two requests. A client must not assume it is the only one acting: read the parts after a call, do not keep its own copy as the truth.
- `LinkClient` reconnects by itself. Call `client.wake()` when the app comes to the front or the network changes.
- `state === "revoked"` means the host no longer knows this device. Delete the stored `Pairing` and show the pairing screen. Do not retry.

### What a client may call

`link-host/methods.mjs` (`REMOTE_METHODS`) lists the app's calls. A call that opens a window, a file dialog or the browser on the host is not in it. The link's own calls start with `link.`; `Calls` in `types.ts` types all of them. Check `meta.capabilities` before using a feature, and say "Update the app on your computer" when its name is missing.

## Devices: list, rename, remove (`devices-v1`)

Any paired client may read the list of paired devices, rename one and remove one, as the person can in the host's own Settings.

| Call | Answer |
| --- | --- |
| `link.devices.list()` | `PairedDevice[]` |
| `link.devices.rename(id, name)` | `PairedDevice[]` as it is afterwards |
| `link.devices.remove(id)` | `PairedDevice[]` that are left |

```ts
type PairedDevice = {
  id: string;
  name: string;
  platform: string;
  kind: "phone" | "desktop";
  createdAt: number;     // when it was paired (ms)
  lastSeenAt: number;    // when it last made a call (ms; written at most once a minute)
  connected: boolean;    // heard from in the last 90 seconds
  current?: true;        // the device that asked
};
```

- Nothing of a key, a session or a notification address is in the list.
- `remove(id)` ends that device's sessions at once. Its next request is refused and its client goes to `"revoked"`. Its notification addresses, device-access choices, uploads and screen sharing go with it. The other devices keep their sessions.
- Removing the device that asks is unpairing (the same as `link.unpair`).
- An id that is not paired answers "That device is no longer paired."
- The `phones` part has one entry for each paired device, by id: `{ name, kind, platform, push?, sources? }`. It changes when a device is paired, renamed or removed, so a client's list can stay in step without asking.

### On the host itself

The host's app reads the same registry without a session, for its own Settings › Phone page:

- `link.status().devices`: each device with `id`, `name`, `platform`, `kind`, `createdAt`, `lastSeenAt`, `connected`.
- `link.removeDevice(id)`, `link.renameDevice(id, name)`.
- Events: `"paired"` (with the device) and `"status"` (after any change).

## What differs for a desktop client

- **Notifications.** A desktop client does not register for push (`link.push.register` is for phones). It should call `link.push.presence(active, chatId?)` when its window comes to the front, goes away, or shows another chat. While a desktop client is in front, the host treats it like its own window: a reply in the chat on that screen sends no notification to a phone.
- **Tools on the device.** `link.device.*` (calendar, contacts, Health, location, photos, mail) are for phones. A desktop client sets no sources and answers no asks.
- **The screen.** `link.screen.*` shows the host's screen. A desktop client may use it under the same rule as a phone (the host's person allows view or control).
- **Secrets.** As for a phone: a client saves a credential or links a field, then sends `{ $credential: id }`. No call returns a secret.
- **Which host is in use.** Show `meta.name` (the host's name) wherever the client shows data from a host, and let the person switch between "This Mac" and each paired host. Keep one `Pairing` and one `LinkClient` for each host.

## The relay

Away from the host's network a client goes through the relay (`relay.botkins.app`). The host lists it as one more address, `relay!<room>@<host>`, and `relayFetch` carries the same sealed requests over a socket. The relay sees sizes and timing, never contents. A room takes 16 client sockets at once (8 from one address). The relay is off until the person turns it on on the host.

## Upgrades

- `link.json` is version 1 and has not changed shape. A device paired before `kind` existed gets its kind from its platform when the file is read. No device has to pair again.
- A host without `devices-v1` has no `link.devices.*` calls and no `kind` in `phones`. A client then shows only itself.
- When this contract changes, the change is made here first, then in `link-host/` and `src/link/` together, with a test in `tests/devices.test.ts` or `tests/link.test.ts`.
