# Apple Surfaces: Watch, Music, CarPlay, and Shortcuts

**Status:** Approved architecture, awaiting written-spec review
**Delivery:** One branch and one monolithic pull request
**Implementation boundary:** Mocks, code, native target organization, and pure tests first. Do not compile, prebuild, launch, or simulator-test until compute is available.

## Goals

1. Add a companion Apple Watch app that:
   - shows the primary Botkin's avatar and host identity;
   - shows the latest one-to-one chat in a conversation-first layout;
   - starts and controls the same full live-voice session used on iPhone;
   - sends Watch microphone PCM to the live provider through iPhone; and
   - plays the provider's response audio on the Watch.
2. Add Apple Music as an iPhone device capability agents can use to inspect now playing, search the library and catalog, play or control music, create playlists, add songs to playlists, and add catalog items to the library.
3. Add a compact Live Activity presentation that iOS can render in CarPlay without creating a miniature chat or CarPlay app.
4. Add two iOS Shortcuts while preserving the two existing actions:
   - `Open Botkins`
   - `Chat with your Botkin`
5. Keep all four features in one reviewable, single pull request.

## Non-goals

- The Watch is not another paired Botkins client. It does not store pairing keys, host credentials, provider tokens, or a second local chat database.
- The Watch does not offer agent, host, or model management.
- CarPlay does not expose approvals, message entry, music creation, or live-voice capture.
- Apple Music does not add a persistent music player inside Botkins.
- The existing `Send a Botkins Chat` and `Start a Voice Chat` Shortcuts remain available with compatible saved configuration.

## Approved User Experience

### Apple Watch

The Watch home screen is conversation-first, matching the approved phone mockup:

- The compact header shows the primary Botkin's avatar, name, selected computer, and connection state.
- The visible conversation is the latest one-to-one chat with the primary Botkin. It shows the latest few messages and the current turn state, not a full history.
- The active-voice bottom control replaces the idle `Talk` action with a waveform and `Listening`, `Working`, or `Speaking`.
- Controls are limited to what is safe and useful on a watch: start, mute, interrupt, end, and push-to-talk where that is the saved input mode.
- A disconnected phone shows `Phone unavailable`. It never attempts to call the paired computer directly.
- If the Watch app starts with no conversation, it displays the avatar and offers `Talk to <Botkin>`; the first voice command creates the Botkin's first chat.

The avatar uses the same character, palette, eyes, and custom-color fallback as the existing Botkin identity. Watch receives a normalized `WatchBot` description and uses native asset copies rather than image HTML or a React Native surface.

### CarPlay Live Activity

The CarPlay treatment is a compact ActivityKit small-family card:

- Botkin avatar
- one-line name/status
- one chat title or latest status line
- optional step count
- tap target to open the matching chat on iPhone

It never contains approval buttons, command previews, free text, or risky-action affordances. When the Live Activity is stale, the card says `Open Botkins for the latest`.

### Shortcuts

`Open Botkins` opens the app with no required parameters.

`Chat with your Botkin` opens the app and presents:

- **Computer**: one paired computer, defaulting to the active computer
- **Agent**: agents on that selected computer, plus `Primary Botkin`
- **Chat**: `Latest chat` or `New chat`

It does not send a prompt. Background prompt sending remains the responsibility of the existing `Send a Botkins Chat` action, and the existing `Start a Voice Chat` action remains unchanged.

## Architecture

```text
Watch app
  |-- WatchConnectivity snapshot + commands --> iPhone Botkins
  |-- 16 kHz mono PCM16 microphone ----------> iPhone voice endpoint
  |<-- provider PCM16 response audio ---------|

iPhone Botkins
  |-- existing pairing, encrypted link, host catalog, chat state
  |-- one shared live-voice session controller
  |-- WatchConnectivity coordinator
  |-- MusicKit device-capability module
  |-- App Intents / Shortcuts bridge
  `-- existing Live Activity module

paired computer
  |-- authoritative chats, agents, tool permission contract
  `-- live-provider session and ephemeral credentials
```

The iPhone remains the security and transport owner. No provider key, pairing key, encrypted notification key, chat encryption material, or Music token crosses to Watch. The Watch receives only its bounded display snapshot, commands already authorized by the paired Watch, and audio belonging to the active voice session.

## Apple Watch

### Native target

Add a `watch` target under `mobile/targets/watch/` using `@bacons/apple-targets`. It is a native SwiftUI app, not a React Native target:

- `expo-target.config.js`
  - target name `BotkinsWatch`
  - bundle identifier `.watchkitapp`
  - watchOS deployment target 11
  - `SwiftUI`, `WatchConnectivity`, `AVFoundation`, and `WatchKit`
- `BotkinsWatchApp.swift`
- `WatchHome.swift`
- `WatchConversation.swift`
- `WatchVoiceControls.swift`
- `WatchSnapshot.swift`
- `WatchVoiceEngine.swift`
- `WatchSession.swift`
- `Info.plist`
- Watch icon and copied Botkin head assets

The main iOS target embeds the Watch app. TestFlight export configuration and release documentation include the additional Watch signing target.

### Shared protocol

The iPhone and Watch contain the same versioned protocol types, kept as a small Swift value model rather than sharing TypeScript or React Native:

```swift
struct WatchSnapshot: Codable {
    let version: Int
    let revision: UInt64
    let reachableAt: Date
    let computer: WatchComputer
    let bot: WatchBot
    let chat: WatchChat?
    let voice: WatchVoiceState
}
```

The display payload is capped before transfer:

- at most eight visible message entries;
- each text entry is clipped to 1,500 characters;
- the total snapshot stays below 32 KiB;
- only the selected host and primary Botkin are sent.

`WatchCommand` is a closed enum:

- `startVoice`
- `mute(Bool)`
- `interrupt`
- `press`
- `release`
- `endVoice`
- `refresh`
- `openOnPhone(chatID: String?)`

Messages carry protocol version, revision, session ID, and monotonically increasing sequence values. Unknown protocol versions are shown as `Update Botkins`, not interpreted.

### iPhone coordinator

Add an iOS Expo module, `modules/botkins-watch/`, exposing a narrow JavaScript interface:

- `start()`
- `update(snapshot: string)`
- `voiceStarted(sessionId, inputRate, outputRate)`
- `voiceEnded(sessionId, reason?)`
- `play(sessionId, pcm16Base64)`
- `flush(sessionId)`
- `stop()`
- events for `command`, `frame`, `output`, `reachability`, and `interrupted`

The native `WCSessionDelegate`:

- writes snapshots with `applicationContext` for the Watch's next launch;
- uses `transferUserInfo` for state and control messages that may queue while unreachable;
- uses `sendMessageData` only for reachable, latency-sensitive 20-40 ms audio packets;
- drops audio from an old sequence/session rather than queueing it across voice sessions;
- clears stale voice state when the pairing, active computer, or active chat changes.

The state coordinator in TypeScript reduces existing app state into a Watch snapshot. It subscribes to pairing, bots, chat summaries, watched messages, running turns, and live-call state. It uses the existing primary-bot selection and `chatForTap(..., "latest")` rules rather than inventing separate selection logic.

### Full live voice

The current voice session is coupled to `VoiceDock` through `useLiveSession`. Extract a shared imperative live-session controller:

- existing iPhone UI becomes one controller subscriber and keeps its layout;
- Watch starts the same controller without requiring the iPhone chat screen to remain mounted;
- transcript saving, provider selection, tool calls, interruption, mute, speaker/input mode, and host authorization stay shared;
- changing computer, ending the chat, revoking voice capability, or changing the live provider ends the active Watch session.

Audio endpoint abstraction:

```ts
interface LiveAudioEndpoint {
  start(options: { inputRate: number; outputRate: number; speaker: boolean }): Promise<void>
  play(pcm16Base64: string): void
  flush(): void
  setMuted(value: boolean): void
  stop(): Promise<void>
  addListener(name: "frame" | "output" | "interrupted", listener: (event: ...) => void): Subscription
}
```

The current native iPhone endpoint implements this interface unchanged. `WatchAudioEndpoint` implements it by forwarding audio to and from the native Watch module. Existing socket providers continue to use the same `MicGate`, VAD, barge-in, interruption, and push-to-talk rules.

For WebRTC-only live voice, add an iOS native `WatchRTC` endpoint around the existing provider negotiation:

- JavaScript still owns `OpenAIRealtime` event handling, tool calls, history, and session lifecycle.
- The native endpoint obtains a WebRTC offer, accepts the host's answer, injects the Watch's PCM16 microphone stream as the local audio track, and forwards remote PCM16 output to Watch.
- The native endpoint emits output levels and interruption events into the same controller state as the socket path.
- The peer and session secrets remain in iPhone memory and are never sent to Watch.

This allows Watch to use the selected full voice provider rather than silently falling back to turn-by-turn transcription. A provider that cannot establish its negotiated transport reports a normal live-voice error and does not switch the Watch session to the phone microphone.

The iPhone gets the `audio` background mode while a Watch-owned live session is active. The existing 30-second background termination rule remains for phone-owned calls; a Watch-owned call is instead bounded by:

- Watch reachability;
- an active audio session;
- iPhone audio interruption;
- explicit end/cancel; and
- the provider's session expiry.

If the Watch disconnects for more than three seconds, the iPhone stops capture and output immediately. It may retain chat/transcript state, but audio does not resume automatically; the user must start a new voice session after reconnecting.

### Watch audio engine

`WatchVoiceEngine` owns one `AVAudioEngine`:

- capture 16 kHz mono PCM16 frames;
- voice-processing echo cancellation while available;
- local playback through the Watch's current audio route;
- approximately 20-40 ms chunks;
- no silent chunk amplification;
- 700 ms maximum outbound playback buffer, flushed on interruption.

Audio packets contain protocol version, session ID, sequence, sample rate, sample count, and PCM bytes. Invalid or stale packets are ignored. Packet flow-control drops the oldest packet only; it never replays stale speech.

## Apple Music Device Capability

### Permission model

Add `music` to `DeviceSource`. It is off by default and supports:

| Level | Operations |
| --- | --- |
| Read | now playing, library search, catalog search, recent songs, playlists |
| Interact | all read operations plus play, transport controls, create playlist, add songs to playlist, and add catalog items to library |

The Music row in **Tools > Device access** requests `MusicAuthorization` only after an explicit press. iOS denial keeps the source switch unchanged and links to Settings. MusicKit service failure is not represented as an empty successful search.

`NSAppleMusicUsageDescription` explains that Botkins lets an enabled Botkin use Apple Music. The App ID must have MusicKit enabled for catalog access. No developer token or private key is stored in the repository.

### Tool contract

Keep the host and phone tool tables synchronized by following the existing one-tool-per-operation shape:

| Phone tool | Level |
| --- | --- |
| `phone_music_now_playing` | read |
| `phone_music_search` | read |
| `phone_music_library` | read |
| `phone_music_play` | interact |
| `phone_music_control` | interact |
| `phone_music_create_playlist` | interact |
| `phone_music_add_playlist` | interact |
| `phone_music_add_library` | interact |

Use Bighelp's validated MusicKit semantics:

- kinds: `song`, `album`, `playlist`, `artist`
- sources: `catalog`, `library`
- search limit 1-25 per kind, interleaved across requested kinds
- library limit 1-50
- search text 1-200 printable characters
- IDs up to 512 characters
- playlist name 1-100 and description up to 300 characters
- playlist item list up to 100
- playback controls: `pause`, `resume`, `next`, `previous`, `stop`
- artist search results can be played from top/library songs, but artists cannot be added to the library

Catalog playback and adding catalog items require an active Apple Music subscription; library search and playback work without one. `canPlayCatalogContent` is checked before the operation, then surfaced as a stable `subscription_required` device-tool error when false.

### Native module and JavaScript runners

Add `modules/botkins-music/` as a local Expo module. The module wraps MusicKit only:

- `authorization`
- `requestAuthorization`
- `canPlayCatalog`
- `search`
- `library`
- `nowPlaying`
- `play`
- `control`
- `createPlaylist`
- `addToPlaylist`
- `addToLibrary`

Add `mobile/src/device/music.ts` for argument validation, answer shaping, and the runner table. Add `mobile/src/features/device/sources.ts` for Music UI/permissions.

Before every native operation, the runner checks the current app source level and iOS authorization. Mutating operations also pass a native grant revision. If the person turns Music off during a catalog lookup, the revision check runs immediately before setting the SystemMusicPlayer queue or changing a library object. This prevents a slow lookup from crossing a revoked consent boundary.

Results are bounded and contain only stable IDs, kind, source, short printable metadata, playback state, and position. Raw MusicKit objects and system errors are never returned to the agent.

## CarPlay Live Activity

Add `.supplementalActivityFamilies([.small])` to `BotkinsWidgets`.

Add `BotCardSmall` and the legacy chat equivalent to the existing widget target. `BotkinLiveActivity` reads `@Environment(\.activityFamily)`:

- `.small` renders one compact row and one secondary line;
- the existing default rendering remains unchanged on iPhone Lock Screen and Dynamic Island.

For a Botkin card:

1. prioritize a chat that needs the person;
2. otherwise use the first running/thinking chat;
3. otherwise show the latest completed chat.

The compact card uses only already-public Live Activity state plus the existing decrypted title when available. It does not render `AskButtons` or any App Intent. The card URL still targets the selected chat or Botkin through the existing `Links` helpers.

## App Intents and Shortcuts

Extend `mobile/plugins/shortcuts/` rather than adding another native shortcut stack.

### Entities

- Keep `ShortcutAgent` compatible with saved shortcuts and its `host|bot` stable identifier.
- Add `ShortcutHost` with saved pairing IDs and display names.
- Add a host-filtered agent query for `ChatWithBotkin`; the existing `SendBotkinsChat` query keeps its current selection behavior.
- Invalid, removed, or unpaired IDs fail with a plain sentence and do not switch hosts.

### Actions

Add:

- `OpenBotkins`
  - `openAppWhenRun = true`
  - no bridge request
- `ChatWithBotkin`
  - `openAppWhenRun = true`
  - parameters: `computer`, `agent`, `chat` (`Latest` / `New`)
  - sends an `open` request to the existing Shortcut bridge after React/navigation is mounted

Preserve:

- `SendBotkinsChat`
- `StartBotkinsVoiceChat`

The JavaScript shortcut bridge gets an `open` action separate from `send` and `voice`. It:

1. validates that the selected pairing still exists;
2. switches computer with `switchComputer`;
3. waits for synchronization;
4. validates that the selected agent is still available;
5. selects the latest one-to-one chat or calls `createChat`;
6. calls the existing `showChat`; and
7. returns only after navigation has been initiated.

This reuses `lastOrNewChat` and host switching instead of duplicating chat-selection logic.

## Security and Privacy

- Watch receives no host keys, pairing material, provider credentials, Music tokens, sealed-notification keys, or full chat archive.
- Watch snapshots are bounded and overwritten on each host/chat change. On unpair or app logout, the iPhone clears the Watch application context.
- Audio exists only in memory and is never written as a Watch file.
- A late Watch command from an old session is ignored by session ID and sequence.
- A disconnected Watch cannot silently continue a provider session in the background.
- Music result text is clipped and normalized; system errors are mapped to stable user/agent sentences.
- Turning a device source off immediately revokes queued mutation commits through a native revision check.
- CarPlay compact state uses the same encrypted/filtered Live Activity pipeline and adds no sensitive fields.

## Error Handling

### Watch

| Condition | Behavior |
| --- | --- |
| Phone not reachable | Show `Phone unavailable`; disable voice and retain last display snapshot as stale |
| Protocol mismatch | Show `Update Botkins on your phone or Watch` |
| Pairing removed | Clear conversation, voice state, and avatar |
| Provider session fails | End Watch audio and show the provider's sanitized error |
| Phone audio interruption | Pause/end the endpoint and show `Call paused` or `Call ended` based on recovery |
| Watch audio engine fails | Send an interruption event; iPhone ends the provider session |
| Audio packet gap | Drop the gap; do not backfill; show reconnect/error only when the gap persists |

### Music

| Condition | Error/result |
| --- | --- |
| Music authorization not granted | `Music access is off in iOS Settings.` |
| Music source off/read-only | Existing device-source permission sentence |
| Catalog unavailable | `music_service_unavailable` |
| No subscription for catalog playback/add | `subscription_required` |
| No matching ID/item | `not_found` |
| Switch revoked during lookup | operation returns permission-disabled/outcome-safe failure without committing |
| Native MusicKit failure | stable sanitized `Apple Music could not do that just now.` |

## Testing

Testing begins only after compute frees, as requested. No compile or simulator run is performed during the initial mock/code organization phase.

### Pure TypeScript tests

- Watch snapshot selection: primary Botkin, latest one-to-one chat, host switch, empty state, size clipping, no other host/agent leakage.
- Watch protocol reducers: stale revision, unknown version, old session audio, command validation, disconnect state.
- Shortcut routing: latest/new chat, host switch, stale host, stale agent, active-agent default, existing saved intent compatibility.
- Music argument bounds, enum validation, result clipping/interleaving, source-level rules, and host/phone tool table parity.
- Live voice controller fakes prove that the same transcript/tool/history path is used for iPhone and Watch endpoints.
- Audio fake tests prove old-session frames are rejected, flush stops queued audio, and phone reachability loss ends a Watch session.

### Native tests performed later

- MusicKit provider fakes for every operation and `beforeCommit` revocation.
- Watch protocol data encoding/sequence handling.
- Watch audio engine capture/playback on a real Watch.
- Live voice over Watch for each supported transport class, including WebRTC-only provider negotiation.
- CarPlay `.small` Live Activity snapshots for working, needs-you, done, failed, and stale states.
- Real Music app playback/playlist mutation on an authorized iPhone.
- Four App Intents from the Shortcuts app and their saved-parameter migration.

### Manual acceptance criteria

- Watch shows the primary avatar and the latest conversation while iPhone is foregrounded and backgrounded.
- A Watch voice session records on Watch, shows live transcript/state, plays response audio on Watch, interrupts and mutes correctly, and ends cleanly.
- Taking iPhone or Watch out of reach cannot leave provider audio running invisibly.
- Agents can search Apple Music, start playback, and create/modify a playlist only at the matching permission level.
- CarPlay shows the small Live Activity without approval controls or text entry.
- Both old Shortcuts still work. The two new Shortcuts open the correct pairing, Botkin, and latest/new chat.

## Implementation Organization

Keep the implementation in logical directories but one PR:

```text
mobile/targets/watch/
mobile/modules/botkins-watch/
mobile/modules/botkins-music/
mobile/src/features/watch/
mobile/src/features/voice/live/
mobile/src/features/shortcuts/
mobile/src/device/music.ts
mobile/src/state/watch.ts
mobile/targets/widgets/BotCard.swift
mobile/targets/widgets/BotkinLiveActivity.swift
mobile/plugins/shortcuts/
mobile/link-host/device.mjs
```

The implementation order is:

1. protocol and state reducers;
2. shared voice-controller extraction plus fake endpoint tests;
3. Music permission/tool contract;
4. native Watch and MusicKit modules;
5. CarPlay small Live Activity view;
6. Shortcuts entities/actions;
7. signing/export/documentation updates;
8. later typecheck, tests, native build, real-device validation, commit, and PR.

All work remains on `feat/apple-device-surfaces` and lands in one monolithic pull request.
