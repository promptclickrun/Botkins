# The side pane, opened by a bot

A bot can open the pane beside a chat and show a panel in it: a page it wrote (a rich UI), a table, a website, or the Screen panel. This file is the contract between the desktop app (which holds the state and gives bots the tools) and every screen that shows a chat: the desktop window, a paired phone, and another computer paired to this one.

The code is `desktop/sidepane.mjs` (state and tools), `desktop/webviewer.mjs` (the website viewer's guards) and `src/SidePane.tsx` (the pane in the window). The app lists the capability `"side-pane-v1"`.

## State

Each chat carries its pane in the app's state, so every client sees the same tabs:

```ts
type Chat = {
  // …
  pane?: {
    panels: PanePanel[];          // the tabs, oldest first. At most 8.
    active: string | null;        // the id of the tab in front, or null for the chat's own Details
    ask?: {                       // the latest time a bot asked something of the pane
      seq: number;                // goes up by one with every ask
      panelId?: string | null;    // the tab to show (null: Details)
      close?: true;               // the bot asked for the pane to close instead
      runId: string;              // the turn that asked
      botId: string;              // the bot that asked
      at: number;                 // when (ms since 1970)
    };
    closed?: { runId: string | null; at: number };   // the person closed the pane (runId: the turn that was running, if any)
  };
};

type PanePanel = {
  id: string;
  kind: "rich_ui" | "table" | "web" | "screen";
  title: string;                  // for the tab
  botId: string;                  // the bot that opened it
  createdAt: number;
  updatedAt: number;
  pinned?: true;                  // the person pinned it
  unseen?: true;                  // added while the person couldn't see it (pane closed by them, or another tab pinned in front)
  frame?: string;                 // rich_ui: the id of the stored page, the same kind of view as an html block (custom view)
  columns?: string[];             // table
  rows?: string[][];              // table: every row as wide as `columns`
  url?: string;                   // web: an http or https address
};
```

## What a client does

- **Tabs.** Show the chat's own Details first, then one tab for each panel, with its title and the name or avatar of the bot that opened it (`botId`). `active` says which is in front. A tab with `unseen` gets a mark until the person looks at it.
- **Opening.** When `pane.ask.seq` goes up for the chat that is on the person's screen, and `ask.close` is not set, open the pane and show `ask.panelId`. Only the client the person is using for that chat reacts: a client that doesn't have the chat on screen does nothing, and when the person opens that chat later the tabs are simply there. A client seeing a chat for the first time treats the `seq` it finds as already handled, unless the turn that asked (`ask.runId`) is still running.
- **Closing on request.** When `seq` goes up with `ask.close`, close the pane (the tabs stay).
- **The person's choices go back to the app** through one call, `sidePane(chatId, action, panelId?)`:
  - `"select"` with a panel id, or with no id for Details: the tab the person chose.
  - `"remove"`: the person closed a tab. The panel is gone for every client.
  - `"pin"`, `"unpin"`: a pinned tab is never dropped to make room, and a bot's new panel doesn't take its place in front.
  - `"closed"`: the person closed the pane. For the rest of the running turn no bot opens it again; a new panel waits as a tab with `unseen`.
  - `"opened"`: the person opened the pane themselves.
- **Never reopen in a loop.** A client doesn't open the pane except on a rise of `seq`. The app doesn't raise `seq` while `closed.runId` is the running turn.

## What each kind shows

### Artifacts

Open **Artifacts** beside **Details** to see files the bot wrote, uploads to the chat, `MEDIA:` attachments it sent and exports. Group chats also have the Artifacts tab. Select **This chat** or **All of this bot’s chats** and filter by **All**, **Files** or **Media**. Files includes folders. Media includes images, video and audio. Select an item for a quick preview. **Open** or a double-click uses the local OS handler. **Show in folder** reveals it, and **Go to message** selects the source conversation and message when known.

Each row is labeled **Written**, **Sent**, **Uploaded** or **Exported**. A file the bot writes and later sends appears twice. Each row links to its own source message when available.

Botkins stores the index in the workspace data directory. Successful write and edit tools supply file paths. During a shell command, Botkins watches its working directory and checks recently changed files when the command finishes. Concurrent commands with ambiguous authorship are skipped. In replies, a `MEDIA:` reference must point into the bot or project workspace, or to a file already shared with that bot. An export without an open chat belongs to its bot when known, otherwise to the primary bot.

Paired clients use the `artifacts-v1` capability. `artifacts.list({ botId, chatId?, kind?, folder?, cursor? })` returns up to 50 entries and a cursor. A folder id lists its direct children. `artifacts.read(idOrIndexedPath, { offset?, length? })` returns base64 in chunks up to 512 KiB. `artifacts.thumbnail(id, { size? })` returns a bounded JPEG or PNG, or null when unavailable. `artifacts.resolve({ chatId, paths })` returns an ordered entry or null for up to 20 paths. The phone can read indexed artifacts and children of shared folders. OS open and reveal actions belong to the local desktop.

Existing standalone local paths in chat become clickable after a main-process check. Click opens the file or folder. Executables, application bundles and unfamiliar file types are revealed. Right-click or Command/Ctrl-click opens **Show in folder**, **Preview in Artifacts** and **Copy path**. A remote workspace resolves paths against its own index. Both clients use the [shared path-detection cases](path-detection.json).

| Kind | Desktop window | Phone (suggested) |
| --- | --- | --- |
| `rich_ui` | The stored page in the app's sandboxed frame (`HtmlFrame`): scripts only, no network, the same rules as an html block. Its answers go to this chat's message box. | A sheet with the same view the phone already shows for custom views (`link.frame`). |
| `table` | A table that scrolls in both directions. Cells are plain text. | A sheet with the table. |
| `web` | The website viewer: a guest page with its own in-memory storage, no access to the app, http and https only, no local-network addresses, no new windows, no downloads, no permissions. A bar shows the address, with back, forward, reload and "Open in browser". | The system's in-app browser (a Safari sheet) on the address. |
| `screen` | The Screen panel: whether a phone may view or control this computer's screen, with the same switch and the same system permission rows as Settings › Phone. A bot can only show it. | The phone's own Screen view, behind its own gate. |

## The tools a bot gets

Offered in a turn the person is there for (not a routine, a task, a Today panel refresh or a helping teammate).

| Tool | Asks first? | Arguments | Answer |
| --- | --- | --- | --- |
| `side_pane_show` | Never | `kind`: `"rich_ui"` \| `"table"` \| `"screen"` \| `"details"` (required); `title`; `html`, `data` (rich_ui); `columns`, `rows` (table) | `{ id, kind, title, opened, note? }` |
| `side_pane_web` | By the chat's approval setting, like any tool that reaches the network | `url` (required); `title`; `id` to send a web panel the bot opened to another address | `{ id, kind: "web", title, url, opened, note? }` |
| `side_pane_update` | Never | `id` (required); `title`; `html`, `data`; `columns`, `rows` | `{ id, kind, title, updated: true }` |
| `side_pane_close` | Never | `id` to close one panel the bot opened; nothing to ask for the pane to close | `{ closed, left }` |
| `side_pane_list` | Never | none | `{ panels: [{ id, kind, title, url?, pinned?, in_front?, yours }], closed_by_person }` |

Rules the tools keep:

- `opened: false` with a `note` when the person closed the pane during this turn: the panel is a tab, and the pane stays closed.
- A bot changes and closes only the panels it opened. The person closes anything.
- A chat keeps at most 8 panels. The oldest one that isn't pinned makes room. One reply shows at most 8.
- A rich UI is limited like an html block (300,000 characters of page, 200,000 of data). A table has at most 12 columns and 200 rows of text, 500 characters a cell.
- A website's address is checked before anything is kept: http or https, no user name or password in it, not on the local network (a name is looked up first). This computer's own addresses (localhost) are allowed, for a site the bot is building.
- `screen` holds no setting. No tool reads or changes who may see or use the screen.

## Not there

The desktop app has no browser control (a bot driving a browser), so there is no panel for it and no tool pretends to offer one. The website viewer is for the person to look at a page; a bot can't read or click in it.
