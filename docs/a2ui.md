# A2UI 1.0 in Botkins

Botkins supports the [A2UI v1.0](https://a2ui.org/specification/v1.0-a2ui/) protocol so any bot turn, workflow Output step, routine, or task result can render interactive UI directly inside a chat on both desktop and mobile, and route user interactions back to the host.

## What is supported

- **Protocol version:** A2UI `1.0` (`createSurface` with optional inline `components` and `dataModel`, `updateComponents`, `updateDataModel`, `deleteSurface`). Per v1.0, `createSurface` must not carry `theme`; Botkins styles surfaces natively with its own light/dark theme tokens.
- **Basic Catalog (`https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`):**
  - **Display:** `Text`, `Image`, `Icon`, `Divider`, `Video` (safe external link), `AudioPlayer` (safe external link)
  - **Layout:** `Row`, `Column`, `List` (static child IDs and `{ componentId, path }` data templates), `Card`, `Tabs`, `Modal`
  - **Inputs & Actions:** `Button`, `TextField` (`shortText`, `longText`, `number`, `obscured`), `CheckBox`, `ChoicePicker` (`mutuallyExclusive` / `multipleSelection`, `checkbox` / `chips`, `filterable`), `Slider`, `DateTimeInput`
- **Dynamic bindings & catalog functions:** `{"@path": "/pointer"}`, `{"@call": ...}` (`required`, `regex`, `length`, `numeric`, `email`, `formatString`, `formatNumber`, `formatCurrency`, `formatDate`, `pluralize`, `openUrl`, `and`, `or`, `not`, `@index`), and input `@checks`.
- **Bot tool (`render_ui`):** Bots can create surfaces and later refresh a surface they previously posted in the same chat via `updateDataModel` or `updateComponents`.
- **Workflows:** Chat Output steps accept an `a2ui` payload (templated with `{{field}}` tokens) alongside the action card config, configurable in both the desktop and mobile workflow inspectors.
- **Action routing (`chat.a2uiAction` / `chat.cardAction`):**
  1. **Built-in actions (`dispatch`, `dismiss`):** Owner-only, matching workflow action cards.
  2. **Workflow surfaces:** Optional `onAction: "resume"` (resumes a waiting approval step) or `onAction: "trigger"` (triggers the workflow with the action payload as input).
  3. **Bot surfaces:** Starts a follow-up turn for the owning bot in that chat carrying the resolved action event and (when `sendDataModel: true`) the current `dataModel`.
  - Actions are idempotent per `(surfaceId, actionId)`.
- **Rich-cards-off fallback:** When rich cards are switched off, Botkins displays a plain-text summary extracted from the surface plus its interactive action buttons.

## Security model

- Every surface payload is treated as untrusted model output and validated on the host against the A2UI v1.0 envelope and Basic Catalog schemas with strict component count, nesting depth, and byte caps.
- No scripts, arbitrary HTML, or unconfirmed network requests are executed. External URLs (`openUrl`, `Video`, `AudioPlayer`) go through Botkins' existing `openLink` confirmation flow, and images allow only `http://`, `https://`, or safe `data:image/*` URLs.
- Returning action payloads are framed as structured user input data (never system instructions) and follow chat membership / owner permissions.

## Left out of this initial v1.0 release

- Bidirectional RPC `callRendererFunction` / `callAgentFunction` execution loops (envelope messages are schema-validated; interactive events use `action`).
- Custom third-party component catalogs beyond the A2UI v1.0 Basic Catalog.
- Inline native video/audio playback widgets (rendered as safe link cards using `openLink`).
