# Spaces: pages of panels, private or shared (`spaces-v1`)

A **space** is a named page of panels on a host. A person makes one, keeps it private, or shares it: with members they pick, with all members, or with anyone who has a link. Today, Feed, Ideas and Goals stop being parts of one Today page and become spaces themselves.

This file is the contract every part builds against: the app on the host (`desktop/desktop/`), the link host (`mobile/link-host/`, copied to `desktop/desktop/link/`), the relay (`mobile/relay/`), the client library (`mobile/src/link/`), the desktop window (`desktop/src/`) and the phone app. It builds on `TEAMS.md` (`teams-v1`, `team-people-v1`); read that first. The pictures both apps follow are in `design/mockups/spaces.html` of the phone's working folder (10 screens, approved by the owner on 2026-11-20).

Written 2026-11-20 against `origin/main` at `42c6445`, and reviewed once against that code. The Mobile thread owns this file: a change goes to it first, then to every side.

**Built so far (2026-11-20):** the link host's half and the demo computer (`spaceCan`, `spaceView`, the checks, the cut of what each device is sent, `link.spaces.*` without publishing, each person's view). Not built yet: the app on the host, the relay's routes and page, publishing a link's copy, notifications, both apps' screens.

## Decided by the owner (2026-11-20)

1. People make their own spaces. A space is private until its maker opens it and uses Share.
2. Share has four levels: private (only its maker), members the maker picks, all members, anyone who has the link.
3. A shared space lives on the host it was made on. Others reach it there. It is never copied to a phone or to another computer.
4. A member is a member of the host's team (`TEAMS.md`). "Permissions within that team/group/etc apply."
5. A link opens as a web page through the relay, for anyone, member or not.
6. A panel is refreshed by the bot assigned to that panel or its routine.
7. Panels hold apps (custom views, `html` blocks), not only text.
8. A space or a panel can be attached to a project.
9. Spaces can be pinned and put in order by each person. Panels can be moved and resized.
10. Today, Feed, Ideas and Goals each become a space.

**One choice here is this contract's, not the owner's, and the owner has been asked:** the host's owner can open every space on their host, a member's private one included. `TEAMS.md` already lets the owner read every member's chat, and a member's panel is built in such a chat, so a space the owner could not open would be a promise the host does not keep. "Private" therefore means: no other member. If the owner decides otherwise, the change is in `spaceCan`, and then `panels`, `board`, `spaces`, the frame calls, a space's chats and its refresh alerts all need a cut for owner devices too.

## Words

- **Person**: the owner (id `"owner"`) or a member (their member id), as in `team-people-v1`.
- **Maker**: the person who made a space.
- **Built-in space**: one of the four every person has: Today, Feed, Ideas, Goals.
- **Card**: an item in Feed, Ideas or Goals (today's `BoardItem`).
- **App panel**: a panel with at least one `html` block.

## What is kept, and where

Content is the app's. Who may open it, and each person's own view, are the link's. This is the split `team-people-v1` made for chats.

**In the workspace** (the app, `workspace.json`):

```ts
type SpaceRecord = {
  id: string;                                   // "s_" + 10 base32 chars
  name: string;                                 // 1–40 chars
  builtin?: "today" | "feed" | "ideas" | "goals";
  createdBy?: string;                           // a member's id. Absent: the owner made it.
  projectId?: string;                           // the owner's spaces only
  createdAt: number;
  updatedAt: number;                            // the last change to the space or to anything in it
  rev: number;                                  // goes up with every such change
};
```

A `Panel` gains:

```ts
spaceId: string;
createdBy?: string;                             // the person who asked for it, when a member
state?: Record<string, unknown>;                // an app panel's saved state (see "App panels")
stateRev?: number;
notes?: { id: string; by: string; name: string; text: string; at: number }[];
last?: { by: string; name: string; label?: string; at: number };   // the last change a person made
```

A panel's routine gains `setBy?: string` (the member who last set it). A `BoardItem` gains `spaceId`. A panel's place in its space is its place in `state.panels` among the panels of that space.

**A bot's panel key is unique within a space, not within the workspace.** A panel is found by `(botId, spaceId, key)`. Today it is `(botId, key)`, which would let a bot in one person's chat read or overwrite its panel in another person's space.

**In the link's store** (`team`, never in the workspace):

```ts
team.spaces[spaceId] = {
  access: "private" | "members" | "team" | "link";
  grants: { id: string; can: "view" | "edit" }[];   // access "members": person ids, "owner" allowed
  teamCan: "view" | "edit";                          // access "team" or "link": what every person may do
  share?: { id: string; salt: string; key: string; createdAt: number; putAt?: number };   // the link, see "Share by link"
};
team.spaceCopies: { id: string; relay: string }[];   // copies still to delete from a relay
team.linkSharing: boolean;                           // "Members may share by link". Off at first.
team.views[person].spaces = {                        // for every person, the owner too
  order: string[]; pinned: string[];
  seen: Record<string, number>;                      // space id → when the person last opened it
  notify: Record<string, "off" | "daily" | "all">;
};
```

A space with no entry in `team.spaces` is private.

**Limits.** 60 spaces a person. 40 panels a space (panels already over that after the move are kept; no new one is made until there is room). 50 notes a panel, 2000 characters each. A panel's state: 64 KiB of JSON, 200 top-level keys. 60 grants a space.

## Who can do what

`spaceCan(team, space, person)` in `team.mjs` (pure, tested) answers `"own"`, `"edit"`, `"view"` or `null`. The link host, the window and the app all use this one function.

- The maker (`createdBy`, or the owner when there is none): `"own"`.
- The owner: `"own"` for every space on the host.
- `access: "members"`: a person with a grant gets that grant's `can`.
- `access: "team"` or `"link"`: every person gets `teamCan`.
- Anyone else: `null`. The space does not exist for them: it is in no part, and a call that names it, one of its panels, one of its cards or one of its custom views fails as an unknown id does.

**A member's role applies on top**, own spaces included. The scope key stays `today` so saved roles keep working. Its label becomes **Spaces**.

| A member wants to | Needs from the space | Needs from the role |
| --- | --- | --- |
| see spaces at all, open one, pin, order, set "Notify me" | to open it | `today.view` |
| act in one: mark or rate a card, refresh a panel, change an app panel's state, write a note, ask a bot from it | `"own"` or `"edit"` | `today.use` (asking a bot: also `agents.chat`) |
| make a space | | `today.create` |
| make a panel | `"own"` or `"edit"` | `today.create` and `agents.chat`; with a refresh, also `today.manage` |
| change one: resize or hide a panel, put panels in order, set a routine | `"own"` or `"edit"` | `today.manage` |
| rename a space | `"own"` | `today.manage` |
| move a panel to another space | `"own"` on the space it leaves, or be the panel's `createdBy`; `"own"` or `"edit"` on the one it enters | `today.manage` |
| widen who can open it | `"own"` | `today.manage`; a link also needs `team.linkSharing` |
| narrow who can open it | `"own"` | nothing: a maker can always take sharing back |
| delete a space | `"own"` | `today.delete` |
| delete a panel, a card, a routine | `"own"` or `"edit"` | `today.delete` |

- A grant never widens a role. A member whose role lacks `today.view` cannot be picked: "That person's role can't open spaces. Change their role in Team settings first."
- A member is sent a panel or a card only when its bot is visible to their role, as now.
- Projects stay the owner's. A member never sets or is sent `projectId`.
- A bot's turn works for people: the chat's starter and the person who sent the message. Its panel tools see only spaces both can open, and write only to spaces both can change (`narrower`, as `team-turn.mjs` does for limits).

**Chats that belong to a space.** A chat started by `spaces.newPanel` or `spaces.ask` is its starter's (`createdBy`, as `createChat` stamps). A panel's refresh chat is made with `createdBy = panel.createdBy`, so its alerts go to that chat's people and not to the owner by default. `chatFor` (`frames.mjs`) makes no chat for a read.

**Whose limits a refresh runs under.** Every refresh, by hand or by routine, runs as the panel's bot under the narrower of the limits of the panel's `createdBy` and of the person who pressed Refresh or last set the routine (`setBy`). So a member who writes a routine's prompt on the owner's panel never gets the owner's tools.

**When a member is removed**, the spaces they made pass to the owner (`createdBy` is dropped) and become private; their link copies are deleted; routines they set are paused; their grants and their view go. Their notes stay, with their name.

**When a member's role changes**, the next part they are sent and their next call follow the new role. A link they made stays until its maker or the owner narrows it.

## Built-in spaces, and what exists today

- Every person has the four built-in spaces. The link host asks the app for them (`spaces.ensure(person)`, host-side, safe to repeat) the first time that person's device is sent parts and their role has `today.view`. They cannot be renamed or deleted. They can be pinned, unpinned, put in order and shared like any other.
- Another person's built-in space is named with its maker: "Maya's Today". The apps build that from `by.name`; the record's name stays "Today".
- Today holds panels. Feed, Ideas and Goals hold cards of that kind, and may hold panels too.
- **Moving what exists.** On first start with this version, the app puts every panel in the owner's Today and every card in the owner's Feed, Ideas or Goals by its kind. The link host, the first time it sees an app with `spaces-v1` (`team.spacesMoved` is unset), shares the owner's four built-in spaces with all members (`access: "team"`, `teamCan: "edit"`) if the team has a member, so no member loses what their role shows them now. With no member they start private, and stay private when a first member joins later. The owner's pinned row starts as Today, Feed, Ideas, Goals.
- **Where a bot's work lands.** `board_post` puts a card in the Feed, Ideas or Goals of the chat's starter. `today_publish` with no `space` puts a new panel in the space the chat was started from (`spaces.newPanel`, `spaces.ask`), else in the starter's Today.
- **A card's marks are the space's.** `status`, `rating`, `answer` and `snoozedUntil` are one value for everyone who can open that Feed, Ideas or Goals, as a shared list's ticks are. An app that knows spaces marks a card "New" from `seenAt` (below), not from the card's `read`.

## Panels in a space

- A panel keeps everything it has: its bot, its blocks, its size (Small, Wide, Tall), its routine, its refresh chat, its project.
- **Its bot refreshes it** (see "Whose limits" above).
- **Order.** `changePanel`'s `earlier` and `later` swap a panel with the one before or after it **in the same space**. `spaces.movePanel` puts it anywhere.
- **Hidden** is the panel's, for everyone. A hidden panel is listed under "Hidden" for people who can change the space, and is never in a link's copy.
- **New panel.** `spaces.newPanel` starts a chat with the chosen bot, in that space, and sends the person's sentence as `/today-panel` does now. The apps open that chat, as now. `start` only adds one line to the request ("Make it a checklist."). `refresh`, when given, becomes the panel's routine as soon as the bot first publishes from that chat, with the person's sentence as its prompt.
- **Ask about this space.** `spaces.ask` starts a chat with the chosen bot in that space. The bot is told the space's name and its panels' titles and keys, and may read them with `today_list`. With `panelId`, the ask is about that panel ("Ask Pip to change it").
- **Bot tools.** `today_list`, `today_publish`, `today_routine` and `today_remove` take an optional `space` (an id or a name) and follow "A bot's turn works for people" above. Publishing a key that exists only in another space makes a new panel. A new tool `space_list` names the spaces the turn's people can open. `today_list` with `full` also answers a panel's `state`.
- **A bot is deleted.** Its panels go, in every space, as now. Each such space's `rev` goes up and its link copy is put out again.
- **Notes.** People who may act in a space write short notes on a panel. A person removes their own notes. The maker and the owner remove any.
- **The last line.** When a person changes a panel's state or writes a note, the app sets `last`. The apps show "Maya ticked Press kit · 2m" (`name`, then `label` with a small first letter), or "Maya changed this · 2m" without a label. `label` is the page's own words: plain text, at most 80 characters.
- **A view's answer.** In a panel of a space, `sendAnswer` puts the text in the message box of an ask about that panel (`spaces.ask` with `panelId`); it is never sent by itself, and never to another person's chat.

### App panels: saved state

Today a custom view can only hand text to the message box. An app that people use together needs to keep what they did. The bridge (`window.botkins`, the same on the desktop, the phone and the web page) gains:

```js
botkins.state.get()                 // Promise<object>: the panel's state, {} when none
botkins.state.set(patch, label?)    // Promise<boolean>: merges top-level keys; null removes a key
botkins.state.onChange(fn)          // fn(state) when someone else changed it; returns a function that stops it
```

- `set` is a shallow merge on the host, so two people ticking different items do not undo each other.
- It needs the right to act in the space. Without it, and on the web page, `set` resolves `false` and nothing is saved.
- **A page cannot save by itself.** The app that shows the view passes a `set` on only within 3 seconds of a touch, click or key press in that view, and at most one a second. So a page cannot write under a person's name when they only opened it.
- Only a panel's own views get its state. A custom view in a chat has none: `get` answers `{}` and `set` answers `false`.
- A bot's `today_publish` keeps the state unless it passes `state`.
- The `today-panel` skill teaches bots to keep what people change in `botkins.state`, and to pass a short `label`.

## What each device is sent

**The `spaces` part**: the spaces the person can open, in that person's order (pinned first, in pinned order; a space new to the person goes last, unpinned).

```ts
type SpaceSummary = {
  id: string; name: string;
  builtin?: "today" | "feed" | "ideas" | "goals";
  by: { id: string; name: string };              // the maker
  mine: boolean;
  access: "private" | "members" | "team" | "link";
  can: "own" | "edit" | "view";                  // from spaceCan. A member's role narrows what each allows (team.me).
  people?: { id: string; name: string; can: "view" | "edit" }[];   // access "members"
  teamCan?: "view" | "edit";
  link?: string;                                 // to the maker and the owner
  projectId?: string;                            // owner devices only
  count: number;                                 // panels and open cards the person is sent
  changed: number;                               // of those, changed since the person last opened it (99 at most)
  pinned: boolean;
  notify: "off" | "daily" | "all";
  here: { id: string; name: string; panelId?: string }[];   // other people looking at it now
  rev: number; updatedAt: number;
};
```

- The app's snapshot names each space with what the link needs to count: `SpaceRecord & { items: { id: string; botId: string; updatedAt: number }[] }`. The link host turns that into `SpaceSummary[]` for each person (`spaceView` in `team.mjs`, pure). `filterParts` starts from a copy of every part, so the raw `spaces` part must be replaced there by name. The owner's parts are not filtered today (`viewParts` returns them as they are), so the owner's `spaces` is built there too. A test fails when anyone is sent a space `spaceCan` refuses them, or the raw part.
- **A space's content** is asked for, not pushed: `spaces.read(id)` answers `{ id, rev, seenAt, panels: PanelView[], cards: BoardItem[] }`. An app reads again when the `rev` in the `spaces` part passes the one it holds. `seenAt` is when the person last opened it before this read.
- **`PanelView`** is a `Panel` without `lastWriter`. For a member it is also without `projectId`; without `chatId` and `refreshChatId` unless they are in that chat; and without `routine.prompt` unless they may change the space. The same cut applies to `panels` below.
- **Custom views.** `link.frame.page` and `link.frame.chat` look up the view's panel, then its space, then `spaceCan` for the caller. The check must not search a part's JSON for the id: with state and notes in a panel, a person could write an id there.
- **`panels` and `board` stay**, for apps that do not know spaces: the panels of every Today, and the cards of every Feed, Ideas and Goals, that the person can open. An app that sees `spaces-v1` ignores both.

## Calls

**The app's** (in `REMOTE_METHODS`, each with its shape cut in `methods.mjs`; the link host checks each against `spaceCan` and the role in `authorize`, with a `space` lookup; the app is handed the person, as `send` is handed its author):

| Call | Does |
| --- | --- |
| `spaces.read(id)` | the content, see above |
| `spaces.create({ name })` → id | a new private space, pinned for its maker |
| `spaces.rename(id, name)` | not a built-in |
| `spaces.remove(id)` | the space, its panels, their routines, refresh chats and views. Not a built-in. |
| `spaces.setProject(id, projectId \| null)` | attach a space to a project. Owner only. |
| `spaces.setPanelProject(panelId, projectId \| null)` | attach one panel. Owner only. |
| `spaces.newPanel({ spaceId, botId, prompt, start?, refresh? })` → `{ chatId }` | `start`: `"checklist" \| "tracker" \| "chart" \| "table" \| "notes" \| "app"`. `refresh`: `{ cron, timezone }`. The bot must be visible. |
| `spaces.ask({ spaceId, botId, text, panelId? })` → `{ chatId }` | the bot must be visible |
| `spaces.movePanel(panelId, { spaceId, before })` | `before`: a panel id, or `null` for the end |
| `spaces.patchState(panelId, patch, label?)` → `{ rev }` | see "App panels" |
| `spaces.note(panelId, text)` → id, `spaces.removeNote(panelId, noteId)` | |

`changePanel`, `routine`, `refreshPanel` and `boardAct` keep their shapes and their role rows. Each now also needs the space of its panel or card (`"own"` or `"edit"`).

Host-side only, never remote, on `backend.spaces`: `ensure(person)` (the four built-in spaces, safe to repeat), `release(person)` (a member was removed: `createdBy` is dropped from what they made and the routines they set are paused) and `snapshot(id)` (the copy for a link).

**The person of a call.** The link host hands every app call its principal, as it does for `send`: `backend.call(method, args, { principal })`, with `principal.kind` `"owner"` or `"member"` (then `memberId`, `name`). The app stamps `createdBy`, a note's `by` and `name`, and `last` from it. The link has already checked who may make the call.

**What the link adds to an answer.** `spaces.read` answers `{ id, rev, panels, cards }` from the app; the link host cuts the panels and cards for the person (`PanelView`, bots the role sees) and adds `seenAt`. After `spaces.create` the link host pins the new space for its maker. After `spaces.remove` it drops the space's sharing.

**The link's** (handled by the link host, as `link.team.*` is; the window calls the same functions host-side):

| Call | Does |
| --- | --- |
| `link.spaces.share(id, { access, grants?, teamCan? })` → `{ link? }` | `"link"` makes a link if there is none, and keeps what members could do (`teamCan`) unless one is given. Going back to a narrower level deletes the copy from the relay. A grant for the maker, or one named twice, is dropped. |
| `link.spaces.newLink(id)` → `{ link }` | A fresh link. The old copy is deleted. |
| `link.spaces.arrange({ order, pinned })` | The caller's own order and pins. Ids the caller cannot open are dropped. |
| `link.spaces.seen(id)` | The caller has seen it now. |
| `link.spaces.notify(id, mode)` | The caller's "Notify me" for that space. |
| `link.spaces.here(id \| null, panelId?)` | The caller is looking at this space (and this panel) now. Sent when it comes into view, every 30 seconds while it stays, and with `null` on leaving. Forgotten after 75 seconds of silence. Kept in memory only. |
| `link.team.setLinkSharing(on)` | Owner only. Whether members may share by link. |

**For the app on the host** (its own window has no device): the same as methods of `LinkHost`, each taking the person first (`"owner"` for the window): `spacesFor(person)` → `SpaceSummary[]`, `spaceCan(spaceId, person)`, `shareSpace(person, id, input)`, `newSpaceLink(person, id)`, `arrangeSpaces(person, input)`, `seenSpace(person, id)`, `notifySpace(person, id, mode)`, `hereInSpace(person, id | null, panelId?)`, `setLinkSharing(on)`. `LinkHost` emits `"status"` when a list changes.

**Sentences the link answers with**, shown as they come: "This space no longer exists.", "This panel no longer exists.", "This item no longer exists.", "You can look at this space, not change it.", "Only the person who made this space can do that.", "The owner hasn't turned on sharing by link for members.", "Turn on the relay on your computer to share by link.", "That person's role can't open spaces. Change their role in Team settings first.", "That person is no longer on the team.", "This space isn't shared by link.", "Choose who can open this space.", "Choose Off, Once a day or Every change."

Every name in these two tables has an entry in `TEAM_METHODS`. The test that exists covers `REMOTE_METHODS` only, and a missing `link.*` name quietly becomes owner only, so a new test lists both tables.

## Share by link

The host publishes a sealed copy of the space to the relay. The page a link opens reads that copy. **Nobody without a pairing ever reaches the host**: the link gives no call into it, only a copy that the host chose to put out.

- **Who.** The maker or the owner. A member also needs `today.manage` and the owner's switch "Members may share by link" (Settings › Team, off at first). The owner sees every link-shared space, since the owner can open every space.
- **Before it is made** the app asks: "Anyone with the link can see everything on this space. They can't change it." Moving a panel into a link-shared space asks too: "Anyone with the link will see this panel."
- **The link**: `https://relay.botkins.app/s/<shareId>#k=<key>` (the host's own relay address when it uses another relay). `key` is 32 random bytes, base64url. The fragment never reaches a server.
- **`shareId` belongs to the host's relay key**: `shareId = base64url(first 16 bytes of SHA-256("botkins-space-id-v1:" + relayPublicKey + ":" + salt))`, with `salt` 16 random bytes, base64url. The relay works this out again on every PUT, so nobody else can ever put a copy under that id, also after it was deleted or ran out. A host whose relay key is reset makes new links.
- **The copy** (`SpaceSnapshot`, built by the app with `spaces.snapshot(id)`, sealed and sent by the link host):

```ts
type SpaceSnapshot = {
  v: 1;
  name: string;
  from: string;                                  // the team's name, else the owner's
  kind: "panels" | "feed" | "ideas" | "goals";
  updatedAt: number;
  panels: { title: string; size: "small" | "wide" | "tall"; bot: { name: string; look: BotkinLook }; updatedAt: number;
            blocks: SnapshotBlock[]; state?: Record<string, unknown>; left?: "size" }[];
  cards: { kind: "feed" | "idea" | "goal"; title: string; body: string; links: string[]; category?: string;
           bot: { name: string; look: BotkinLook }; createdAt: number }[];
};
// SnapshotBlock is a PanelBlock, except { type: "html"; height: number; page: string; data?: unknown }: the page itself, not a frame id.
```

- **What a copy holds**: every panel that is not hidden and every open card; when a member made the space, only those whose bot that member's role may see. **No field of a copy is** a host id, a chat id, a bot id, a panel id, a project, a routine's prompt, a note, `last`, who is here, or a person's name other than `from`. What a panel itself says (its text, its page, its data, its state) is public as it is.
- **Sealing**: `body = nonce(12) || ciphertext || tag(16)`, AES-256-GCM over the gzip of the JSON, with `aad = "botkins-space-v1:" + shareId`. AES-GCM, not the link's ChaCha20, because a browser's WebCrypto has it and Node and Electron do too. The page refuses a copy that unpacks to more than 32 MiB.
- **Size**: `body` is at most 4 MiB. Over that, the app leaves out the largest `html` pages first and marks those panels `left: "size"`; the page says "This panel is too large to share by link."
- **Relay routes**, signed with the host's relay key as the invite directory is:
  - `PUT /v1/spaces/<shareId>`, body `body` as bytes, headers `x-botkins-key`, `x-botkins-time`, `x-botkins-sig`, `x-botkins-salt`, `x-botkins-expires`. Signed string: `botkins-relay-space-v1:<room>:<shareId>:<expiresAt>:<base64url(SHA-256(body))>:<time>`. `expiresAt` at most 7 days ahead. Refused when `shareId` does not come from the key and salt, or when `time` is not later than that of the copy it holds. 204.
  - `DELETE /v1/spaces/<shareId>`, with the key, time, salt and signature over `botkins-relay-space-del-v1:<room>:<shareId>:<time>`. Refused when `time` is not later than the held copy's. 204, or 404.
  - `GET /v1/spaces/<shareId>` → `body`, `cache-control: no-store`, or 404. Public. Its own rate limit, 60 a minute for each network.
  - `GET /s/<shareId>` → the page. The same page for every id; an id that is not 22 base64url characters gets 404.
  - `GET /s/frame` → the empty document an app panel runs in (below).
  - A copy is kept in pieces under the store's per-value limit, read and written as bytes. One host key holds at most 100 live copies and puts at most 30 a minute; more is refused with 429.
- **When the host publishes**: when the space is first shared by link; after a change, at most once every 20 seconds for each space; and once a day, with a new `expiresAt` 7 days ahead. So a host that is gone leaves nothing behind after a week. On start and when the relay comes on it puts every link's copy out again (as `syncInvites` does).
- **Taking a link back must not fail quietly.** When a space stops being shared by link, gets a new link, is deleted, or its maker is removed, the link host cancels any publish that is waiting, adds the copy to `team.spaceCopies`, and tries the DELETE until the relay answers 204 or 404: at once, then at growing gaps, and at every start. The sheet says "Taking the link back…" until then.
- **Relay off or host locked**: `link.spaces.share` with `"link"` is refused: "Turn on the relay on your computer to share by link." When the relay is switched off, the host deletes its copies first. A link-shared space then keeps its level, has no `link`, and its sheet says "Links are off while the relay is off."
- **The page** draws the space as the apps do: the name, "Shared from <from> · Updated 5m", the panels at their sizes, each with its bot's Botkin and name, cards for Feed, Ideas and Goals. Ink theme, light or dark from the browser. A quiet last line: "Made with Botkins", a link to botkins.app.
  - Its policy: `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, with the `/join` page's other headers.
  - Every string from a copy is written as text. Markdown is drawn by the page's own small renderer, with no raw HTML and only `http` and `https` links.
  - **An app panel** runs in `<iframe sandbox="allow-scripts" src="/s/frame">`. `/s/frame` is served with the custom-view policy as a header (`FRAME_CSP` in `mobile/src/ui/frame.ts`) plus `sandbox allow-scripts; frame-ancestors 'self'`, so it has no origin of its own however it is opened and cannot read the key or the page. It takes one message, only from its parent, holding the panel's HTML, data and state; it removes what `FRAME_GUARD` removes, sets up `window.botkins`, then writes the HTML. The page listens only to its own frames. `getData`, `theme` and `state.get` work. `state.set` and `sendAnswer` answer `false`. `openLink` asks first and opens `http` and `https` only.
  - Known limit: a browser may look up a name a page mentions before the policy applies (DNS prefetch is outside it), so a panel's author could learn that a link was opened. The same holds for a custom view in the apps.
  - A bot with its own colors is drawn in its character's original ones, as the Live Activity does.
  - A copy that is gone: "This space is no longer shared." A key that does not open it: "This link isn't complete. Ask for it again."
- The self-hosted Node relay (`relay/node`) gets the same routes.

## Notifications

A person's "Notify me" for a space is Off, Once a day or Every change.

- **Once a day** (the default for a space a person made or was picked for): one alert at 8:00 in the host's time zone when something in that person's "Once a day" or "Every change" spaces changed since they last opened it. For one space: title the space's name, text "3 panels changed overnight: Signups, Launch checklist and 1 more." For several: title "Spaces", text "Launch and Money changed overnight."
- **A note** from another person goes right away to everyone who can open the space and has not set Off: title "Maya in Launch", text the note.
- **Every change**: also a change another person made, as it happens: title "Maya in Launch", text the label ("Ticked Press kit") or "Changed Launch checklist". At most one alert for each space and person in 10 minutes.
- **Off** is the default for a space shared with all members, or by link, that the person did not make, and for a member's space as the owner sees it.
- Nothing is sent to a person who is looking at that space now (`here`), or about their own change.
- A person's devices are the devices with their member id, or the owner's devices; nothing addresses a member's devices as one today, so the sender goes through them.
- Alerts are sealed like the others, kind `"space"`, and carry the space's id and the panel's so a tap opens there. The phone's notification choices gain "Spaces" (`PushPrefs.spaces`, on by default).

## Words on screen

**These words are final for both apps.** Tell the Mobile thread only the ones you cannot use.

- The place: **Spaces**. The built-ins: **Today**, **Feed**, **Ideas**, **Goals**; another person's: **Maya's Today**. The list of all: **All spaces** (desktop side menu), **All** (the phone's row), sections **Pinned**, **More** and, for the owner, **From members**.
- Who can open it, as a tag and a subtitle: **Only you**, the picked people's first names (**Maya and Dev**; **Maya, Dev and 2 more**), **All members**, **Anyone with the link**. A space someone else made that is private: **Only Maya**.
- Share: button **Share**. Sheet title **Share <name>** (phone), **Who can open <name>** (desktop). Section **Who can open it**. Choices **Only you** (line: "Private" for the owner; "The owner can open it too" for a member), **Members you pick** (line: the names, or "2 picked"), **All members** (line: "5 people on <computer>"), **Anyone with the link** (line: "They can look, not change"; on the desktop "View only"). Section **Members**, each **Can edit** or **Can view**. **Copy link**, **New link**, **Notify me** with **Off**, **Once a day**, **Every change**. Close with **Done**.
- Panels: **Add panel** (button), **New panel** (sheet), **What should it show?**, **Bot**, **Start from** with **Checklist**, **Tracker**, **Chart**, **Table**, **Notes**, **App**; rows **Space**, **Project**, **Refresh**; action **Create**. Sizes **Small**, **Wide**, **Tall**. The badge on an app panel: **App**.
- Asking: **Ask about this space** (phone), **Ask about this space, or describe a new panel** (desktop), **Ask <bot> to change it** (an opened panel).
- What changed: "2 panels changed since yesterday". The time is "this morning" (seen before noon today), "earlier today", "yesterday", the weekday within a week, else the date.
- Menus: **Pin**, **Unpin**, **Rename**, **Delete space**; "Delete Launch and its 5 panels?" with **Delete**. Creating: **New space…**, **New panel…**.
- Projects: the section **Spaces and panels**, the button **Attach**, the menu heading **Attach a space**.
- Team settings: the scope **Today** is shown as **Spaces**; the switch **Members may share by link**.
- Without the capability: "Update the app on your computer" (phone), "Update Botkins on the owner's computer" (a member's app).

## Capability, and older apps

- The app names `spaces-v1` in its capabilities. The link host names it only when the app does.
- A phone or window that sees `spaces-v1` shows Spaces and no Today page. One that does not keeps today's Today page, from `panels` and `board`.
- A host without `spaces-v1` gets today's Today page from a new phone.
- The desktop app used as a member of another host shows that host's spaces from the same part and calls.

## Who builds what

| Part | Folder | Thread |
| --- | --- | --- |
| Records, the move of what exists, the app's calls, bot tools and the panel key, the skill, `botkins.state` on the host, refresh limits and chat ownership, the copy for a link, when to notify | `desktop/desktop/` (not `link/`) | Botkins Terminal Host |
| This contract, `spaceCan`, `spaceView`, `authorize`, `filterParts` and the owner's `spaces`, `link.spaces.*`, publishing to the relay and taking back, the demo computer, client types | `mobile/link-host/`, `mobile/src/link/`, `mobile/docs/` | Botkins Mobile App |
| The relay's routes, store, page and frame, and its deploy | `mobile/relay/` | Botkins Mobile App |
| The phone's screens, the Lock Screen and Home Screen widget of a pinned panel | `mobile/src/`, `mobile/targets/` | Botkins Mobile App |
| The window: side menu, space page, share, arranging, the project page, Team settings, the bridge in the window's views | `desktop/src/` | Botkins Desktop App |

Order: the link host and the demo computer first, since both apps and the host build against them. The Mobile thread owns this file from here: a change to the contract goes to it first, then to every side.

## Still to settle while building

- The desktop app's copy of `link/methods.mjs` does not list the space calls yet: its own test wants a handler and a `preload.cjs` entry for every listed call. The app's PR (Terminal Host thread) copies `mobile/link-host/methods.mjs` over it, byte for byte, with those.
- A panel or card the app has put in no space is sent to the owner only.
- The headless host's backend drops the call's context (`headless/backend.mjs`), so it cannot tell which person called. Spaces need the person on the host; it has to be passed through there. Whether it stamps `createdBy` on a member's chat today is unchecked.
- The widget needs a new native build and a real phone to check.
- Nothing here has been tried with a real team. The first check with two people on one host is owed before a release says it works.
