# Teams: members, groups and roles (`teams-v1`)

A host's owner can let other people use the host's Botkins. Each person joins with an invite, the owner approves them, and a role decides what they see and do. This file is the contract every part builds against: the link host (`mobile/link-host/`, copied to `desktop/desktop/link/`), the relay (`mobile/relay/`), the client library (`mobile/src/link/`), the desktop app and the phone app.

## Words

- **Owner**: the person at the host, and every device they paired with a pairing code. Owner devices stay full trust, as in `CONTRACT.md`.
- **Member**: a person who joined through an invite. A member has one or more **member devices** (a device record with `memberId`). A member device is never full trust.
- **Group**: a set of members. Each group has exactly one role. A member is in exactly one group.
- **Role**: permissions per scope, plus which bots are visible.
- **Principal**: who made a call: `{ kind: "owner" }` or `{ kind: "member", memberId, name, groupId }`.

## Permissions

| Scope key | Label | Actions, in order |
| --- | --- | --- |
| `agents` | Agents | `view`, `chat`, `create`, `manage`, `delete` |
| `today` | Today | `view`, `use`, `create`, `manage`, `delete` |
| `skills` | Skills | `read`, `use`, `create`, `manage`, `delete` |
| `mcp` | MCP Servers | `view`, `use`, `create`, `manage`, `delete` |
| `plugins` | Plugins | `view`, `use`, `install`, `manage`, `uninstall` |
| `settings` | Settings | `view`, `manage` |

Every action except the first in a row implies the first (`chat` implies `view`; saving a role adds it). Actions are otherwise independent.

```ts
type Scope = "agents" | "today" | "skills" | "mcp" | "plugins" | "settings";
type Role = {
  id: string;                 // "r_" + 10 base32 chars; built-ins keep fixed ids
  name: string;               // 1–40 chars
  perms: Record<Scope, string[]>;
  bots: "all" | string[];     // bot ids a member with this role can see
};
type Group = { id: string; name: string; roleId: string };          // id "g_…"
type Member = { id: string; name: string; groupId: string; joinedAt: number; deviceIds: string[] };  // id "m_…"
```

Built-in roles (editable, not deletable while a group uses them):

- **Guest** (`r_guest`): agents `view chat`, today `view`, skills `read use`, mcp `view use`, plugins `view use`, settings none. Bots: none until the owner picks.
- **Collaborator** (`r_collab`): Guest plus agents `create manage`, today `use create manage`, skills `create manage`.
- **Admin** (`r_admin`): every action.

A new team starts with one group, **Everyone** (`g_everyone`, role Guest).

### What a role does at the call level

`mobile/link-host/team.mjs` holds `TEAM_METHODS`: every remote method name mapped to `[scope, action]` or `"owner"`. A member's call is allowed only when its role has that action. **A method that is not in the table is owner only.** A test lists `REMOTE_METHODS` and fails when one is missing from `TEAM_METHODS`.

Always owner only, whatever the role: provider sign-in and keys (`signIn`, `auth`, `providers`, `setProviderEnabled`, `connectProviderService`…), `credentials`, `removeCredential`, every `link.devices.*`, `link.screen.*`, `link.device.*` (the phone tools), `link.push.test`, projects, wiki, tasks, folders (`listFolders`), `setBotAccess`, `setBotIntegrations`, `botMemory`, `setBotMemory`, templates import and export, and every `link.team.*` management call. A member's `setPreferences` with `settings.manage` may change only the display fields listed in `MEMBER_PREFERENCE_FIELDS`. It never changes `approval`, `access`, `teamwork`, the link or voice keys.

Bot-scoped calls (`createChat`, `send`, `updateBot`, `deleteBot`…) also need the bot to be visible to the role. Chat-scoped calls (`send`, `stop`, `renameChat`, `deleteChat`, `respond`…) also need `chat.createdBy === memberId`. A member never answers a `permission` or `secure` prompt. Those go to the owner (see "Bots and identity").

### What a member is sent

The host filters parts for each member session before sealing (`filterParts(parts, principal, team)` in `team.mjs`, pure and tested):

- `bots`: only visible bots. Without `agents.view`, none.
- `chats`, `live`, `runs`, `run:<id>`, `chat:<id>`: only chats with `createdBy === memberId`.
- `panels`, `board`: with `today.view`. Otherwise empty.
- `skills`, `mcp`, `plugins`: with that scope's first action. Never a secret value, a command line, an env var, a header or a file path.
- `settings`: with `settings.view`, only `MEMBER_PREFERENCE_FIELDS`. Otherwise empty.
- `voice`: only with `agents.manage`, and then only the shared choices and what each provider has (`memberVoice`, no key and no address); it is for setting a bot's own voice (VOICE.md, "A voice of a bot's own"). `link.voice.options` needs `agents.manage` too.
- `voice`: only with `agents.manage`, and then only the shared choices and what each provider has (`memberVoice`, no key and no address); it is for setting a bot's own voice (VOICE.md, "A voice of a bot's own"). `link.voice.options` needs `agents.manage` too.
- Never: `credentials`, `phones`, `asks` of the owner's chats, `voice` keys, `host` screen state, `projects`, `tasks`, wiki.
- `team`: `{ me: { memberId, name, group: { id, name }, role: { name, perms, bots } }, team: { name } }`. Owner devices get the full team (below).
- `meta.you`: `{ kind: "member", memberId, name }` or `{ kind: "owner" }`.

## Bots and identity (decided by the owner: "trusted team")

- A bot keeps its tools on a member's turn: shell, files, MCP servers, skills and plugins, as on the owner's turns. The role trims them. Without `mcp.use` the bot gets no MCP servers on that member's turns. Without `skills.use`, no skills. Without `plugins.use`, no plugin tools.
- Identity travels with each message. The desktop stamps `author: { memberId, name }` on a member's user messages and `createdBy: memberId` on a chat a member creates. Before a member's message in a chat of one person, the bot is told who is speaking: `[From <name>, a member of <team name>'s team, not the owner]`; in a chat of several people each message starts with its speaker's name instead (see "People in a chat"). Owner messages carry no stamp. A bot can always tell members A, B and C apart and from the owner.
- Approval prompts (`permission`, `secure`) raised on a member's turn go to the owner: the desktop's request panel, and a push to owner devices. The member sees "Waiting for <owner name> to approve".
- The owner sees members' chats in the app, marked with the member's name.

## Invites

```ts
type Invite = {
  id: string;            // "i_…"
  code: string;          // 10 Crockford base32 chars, shown as XXXXX-XXXXX. Kept on the host so the owner can copy it again.
  groupId: string;
  createdAt: number;
  expiresAt: number;     // 1 day, 7 days (default) or 30 days
  maxUses: number;       // 1 (default), 5 or 25. Used up by approvals, not by requests.
  uses: number;
  revoked?: true;
};
```

- **Link**: `https://relay.botkins.app/join#c=<CODE>&k=<serverKey>`, where `serverKey` is the host's link public key (base64url). The fragment never reaches a server. The relay serves a small page at `/join` that opens `botkins://join?c=<CODE>&k=<serverKey>` and also shows the code with "Open Botkins and enter this code".
- **Code**: typed in the app as `XXXXX-XXXXX`. Case, spaces and dashes are ignored. `I`/`L` read as `1` and `O` as `0`.

### Finding the host from a code (relay invite directory)

The host publishes an **invite card** to the relay so a typed code can find it:

- `lookup = base64url(SHA-256("botkins-invite-v1:" + CODE))`, 43 chars.
- `cardKey = HKDF-SHA256(ikm = CODE, salt = "botkins-invite-card-v1", info = lookup, 32 bytes)`.
- `card = ChaCha20-Poly1305(cardKey, nonce 12 random bytes, JSON { v: 1, serverId, serverKey, name, room, hosts })`, sent as base64url of `nonce || ciphertext`. The relay can't read a card, and without the code it can't forge one.
- `PUT https://relay.botkins.app/v1/invites/<lookup>`, body `{ card, expiresAt }`, with the host's relay proof: headers `x-botkins-key` (Ed25519 public key), `x-botkins-time`, `x-botkins-sig` over `botkins-relay-invite-v1:<room>:<lookup>:<expiresAt>:<base64url(SHA-256(card))>:<time>`. The relay keeps the card in a Durable Object named by the lookup until `expiresAt` (at most 30 days, card at most 4 KiB). Only the same key may replace or delete it.
- `DELETE /v1/invites/<lookup>` with the same headers (signature over `botkins-relay-invite-del-v1:<room>:<lookup>:<time>`). The host deletes it on revoke, on expiry and when the invite is used up.
- `GET /v1/invites/<lookup>` → `{ card }`, or 404. Rate limited like other requests, plus 20 a minute per network.
- A host without the relay on publishes nothing. Its invites work only by link, and only when the link's address is reachable. The owner is told this when they make an invite.

A client that has `k` (from a link) checks that the card's `serverKey` equals it.

### Joining

New route `POST /botkins/v1/join`, also served through the relay like `pair`:

```
request:  { key: <client X25519 public, b64u>, box: seal(K, { code, name, platform, kind, presenceKey? }, "join:" + serverId) }
          K = HKDF-SHA256(X25519(client, serverKey), salt = CODE, info = "botkins-join-v1")
answer:   { box: seal(K, Answer, "joined:" + serverId) }
Answer =  { status: "pending", requestId, team }                           // first call, and while waiting
        | { status: "approved", device, serverId, name, hosts }            // same as pair's answer
        | { status: "denied" }
```

- The same client key calling again is a status check, never a second request. The client checks every 10 seconds while its waiting screen is open, and when the app comes to the front.
- A wrong, expired, revoked or used-up code gets `403 join_closed`. Wrong codes count against the same per-source limits as pairing (`join_wait` 429).
- At most 50 pending requests. A denied request answers `denied` for 24 hours, then is forgotten.
- A client key that already belongs to an owner device is refused (`409 join_owner`).
- After `approved`, the client stores a `Pairing` with `member: true` and uses sessions exactly as in `CONTRACT.md`.
- Host offline: the client says "Can't reach <team> right now. Try again when the owner's computer is on." A queued request on the relay is not in v1.

### The owner's side

- A new request emits `"joinRequest"` on `LinkHost`. The desktop shows a system notification ("<name> wants to join your team"). Clicking it opens Settings › Team › Requests. The desktop also pushes to owner devices (category `team`, never to member devices).
- Approve picks a group (the invite's by default). That creates the member and the member device, uses one invite use, and the client's next check gets `approved`. Deny marks the request denied.
- Removing a member removes their devices and ends their sessions at once (`revoked`, as in `CONTRACT.md`).

### Owner calls (`link.team.*`, owner devices only; the desktop calls the same functions host-side)

`link.team.get()`, `link.team.saveRole(role)`, `link.team.deleteRole(id)`, `link.team.saveGroup(group)`, `link.team.deleteGroup(id, moveTo)`, `link.team.createInvite({ groupId, days, maxUses })` → `Invite & { link }`, `link.team.revokeInvite(id)`, `link.team.approve(requestId, groupId?)`, `link.team.deny(requestId)`, `link.team.moveMember(memberId, groupId)`, `link.team.removeMember(memberId)`, `link.team.rename(name)`, `link.team.renameMember(memberId, name)`.

`link.team.renameMember` (capability `member-rename-v1`) is owner only. The name is trimmed and has 1 to 60 characters with no control characters, as the team's own name has; anything else is refused ("Give the member a name of up to 60 characters."), and so is a member who left ("That member is no longer on the team."). The member and every device of theirs take the name, as when a member's device sets its person (`link.devices.setPerson`), and the answer is the owner's `team` part. Every session is told at once, so the new name is in `team.people`, in `meta.you` of the member's own devices and in what the app reads from `link.team()`. A message keeps the name it was sent with, and a window shows the member's name as the team has it now. Without the capability a client leaves out Rename.

The `team` part for owner devices: `{ name, roles, groups, members (with devices: name, kind, platform, connected), invites (with link), requests (pending, with name, platform, kind, at, inviteId) }`.

## People in a chat, and each person's own view (`team-people-v1`)

A **person** is the owner (id `"owner"`) or a member (their member id). The owner is named by the name on one of the owner's devices ("Your name"), else by the computer's name.

**A chat's people** are its starter (`createdBy`, or the owner when there is none) and those invited. Invites are kept in the link's store (`team.chats`, by chat id), never in the workspace.

- `ChatSummary.invited?: string[]` goes to the owner and to the chat's people. The `team` part has `people: { id, name }[]`: the whole team for the owner and for a member who can start a chat (and so invite); for anyone else only the owner and the people of the chats they are in.
- `link.team.inviteToChat(chatId, personId)` and `link.team.removeFromChat(chatId, personId)` answer the invited list afterwards. The chat's starter or the owner invites and removes; someone invited may take themselves out. A chat holds up to 20 people.
- Someone invited sees the chat and may read it, send, stop, answer its questions, fork it and set their own flags on it. An invite never widens a role: a person whose role can't use the chat's bot can't be invited ("That person's role can't use this chat's bot. Change their role in Team settings first."), and loses the chat if their role later loses the bot. They may not rename, compact or delete it, change its model, project or schedule, or invite. Their messages carry their name, and a turn they start runs under the narrower of the starter's limits and their own (the app's `team-turn.mjs`).
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

## Limits

- Owner devices: 20, as before. Member devices: 60 more.
- Sessions: member sessions share 32 slots, evicting the oldest member session. They never evict an owner session.
- Relay: up to 48 phone sockets per room (was 16). Per network stays 8.

## Capability

The host lists `teams-v1` in `meta.capabilities`. A client checks it before showing Join or Team. Otherwise it says "Update Botkins on the owner's computer". `member-rename-v1` is for renaming a member: a client checks it before it offers Rename.

## UX copy (exact)

- Invitee, after Accept: **The request has been sent to the owner of the team.**
- Invitee, denied: "The owner didn't approve this request."
- Invitee, approved: "You're in. Welcome to <team>."
- Owner notification: "<name> wants to join your team".
