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

   - `name` is what the host shows for this device (60 characters at most). The person can rename it later. A phone sends its model ("iPhone 17 Pro"): since iOS 16 its own name is the bare word "iPhone".
   - `person` (optional, `device-person-v1`) is who the device belongs to ("Jordan"), asked before pairing. The host cleans it (no control characters, trimmed, 60 characters at most) and keeps it beside `name`; an empty one is left out. A host from before ignores it and pairs as it did. A team join (`startJoin`) sends the same field, and the member is named by it.
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
| `link.devices.setPerson(id, person)` (`device-person-v1`, owner only) | `PairedDevice[]` as it is afterwards |
| `link.devices.remove(id)` | `PairedDevice[]` that are left |

```ts
type PairedDevice = {
  id: string;
  name: string;          // the device ("iPhone 17 Pro")
  person?: string;       // who it belongs to ("Jordan"; device-person-v1). Absent until someone gives one
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
- Show `person` first and `name` under it; with no `person`, `name` alone. `setPerson` refuses an empty name ("Give the person a name."). On a team member's device it renames the member too, and every device of that member.
- The `phones` part has one entry for each paired device, by id: `{ name, kind, platform, push?, sources? }`. It changes when a device is paired, renamed or removed, so a client's list can stay in step without asking.

### On the host itself

The host's app reads the same registry without a session, for its own Settings › Phone page:

- `link.status().devices`: each device with `id`, `name`, `person` (when it has one), `platform`, `kind`, `createdAt`, `lastSeenAt`, `connected`.
- `link.removeDevice(id)`, `link.renameDevice(id, name)`, `link.setDevicePerson(id, person)`.
- Events: `"paired"` (with the device) and `"status"` (after any change).

## The screen's level, set from a phone (`screen-grant-v1`)

What paired devices may do with a host's screen is one setting: `"off"`, `"view"` or `"control"`. A host with a window sets it in its own Settings › Phone, and no client can change it. A **headless host** (a server with no window) has nobody at a window, so there, and only there, a phone may set it. It is the one call that widens what clients can do, and it asks for more than a paired session.

**What a headless host says.** Its app passes `backend.headless === true` and `backend.displayStatus()` (the display as it is now, read at each rebuild of the parts; the app calls `link.changed()` when it changes). The host then names `screen-grant-v1` in `meta.capabilities`, and the `host` part is:

```ts
type HostPart = {
  screen: "off" | "view" | "control";
  relay?: boolean;
  headless?: true;                                              // only a headless host
  display?: { available: boolean; kind?: string; note?: string }; // with headless: the display now ("xvfb"); note is one sentence for a person
  screenSetBy?: { deviceId: string; name: string; at: number }; // the phone that last set the level; absent when it was set on the host
};
```

A host with its own window says neither `headless` nor the capability, and refuses the calls below ("Change this on the computer itself."). `phones[deviceId].presence` is `true` for a device whose presence key the host keeps.

**The presence key.** When a phone pairs, it sends a second public key in the pairing's sealed hello: `presenceKey`, P-256, SPKI as base64url. The private half stays on the phone and can be used only after Face ID, Touch ID or the passcode, each time (`modules/botkins-presence`: the Secure Enclave where the phone has one). The host keeps the key on the device's record **only when the pairing request reached it directly over HTTP**, never through the relay. There is no way to add a key later: a device paired without one (an older build, a pairing through the relay, a phone with no passcode) pairs again to get one.

**A server behind its own relay (`screen-grant-relay-v1`).** A cloud server may have no network of its own that a phone can join: phones reach it only through a relay that runs on the server itself. Its app says so with `relay: { url, own: true }` (the headless host: `BOTKINS_RELAY_OWN=1`). While that relay is on, a headless host names `screen-grant-relay-v1` beside `screen-grant-v1`, keeps the presence key of a phone that paired through that relay, and takes the three calls below through it. Nothing else changes: the ticket, the signature, the phone and the headless host are all still required. The relay cannot make a grant, because it carries sealed messages and has no presence key. A client reads the capability to know that the relay is no bar. Without `own`, and on any other relay, the rules in this section hold as written.

**The calls.** All three are the link's own calls. Each is refused unless the host is headless, the call arrived directly (the transport is checked on every call, also in a session that was opened directly), and the device is a phone.

| Call | Answer |
| --- | --- |
| `link.screen.grant.begin(level)`, `level` `"view"` or `"control"` | `{ ticket, expiresAt }` |
| `link.screen.grant.confirm(ticket, signature)` | `{ screen }`, the level now in force |
| `link.screen.revoke()` | `{ screen: "off" }` |

- A **ticket** is 32 random bytes as base64url. It lasts 60 seconds, works once (a refused `confirm` uses it up), and belongs to one session, one device, one level and this host. A device has one open ticket; asking again ends the one before. Any change of the level, the session ending and the device being removed end it.
- The **signature** proves a person confirmed on that phone. The phone signs the UTF-8 bytes of `JSON.stringify(["botkins-screen-grant-v1", serverId, deviceId, level, ticket])` with its presence key: ECDSA P-256 with SHA-256, the signature as DER in base64url. `grantMessage` in `src/link/client.ts` and in `link-host/grant.mjs` builds that text, and a test holds the two equal.
- `revoke` needs no ticket and no signature: taking access away is one step. A phone without a presence key can still revoke.
- The level and `screenSetBy` are kept in `link.json` until changed, over a restart too. The host's own setting (`setScreenMode`) clears `screenSetBy`.
- The sentences a client may get: "Change this on the computer itself." / "This can't be changed through the relay. Connect to the computer's own network and try again." / "Only a paired phone can change this." / "Pair this phone with the computer again to change this from the phone." / "That confirmation ran out. Try again." / "This phone couldn't confirm it was you. Try again."

**No bot can reach it.** These calls are answered only inside a paired device's sealed session. They are not among the app's calls a client may make (`REMOTE_METHODS`), no tool a bot has on the host or on a phone touches them, and the host's app registers no remote method, command-line tool, bot tool or MCP tool for grants. On the headless host the link and its pairing store run in a container of their own, apart from the one that runs the bots, their tools and the display; the bots' container holds no grant method and can't read the host's identity or the owner's pairing file. On the phone only the Screen section of the computer's page makes the calls, from a tap by the person, after a question that says what the level grants; nothing a bot sends (a message, a custom view, a notification, a phone tool) can start it. `tests/screen-grant.test.ts` checks the host's rules, the phone's states and that these are the only callers.

## The computer's own updates (`app-update-v1`)

A phone can see which Botkins its computer runs, check for a newer release, and start the update. On a server (the terminal host) the phone is the only screen, so this is how it is kept up to date. The computer's app names `app-update-v1` in `meta.capabilities` when it can report on updates.

```ts
type AppUpdate = {
  status: "idle" | "checking" | "current" | "available" | "downloading" | "restarting" | "error";
  current: string;        // the installed version
  latest?: string;        // the newest stable release, once checked
  canInstall: boolean;    // this copy can install `latest` by itself
  installer?: string;     // for information only
  message?: string;       // one sentence from the computer: why it can't, or what failed. Shown as it comes.
  auto?: boolean;         // present only on a host that can install by itself; false until switched on
  last?: { at: string; from: string; to: string; ok: boolean; message?: string }; // how the last install ended, kept across the restart; `message` with `ok: true` is a note about an install that worked
};
```

| Call | Answer |
| --- | --- |
| `appUpdateStatus()` | `AppUpdate` as it is now |
| `checkAppUpdate()` | `AppUpdate` after asking for the newest release |
| `installAppUpdate()` | `AppUpdate` (`downloading`, then `restarting`) |
| `setAppUpdateAuto(on: boolean)` | `AppUpdate`; refused where `auto` is absent |

- **No call takes a version, an address or a channel.** Where a release comes from is fixed on the computer. `setAppUpdateAuto` takes exactly one boolean; the link refuses anything else (`link-host/methods.mjs`).
- **The owner's devices only.** A team member's device may not make these calls (`link-host/team.mjs`), and no part a member gets says more about updates than the app's version in `meta`.
- **Directly and through the relay.** Unlike the screen grant, these calls are allowed over the relay too, for the owner's devices of either kind (a phone, or another computer's Botkins app): a server is usually reached through the relay, and starting its update from a phone is the point.
- **Installing restarts the computer's Botkins.** The link drops and comes back, and it can drop before `installAppUpdate` answers: a client then asks `appUpdateStatus()` before it calls the install a failure. Afterwards `appUpdateStatus().last` says how it ended, a rollback too (`ok: false`, and `message` says what happened). `message` can also come with `ok: true`: the install worked, and the computer has one more thing to say about it (for example, that it kept its older system files). A client shows that sentence after the result, as it comes, where the person can read it, not only in a passing notice. To tell this install's `last` from an older one, compare it with the `last` the computer showed before the install, never the client's clock with `last.at`.
- **When `canInstall` is false**, `message` says what to do instead (pull a new image, `git pull`); a client shows it as it comes.
- **A notification.** When a computer learns of a newer release it calls `link.push.updateAvailable(version)` (`link-host/push.mjs`). Each owner device whose notifications are on and whose `updates` choice is on (the default) gets one sealed alert for that version, titled with the computer's name: "Botkins 0.16.5 is available." A member device never gets it. A device counts as told only once the relay took its alert, so one that missed it is told at a later check. The alert's kind is `"update"`, and its unsealed line is "An update is available"; a tap opens the computer's page.

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
- A host without `device-person-v1` ignores `person` and has no `link.devices.setPerson`; a client offers only Rename. A device paired before has no `person` until the owner adds one.
- When this contract changes, the change is made here first, then in `link-host/` and `src/link/` together, with a test in `tests/devices.test.ts` or `tests/link.test.ts`.
