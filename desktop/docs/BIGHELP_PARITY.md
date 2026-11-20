# Bighelp parity

Botkins is the native counterpart of Bighelp, built on the GitHub Copilot SDK 2.0 (behind a model provider layer, `desktop/providers/`) instead of a Hermes host. This file compares the two apps and tracks the Bighelp functionality that Botkins brings over.

Reference: Bighelp `main` at `6309de48` (2.6.93). Paths starting with `B/` are under `Bighelp/` in that repository.

## Ground rules

- **Keep Botkins' interface.** Botkins keeps its own layout, colors and type. Bighelp supplies behavior and features, not its look.
- **No Hermes.** Nothing depends on a Hermes host, Hermes rooms, the Bighelp plugin, Link pairing or APNs. Each feature runs on the Copilot SDK and local data in the Electron main process.
- **Out of scope:** iPhone device tools, CarPlay, Watch, Live Activities, Vision Pro, multi-computer fleet, Credential Vault and Hermes personalities. Bighelp retired its Wiki; Botkins has its own (see Status).

## What already matches

| Area | Botkins today |
|---|---|
| Places | Home, Today, Chats and Work, with a sidebar |
| Bots | Create and edit name, role and instructions; per-bot model default |
| Chat | Streaming replies, Markdown, a stop button, a tool activity trail, inline `render_card` cards |
| Composer | `/` menu of commands, skills and tools; model and thinking picker; `/btw` side questions |
| Approvals | Allow once, Allow for this chat, Deny; clarifying questions; MCP forms |
| Today | Bot-published panels (metric, Markdown, list, table, bars) with cron routines, sizes and hiding |
| Work | Requests and refreshes with All, Working, Needs you and Completed filters |
| Settings | Appearance, approval level, clarifying-question rules, capability sources, cache |

## Status

| Area | State | Where |
|---|---|---|
| Avatars | Done, with Botkins instead of Bighelp's bodies: a bot is one of the design kit's 20 characters in one of 7 palettes, kept on the bot (`bot.look`); Bot Studio has a live preview and Surprise me; the Botkin acts out what the bot is doing (idle, thinking, planning, looking things up, coding, working, replying, waiting for you, finished or failed); reduced motion | `desktop/looks.mjs`, `src/botkins.ts`, `src/Avatar.tsx`, `src/BotStudio.tsx`, `design/botkins-kit` |
| Agent management | Done: primary bot, pins, hiding, sections, bot menu, bot page, templates, duplicate, delete; chat groups, unread, pin, rename, archive, delete | `desktop/agents.mjs`, `src/Pages.tsx`, `src/BotProfile.tsx`, `src/BotForm.tsx` |
| Thinking and chat canvas | Done: reasoning, work summary, tasks, background helpers, queue and Send now, attachments, copy, reply, fork, Try again, Scroll to latest message, context meter and Compact, starter prompts | `desktop/canvas.mjs`, `src/ChatView.tsx`, `src/ChatActivity.tsx`, `src/Composer.tsx` |
| Routines | Done: routines for any bot with a cadence picker, run now, pause, edit, duplicate, runs; bot routine tools; Work counts and Upcoming | `desktop/routines.mjs`, `desktop/schedules.mjs`, `src/Routines.tsx`, `src/Work.tsx` |
| Notifications and usage | Done: desktop notifications with quiet hours; usage by day, model and bot with CSV export | `desktop/notify.mjs`, `desktop/usage.mjs`, `src/Usage.tsx` |
| Feed, Ideas and Goals | Done: bot board tools, Today panel, answers and feedback | `desktop/board.mjs`, `src/Board.tsx` |
| HTML apps | Done: `show_app` and `update_app` tools, sandboxed app window, data bridge, answers into the message box | `desktop/apps.mjs`, `desktop/app-window.mjs`, `desktop/app-preload.cjs` |
| Group chats | Done: 2–6 bots, each in its own Copilot session, catching up on the others; @mentions; per-member labels and typing | `desktop/groups.mjs`, `src/NewChat.tsx`, `src/ChatView.tsx` |
| Coding sessions and Project Changes | Done: project folders, Default, Plan and YOLO modes, changed files, diffs, Commit | `desktop/projects.mjs`, `src/ProjectChanges.tsx` |
| Projects and access | Done (Botkins only): project workspaces with chats, panels, to-dos and an optional folder; per-bot access with a global switch, enforced in the main process | `desktop/projects.mjs`, `desktop/access.mjs`, `src/Projects.tsx`, `src/AccessSettings.tsx`, `src/BotAccess.tsx` |
| Tasks | Done: Kanban lanes, dispatcher, review and approve, bot task tools | `desktop/tasks.mjs`, `src/Tasks.tsx` |
| Teamwork | Done: the behavior of Bighelp's Teamwork switch, built natively. A bot is told its team and asks a teammate with `ask_teammate`; the teammate answers from its own session and sees only the message. The chat shows a row per ask with live status and the exchange. One switch for the app, an opt-out per bot, project access respected, eight asks per reply, no chains. Nothing from Hermes (`message_agent`, profiles, the plugin) is used | `desktop/teamwork.mjs`, `src/TeamRail.tsx`, Settings → Teamwork |
| Memory | Done (Botkins only): one `MEMORY.md` per bot, read at the start of every conversation and kept with `memory_save`, `memory_forget` and `memory_read`; editable on the bot's page | `desktop/memory.mjs` |
| Skills and MCP servers | Done (Botkins only): managed once in Settings for every bot, with a per-bot off switch; skills written in the app, copied in or linked; MCP servers added by form or imported from JSON, with a connection test; secret values never reach the page | `desktop/integrations.mjs`, Settings → Skills, Settings → MCP servers |
| Mentions | Done (Botkins only): `#` projects, wiki pages and workspace files in the composer, and `@` to address a bot in a group chat, resolved and access-checked in the main process | `desktop/mentions.mjs`, `src/Composer.tsx` |
| Wiki | Done (Botkins only): a shared Markdown wiki in `<data>/wiki` in the LLM-wiki pattern: a guide (`WIKI.md`), a catalog (`index.md`) and a change log (`log.md`) that Botkins keeps, sections as folders with a template each, links in both directions, earlier versions and a trash. People edit pages in a rich editor; bots use `wiki_search`, `wiki_read`, `wiki_write`, `wiki_edit` and `wiki_organize`, and may reshape sections, templates and the guide. A bot limited to some projects uses only pages about them, and the wiki is read-only in routines, tasks, panel refreshes and for a helping teammate | `desktop/wiki.mjs`, `src/Wiki.tsx` |
| Markdown in chats | Done: GitHub-flavored Markdown (tables, task lists, strikethrough, footnotes, callouts), code blocks with a language label, colors and Copy; no raw HTML and no remote images | `src/RichText.tsx`, `src/markdown.css` |
| First run | Done (Botkins only): a new workspace has no bots; the person's Copilot agents in `~/.copilot/agents` are offered as bots, and with none the Create a bot form opens | `desktop/providers/copilot/agents.mjs`, `desktop/agents.mjs`, `src/FirstBot.tsx` |
| MCP sign-in and the credential vault | Done (Botkins only): remote MCP servers sign in with an API key, custom headers or OAuth (discovery, dynamic registration, PKCE on a loopback address, renewal); every secret is encrypted in a vault whose key the system keychain guards; Settings › Credentials lists what is stored without showing it | `desktop/vault.mjs`, `desktop/oauth.mjs`, `desktop/integrations.mjs`, `src/McpSettings.tsx` |
| Html blocks | Done (Botkins only): a Today panel or chat card can hold a page the bot wrote, drawn in a sandboxed frame with no network and a small bridge (data, colors, text for the message box, links with a confirmation), in the spirit of MCP Apps | `desktop/frames.mjs`, `desktop/panels.mjs` |
| Wiki export | Done (Botkins only): the whole wiki, a project or a page with what is related, as Markdown in a zip, one web page or a PDF | `desktop/wiki.mjs`, `desktop/zip.mjs` |
| Side menu | Done (Botkins only): the places can be rearranged in Settings, and the menu collapses to icons | `desktop/preferences.mjs`, `src/app.tsx` |
| Link previews and read aloud | Done: opt-in, visible links only, public addresses checked at connect time; per-message Read aloud and auto read-aloud | `desktop/linkpreview.mjs`, `src/Extras.tsx` |
| Card elements | Done: progress, badges and line charts in cards and panels | `desktop/panels.mjs`, `src/Today.tsx` |
| Not brought over | Space drafts (a bot drafts a panel and you add it): Botkins keeps publishing directly. Live voice chat with speech recognition: no provider without Hermes; macOS dictation works in the composer. Bighelp's Workflows engine and Dev Factory. Credential Vault and Composio connect flow: Botkins uses MCP sources instead. | |

## Gaps, by priority

### 1. Avatars

| Bighelp | Botkins gap | Copilot SDK basis |
|---|---|---|
| Bot Studio silhouette bodies in sets, with palette, colorways, eyes and mouth (`Bighelp/Resources/BotBodies.json`, `BotLookRenderer.swift`) | None. Bots are Botkins, not silhouette bodies: 20 characters and 7 palettes from the design kit, with no colorways, eyes or mouth to set | None needed |
| Avatar states follow the bot: idle, listening, thinking, waiting, talking, happy, sleeping | None. A Botkin acts out what its bot is doing, and shows a finished or failed reply for a moment | Turn, tool and request events |
| Avatar chooser with Surprise me and a color picker (`B/Agents/AvatarChooserView.swift`, `BotStudioView.swift`) | None. Bot Studio picks a character and a palette, with a live preview and Surprise me; there is no free color picker | None needed |
| Working and needs-you states in bot rows and the sidebar | None | Turn and request events |

### 2. Thinking and the chat canvas

| Bighelp | Botkins gap | Copilot SDK basis |
|---|---|---|
| Reasoning block: "Thinking…" live, then "Thought for 12s", folded at 6 lines with Show more (`B/Chat/ChatReasoningMessageView.swift`) | Reasoning is not shown | `assistant.reasoning_delta`, `assistant.reasoning` |
| Work display: a live card with the newest steps, folded to "Worked for 2m 14s · 7 steps" with a plain summary (`B/Chat/ChatLiveWorkView.swift`, `ChatCompletedTurnPresentation.swift`) | A flat list of tool calls | `tool.execution_*` |
| Tasks rail above the composer: "3/5" with a drawer of pending, in-progress, done and cancelled items (`B/Chat/SessionTasksSheet.swift`) | None | `session.todos_changed`, `session.plan.readSqlTodosWithDependencies()` |
| "In the background" roster of helpers (`B/Chat/SessionSubagentRosterSheet.swift`) | None | `subagent.started`, `.completed`, `.failed` |
| Send while a bot works: queue or steer | Composer is locked during a turn | `send({mode:"enqueue"})` |
| Attachments: files by picker, paste or drop, shown as a tag above the box | None | `MessageOptions.attachments` |
| Message actions: Copy, Reply (quote), Fork from here, retry a failed turn (`B/Chat/ChatMessagePresentation.swift`) | Only `/copy` | `rpc.sessions.fork` |
| "Scroll to latest message" button; the view follows the tail only while at the bottom (`docs/CHAT_INTERACTION_CONTRACT.md`) | Always scrolls to the end | None needed |
| Usage and context window meter, Compact (`B/Chat/ChatCompaction.swift`) | None | `assistant.usage`, `session.usage_info`, `/compact` |
| Empty chat: "What can Bot help with?" with starter prompts | A bot name and role only | None needed |

### 3. Agent management

| Bighelp | Botkins gap |
|---|---|
| Primary bot, pinned bots, hidden bots (`B/SimpleBots/SimpleBotsHomeView.swift`) | None |
| Sections as folders of bots (`B/SimpleBots/SimpleBotsSections.swift`) | None |
| Right-click menu on a bot: New chat, Pin, Move to section, Bot page, Duplicate, Hide, Delete | Click opens the latest chat only |
| Bot page: avatar, name, role, about, instructions, model, capabilities, routines, chats (`B/SimpleBots/SimpleBotProfileView.swift`) | Settings tabs per bot |
| Templates when creating a bot | None |
| Search bots with All, Pinned and Hidden | None |
| Chats: Pinned, Today, Yesterday and Earlier groups; unread dots; Unread filter (`B/Home/Chats/ChatsInboxProjection.swift`) | One list with search |
| Chat menu: Pin, Mark unread, Rename, Archive, Delete; Archived chats (`B/Home/Chats/ChatsInboxView.swift`) | None |
| Working and needs-you lines in bot and chat rows (`B/Agents/BotChatActivity.swift`) | None |

### 4. Routines

| Bighelp | Botkins gap |
|---|---|
| Scheduled tasks for any bot, not only panels (`B/Scheduling/ScheduledTaskModels.swift`) | Routines exist only on Today panels |
| Cadence picker: Once, Daily, Weekdays, Weekly, Custom (`B/Scheduling/ScheduledTasksView.swift`) | Raw five-field cron text |
| List with Up next, Paused and Finished; Run now, Pause, Edit, Delete, Duplicate for another bot | Panel menu only |
| Runs history, each run a chat (`B/Scheduling/ScheduledTaskRunsView.swift`) | Panel refresh chat only |
| Bots create and change routines on request | Only `today_routine` for panels |
| Failed runs count as Needs you; upcoming runs listed last in Work (`B/Work/WorkProjection.swift`) | Runs only |
| Notifications for finished routines and requests, with quiet hours (`B/Notifications/BighelpQuietHours.swift`) | None |

### 5. Later

| Bighelp | Notes |
|---|---|
| Group chats of 2 to 6 bots with @mentions (`B/BotMode/`) | Needs a local multi-session runner; Hermes rooms are not used |
| Feed, Ideas and Goals on Today (`B/Today/TodayBoardsPanel.swift`, `B/Board/`) | Bot tools that write to a local board |
| Space drafts: a bot drafts a panel in chat and the person adds it (`B/Spaces/SpaceDraftCardView.swift`) | Changes today's publish-directly model |
| Coding sessions: bot plus project folder, Plan and YOLO modes, Project Changes with git diff (`B/Code/`, `B/Chat/ProjectChangesView.swift`) | `workingDirectory`, `agentMode`, local git |
| Kanban tasks assigned to bots (`B/Kanban/`) | Local board and a dispatcher |
| HTML apps from bots (`docs/HTML_APPS.md`) | Sandboxed window and a `show_app` tool |
| Cards v1 elements beyond Botkins' blocks: progress, badge, line and area charts (`docs/BIGHELP_CARDS.md`) | Extends `render_card` |
| Usage page with 7, 30 and 90 day totals by model and bot (`B/Usage/UsageView.swift`) | From recorded `assistant.usage` |
| Voice: read replies aloud | `speechSynthesis`; macOS dictation already works in the composer |
| Link previews | Fetch in the main process; never fetch private hosts |
