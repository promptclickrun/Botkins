# Routine Notification Targets — Design Spec

**Date:** 2026-11-24 (Revised for `origin/main` Teams/People + `feature/user-profiles`)
**Status:** Draft — Pending User Review
**Target Base:** `origin/main` (`0287425`, compatible with and enhanced by `feature/user-profiles` from `[Cross-Device Profiles and Host Access](t3-thread://v2/603627bb-22c0-4833-9cee-c3b998083cf4/310583e4-c6c0-4cea-9d6e-c78b26338f00)`)

---

## 1. Problem & Goals

When multiple humans (an owner plus team members) and multiple devices (host computer, phones, tablets, remote desktops) are attached to a Botkins host, routine notifications are currently binary (`notify: true | false`) and fan out to everyone who can see the routine's chat on all of their devices.

We want agents and humans to control **exactly which people and/or individual devices** a routine notifies:

1. **Both people and individual devices** can be targeted:
   - Targeting a **person** (`"owner"` or a team `memberId` `"m_…"`) alerts **all** of that person's devices — including `"host"` (the host computer) for the owner, plus every current and future paired or Botkins-Profile-enrolled device belonging to them.
   - Targeting a **device** (`"host"` or a paired `device.id`) alerts only that exact device.
   - Mixing both (`people` + `devices`) notifies their deduplicated union.
2. **Both routine defaults and per-run dynamic overrides** are supported:
   - Each routine stores an optional default `notifyTargets` (editable by humans in Desktop & Mobile Routine Editors and by agents via `routine_create` / `routine_update`).
   - During a routine run, the agent can call `routine_notify` to dynamically choose who/which devices to alert for **that run** (including escalating a quiet routine on an anomaly, narrowing an alert, or silencing an uneventful run without suppressing its output), and `routine_notify_targets` to discover eligible people and devices.
3. **Zero duplicated identity management**:
   - Reuse Botkins' existing canonical person model (`OWNER = "owner"`, `team.members[].id`, `team.people`) and device ownership (`device.memberId`), which `feature/user-profiles` (`profile-v1`) automatically keeps unified across device upgrades and multi-device sign-ins via `profiles.owner` / `profiles.members[memberId]`.
   - No new `state.people` directory, no `Settings › People` screen, and no manual device-to-person assignment UI.
4. **Full Team permission & privacy preservation**:
   - Respect `TEAMS.md` invariants: never notify a member whose role cannot see the routine's bot (`memberSeesBot`), never expose other people's device inventories to team members, never leak private routine chat history when alerting a member outside that chat, and fail closed when saved targets are revoked/removed.

### Non-Goals

- Push notifications to remote desktop clients (`kind: "desktop"`): today only the host computer (`"host"`, Electron `Notification`) and push-registered phones/tablets (`LinkStore` push records) receive alerts. Remote desktop devices are shown accurately with `canNotify: false`.
- Targeting non-routine interactive chat replies, space alerts (`space-alerts.mjs`), or permission/approval requests.

---

## 2. Architecture Overview

```
Existing Botkins Identity (LinkStore + team.mjs + profile-v1)
  ├── People: "owner" (ownerName via profile/device/host) + team.members[].id ("m_…")
  └── Devices: "host" (host desktop) + store.data.devices[] (owned by device.memberId ?? "owner")
                                 │
                                 ▼
              ┌─────────────────────────────────────┐
              │ desktop/desktop/link/notify-targets │  ◄── Pure resolver + validator
              │   .mjs (mirrored in mobile/link-    │      enforces role/bot visibility,
              │   host/notify-targets.mjs)          │      owner vs member scope, & fail-closed
              └──────────────┬──────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
  desktop/routines.mjs  desktop/notify.mjs   desktop/link/push.mjs
  • entry.notifyTargets • Host OS alerts     • Mobile/remote push
  • run.notifyTargets   • Checks "host" /    • Checks device.id /
  • routine_notify_targets  "owner" match      personId match
  • routine_notify (run)• Preserves quiet    • Preserves Live Activities
  • routine_create/update  hours & prefs     • Safe tap target (c)
                             │
         ┌───────────────────┴───────────────────┐
         ▼                                       ▼
  Desktop Routine Editor                 Mobile RoutineEditor
  (desktop/src/Routines.tsx)             (mobile/src/features/work/RoutineEditor.tsx)
  • Everyone / Specific / Quiet          • Everyone / Specific / Quiet
  • Grouped Person → Device picker       • Grouped Person → Device picker
  • Uses existing phones + team parts    • Uses existing phones + team parts
```

### How `feature/user-profiles` Simplifies This Design

Under `profile-v1` (`CONTRACT.md`), each person on a host (`"owner"` or an existing `memberId`) can bind their Botkins User Profile (`store.data.profiles.owner` or `store.data.profiles.members[memberId]`). When that person signs into a new phone, tablet, or second desktop:

- The host automatically enrolls the device under the same owner or `memberId` principal and keeps their display name synced (`ownerName()` / `nameMember()`).
- Because routine targeting references canonical person IDs (`"owner"`, `"m_…"`), **targeting a person automatically follows them across new and replaced devices** with zero manual re-binding.
- Account-free QR-paired and invite-code devices continue to work identically because they already carry the same `device.memberId ?? "owner"` ownership model.
- This feature works cleanly directly on `origin/main` and automatically gains profile-synced names and seamless multi-device enrollment whenever `profile-v1` is active (reading `store.data.profiles` via optional chaining so there is no hard dependency).

---

## 3. Data Model

### 3.1 Canonical Identifiers (No New Identity Tables)

| Entity | Canonical ID | Source of Truth | Display Name |
|---|---|---|---|
| Host Owner | `"owner"` (`OWNER`) | `team.mjs` | `link.ownerName()` (`profiles.owner.name` → owner device `person` → host `name` → `"Owner"`) |
| Team Member | `"m_…"` (`member.id`) | `store.data.team.members` | `member.name` (synced with profile when bound) |
| Host Computer | `"host"` (`HOST_DEVICE_ID`) | Host desktop app | `store.name` (UI label: `"This computer"` on desktop, `meta.name` on mobile) |
| Paired Device | `device.id` | `store.data.devices` | `device.name` (excluding `kind === "gadget"`, which cannot receive alerts) |

### 3.2 Routine Default Targets (`ChatSchedule.notifyTargets`)

Added as an optional field on routine schedule entries (`chat.schedules[]` where `entry.routine === true`):

```ts
export const HOST_DEVICE_ID = "host";

export interface NotifyTargets {
  people?: string[];  // Canonical person IDs: "owner" or memberId ("m_…")
  devices?: string[]; // Canonical device IDs: "host" or LinkStore device.id
}
```

**Canonical semantics & backward compatibility:**
- `entry.notify === false`: Routine is **quiet by default** (notifies no one unless a run explicitly calls `routine_notify` with targets). `entry.notifyTargets` is omitted when `entry.notify === false`.
- `entry.notify !== false` and `entry.notifyTargets === undefined`: **Default behavior** (unchanged from `origin/main` — alerts everyone in the routine/delivery chat on all their devices).
- `entry.notify !== false` and `entry.notifyTargets` is present: **Specific targets** — notifies the deduplicated union of `people` (expanded to all their devices, including `"host"` for `"owner"`) and `devices`.
- Saving `notifyTargets: { people: [], devices: [] }` (both arrays empty) is normalized at write time to `{ notify: false }` with `notifyTargets` omitted, maintaining a single canonical representation of "quiet by default".
- Saving `notifyTargets: null` clears custom targets back to default (chat members) while preserving `notify: true`.
- `duplicateRoutine` deep-clones `entry.notifyTargets` when present.
- Limits: at most 50 entries in `people` and 50 entries in `devices`, deduplicated, trimmed non-empty strings.
- Older clients that only read/write `notify: boolean` continue working: setting `notify: false` clears `entry.notifyTargets`, and setting `notify: true` without `notifyTargets` keeps existing `entry.notifyTargets` intact (or default if none).

### 3.3 Per-Run Dynamic Override (`Run.notifyTargets`)

Added as an optional field on a routine `Run` record (`state.runs[]`), populated exclusively by the `routine_notify` agent tool during a routine run:

```ts
export type RunNotifyOverride =
  | { mode: "none" }
  | { mode: "default" }
  | {
      mode: "only";
      people?: string[];
      devices?: string[];
      message?: string; // Optional concise alert body (trimmed, max 240 chars)
    };
```

- **Last call wins** within a single run. Calling `routine_notify({ mode: "default" })` clears any prior override in that run.
- Persisted on the `Run` record (and included in `runSummary(run)` in `parts.mjs`) so `notify.mjs`, `push.mjs`, Desktop UI, and Mobile UI all see the exact override.
- `message` is used as the alert body for successful routine runs (`run.status === "Completed"`); failed runs always display their failure detail instead.

---

## 4. Target Resolution, Precedence & Security Rules

All resolution, normalization, and validation logic lives in a single pure, dependency-free module:
- `desktop/desktop/link/notify-targets.mjs` (mirrored identically to `mobile/link-host/notify-targets.mjs`, matching `team.mjs` and `push.mjs`).

### 4.1 Precedence Table (Evaluated at Run Completion)

Evaluated in strict order for routine runs (`run.scheduleId != null || run.trigger === "scheduled"`):

1. **Run stopped / non-terminal / temporary chat / `run.notify === false`** → Notify **nobody**.
2. **`run.status === "Completed" && run.noOutput === true`** (e.g. `[SILENT]` reply) → Notify **nobody**.
3. **`entry.deliver?.to === "none"`** → Notify **nobody** (preserves Botkins' invariant that no-output routines never publish or notify).
4. **Panel refresh (`run.panelId`)**: Unchanged — quiet unless scheduled & failed, using existing owner/chat rules (`routine_notify` is not exposed to panel refreshes).
5. **Effective target selection**:
   - If `run.notifyTargets?.mode === "none"` → Notify **nobody** (run output is still saved/delivered normally).
   - Else if `run.notifyTargets?.mode === "only"` → Use **explicit target set** `{ people, devices }` (and optional `message`). **This overrides `entry.notify === false`**, allowing a routine to stay quiet by default and alert specific people/devices only when a condition triggers.
   - Else if `entry?.notify === false` → Notify **nobody**.
   - Else if `entry?.notifyTargets` is set → Use **explicit target set** `entry.notifyTargets`.
   - Else → **Default mode** (existing `origin/main` behavior: everyone in the routine chat — and delivery chat if `deliver.to === "chat"` — on all their devices).

### 4.2 Explicit Target Expansion & Fail-Closed Invariant

Given an explicit target set `{ people = [], devices = [] }`, `resolveRoutineTargets({ target, botId, team, devicesList, maker })` computes:

- **Eligible people (`canReceivePerson(personId)`):**
  - `"owner"` is eligible (the host owner can see every bot).
  - A member `m_…` is eligible **if and only if** they currently exist in `team.members` **AND** `memberSeesBot(memberId, team, botId)` is `true`.
  - Any unknown, removed, or bot-ineligible person ID is dropped.
- **Eligible devices (`canReceiveDevice(deviceId)`):**
  - `"host"` belongs to `"owner"` and is eligible whenever caller scope permits owner device targeting (§4.3).
  - A paired device `d` (with `d.kind !== "gadget"`) belongs to `ownerOf(d) = d.memberId ?? "owner"`. It is eligible if `canReceivePerson(ownerOf(d))` is `true` and caller scope permits targeting `d` (§4.3).
- **Expansion:**
  - `host`: `true` if `"host"` is an eligible explicit device OR `"owner"` is in `people`.
  - `deviceIds`: `Set` of all eligible non-gadget paired `d.id` where `devices.includes(d.id)` OR `people.includes(d.memberId ?? "owner")`.
- **Fail-closed guarantee:** If an explicit target set is active (via `entry.notifyTargets` or `run.notifyTargets.mode === "only"`) and **zero** eligible host/devices resolve (e.g., the targeted member left the team or their phone was revoked), the resolver returns `{ explicit: true, host: false, deviceIds: new Set() }` — notifying **nobody**. It **never** silently falls back to broadcasting to everyone in the chat.
- Saved IDs are **retained on `entry.notifyTargets`** when a member leaves or a device is unpaired (never widened), so the Routine Editor can explicitly surface *"1 removed target"* to the human and clean it up on next save.

### 4.3 Owner vs. Member Privacy & Scope Rules

Matches `TEAMS.md` (`team-people-v1` & `routine-owner-v1`):

| Capability | Owner (`!maker` / owner principal) | Team Member (`maker = memberId`) |
|---|---|---|
| Discover people (`routine_notify_targets`) | `"owner"` + all `team.members` where `memberSeesBot(m.id, team, botId)` | `"owner"` + all `team.members` where `memberSeesBot(m.id, team, botId)` |
| Discover devices (`routine_notify_targets`) | `"host"` + all non-gadget paired devices of every eligible person | **Own devices only** (`d.memberId === maker`); other people's `devices` arrays are omitted |
| Target people (`people: [...]`) | Any eligible person | Any eligible person |
| Target specific devices (`devices: [...]`) | `"host"` or any eligible person's non-gadget device | **Own devices only** (`d.memberId === maker`); targeting `"host"` or another person's `device.id` is rejected with a clear error |
| Edit routine `notifyTargets` | Owner routines (or any routine on host) | Own routines only (already enforced by `ROUTINE_METHODS` in `team.mjs`) |

> **Why this boundary matters:** Per `TEAMS.md`, team members never receive `phones` or `team.members[].devices`. Restricting member device visibility and direct device targeting to their own devices — while still letting them target eligible teammates by **person** — preserves host privacy while enabling multi-human team alerting.

### 4.4 Chat Visibility & Notification Delivery Sinks

**Host computer (`desktop/desktop/notify.mjs`):**
- `decide(event, { settings, focused, now, timeZone, mine, resolved })`:
  - For non-panel routine turns with explicit targeting (`resolved?.explicit === true`): `resolved.host` replaces the `mine` check (so an owner routine targeting only Maya or only the owner's iPhone keeps the host computer quiet; a member routine explicitly targeting `"owner"` alerts the host computer).
  - Host preferences (`prefs.routines`, `prefs.quietHours`) always remain enforced.
  - Alert body for non-failed runs: `firstLine(run.notifyTargets?.message) || firstLine(reply?.text) || "Finished."`.

**Mobile / remote push (`desktop/desktop/link/push.mjs` & `mobile/link-host/push.mjs`):**
- **Live Activities untouched:** In `Push.onFinish`, the Live Activity update/end loop continues to run solely for devices where `maySeeChat(device, chat)` is `true`, completely independent of `notifyTargets`.
- **Alert loop:**
  - When `resolved.explicit === false` (default mode): exact existing behavior (`maySeeChat(device, chat)` and `deliveryChat` checks).
  - When `resolved.explicit === true`: skip `device` unless `resolved.deviceIds.has(device.id)` (which has already enforced `memberSeesBot` and non-gadget checks).
  - Per-device preferences (`this.wants(device, "routines")`) and active presence suppression (`this.present(device.id, targetChatId)`) always remain enforced.
- **No silent chat invite & safe tap target (`c`):**
  - Alerting a member who is not in the routine's private chat does **not** add them to that chat or expose its history.
  - Tap target `c` in the sealed push payload:
    - If `run.delivery?.chatId` exists and `maySeeChat(device, chats.get(run.delivery.chatId))` → `c = run.delivery.chatId`.
    - Else if `maySeeChat(device, chat)` → `c = run.chatId`.
    - Else → omit `c` (tapping opens Botkins cleanly without attempting to navigate to an inaccessible chat).
- **Preview privacy:** If `record.prefs.previews` is `true`, alert body `m` uses `firstLine(run.notifyTargets?.message)` (for non-failed runs) or `firstLine(reply?.text)` / failure detail. If `record.prefs.previews` is `false`, `m` stays generic (`"A run needs a look."` / `"New message"`), never leaking `message` or reply text.

---

## 5. Agent Tools & Prompt Integration

All agent tools are registered inside `Routines.tools(bot, chat, run, task)` in `desktop/desktop/routines.mjs`, using flat, provider-safe JSON Schema (no `oneOf`/`anyOf`).

### 5.1 `routine_notify_targets` (Read-Only Discovery)

Available to any bot with routine tools (both in interactive chats and during routine runs).

- **Input:** `{}` (no parameters).
- **Output:**
  ```json
  {
    "people": [
      {
        "id": "owner",
        "name": "Alex",
        "role": "owner",
        "profileLinked": true,
        "devices": [
          { "id": "host", "name": "Alex's MacBook Pro", "kind": "host", "platform": "darwin", "canNotify": true },
          { "id": "d_9f2a1", "name": "Alex's iPhone", "kind": "phone", "platform": "ios", "canNotify": true, "connected": true }
        ]
      },
      {
        "id": "m_3k8p2",
        "name": "Maya",
        "role": "member",
        "profileLinked": true,
        "devices": [
          { "id": "d_4b7c0", "name": "Maya's iPhone", "kind": "phone", "platform": "ios", "canNotify": true, "connected": false }
        ]
      }
    ]
  }
  ```
- Follows §4.3 scope rules (for member turns, `devices` is only included on that member's own entry).
- `canNotify` is `true` for `"host"` when desktop routine notifications are enabled (`settings.notifications.routines !== false`), and `true` for paired devices with a registered push token and routine alerts enabled (`Boolean(push?.token && push.prefs?.enabled !== false && push.prefs?.routines !== false)`).
- Never exposes `profileId`, `statusKey`, `publicKey`, or push tokens.

### 5.2 `routine_create` & `routine_update` (Extended)

Add optional `notifyTargets` parameter to both existing tools (preserving `notify: boolean` compatibility):

- **Parameters (flat JSON Schema):**
  - `notify`: `boolean` (optional) — `false` sets Quiet (clears `notifyTargets`); on `routine_update`, `notify: true` without `notifyTargets` resets to Everyone (clears `notifyTargets`); omitting both `notify` and `notifyTargets` leaves existing notification settings untouched.
  - `notifyTargets`: `{ people?: string[], devices?: string[] }` (optional) — sets Specific targets (implies `notify: true`). Accepts canonical IDs (`"owner"`, `"m_…"`, `"host"`, `device.id`) OR unambiguous case-insensitive exact names (e.g. `"Maya"`, `"Maya's iPhone"`), resolved to canonical IDs before saving.
- Validation rejects unknown, unauthorized, or ambiguous names/IDs with an actionable error advising the agent to call `routine_notify_targets`.
- Rejects passing both `notify: false` and `notifyTargets` in the same call.
- Returns advisory `warnings?: string[]` if any resolved target has zero devices or `canNotify: false`.
- `routine_list` / `Routines.view()` includes `notifyTargets` (when set) and a concise `notifySummary` (e.g. `"Maya, Alex's iPhone"`).

### 5.3 `routine_notify` (Per-Run Dynamic Targeting)

Registered **only during a routine run** (`(run?.scheduleId != null || run?.trigger === "scheduled") && !run?.panelId`, and omitted for `deliver.to === "none"` routines).

- **Parameters:**
  ```json
  {
    "mode": { "type": "string", "enum": ["only", "none", "default"] },
    "people": { "type": "array", "items": { "type": "string" } },
    "devices": { "type": "array", "items": { "type": "string" } },
    "message": { "type": "string", "description": "Optional short alert body (<= 240 chars) shown in the notification banner." }
  }
  ```
- **Validation & behavior:**
  - `mode: "only"` requires at least one entry across `people` or `devices`; resolves IDs or unambiguous names within caller scope + `memberSeesBot`.
  - `mode: "none"` silences alerts for this run (output is still posted to chat/board).
  - `mode: "default"` clears any earlier override in this run.
  - Rejects `people` or `devices` when `mode` is `"none"` or `"default"`.
  - Saves `run.notifyTargets` on the active run and calls `ws.save()`. Last call wins.
  - Returns `{ ok: true, mode, targets: { host: boolean, devices: [{ id, name, personId, personName, canNotify }] }, warnings: string[] }`.

### 5.4 Routine Run System Hint

In `Routines.destinationNote(chat, scheduleId)` (appended only to routine runs where `deliver.to !== "none"`):
- When the bot has more than one eligible person or more than one eligible device, append one concise sentence:
  > *"If your instructions ask to alert specific people or devices (or stay quiet for this run), call `routine_notify_targets` to see IDs and `routine_notify` before finishing."*
- Single-person, single-device hosts receive zero extra prompt tokens.

---

## 6. Link Protocol & Sync Contract

- **New capability:** `"routine-notify-targets-v1"` advertised in `meta.capabilities` (`desktop/desktop/main.mjs` / `link/server.mjs` and `mobile/link-host/`).
- **Zero new synced parts or RPC namespaces.** Extend existing payloads minimally:
  1. `phones` part (owner only): add `canNotify: boolean` to each paired device summary.
  2. `team` part:
     - Owner view (`teamPart(..., true)` / `server.team()`): add `canNotify: boolean` to each entry in `team.members[].devices[]`, plus `profileLinked?: boolean` when profile data is present.
     - Member view (`teamPart(..., false)`): add `me.devices: [{ id, name, kind, platform, connected, canNotify }]` containing **only that member's own non-gadget devices**.
  3. Existing routine CRUD (`routine:create` / `routine:update` Desktop IPC in `main.mjs`, and `createRoutine` / `updateRoutine` Link RPCs): accept optional `notifyTargets?: NotifyTargets | null`, validated with the exact same `validateNotifyTargets()` helper and caller principal checks.
  4. `runSummary(run)` in `parts.mjs`: include `...(run.notifyTargets && { notifyTargets: run.notifyTargets })`.
  5. Update `mobile/src/link/types.ts` and rebuild `desktop/desktop/remote/link-client.mjs` via `node scripts/build-link-client.mjs`.

---

## 7. UI Design (Desktop & Mobile)

Both Desktop (`desktop/src/Routines.tsx`) and Mobile (`mobile/src/features/work/RoutineEditor.tsx`) upgrade the existing Notifications control in the Routine Editor while keeping solo single-device setups uncluttered.

### 7.1 Routine Editor Notification Control

When `deliver.to === "none"`, the control stays disabled with the existing helper copy (*"No-output routines never publish or notify."*).

Otherwise, when the host advertises `"routine-notify-targets-v1"` (or on Desktop host directly), show a 3-option segmented control (falling back to the existing On/Quiet toggle on older hosts):

1. **Everyone** *(Default — `notify: true`, `notifyTargets: undefined`)*
   - Helper: *"Alerts everyone in this routine's chat on all their devices."* (Or *"On this computer and your devices"* when no team members exist.)
2. **Specific** *(`notify: true`, `notifyTargets: { people, devices }`)*
   - Reveals a compact grouped recipient picker built directly from existing `team` + `phones` state (filtered by `memberSeesBot` for the routine's selected bot):
     - **Each person** is a grouped row showing their display name (`"Alex (You)"`, `"Maya"`, `"Sam"`) with an **"All devices"** toggle (stores the person ID — automatically covers future profile-enrolled devices).
     - **Nested under each person** (for owner: `"This computer"` + each non-gadget paired device; for a member: only their own devices under their own row): individual device pills/rows with platform icon and a muted `Push off` pill when `canNotify === false`.
     - Checking a person's **"All devices"** toggle shows all of their devices as covered; unchecking one device switches from the person ID to the remaining specific device IDs so intent stays explicit.
     - If a saved `notifyTargets` contains a removed member or unpaired device ID, show a subtle warning chip (*"1 removed target"*) that is dropped automatically on save.
     - Validation: Save is disabled (with inline prompt) when **Specific** is chosen with zero remaining targets — user can pick a target or switch to **Quiet**.
3. **Quiet** *(`notify: false`, `notifyTargets: undefined`)*
   - Helper: *"Runs quietly by default. The bot can still alert specific people if its instructions ask it to."*

### 7.2 Routine List & Run History Badges

- **Routine list item** (`Routines.tsx` & mobile routines list):
  - Everyone → no extra badge (unchanged).
  - Quiet → `· Quiet` (unchanged).
  - Specific → compact summary: `· Alerts Maya`, `· Alerts Alex's iPhone`, `· Alerts 2 people`, `· Alerts 3 targets`, or `· No active targets` (if all saved targets were removed).
- **Finished routine run**:
  - When `run.notifyTargets` was set dynamically by the agent, show a subtle metadata chip on the run (e.g. `Alerted Maya` or `Silenced for this run`).

---

## 8. File Map & Verification Plan

### 8.1 Files to Create / Modify

1. **New pure module (shared core):**
   - `desktop/desktop/link/notify-targets.mjs` — `HOST_DEVICE_ID`, `normalizeNotifyTargets`, `validateNotifyTargets`, `listNotifyTargets`, `resolveRoutineTargets`, `summarizeNotifyTargets`.
   - `mobile/link-host/notify-targets.mjs` — identical mirror.
2. **Host backend (`desktop/desktop/`):**
   - `routines.mjs` — store/validate `entry.notifyTargets`, add `routine_notify_targets` & `routine_notify` tools, extend `routine_create`/`routine_update`/`view`/`destinationNote`.
   - `notify.mjs` — wire `resolveRoutineTargets` into `decide()` and `Notifier.consider()`, handle `run.notifyTargets.message` and explicit `"host"` / `"owner"` targeting.
   - `link/push.mjs` (+ mirror `mobile/link-host/push.mjs`) — wire `resolveRoutineTargets` into `Push.onFinish()`, preserve Live Activities, enforce `memberSeesBot`, safe tap target `c`, and `run.notifyTargets.message` (respecting `previews`).
   - `link/team.mjs` (+ mirror `mobile/link-host/team.mjs`) — include `me.devices` (own non-gadget devices only) in member `teamPart`.
   - `link/parts.mjs` (+ mirror `mobile/link-host/parts.mjs`) — include `run.notifyTargets` in `runSummary`.
   - `link/server.mjs` — advertise `"routine-notify-targets-v1"`, expose `canNotify` on `phones` & `team.members[].devices`, pass `notifyTargets` + principal through `createRoutine` / `updateRoutine`, expose live devices/team helper to workspace & notifier.
   - `main.mjs` — pass `notifyTargets` through Desktop IPC `createRoutine` / `updateRoutine`, wire `link` target provider into `Workspace` / `Notifier`.
   - `link/CONTRACT.md` & `link/TEAMS.md` — document `"routine-notify-targets-v1"` and privacy rules.
3. **Desktop UI (`desktop/src/`):**
   - `types.ts` — add `NotifyTargets`, `RunNotifyOverride`, `canNotify`, `me.devices`.
   - `Routines.tsx` (+ `routines.css`) — 3-way notification control, grouped Person → Device picker, routine/run badges.
4. **Mobile UI (`mobile/src/`):**
   - `link/types.ts` (and rebuild `desktop/desktop/remote/link-client.mjs`).
   - `features/work/RoutineEditor.tsx`, `features/work/delivery.ts`, `features/work/bits.tsx` — 3-way notification control, grouped Person → Device picker, routine/run badges.

### 8.2 Verification & Test Cases

1. **`desktop/test/notify-targets.test.mjs`** (pure resolver & validator):
   - Person expansion (`"owner"` → `"host"` + all owner non-gadget devices; `"m_alice"` → all Alice's devices; ignores `"gadget"` devices).
   - Union & deduplication of overlapping `people` + `devices`.
   - Profile-enrolled device automatically covered when targeting person ID.
   - Role/bot visibility enforcement (`memberSeesBot === false` dropped on resolve and rejected on validate).
   - Member privacy enforcement: member cannot discover or target `"host"` or another person's `device.id`, but CAN target eligible teammates by person ID and their own devices.
   - Fail-closed invariant: explicit target list whose IDs were all removed/revoked resolves to `{ explicit: true, host: false, deviceIds: empty }` (never falls back to chat broadcast).
   - Normalization: empty `{ people: [], devices: [] }` → quiet (`notify: false`).
   - Case-insensitive name resolution & ambiguous-name rejection.
2. **`desktop/test/notify.test.mjs`** (host desktop notifications):
   - Owner routine targeting only a member or only owner's iPhone does NOT notify host desktop.
   - Owner routine targeting `"owner"` or `"host"` DOES notify host desktop (honoring quiet hours & `prefs.routines`).
   - Quiet routine (`notify: false`) with per-run `run.notifyTargets: { mode: "only", people: ["owner"], message: "..." }` DOES notify host desktop with custom `message` on success (and failure detail on error).
   - Routine with `run.notifyTargets: { mode: "none" }` suppresses host notification while keeping output.
   - `deliver.to === "none"` and `run.noOutput === true` remain silent.
3. **`desktop/test/push.test.mjs` & `mobile/tests/push.test.ts`** (mobile push):
   - Explicit targeting sends sealed alerts ONLY to resolved devices (including a bot-eligible member outside the routine's private chat, with `c` omitted safely when `!maySeeChat`, and `c` preserved when `maySeeChat`).
   - `run.notifyTargets.message` is used when `previews: true` and hidden when `previews: false`.
   - Live Activity updates remain completely unaffected by `notifyTargets`.
   - Member whose role cannot see the bot receives zero alerts even if referenced.
4. **`desktop/test/routines.test.mjs`** (agent tools & persistence):
   - `routine_notify_targets` output for owner vs member turns (verifies zero device leakage).
   - `routine_create` / `routine_update` validation and persistence of `notifyTargets`.
   - `routine_notify` available only on non-panel, non-`deliver:none` routine runs; last-call-wins; returns resolved targets and `canNotify: false` warnings.
5. **Mirror parity, typechecks & builds:**
   - Diff check confirming `desktop/desktop/link/` and `mobile/link-host/` mirrored files match.
   - `desktop` TypeScript + Vite build and `mobile` `npx tsc --noEmit`.

