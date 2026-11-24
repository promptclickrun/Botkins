# A turn in the order it happened (`turn-timeline-v1`)

What the computer sends so a chat reads in the order things happened, shows a turn's helpers and
their own steps, and still says where a turn left off when it ended without a reply. The phone
builds against this (`src/features/chat/turn.ts`, `helpers.ts`; tests in `tests/turn.test.ts`).
The demo computer does all of it (`link-host/mock-backend.mjs`, `timelineTurn`), and acts as an
older computer with `BOTKINS_DEV_TIMELINE=off`.

Everything here is additive. A computer names `turn-timeline-v1` in `meta.capabilities`
(`backend.capabilities`) only when it does all of sections 1 to 5.

**Status (2026-11-19).** The desktop thread agreed to the field names and the capability for its
next change, with the refinements in "Agreed refinements" below; where a refinement and a numbered
section differ, the refinement holds. Desktop 0.15.6 does **not** name `turn-timeline-v1`, so the
phone's fallback (the table "What an older computer sends") stays in use.

## What the desktop app records today (0.15.5)

| What | Today | Where |
| --- | --- | --- |
| A steer | A user message with `steeredRunId` and `time`, pushed when it is delivered. | `desktop/workspace.mjs:720` |
| The reply so far | One string per chat, `task.stream`, sent as `live.streams[chatId]`. Text before and after a step or a steer is in the same string. | `workspace.mjs:88` (`appendStream`), `:317` |
| The reply | One assistant message at the end, **with no `time`**. Copilot gives only the last message's text (`copilot/index.mjs:374`); Claude, Codex and OpenCode join every message of the turn (`claude/index.mjs:276`, `codex/index.mjs:275`, `:450`). Text written before a tool call is lost after the turn on Copilot. | `workspace.mjs:1588` |
| Steps | `run.steps`, each with `started` and `finished`. A helper's own tool calls are recorded too, **without saying whose** (the event's `agentId` is dropped). | `desktop/activity.mjs:19` |
| Thinking | `run.reasoning`, each part with `started`. A helper's thinking is dropped. | `desktop/canvas.mjs:24` |
| Helpers | `run.agents`: `id` (the id of the step that started it), `name`, `description`, `status`, `started`, `finished`, `detail`. A helper's text is dropped. | `canvas.mjs:75`, `workspace.mjs:1529` |
| Requests | `live.requests` while open. Nothing is kept once answered, and a request has no time or run. | `desktop/interactions.mjs:17`, `:54` |
| Can it be steered | `steerable[chatId]` in the snapshot. The link did not carry it; it does now (section 6). | `workspace.mjs:331` |
| A turn that ends without a reply | `run.status` "Needs you" with `detail` = the error (a Copilot turn with no event for 10 minutes: "Copilot session stalled without an event for 600 seconds."); "Interrupted" after a restart that couldn't resume; "Stopped". **The text written so far is dropped** (the task is deleted, no message is pushed). | `workspace.mjs:1664`, `:251`, `copilot/index.mjs:48`, `:282` |
| The run part | `run:<chatId>` is the turn under way, **or the chat's newest turn when it has no reply** (an ended one). | `link-host/parts.mjs`, `runPart` |

## 1. Interim messages (new)

When the bot has written text and then one of these happens, the computer ends that text as a
message of the run, and `live.streams[chatId]` starts again at `""`:

- the turn's own agent starts a step (`tool.execution_start` with no `agentId`);
- a steer is delivered (before the steer message is pushed);
- a request is raised (before it is added to `live.requests`);
- the turn ends without a reply (Needs you, Interrupted, Stopped): what was written stays.

```ts
// a Message in chat.messages
{ role: "assistant"; text: string; runId: string; time: number; interim: true; botId?: string }
```

- `text` is trimmed and never empty. `time` is when its first words arrived (not when it ended).
- A helper's text never becomes an interim message.
- The reply (the run's one non-interim assistant message) holds only what came after the last
  interim message. Copilot's final text is that already. For a provider that joins every message of
  the turn, the computer uses what streamed since the last interim message when that is not empty,
  and the provider's text otherwise. If nothing came after the last interim message, that message
  becomes the reply (its `interim` is removed), so a finished turn always ends with one reply.
- Code that looks for "the reply" must skip interim messages. In this checkout that was
  `runPart` in `link-host/parts.mjs` and `onFinish` in `link-host/push.mjs` (both changed, section
  6). In the desktop app, check at least the group chat's catch-up (`groups.mjs`), `chatSummary.last`
  and the unread mark. Message indexes (Fork from here) count interim messages like any other.

## 2. Answers to requests (new)

When the person answers a request of a turn (not when the turn ended and closed it), the computer
pushes:

```ts
{ role: "user"; text: string; time: number; answer: { runId: string; requestId: string; kind: AgentRequest["kind"]; title: string } }
```

- `title` is the request's `title`. `text` is the answer in the desktop app's words:
  permission "Allow once", "Allow for this chat" or "Deny"; a question its value; a form or a
  secure input "Answered"; a dismissed request "Dismissed".
- **Never a secret.** A question's value is kept only when it is one of its `choices`, or when the
  question does not look like it asks for a secret (the phone's test is `looksSecret` in
  `src/features/chat/request/logic.ts`). Otherwise, and for a `{ $credential }` answer, `text` is
  "Answered". A form's or a secure input's values are never kept.
- It carries `answer.runId`, **not** `runId` (a user message's `runId` means "started this run",
  and `retry` and recovery look for that) and not `steeredRunId` (recovery adds steers to its
  prompt as "The person added during this turn").

## 3. A time on every reply (new)

Every assistant and command message gets `time`: when its first words arrived. Today the reply has
none (`workspace.mjs:1588`, `:1657`). Group replies already have one.

## 4. Helpers (new fields)

```ts
Step     += { agentId?: string }   // the helper (Subagent.id) that ran this step; missing for the turn's own steps
Subagent += { prompt?: string; intent?: string; result?: string }   // each cut to 4000 characters
```

- `agentId` is the id in `run.agents` (the `toolCallId` of the step that started the helper), not
  the provider's own instance id. Copilot sends a helper's events with `agentId` = its instance id;
  its `assistant.turn_start` carries `data.parentToolCallId` (`@microsoft/copilot-sdk`
  `session-events.d.ts`, `AssistantTurnStartData`), which maps the instance to the helper. Claude's
  `agentId` is already the `Task` call's id (`claude/index.mjs:296`). OpenCode's is the child
  session (`opencode/index.mjs:255`, `:678`); its `task` tool call has to be matched to that session
  (not checked). Codex reports a helper only as one `collabAgentToolCall` step
  (`codex/index.mjs:131`): no `agentId` there.
- `prompt`: what it was asked (the task call's `prompt` argument). `intent`: its latest
  `assistant.intent` while it runs. `result`: what it came back with (the task call's result).
- Helper steps stay in `run.steps` (Work and Usage count them), and are sent as they happen, like
  any step.

## 5. How a turn ended (new field)

```ts
Run += { ending?: "failed" | "timed-out" | "interrupted" | "stopped" }
```

Set when a turn ends without finishing. "timed-out" is a deadline that a caller named (`BOTKINS_TURN_TIMEOUT`,
"didn't finish in time") or a request that got no answer (`ETIMEDOUT`). A turn is never failed for being quiet:
a harness that is gone (its process exited, its connection closed, its session no longer exists) ends as "failed". The text written so far is kept as an interim message (section 1).

### Keeping the work moving (new, optional fields)

```ts
Run += {
  plan?: { open: number; total: number };                 // the turn's plan when it ended
  continued?: { count: number; limit: number; reason: "plan" | "next-step"; open?: number };
  stoppedOpen?: true;                                     // it ended with plan steps open and nothing went on
}
AgentRequest += { detached?: true }                       // a question whose turn went on without an answer
AgentRequest += { time?: number }                         // when the computer raised it
```

The computer gives a bot more turns in the **same run** while its plan has open steps (`reason: "plan"`; at
most 8 in a chain, and not when the same open steps come back) or when its reply named the next step without
doing it (`"next-step"`; at most 2). Each turn's reply is its own assistant message with the run's `runId`, so a
continued run has several: all but the last are drawn where they came. Botkins' note to the bot is no message of
the chat. A routine, a Proactive run, Plan mode and a group chat are never continued. `stoppedOpen` is set when a
turn ends with open steps and nothing went on (the limit, the same steps again, Stop, a waiting message or request,
or an error in a continuation). A question unanswered for ten minutes is `detached`: the turn goes on, the request
stays in `live.requests`, and `respond` with an answer sends it as the person's next message, quoting the question.
An older phone ignores every one of these fields; a phone that finds none of them draws a run as before.

## 6. In the link (changed in this checkout; copy to `desktop/link/`)

- `link-host/parts.mjs`: `live.steerable` is sent when the snapshot has it. `runPart` does not count
  an interim message as a reply.
- `link-host/push.mjs`: the "finished" notification never takes an interim message as the reply.
- `send` takes `delivery: "steer" | "queue"` from a phone (already passed through by `remoteArgs`).
  The phone now sends `"steer"` while the chat works, as the desktop app's composer does.

## Agreed refinements (the desktop thread, 2026-11-19)

**When text is ended (section 1).**
- The root agent's text is ended before: a delivered steer; an interactive request opening **and**
  the person's answer to it; a root step; a terminal failure or stop.
- White space inside the Markdown is kept (only the ends are trimmed).
- A segment's `time` is when its first words were seen, or when it was received for a provider that
  gives only a final text. Entries with equal times keep their recorded order.
- The tail that is not committed yet is checkpointed for a restart. A turn is marked interrupted
  only after recovery has ended.
- A routine set to "No output" publishes nothing: no transcript entry and no notification.

**The reply and repeats (section 1).**
- Repeats are removed by the provider's message identity and segment boundaries, also when recovery
  replays a turn. A cumulative final text with an empty tail is never appended whole.
- The last interim message is promoted in place only for a turn that succeeded and wrote visible
  text, for each responding bot in a group chat.
- No reply is made up for a turn that only used tools, or for a no-output turn. **So a finished turn
  can have no reply**: the phone shows its work line and nothing after it.

**Receipts (section 2).**
- Exactly one receipt for each human response, with `answer.runId` and `answer.requestId`.
- A secure input keeps the receipt the desktop app writes today: the title and the labels of the
  fields that were given ("Sign in · Provided Username, Password"; "… · No fields supplied").
  The phone draws the title above the bubble and the rest in it (`answerText` in `turn.ts`).
- A form, a free-text answer and a credential-backed answer get a receipt without the value, by
  default. Only a choice that was declared with the request and is not sensitive is stored as it
  was given. A test of the label for secret-looking words is not enough to store a value, least of
  all after the link filled a credential in.
- A request closed by itself (the turn ended) leaves no receipt.

**Helpers (section 4).**
- Claude carries the parent tool-use id. Copilot declares an optional `parentToolCallId`: it is
  used only when it was seen. OpenCode gives a child session id: steps are attached only after an
  explicit association with the parent task. The Codex adapter gives the collaboration step, its
  prompt and its status. ACP has no dependable mapping from child to parent.
- `prompt`, `intent`, `result` and `agentId` stay optional and are left out when a provider does
  not give them. Ownership is never guessed from overlapping times, and a step whose helper is not
  known never ends the root agent's text.

**How a turn ended (section 5).**
- `ending` is set for every terminal outcome; "timed-out" comes from a typed inactivity or
  deadline error, not from matching words.
- Today (0.15.6) streamed text that was not committed can be lost; earlier messages and steps that
  were saved survive. A restart draft is cut to 4,000 characters, so the full unpublished tail
  cannot be promised by the current release.

## Secure input (`secure-input-v1`, in the desktop app from 0.15.6)

Agreed exactly as the phone built it: a request of kind `"secure"` with `title`, `detail` and 1 to
8 `fields` (`key`, `label`, `kind` "password" | "code" | "secret" | "text", `hint`, `optional`),
answered with `respond(id, { action: "accept", content })` or `{ action: "cancel" }`, a saved
credential as `{ $credential: id }`. The desktop app's own window can answer it too. The typed
values stay out of the model, the saved chat and every part of the link; the bot gets a handle for
each field, good for one approved operation and a few minutes (`desktop/secure-input.mjs`). The
request's `detail` is the operation and its address, then one line for each field ("Password →
password").

## What an older computer sends, and what the phone does

| Missing | The phone |
| --- | --- |
| Interim messages | Places steers among the steps by their `time`. While it watches a turn, it notes how long the reply so far was when each step, thought and steer first showed (`src/state/turnMarks.ts`) and cuts the text there. A reply that already holds a noted piece is not shown twice. |
| A time on the reply | Puts the reply after everything else of its run. |
| Answers | Nothing to show; the `ask_user` step reads "Asked you: …". |
| `agentId` | Shows every step as the turn's own. The helper's sheet says "Update the app on your computer to see this helper's steps." What it was asked and came back with come from the step that started it (`input.prompt`, `output`). |
| `ending` | Reads it from `status` and `detail` ("stall", "timed out", "didn't finish in time" make "Timed out"). |
| The text of a turn that ended without a reply | Shows the last text it saw, if it watched the turn in this app session. |

Also on any computer: the run part for an ended turn is no longer taken for a turn under way (the
composer offered Stop and the failure line was hidden; that was the phone's cause for "the history
is gone").

## Worked example

A turn with text, a step, a steer, a question and its answer, and a helper. Times are milliseconds
after the person's message.

```jsonc
// chat.messages
[
  { "role": "user", "text": "Check the deploy and fix what's broken", "runId": "r1", "time": 0 },
  { "role": "assistant", "text": "I'll look at the last deploy first.", "runId": "r1", "time": 400, "interim": true },
  { "role": "user", "text": "Only staging, please", "steeredRunId": "r1", "time": 5200 },
  { "role": "assistant", "text": "Staging only, then. One question first.", "runId": "r1", "time": 5600, "interim": true },
  { "role": "user", "text": "Yes", "time": 9100, "answer": { "runId": "r1", "requestId": "q1", "kind": "question", "title": "Restart the staging server?" } },
  { "role": "assistant", "text": "Restarted. Staging is healthy again.", "runId": "r1", "time": 14200 }
]
```

```jsonc
// the run, once it finished (in chat:<id>; while it runs, the same in run:<id>)
{
  "id": "r1", "status": "Completed", "time": 0, "finished": 14800,
  "reasoning": [{ "id": "t1", "text": "Read the deploy log before anything.", "started": 100, "finished": 350 }],
  "steps": [
    { "id": "s1", "name": "bash", "label": "tail deploy.log", "status": "Done", "started": 1900, "finished": 2600 },
    { "id": "h1", "name": "task", "label": "Check staging's health", "status": "Done", "started": 2700, "finished": 8000,
      "input": "{\n  \"description\": \"Check staging's health\",\n  \"prompt\": \"Call /health on staging and say what fails.\"\n}",
      "output": "Staging answers 502 on /api." },
    { "id": "s2", "name": "web_fetch", "label": "https://staging.example.com/health", "status": "Done", "started": 3000, "finished": 3400, "agentId": "h1" },
    { "id": "s3", "name": "ask_user", "label": "ask_user", "status": "Done", "started": 6000, "finished": 9100 },
    { "id": "s4", "name": "bash", "label": "systemctl restart api", "status": "Done", "started": 9300, "finished": 13800 }
  ],
  "agents": [{ "id": "h1", "name": "Explore", "description": "Check staging's health", "status": "Done", "started": 2700, "finished": 8000,
    "prompt": "Call /health on staging and say what fails.", "result": "Staging answers 502 on /api." }]
}
```

```jsonc
// live, at 7000 ms: the text since the last interim message, the open question, and a turn that takes a steer
{ "streams": { "c1": "" }, "requests": [{ "id": "q1", "chatId": "c1", "botId": "b1", "kind": "question", "title": "Restart the staging server?", "choices": ["Yes", "No"], "freeform": true }], "steerable": { "c1": true } }
```

With Steps and Thinking and updates both Open, the phone shows the work in order as it arrives.
For this example the conversation reads as follows.

> The person's message · “Read the deploy log before anything.” · “I'll look at the last deploy first.” · Ran a command, started a helper, read a web page ·
> “Only staging, please” · “Staging only, then. One question first.” · Asked you a question ·
> “Yes” (under “Restart the staging server?”) · Ran a command · the reply

The helper's own step `s2` also appears in its activity sheet. Folded keeps the selected kind of
work in the rail. Failed only shows failed tool calls in the conversation. Fold finished steps
controls what happens when the reply lands. With it on, the person's messages and the reply
stay in order and the work moves under “Worked for 15s · 5 steps”. With it off, the work stays
where it appeared.

An older computer sends the same turn as: the person's message, the steer, and one reply with no
time (Copilot: "Restarted. Staging is healthy again."; Claude: all three texts joined), steps without
`agentId`, no answer message. The phone reads: the person's message · Ran a command, started a
helper, read a web page · "Only staging, please" · Asked you a question, ran a command · the reply.

## For the desktop app's own screen

- Its chat (`src/ChatView.tsx`) draws `chat.messages` in order and the live text at the end, so
  interim messages and answers put it in order too. It shows the run's work under the person's
  message (`ToolTrail`); with interim messages it may want to cut that by time as the phone does.
- The phone says "Timed out" where the desktop app says "Needs you" for a stall (`ChatView.tsx:741`
  shows `{run.status} · {run.detail || "Reply stopped."}`). With `ending`, the desktop app can say
  "Timed out" too, so both apps use the same word.
- The helper chip ("In the background · 2 running", `src/ChatActivity.tsx:298`) is the phone's
  rail. With `agentId`, a helper's row can open its own steps there as well.
