# One Live Activity for all Botkins or one per Botkin, and answering from the Lock Screen (`activity-all-v1`, `activity-bots-v1`)

What the computer and the phone send so each working Botkin has one card on the Lock Screen and
in the Dynamic Island. The card shows that Botkin's chats, the steps as they run, the latest line
of thinking, and buttons for what the bot asks. The mockups are `design/mockups/widgets-live-activities.html`.
The owner's decisions (2026-11-20): thinking and steps show on the cards, sealed until they reach
the phone. One tap on a choice sends it. Notifications get choice buttons, which takes a
notification content extension.

Everything here is additive. A computer whose link names `activity-bots-v1` in `meta.capabilities`
does all of it. Without it, the phone keeps one card per chat, as before.

## 0. One card for all Botkins (`activity-all-v1`)

The owner's decisions (2026-11-22): one Live Activity for every Botkin's chats, drawn as one row per
chat ("The Feed", direction B of the mocks; `targets/widgets/FeedCard.swift`). It goes away on its
own. A request makes its sound through the card; a finished turn still gets its own notification.

- **Asking.** A phone sends `cards: "all"` to a computer that names `activity-all-v1` and a build
  that can draw it (`startAllCard` in the native module). Otherwise it asks for `"bots"` as below.
- **Key.** `"all"`. Attributes `card: "all"`, `botName: "Botkins"`, no look.
- **Rows.** The same rules as a Botkin's card (sections 3 to 5), across all Botkins. Each entry in
  `chats` also has `bot` (the Botkin's id) and, when the computer has a look saved, `head`,
  `palette`, `eyes` and (for four colors of the person's own) `colors`. The sealed rows add `b`, the
  Botkin's name, and an ended row gets `r` (the reply's first line, at most 100) even with several
  rows. The sealed part is kept under 2,000 bytes. A row without a look takes it, and its name, from
  the widgets' snapshot.
- **Starting.** Only the phone starts it, while the app is in front and a chat is at work or needs
  the person. It is never started by a push: the computer could not change it until the app said
  its address, and often the app never did.
- **Who draws it.** The phone, only while the app is in front (it knows a turn's steps only for the
  chat on screen). The computer holds back then, and sends the whole card again the moment the app
  leaves (`link.push.presence` false), so the card shows each chat's current step from then on.
- **One chat.** With one chat on it, the card shows that chat's last two steps and the latest
  sentence of thinking under its row (from the sealed `s` and `th`).
- **Ending.** Once every chat on it has ended, the computer sends that as an update and keeps the
  card for a minute (`OVER_HOLD_MS`; a new turn in that minute takes it over), then ends it with its
  final state, which stays on the Lock Screen four more minutes. A card with nothing left on it is
  ended at once. The computer also looks at its cards when it starts, so a card left from before a
  restart is ended a minute later without waiting for a change. When the app comes to the front it
  ends a finished card it didn't draw, any card that is not its card for all Botkins, and cards iOS
  ended by itself but left on the Lock Screen (`dismissEnded`, only in front: a card that just ended
  keeps its final state).
- **A request.** While the phone has the card, the request's notification is not sent. The card's
  first update that shows the request carries `aps.alert` (`"Botkins"`, `"A bot needs you"`) and
  `sound`, which lights the screen and plays the sound. A request the card doesn't show is a
  notification, as before. Without the card (Live Activities off, or none running) every request is
  a notification.
- **A finished turn.** When its end leaves every chat on the card ended, the card's update that says
  so carries `aps.alert` (`"Botkins"`, `"All done"` or `"A chat stopped"`) and `sound`: the Dynamic
  Island opens and the sound plays. The turn's notification still comes, without `sound`. A turn
  that ends while others still work gets its notification as before, with its sound.
- **The card's address** reaching the computer brings the whole card, never a chat's catch-up.

The hold before the end, and the look at a restart, apply to a Botkin's card too (it never chimes).

## 1. A phone asks for cards per Botkin

`link.push.register(target, prefs)`: `target.cards` is `"bots"`. A phone sends it only to a computer
that names `activity-bots-v1`. The computer keeps it with the phone's notification record. A phone
that doesn't send it gets one card per chat, as before.

## 2. A card's key

`link.push.activity(key, token)` and the record's `activities` use `"bot:" + botId` for a Botkin's
card. A per-chat card still uses the chat's id.

## 3. Which chats a card shows

The chats whose `botId` is the Botkin's, and not a group chat, temporary, a panel's or a routine's.
A chat counts while its newest turn is "Working", and for 30 minutes after that turn ends
(`ACTIVITY_LINGER_MS`). The card shows up to three, in this order:

1. a chat with an open request (the oldest request first),
2. working chats, the newest start first,
3. ended chats, the newest end first.

`more` counts the rest. The card ends when no chat counts any more.

## 4. What Apple sees (`content-state`, plain)

```jsonc
{
  "v": 1,
  // The card as a whole, also for an older build that knows only these fields.
  "phase": "needs-you" | "thinking" | "working" | "done" | "failed",
  "label": "Needs you" | "Thinking" | "Working" | "Writing" | "Done" | "Stopped",  // never a step's name
  "steps": 6, "startedAt": 1795200000, "finishedAt": 1795200190,                  // the first chat's
  "chats": [{
    "id": "<chat id>",
    "phase": "...",                     // as above, for this chat
    "steps": 6, "startedAt": 1795200000, "finishedAt": 1795200190,
    "provider": "claude",               // the model's provider, for its mark; absent when unknown
    "ask": "approve" | "risky" | "question" | "open"   // what the buttons are; absent without a request
  }],
  "more": 0,
  "sealed": "<base64>"                  // absent when previews are off
}
```

`relevance-score` on each push: 100 when a chat needs the person, 50 while one works, 10 when all ended.

`ask` is `"approve"` for an approval, `"risky"` for one whose command looks destructive (the
phone's `looksDangerous`), `"question"` for a question with one to three short choices or a free
answer, and `"open"` for everything else (a form, a secure input, a long question).

## 5. What only the phone sees (`sealed`)

```
key     = the push key (HKDF-SHA256(device key, salt = device id, info = "botkins/push/v1"))
sealed  = base64(nonce(12) + ChaCha20-Poly1305(key, nonce, JSON, aad "botkins-card-v1"))
```

The other AAD keeps an alert's box from being shown as a card, and a card's box from being shown as an alert.

```jsonc
{ "c": [{
  "id": "<chat id>",                    // the same order as `chats`
  "t": "Fix login refresh",             // the chat's title, at most 60
  "m": "claude-fable-5-2",              // the model's id; the phone shows its name when it knows it
  "l": "Running npm test",              // what it is doing now, at most 60
  // Only when the card shows one chat:
  "s": [{ "k": "search" | "read" | "edit" | "run" | "web" | "helper" | "tool", "l": "Searched for renew(", "d": 0 | 1 | 2, "at": 1795200100 }],  // the last three steps; d: 0 running, 1 done, 2 failed
  "th": "If the retry waits for the first renew, the token rotates once.",          // the latest sentence of thinking, at most 140
  "r": "Fixed: renew now waits for the first refresh to finish.",                    // the reply's first line, once done, at most 140
  // The chat's oldest open request:
  "q": { "id": "<request id>", "k": "permission" | "question" | "form" | "secure", "t": "Run a command", "p": "git push --force", "ch": ["Tue 10:00", "Wed 2:00"], "rm": true, "free": true, "x": true }
}] }
```

`rm`: the approval can be remembered ("Allow for this chat"). `free`: a question takes a typed
answer. `x`: the approval looks destructive. `ch` is there only when the choices are buttons.

The sealed JSON is kept under 2,400 bytes: thinking goes first, then steps, then the reply.

With previews off, nothing is sealed: the card shows the counts, the times and the generic labels.

## 6. A notification for a request

The sealed alert (`k: "request"`) gains `q`, with the same fields as in a card. The notification
extension reads it and sets the alert's category:

| Category | When | Actions |
| --- | --- | --- |
| `botkins_approve` | an approval that can be remembered | Allow once, Allow for this chat, Deny |
| `botkins_approve_once` | an approval that can't | Allow once, Deny |
| `botkins_approve_risky` | an approval that looks destructive | Allow once (opens the app, Face ID), Deny |
| `botkins_question` | a question with 1 to 3 short choices, or a free answer | the choices, Reply…, Open chat |
| `botkins_open` | anything else | Open to answer |

Every action that answers needs the phone unlocked. The choices are set by the notification
content extension (`targets/notify-ui`) from what the service extension opened.

## 7. Answering

A card's buttons (App Intents), the island's and a notification's actions all put one answer in a
queue in the app (`UserDefaults`, `botkins.answers`). The app then sends it with `respond(requestId, answer)`
the same way the request panel does: `approve`, `remember`, `deny`, `answer` with `value`, `cancel`.
A risky approval opens the app and asks for Face ID first. Nothing secret is ever typed outside the app.

## 8. Widgets

Widgets read a snapshot the app writes to its App Group (`group.app.botkins.mobile`,
`widgets.json`). It holds each paired computer's Botkins (looks, states, the newest chats), plans
and limits, and model names. Nothing in it leaves the phone. The computer is not involved.

With spaces (`spaces-v1`) it also holds `panels`: for each panel of the person's spaces, pinned
spaces first, its title, the one thing it says (`value` and `note`: `panelHeadline` in
`src/state/widgetData.ts`), its space and its bot's Botkin, and when it last changed. The **Panel**
widget (`BotkinsPanel`, `targets/widgets/PanelWidget.swift`: Lock Screen and Home Screen) draws one
of them and opens it with `botkins://open/panel?space=…&id=…&host=…`. The phone reads a space only
when it is opened or pinned and a Panel widget is on show, so a space it has not read since it
started keeps the panels the snapshot had.
