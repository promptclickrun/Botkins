# A2UI 1.0 in Botkins

Botkins supports **A2UI 1.0** (`https://a2ui.org/specification/v1.0-a2ui/`) as a first-class way for bots, workflows, routines, and tasks to post interactive, data-bound UI directly into any chat on desktop and mobile.

## Supported Catalogs

Both catalogs are advertised in `render_ui` and in Link `Meta.a2uiRendererCapabilities` (`renderer_capabilities.json` v1.0):

1. **A2UI Basic Catalog** (`https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`):
   - **Display:** `Text`, `Image`, `Icon`, `Video`, `AudioPlayer`, `Divider`
   - **Layout:** `Row`, `Column`, `List` (static child IDs or `{ componentId, path }` data templates), `Card`, `Tabs`, `Modal`
   - **Inputs & Actions:** `Button`, `TextField`, `CheckBox`, `ChoicePicker`, `Slider`, `DateTimeInput`
2. **Botkins Catalog v1** (`https://botkins.app/a2ui/catalog/v1.json`, mirrored in `desktop/desktop/link/a2ui-botkins-catalog.json` and `mobile/link-host/a2ui-botkins-catalog.json`):
   - `BotAvatar`, `Badge`, `StatusBadge`, `Metric`, `Progress`, `Chart` (`bar` and `line`), `Table`, `TaskCard`, `ApprovalCard`
   - Functions: `copyToClipboard`, `getThemeMode`, `computeSummary`
3. **Custom & Inline Catalogs:**
   - Mix components from multiple catalogs in one surface via `createSurface.catalogId` and per-component `@catalogId`.
   - Attach inline catalog definitions (`$schema`, `$id`, `catalogId`, `components`, `functions`) via `render_ui({ messages, inlineCatalogs })`.
   - Unknown catalogs or components automatically fall back to a safe plain-text summary + clickable action buttons and never crash.

## Bot Tools (`render_ui` and `a2ui_respond`)

- **`render_ui`**: Sends an array of A2UI v1.0 envelope messages (`version: "1.0"` with `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`, `callRendererFunction`, or `agentFunctionResponse`).
  - Surfaces attach to chat messages (`message.a2uiSurfaces`), stay scoped to that chat, and are deleted when the chat is deleted.
  - A bot can update or delete surfaces it previously posted in the same chat; other bots cannot mutate them.
  - No `theme` property on `createSurface` (v1.0): Botkins applies its own light/dark theme tokens.
- **`a2ui_respond`**: Replies to a `callAgentFunction` request using the exact `functionCallId` and either `value` (validated against the catalog's declared `returnType`) or `error`.

## Two-Way Function Calls

Botkins supports bidirectional A2UI v1.0 function RPC over Link (`chat.a2uiFunction`):

- **Agent → Renderer (`callRendererFunction` → `rendererFunctionResponse`):**
  - The renderer executes only functions declared in active catalogs (`Basic`, `Botkins`, or inline catalogs).
  - Side-effecting functions (`openUrl`, `copyToClipboard`) still require explicit confirmation / user activation.
  - Responses are validated against the declared `returnType`, correlated by `functionCallId`, idempotent on replay, and timed out cleanly if unanswered.
- **Renderer → Agent (`callAgentFunction` → `agentFunctionResponse`):**
  - Routes to a workflow resume/trigger (for workflow-backed surfaces) or a follow-up bot turn with arguments framed as untrusted user data.
  - Bot replies via `a2ui_respond` (or `render_ui` with `agentFunctionResponse`) are schema-checked against `returnType` and deduplicated per `functionCallId`.

## Inline Video & Audio Players

- **Desktop:** Native HTML5 `<video controls playsInline preload="metadata">` and `<audio controls preload="metadata">`.
- **Mobile:** `AudioPlayer` uses `expo-audio` (already bundled for voice) and `Video` uses `react-native-webview` inline HTML5 `<video controls playsinline>` with `mediaPlaybackRequiresUserAction` (zero new native dependencies).
- **Safety & UX:** Only `https://` and Botkins-served media URLs are played inline (`data:video/*`, `file:`, `javascript:`, and arbitrary `http:` URLs are rejected and fall back cleanly). No autoplay with sound, and a global single-active-player coordinator pauses any previously playing clip when a new one starts.

## Security & Access Control

- **Action & Function Trigger ACL:** By default, only the host owner's tap on a bot surface can trigger a follow-up bot turn. Surfaces can explicitly opt shared chat members in via `allowMembers: true` (member triggers are rate-limited per surface). Built-in `dispatch` and `dismiss` actions are always strictly owner-only.
- **Idempotency:** Actions are deduplicated per `(surfaceId, actionId)` and function calls per `functionCallId`.
- **Untrusted Input Framing:** Action payloads and `callAgentFunction` arguments sent into bot turns are framed explicitly as untrusted user data, never system instructions.
- **Rich-Cards-Off Fallback:** When rich cards are turned off (or an unknown catalog is encountered), surfaces render a plain-text summary with interactive action buttons.

## Workflow Output Steps

Chat Output steps in Workflows accept an `a2ui` configuration alongside `card`, supporting `{{field}}` templates and `onAction: "bot" | "resume" | "trigger"`.

## Screenshots

Light and dark Desktop and Phone mock screenshots are stored in `docs/a2ui/`:
- `docs/a2ui/pr-examples-{desktop,mobile}-{light,dark}.png`
- `docs/a2ui/function-roundtrip-{desktop,mobile}-{light,dark}.png`
- `docs/a2ui/botkins-catalog-{desktop,mobile}-{light,dark}.png`
- `docs/a2ui/inline-media-{desktop,mobile}-{light,dark}.png`
