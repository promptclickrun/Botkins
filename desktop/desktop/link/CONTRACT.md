# The link contract for clients

This is what a client of a Botkins computer builds against: the phone app, and another computer's Botkins app that uses this one ("desktop as a client"). The host's side is `link-host/` (copied into the desktop app as `desktop/link/`). The client's side is `src/link/` in the phone repo. Both sides of every rule below have tests in `tests/` (`link.test.ts`, `devices.test.ts`, `relay.test.ts`).

A host serves many clients at once. Each client has its own credential. Pairing a new client, or removing one, changes nothing for the others.

## Words

- **Host**: the computer whose Botkins app holds the bots, chats and settings. It runs `LinkHost`.
- **Client**: a paired device. Its `kind` is `"phone"`, `"desktop"` or `"gadget"` (a small device that talks with a bot; see "Gadgets").
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
- **State arrives by itself.** The client follows named parts (`meta`, `settings`, `bots`, `chats`, `live`, `runs`, `panels`, `board`, `tasks`, `projects`, `mcp`, `skills`, `phones`, `asks`, `voice`, `credentials`, `host`, `proactive` (the Proactive agent: the computer's switch and each proactive bot's settings and log, "proactive-agent-v2"; see below), …). After any change on the host, every connected client is sent the parts that changed. Do not update state by hand after a call.
- **Every client is served alike.** A streaming reply (`live.streams[chatId]`, `run:<id>`), the task board (`tasks`) and Today (`board`, `panels`) reach every connected client, not only the one that acted.
- **Calls from two clients at the same moment** are handled one after another by the host's app. Each call is one change; no call spans two requests. A client must not assume it is the only one acting: read the parts after a call, do not keep its own copy as the truth.
- `LinkClient` reconnects by itself. Call `client.wake()` when the app comes to the front or the network changes.
- `state === "revoked"` means the host no longer knows this device. Delete the stored `Pairing` and show the pairing screen. Do not retry.

### Light steps (`step-details-v1`)

Most of a long turn's bytes are the inputs and outputs of its steps, and a chat shows them only when a step is opened. A client that sends `steps: "light"` in the `link.sync` argument gets `chat:<id>` and `run:<id>` with light steps: a step keeps its `input` and `output` only when each is at most 400 characters, when the step is a question the bot asked (`ask_user`, `ask`), or when it started a helper. Any other step comes without them and says `more: true`. `link.messages` answers in the form the session follows in.

`link.step(chatId, runId, stepId)` answers `{ input?, output? }` for one step, each cut to 4,000 characters as a whole step always was, or `null` when the step is gone. A team member may read a step only in a chat they may read (the policy of `link.messages`).

A client names the form on every sync and keeps to it: the versions it holds are for that form. A client that does not ask gets whole steps, and a host without the capability ignores the field and sends whole steps, with no `more`.

### Streaming text

A host with `stream-appends-v1` accepts an optional `appends` object in the existing `link.sync` argument. Its keys are watched chat IDs (at most four, 1–128 UTF-16 units each). Each value is `{ id: string, stream: number, thinking: number }`. The text ID is 1–128 units and the numbers are non-negative safe integers counting UTF-16 code units held. Send `{}` for a first read. The phone can include this optional field on its first sync and omits it after a host advertises no support. An invalid or unsupported field selects the original full-string `live` format.

With appends, `live.streams` and `live.thinking` map chat IDs to booleans. A key means the corresponding stream exists, and true means it has text. Other fields are identical. The two forms of `live` have distinct versions. For a watched chat the host sends `text:<chatId>` as `{ id, stream: { from, add }, thinking: { from, add } }`. Append each string at its indicated UTF-16 offset. A fresh ID, unknown cursor, new epoch or out-of-range offset sends both bodies from zero. When neither body exists, a held cursor gets `null`. These parts are acknowledged by cursors, outside the version map.

### Reasoning appends (`reasoning-appends-v1`)

A host with `reasoning-appends-v1` accepts `reasoningWatch` in `link.sync`, an array of up to four chat IDs. Sending the field selects the compact working-run format. Older clients omit it and receive their usual snapshots. New phones request reasoning for the chats they stream. In whole-reply mode they send an empty list until Activity opens, then call `LinkClient.watchReasoning` for the visible chat. Full step inputs and outputs remain available through the existing step-detail call. Callers that request full steps receive them directly.

A working run's reasoning travels in a separate `reasoning:<chatId>` part for each permitted chat. It contains `{run, items, reset?, remove?, order?}`. An item carries its ID, timing, optional bot ID, UTF-16 offset `from`, and suffix `add`. The host compares its current snapshot with the last one sent on that session when the phone acknowledges its version in `have`. New or rewritten items start at zero. Order and removal changes carry their affected IDs. A missing acknowledgment or new session receives a fresh snapshot with `reset: true`. A null part clears the working reasoning. Completed runs keep the authoritative detail supplied by the computer.

When the live thinking preview exactly matches the latest 4,000 characters of that reasoning, `text:<chatId>` carries `preview: {run, botId?}` with an empty thinking body. The phone rebuilds the preview from the indicated run and speaker and acknowledges the empty wire body. A provider-specific preview still travels as text. Sliding a reasoning preview leaves the reply cursor intact.

A direct waiting sync with only text changes flushes at most once per 200 ms per session, including legacy full-string syncs. The first change after silence and all changes to other followed state (including text beginning, a request, or a step) use the ordinary 60 ms pump and carry pending text.

A host with `text-streaming-off-v1` also accepts `text: false` in the `link.sync` argument, to save relay messages. The session gets the boolean `live` form (with or without `appends`) and no text bodies: a held cursor gets `null` once. Text growing alone does not answer a waiting sync. The reply arrives whole in `chat:<chatId>` when it ends. Without the field, or from an older host, the sync is as above.

A host with `text-chunks-v1` also accepts `text: "chunks"`, for a phone on the relay that still wants a reply as it is written. Text comes on the `appends` path as above, in two paces, because each answer through the relay is two billed relay messages (the phone's request and the host's answer; the relay bills incoming messages 20 to 1). The reply's own text (`stream`) goes after the last whole word after the cursor (after whitespace, or after a character of a script written without spaces, such as Han or kana), and text-only news waits 650 ms since the last answer instead of 200 ms. The first words of a reply (when `stream.from` is 0: the phone holds none of this `text` id yet) go at once, whatever the clock says. A word with no whitespace after it yet may not be finished and stays for the next answer. Thinking (`thinking`) is cut at the last complete line or sentence and waits 2 s. Other news is not delayed and carries the text that is ready. Text with no end goes, cut at a word (or, with no whitespace at all, where it is), once it has waited 6 s or runs past 1200 units. A host may change these paces; a client must not rely on a chunk ending at a sentence, only on `add` being the next characters after the cursor. The phone's cursor moves only by what was sent. The reply arrives whole in `chat:<chatId>` when it ends. From an older host (sentences every 2 s), or one without `text-chunks-v1`, the phone gets the older paces, or sends `text: false` instead.

### What a client may call

`link-host/methods.mjs` (`REMOTE_METHODS`) lists the app's calls. A call that opens a window, a file dialog or the browser on the host is not in it. The link's own calls start with `link.`; `Calls` in `types.ts` types all of them. Check `meta.capabilities` before using a feature, and say "Update the app on your computer" when its name is missing.

With `client-message-id-v1`, a client may include a locally generated `clientMessageId` in the options for `send`. The host echoes it on the queued item and on the user message when delivered. A client can show the message immediately and replace its local row when either echo arrives. Each press of Send gets its own ID, even for identical text.

With `chat-title-regeneration-v1`, `regenerateChatTitle(chatId)` asks the host's summarizer to generate and save a title and returns the title. Only the chat's starter or the owner can request it. It needs a message to summarize and does not change the automatic naming setting or add a turn.

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
  kind: "phone" | "desktop" | "gadget";
  gadget?: { board?: string; firmware?: string; botId?: string }; // a gadget's board and firmware, as it said them, and its bot (gadgets-v1)
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

## People in a chat, and each person's own view (`team-people-v1`)

A **person** is the owner (id `"owner"`) or a member (their member id). The owner is named by the name on one of the owner's devices ("Your name"), else by the computer's name.

**A chat's people** are its starter (`createdBy`, or the owner when there is none) and those invited. Invites are kept in the link's store (`team.chats`, by chat id), never in the workspace.

- `ChatSummary.invited?: string[]` goes to the owner and to the chat's people. The `team` part has `people: { id, name }[]`: the whole team for the owner and for a member who can start a chat (and so invite); for anyone else only the owner and the people of the chats they are in.
- `link.team.inviteToChat(chatId, personId)` and `link.team.removeFromChat(chatId, personId)` answer the invited list afterwards. The chat's starter or the owner invites and removes; someone invited may take themselves out. A chat holds up to 20 people.
- Someone invited sees the chat and may read it, send, stop, answer its questions, fork it and set their own flags on it. An invite never widens a role: a person whose role can't use the chat's bot can't be invited ("That person's role can't use this chat's bot. Change their role in Team settings first."), and loses the chat if their role later loses the bot. They may not rename, compact or delete it, change its model, project or schedule, or invite. Their messages carry their name, and a turn they start runs under the narrower of the starter's limits and their own (decided by the host's app).
- Whom the bot is told it is talking to is the host app's own (`team-turn.mjs`); no call or field is added. Every turn starts with one line that names the person it is for by their Botkins name and person id, never by an email or the computer's account; the owner nobody named is left out. In a chat of more than one person each person's message also starts with their name (`[Sam] ...`), and the line lists the chat's people. A routine's, task's or panel refresh's turn is labelled as started on its own, never as the owner's. A teammate asked through `ask_teammate` is told whose request it is. Phones show the name over someone else's message from `author` (and, for the owner's, from `people`) in a chat of more than one person.
- Removing a member drops their invitations and their view. Deleting a chat through the link drops its people and everyone's marks on it. Taking a person out of a chat ends that chat's card on their phones.
- For the app on the host: `link.chatPeople(chatId)` → `{ createdBy, invited }` (never throws), `link.inChat(chatId, personId)`, `link.notifiesOwner(chatId)`, `link.inviteToChat`, `link.removeFromChat`, `link.removeChatPeople(chatId)`.

**Who is notified.** A chat's alerts (reply finished, routine result, Live Activity, a bot's question) go to its people only. An owner device does not hear of a member's chat unless the owner was invited. One exception: a request only the owner can answer (`permission`, `secure`) goes to the owner's devices whoever's chat it is.

**Each member's own view.** A member's `setBotFlags` (`hidden`, `pinned`), `reorderBots` and `setChatFlags` (`pinned`, `archived`, `unread`) are kept in the link's store (`team.views`, by member id) and never reach the app. So the owner's hidden bot is not hidden for a member, and a member's read mark is their own. Arranging one's view needs only `agents.view`. Other flags of `setBotFlags` (`teamwork`) still reach the app and need `agents.manage`; a `sectionId` from a member is dropped. A member's unread: since they last marked the chat read; before that, as the workspace says for a chat they started, and unread for one they were invited to.

**What a member is sent** beyond the cut above: bots without `origin`, and without `instructions` and `clarificationInstructions` unless the role manages bots; no `sections`; `panels` and `board` only for bots the role may see; a custom view in a chat (`link.frame.*`) and a chat's card (`link.push.activity`) only for chats they are in; a view on a Today panel they are sent follows Today's rule. A chat a member starts is marked read for them from the start.

**Routines.** When the app names `routine-owner-v1` (it stamps `createdBy` on a member's routine and its chat), a member may change, run, enable, duplicate or delete only a routine they made.

Not built: projects, tasks and artifacts for members. They are the owner's.

## Admin mode: what an owner device is shown

Decided by the owner on 2026-11-20: "the owner should be able to [open a member's private space], but the owner should not automatically be forced to see everyone else's spaces, agents, chats, etc. Only when toggling maybe an Admin Mode on from within settings."

**Admin mode changes what the owner is shown, never what the owner may do.** It is a way of looking, not a lock: `authorize` and `spaceCan` are unchanged, and a call from the owner that names a member's chat or space passes with it off. It is each owner device's own (a flag on the device record), off at first, so turning it on at the desk does not fill the phone. The app's own window keeps its own.

**With Admin mode off, an owner device is sent what the person `"owner"` is part of** (`ownerParts` in `team.mjs`, pure, tested):

- `chats`, and `live`, `runs`, `chat:<id>` and `run:<id>` with them: chats the owner started or was invited to (`inChat(team, chat, "owner")`).
- **A request only the owner can answer** (`permission`, `secure`) still reaches the owner from any chat. While it waits, its chat is listed for the owner, so it is answered where it is; when it is answered the chat leaves the list again. Join requests are the owner's as before.
- `spaces`: the spaces the owner made, and those shared with the owner (a grant for `"owner"`, all members, by link). `panels` and `board`, for older apps, by the same rule.
- `bots`: without a bot a member made (`createdBy` on the bot, stamped by the app for `addBot` and `duplicateBot` from a member), unless a listed chat or a listed space uses it. A bot from before the mark has none and counts as the owner's.
- Everything that is the owner's alone stays as it is: settings, credentials, the team and its management, projects, tasks, devices.

**With Admin mode on:** everything, as before, each member's thing marked with its maker, and "From members" in All spaces.

- `meta.you` for an owner device is `{ kind: "owner", admin: boolean }`. A host from before this says no `admin`, and shows everything.
- `link.team.setAdminMode(on)` → `boolean`: owner only, for the calling device. A member's device has none ("Only the owner's own devices have Admin mode.").
- For the app on the host, whose window has no device: `link.ownerParts(parts)` cuts its own snapshot's lists the same way (`chats`, `live`, `runs`, `bots`, `panels`, `board`, whichever are given), and `link.spacesFor("owner", { admin: false })` answers the owner's spaces without the members'.
- An app from before Admin mode on a new host is an owner device with it off, and cannot turn it on: it lists what the owner is part of until it is updated.
- **Notifications do not change**: they already go only to a chat's or a space's people.
- **Words, both apps:** the switch **Admin mode** in Settings › Team, with the line "See every member's spaces, bots and chats." While it is on, the tag **Admin mode** beside the computer's name.

## Sections on the Chats screen (`chat-sections-v1`)

Asked for by the owner on 2026-11-20: a person makes sections on the Chats screen, and puts a chat in one by a hold and a move, or from the chat's menu.

**A section is a person's own way to group their chats.** Nobody else sees it, and it changes nothing about a chat. So it is kept where a person's other marks on chats are for a member: by the link, in the team (`team.views[person].chatSections`, with `person` `"owner"` or a member's id), for the owner as for a member. The app's workspace knows nothing of it, and the link names the capability.

**What a device is sent**

- `chatSections`: `{ id: string; name: string }[]`, the caller's sections in their order. A part of its own, beside `sections` (which stays the owner's sections for bots on Home).
- `ChatSummary.sectionId?: string`: the section the caller put that chat in. It is the caller's: two people in one chat each see their own, or none. With Admin mode on, a member's chats come to the owner with no section.

**Calls** (the link's; the caller is the person)

| Call | Answer |
| --- | --- |
| `link.chats.addSection(name)` | the new section's id (`cs_` and 11 characters); it goes to the end |
| `link.chats.renameSection(id, name)` | `null` |
| `link.chats.deleteSection(id)` | `null`; its chats stay in the list, in no section. A section that is gone is no error |
| `link.chats.orderSections(ids)` | `null`; the caller's order. Ids they do not have are dropped; a section not named keeps its place after the named ones |
| `link.chats.setSection(chatId, sectionId \| null)` | `null`; one of the caller's chats goes in a section, or in none |

- A name is 1 to 40 characters after trimming, with no control character, and no two of a person's sections share one (compared without case). At most 30 sections a person.
- A chat is in one section or in none. Only a chat the caller is in (started, or was invited to), and only a section of their own.
- A member needs `agents.view`, as for the list itself.
- A chat that is deleted leaves every person's sections. A member who is removed takes theirs along.
- The computer's sentences: "Give the section a name of up to 40 characters.", "You already have a section with that name.", "You have 30 sections. Delete one first.", "This section no longer exists.", "This chat no longer exists."

**For the app on the host**, whose window has no device, the same as methods of `LinkHost`, each taking the person first (`"owner"` for the window): `chatSectionsFor(person)` → `{ list, of }` (`of` is chat id → section id), `addChatSection(person, name)`, `renameChatSection(person, id, name)`, `deleteChatSection(person, id)`, `orderChatSections(person, ids)`, `setChatSection(person, chatId, sectionId | null)`. `LinkHost` emits `"status"` when they change. The desktop app used as a member of another host gets the part and the calls like a phone.

**On the Chats screen, both apps**

- The order: **Pinned**; then each section, in the person's order, with its chats newest first; then the chats in no section by day (**Today**, **Yesterday**, **Earlier**), as now. A pinned chat shows under Pinned, as a pinned bot does on Home. A section shows also when it is empty. While searching, only groups with a match show.
- A hold and a move on a chat drags it: onto a section to put it there, onto a day's group to take it out of its section.
- A chat's menu gains **Move to section**: each section (the chat's own checked), **None**, then **New section…**.
- A section's menu: **Rename…**, **Move up**, **Move down**, **Delete section…**.
- A section folds with a tap on its heading, while the app is open. A folded section opens while a search is on, so its matches show.
- While a chat is dragged and the list has no day's group to drop it on, a place labelled **None** (the menu's word) takes it out of its section.
- A section whose only chats are pinned says "No chats here yet." like an empty one.
- The phone also has a **New section** chip under the search, which makes an empty section; the window makes one from a chat's menu.

**Words. These are final for both apps; they are the words bot sections on Home already use.** "Move to section", "None", "New section…". The prompt: title "New section", line "<chat's title> moves into it.", button "Create section". "Rename section" with "Rename". "Delete “<name>”?" with the line "Its chats stay. They move out of the section." and the button "Delete section". An empty section's line: "No chats here yet." Without the capability the menu has no "Move to section" and the list is as before.

## A project's artifacts (`project-artifacts-v1`)

A project keeps a list of artifacts: `Project.artifacts?: string[]`, artifact ids, newest attached first, at most 200, left out while empty. The computer's app names the capability. Attaching changes nothing about the artifact and gives a bot nothing new.

| Call | Answer |
| --- | --- |
| `addProjectArtifact(projectId, artifactId)` | the list of ids afterwards; one that is there moves to the front |
| `removeProjectArtifact(projectId, artifactId)` | the list afterwards; not attached is no error |
| `projectArtifacts(projectId)` | `{ items: Artifact[] }`, described as `artifacts.list` describes them |

The link cuts each call to a project id (200 characters) and an artifact id or path (4,096). All three are the owner's, like every project call. The computer's sentences: "This artifact no longer exists.", "A project holds up to 200 artifacts. Remove one first.", "Unknown project". An artifact that is gone drops out of the list by itself.

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

## Fast mode (`fast-mode-v1`)

`setModel(scope, id, model, fastMode?)` saves the model and speed together for a chat, bot, or the global default. Omit the fourth argument to preserve the saved speed. Pass `null` to inherit, or `"off"`, `"fast"`, or `"ultrafast"` for an explicit choice. Settings, bots and chat summaries carry the optional `fastMode` independently of their model. A catalog model’s optional `fastModes` maps supported choices to provider tier ids. Clients offer the speed control when the host advertises this capability.

## A bot's Proactive agent (`proactive-agent-v2`)

Experimental. Each proactive bot has its own recipient, managed routine and gate. A clock tick checks for relevant changes and due work without using a model. Hosts with `proactive-learning-v1` also ground suggestions in personal context and learn from ratings.

- **The computer's switch** is a preference: `setPreferences({ proactive: { enabled } })`, the owner's alone (a member's `setPreferences` takes display fields only). Off pauses every bot's agent without forgetting its settings. It takes no other field: an older client that sends `botId` is refused, so the capability is `-v2`.
- **A bot's own settings** are set with `setBotProactive(botId, patch)`: `patch` is `{ enabled?, every?, sweepHours?, maxPerDay?, deliver?, watch?, instructions? }` and changes only what it names, or `null` to forget the bot's settings and routine. It answers the bot's entry (below). It needs `agents.manage` on a bot the role sees. A member's call also needs the agent to be theirs: the person who first sets an agent up is the one it works for (`person`), and another member's call is refused ("This bot's Proactive agent is set up for someone else."). The owner may change any, and forgets one to take it over.
- **The `proactive` part** is `{ enabled, bots: { [botId]: { enabled, person, every, sweepHours, maxPerDay, deliver, watch, instructions, chatId?, pings?, day?, lastSweepAt?, log } } }`. `chatId` is the routine's chat (Check now is `runRoutine(chatId)`); `log` holds the last wakes, newest first (`{ at, reason, signals, outcome, runId, said? }`). A bot that was never set up has no entry: read it as off, with the usual settings. Decode tolerantly, the entry may gain fields.
- **A member is sent** the switch, the whole entry of each bot their role manages whose agent is theirs (without `person`, and with `mine: true`), and for a bot whose agent is another person's only `{ enabled, taken: true }`. Never the owner's or another member's settings, rules or log.
- **Whose agent it is.** A member's agent hears only of runs and questions in chats that member is part of, for bots their role sees. It never hears of the owner's tasks or of approvals and secure inputs (only the owner answers those), and it never looks around the computer's own tools and accounts (`sweepHours` stays 0, `tasks` is not watched). Its routine and chat are the member's (`createdBy`), and its alerts are a message in that member's chat with the bot (`deliver: "chat"`) or a card in that member's own Feed (`deliver: "feed"`, with `today` view). It pauses while the member's role stops managing the bot. The owner's agent hears of the owner's own chats and of what only the owner can answer.

With `proactive-learning-v1`, `watch` also accepts `context`. This enables wakes on changes to personal context and a one-shot review of evidence at a later time. A review runs on the first eligible tick after the requested instant. A check can use the bot's recent private conversations with its recipient and their open goals with that bot. Only the owner's agent receives the bot's saved memory, USER.md preferences and enabled read connectors. Existing saved watches retain their selections.

The bot returns up to four proposals with evidence references. The host chooses the highest-scoring eligible suggestion, withholds repeats, and can stay quiet. Each entry may include `nextReviewAt`, `learning: { rated, preferred, retired, evaluation? }` and `log[].score` (0–100). Additional wake reasons are `context` and `review`. `evaluation` gives the training and held-out sample counts (`trained`, `tested`), the mean squared errors of the default, incumbent and challenger (`baseline`, `previous`, `challenger`) and whether the challenger was `promoted`. The host keeps raw evidence and individual training examples out of this part.

Existing `reactToMessage` and `boardAct` calls handle feedback at the delivery site. The host links the delivery to its run and uses only the intended recipient's thumbs. A changed rating replaces the previous label. A neutral chat reaction or a removed Feed vote clears it. A shared Feed receives personal suggestions through a private chat instead. Forgetting the bot's proactive settings clears its learning state.

### Several people, setup and offers (`proactive-team-v1`)

A bot looks out for several people. What they share is the bot's: `enabled`, `every`, `sweepHours`, `maxPerDay`, `deliver`, `watch`, `instructions`, and `setUp`. Each person has an entry of their own in `people: { [personId | "owner"]: { on, notify } }`. Each person gets their own check with only what they may see, their own managed routine ("<Bot> looks out for <person>"), their own gate state and their own delivery.

- **Privacy.** An alert built from one person's evidence goes only to that person. A member needs `agents.view` and the bot in their role's allowlist at check time and at delivery. `notify: false` still delivers it to their chat or Feed, with no notification on the computer or on a phone. Alert chats cannot be shared, and if the owner sees a chat only to answer a request, its Proactive alerts are left out.
- **On from the start, but set up first.** The computer's switch (`settings.proactive.enabled`) is on by default. A bot's agent never wakes until `setUp` is true, which the setup steps save together with `enabled: true` and the people they turned on. A host that had the one-person shape brings it over once: the person becomes `people`, the computer's switch becomes on, and only a bot that was really running counts as set up.
- **`setBotProactive(botId, patch)`** takes `setUp` and `people` too. In `people` an entry changes only what it names, a new person starts on and notified, and `null` takes a person out. The host checks who calls (`link-host/proactive-rules.mjs`, the same rule in the app and in the demo computer):
  - The owner changes anything, and adds or takes out anyone whose role sees the bot. `null` as the patch forgets the bot's settings, everyone's state and every routine.
  - A member reaches the call when their role sees the bot. They change only their own entry, and add themselves only when their role manages the bot. Such a role may also save the setup steps and change what the people share, but never look-around (`sweepHours`), the tasks watch, or the owner's pause. Turning the bot off sets `pausedBy: "owner"` in the shared settings; only the owner can turn it on again. A member can still save setup choices without resuming it. A member's `null` takes only that member out.
- **The `proactive` part.** An owner device is sent every entry of `people`, the owner's own activity (`chatId`, `pings`, `day`, `lastSweepAt`, `log`, `nextReviewAt`, `learning`) beside the settings, and, with Admin mode on, each other person's under `activity: { [personId]: … }`. A member is sent, for each bot their role sees, the shared settings, only their own entry in `people`, and their own activity in the same place the owner's is. `person` and `taken` are gone.
- **An alert's actions.** A delivered alert carries `alert: { runId, offer?, chosen? }` on its chat message or its Feed card (`BoardItem`), beside `proactiveRunId`. `offer` is a short label of the one thing the bot offers to do; the request behind it stays on the host. `proactiveAct(botId, runId, "take" | "later")`:
  - `"take"` starts a normal turn in a new private chat titled with the offer's label, with only the offer's request as the person's message, and answers `{ chatId }`. The turn has the chat's usual tools and approvals: an alert never approves anything ahead of time. The check itself stays read-and-draft. Starting a turn is chatting, so a member's role needs `agents.chat` for it (`"later"` needs only to see the bot). The alert is marked once the turn has started, so a start that fails can be tried again.
  - `"later"` holds what the alert was about back across all the recipient's bots for 24 hours and answers `{ until }`.
  - Only the person the alert was for has it: anyone else is told "This alert is no longer available." An alert is acted on once (`chosen`).
- **More signals**, with no model: a routine or task run that failed in the last 24 hours, and a turn that stopped with steps of its plan left (`run.stoppedOpen === true` and `run.plan.open`, both optional), while it is the last thing that happened in its chat.
- **Notifications.** An alert's notification is titled with the bot's name alone, and its text is the alert's first line. The managed routine's name is never a title. A sealed alert that offers something also carries `a: { b: botId, r: runId }`, and the phone shows one button, "Take care of it"; a tap opens the alert. A check that failed sends nothing.
- **Reminders** need no Proactive agent and no model. When a question or approval stays open for 15 minutes, a routine or task run ends needing the person, or a turn stops with steps left, the person it waits on gets one plain notification: "Patch is waiting on your answer", "Patch stopped with 2 steps left". Once for each thing, held during quiet hours, at most six a day for each person, and never for a thing one of their own bots already alerted them about (a bot that watches for it gets its turn first). The app lists what it sent in the last few minutes in its snapshot (`reminders`, never a part), and the link sends each to that person's own phones that have "A bot needs me" on, sealed, with `k: "reminder"`. One switch: `settings.notifications.reminders` (on by default), shown under Notifications in both apps.

## What differs for a desktop client

- **Notifications.** A desktop client does not register for push (`link.push.register` is for phones). It should call `link.push.presence(active, chatId?)` when its window comes to the front, goes away, or shows another chat. While a desktop client is in front, the host treats it like its own window: a reply in the chat on that screen sends no notification to a phone.
- **Tools on the device.** `link.device.*` (calendar, contacts, Health, location, photos, Apple Music, mail) are for phones. A desktop client sets no sources and answers no asks.
- **The screen.** `link.screen.*` shows the host's screen. A desktop client may use it under the same rule as a phone (the host's person allows view or control).
- **Secrets.** As for a phone: a client saves a credential or links a field, then sends `{ $credential: id }`. No call returns a secret.
- **Which host is in use.** Show `meta.name` (the host's name) wherever the client shows data from a host, and let the person switch between "This Mac" and each paired host. Keep one `Pairing` and one `LinkClient` for each host.

## Gadgets (`gadgets-v1`)

A gadget is a small device with a microphone, a speaker and maybe a screen that talks with a bot. It is a client of kind `"gadget"`, and the owner's, like the owner's phone. Its whole contract, with the link's bytes for firmware that has no client library, is `gadget/docs/contract.md`. What a client of the other two kinds needs to know:

- **A gadget is paired by introduction, with no code.** An owner device that read a gadget's public key (over a cable, or Bluetooth) calls `link.gadgets.add({ publicKey, name?, board?, botId? })` and hands the answer, `{ deviceId, serverId, serverKey, name, hosts }`, to the gadget. It is the owner's call only. The app on the host does the same with `link.addGadget(…)`.
- **It is in the device list** with `kind: "gadget"`, `platform: "esp32"` and `gadget: { board?, firmware?, botId? }`. Rename and remove work as for any device. Show it as a gadget, not as a phone.
- **Its chats are the owner's own chats.** A phone lists them, opens them and answers in them like any other.
- **A gadget follows two parts, `meta` and `gadget`,** in place of the app's parts, and makes its own calls (`link.gadget.*`). Those are refused for a phone or a desktop ("Only a gadget can do that.").
- **Its settings are the owner's to change from a client** (`gadget-settings-v1`): `link.gadgets.configure(id, patch)` (volume, microphone, mute, brightness, the screen's timers, the bot) answers the device list; `link.gadgets.wifi(id, { add: { ssid, password } } | { forget: ssid })` answers `{ queued: true }` and the gadget takes it within 10 minutes; `link.gadgets.restart(id)`. The device list's `gadget` carries `settings`, the gadget's own `wifi` report (names, never a password), `wifiWaiting` and `restarting`. The values and their rules: `gadget/docs/contract.md`, "Settings". The app on the host does the same with `link.configureGadget`, `link.gadgetWifi` and `link.restartGadget`.

## The relay

Away from the host's network a client goes through the relay (`relay.botkins.app`). The host lists it as one more address, `relay!<room>@<host>`, and `relayFetch` carries the same sealed requests over a socket. The relay sees sizes and timing, never contents. A room takes 16 client sockets at once (8 from one address). The relay is off until the person turns it on on the host.

### Following through the relay (`sync-push-v1`)

A client that receives this capability in `meta` and can receive intermediate relay frames calls `link.follow` on its relay route. Its argument is the `link.sync` argument without `wait`, including the versions, watches, append cursors, reasoning watches, text mode and step detail. Direct clients and clients without both capabilities poll. A host with this feature paces relay poll news at 250 ms per session. Chunked text retains its sentence and hold timers.

The phone sends the ordinary sealed RPC request. Each intermediate frame from the computer is `[conn 8][0x07][request ID u32][counter u64][sealed news]`. The relay strips the connection prefix. The request stays pending until the usual `0x02` final answer. All integers are big-endian. The decrypted part is a sync result with `epoch`, `v` and `parts`.

The computer seals each part with the session's computer-to-phone key. Its nonce is the four bytes `01 00 00 00` followed by the clear counter's eight bytes. The counter starts at one and increases across all follows under that key. Both endpoints limit it to the positive safe-integer range. RPC answer nonces start with four zero bytes. The UTF-8 associated data is `push:<session id>:<RPC sequence in decimal>:first` for the first frame and ends in `:more` for later frames. The client authenticates this label using the sequence of its own follow RPC. The first counter must exceed every previously accepted counter for that session. Later counters must be consecutive. A missing first frame, replay, gap or authentication failure starts a fresh follow from the client's actual versions and cursors.

The first available news goes immediately. Subsequent frames coalesce changes at 100 ms intervals. After a send the host advances the follow's versions and cursors. A backed-up socket holds the changes at the host. At 25 seconds of silence the host sends an empty sync result. At four minutes it finishes the call and the client renews it. After 40 seconds without a part or final answer the client uses its ordinary sync timeout recovery.

A new follow or sync replaces the session's follow. On rest, stop or departure for a direct connection the client sends a best-effort `link.unfollow` with no arguments. Waking first proves the path with a short-deadline `link.sync` and `wait: 0`. Closing either socket, reseating, ending the session or stopping the host releases the follow. The host deduplicates replayed requests and caches only final answers.

## Upgrades

- `link.json` is version 1 and has not changed shape. A device paired before `kind` existed gets its kind from its platform when the file is read. No device has to pair again.
- A host without `devices-v1` has no `link.devices.*` calls and no `kind` in `phones`. A client then shows only itself.
- A host without `device-person-v1` ignores `person` and has no `link.devices.setPerson`; a client offers only Rename. A device paired before has no `person` until the owner adds one.
- A host without `member-rename-v1` has no `link.team.renameMember(memberId, name)` (owner only; the name has the rules of a team's name: trimmed, 60 characters at most). A client leaves Rename out of a member's menu. Its rules are in `TEAMS.md`.
- When this contract changes, the change is made here first, then in `link-host/` and `src/link/` together, with a test in `tests/devices.test.ts` or `tests/link.test.ts`.

## Pull request panel (`pr-panel-v1`)

An owner can open a github.com pull request from any readable repository. The host uses its signed-in GitHub CLI. The project picker continues to use `link.pullRequests({ chatId }, query?)` under `prs-v1`.

- `link.pullRequest({ url })` returns `{ available: true, pull }`. The list item's fields are joined by `body`, `createdAt`, `checks: [{ name, result }]`, overall `summary`, `review` and `files: [{ path, additions, deletions }]`.
- `link.pullRequestDiff({ url, path })` returns `{ available: true, text }` for the selected changed file. Tool output is limited to 1 MiB and a displayed patch to 128 KiB and 3,000 lines.
- An unavailable read returns `{ available: false, reason }`. Both reads accept the overview, files and commits URLs and fragments. They time out after 15 seconds and cache answers for 30 seconds. Members cannot call either method.

## Skill uploads and the skills.sh catalog

With `skill-upload-v1`, `skills.upload({filename, data, replace?})` accepts one Markdown or zip file. `data` is standard base64. The computer accepts up to 3 MiB before encoding, 12 MiB unpacked, 512 archive entries and 24 skills. It checks paths and file types, imports the folders and enables the skills. The result is `{added: string[], conflicts: string[]}`. A conflict leaves the batch untouched. Ask the person, then repeat with only the approved names in `replace`.

With `skills-catalog-v1`, the computer makes these calls available:

- `skillsCatalog.search(query)` takes 2–200 characters and returns up to 40 rows sorted by installs. Each row has `id, source, skillId, name, installs, available` and an optional installed skill name in `installed`. The computer caches successful searches for two minutes.
- `skillsCatalog.preview(id)` reads a GitHub skill and returns `{name, description, text, token, installed?}`. Domain sources open at `https://skills.sh/<id>`.
- `skillsCatalog.install(token, replace?)` imports the files pinned by the preview and returns the upload result. The preview token expires after ten minutes.

With `skills-featured-v1`, `skillsCatalog.featured()` returns the featured shelf: upstream skills pinned to a commit (`desktop/skills-featured.mjs`), each `{id, name, summary, group, author, license, repo, commit, path, url, pack?, installed?}`. The id is `owner/repo/skill@commit7`; preview and install it with `skillsCatalog.preview` and `skillsCatalog.install` like a skills.sh one. Its preview reads the tree at `commit`, never HEAD, and also returns `source` (the fields above) and `files`. The skill's license file goes with it: one that sits outside the skill's folder (pstack's) is installed as `LICENSE`, and a skill whose license is missing at that commit is not installed.

With `mcp-catalog-v1`, the direct apps catalog (`desktop/mcp-catalog.mjs`):

- `mcpCatalog.list()` returns `{entries, categories}`. An entry has `id, name, category, categoryName, description, transport ("http" | "stdio"), auth ("none" | "oauth" | "key"), keys: [{id, label, hint?}], docs, icon: {letter}`, then `url` for http, or `package, version, license, command, env` for stdio (`command` is the exact line, `env` the names of the values it gets), and `local` for a server another app runs on the computer. Its state: `added`, and when added `serverId, serverName, enabled`, `signedIn, signingIn` (oauth) and `keysSet` (key). An entry never holds a key's value, or where a key goes beyond the names in `env`.
- `mcpCatalog.add(id, {keys?, confirm?})` adds the entry as a tool server, or, when it is already added, sets the keys given again (a key left out is kept). `keys` maps each key's `id` to the value typed; values go to the vault through `saveMcpServer`'s path and are never sent back. A stdio entry needs `confirm` equal to its `command`, which the client has shown and the person said yes to. It returns `{serverId, next}`: `"sign-in"` when the browser sign-in is next (`signInMcpServer(serverId)`), else `"done"`. The link refuses a saved credential's reference in `keys`. A server the person added by hand at the same address, or with the same npm package, counts as the entry.

The list needs the team's Tools view permission. Adding is the owner's.

Search and preview need the team's Skills read permission. Upload and install need create permission, and confirming replacement also needs manage permission. Phones use the link for every file and catalog operation.

## Project folders, modes and GitHub

These calls are owner-only. A computer advertising `project-folders-v1` sends `project.folders`, an ordered list of up to 12 absolute paths. The first is also `project.folder` for older clients. An empty list omits the legacy field. A chat can carry a non-default `folder`. If it disappears, the computer uses the first folder that the project designates as default.

| Call | Answer |
| --- | --- |
| `editProjectFolder(id, "add" / "remove" / "default", path)` | Updated ordered paths |
| `chatProjectFolder(chatId)` | Effective working folder, or null |
| `setChatFolder(chatId, pathOrNull)` | Void. Null selects the default |
| `startProjectChat(botIds, id, mode?, folder?)` | New chat ID |
| `setChatProject(chatId, idOrNull, mode?, folder?)` | Void |
| `projectChanges(id, folder?)`, `projectDiff(id, file, folder?)`, `projectCommit(id, message, folder?)` | Existing changes, diff and commit answers for the chosen folder |

With `project-mode-v1`, `updateProject(id, { mode })` saves Plan or YOLO and clears the preference for Default. Starting or assigning a chat inherits the preference when the caller omits the mode. Changing a started chat's project or working folder carries its transcript into a fresh provider session. A reply in progress must finish first. Group chats use folderless projects.

With `project-clone-v1`, `cloneProjectRepository(repository, parent?, projectId?, { name?, description? }?)` returns the project ID after the computer has cloned the repository. Omitting the project ID creates a project. The destination is the repository name under the supplied parent or the host user's home directory. It must be new or empty. The computer uses its signed-in GitHub CLI for private repositories and falls back to HTTPS Git for public ones. The link validates a supplied parent through its folder browser.
