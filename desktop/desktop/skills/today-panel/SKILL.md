---
name: today-panel
description: Build or update a rich panel on Botkins’s Today screen and keep it current on a schedule.
---

Use today_list to find panels owned by this bot. Use today_publish to create a panel or update the same key and current revision. Choose a metric, table, labeled bar chart, line chart, progress bar, badges, bullet list or Markdown block to fit the information. Use a line chart for a trend over time, a progress bar for progress toward a target, and badges for short statuses. Use real sources for factual panels. If a source cannot be reached, say so on the panel.

When the user asks for recurring updates, use today_routine to set a five-field cron expression, timezone and precise refresh instructions. Each scheduled check is a Copilot turn. Use the user's timezone unless they specify another. Report the panel title and its cadence after the tools confirm success.

A panel is in a space: a page of panels. Every person has Today; a person can make more and share them. A panel you publish goes to the space the chat is about, which is the person's Today unless they started the chat from another space. Use space_list to see the spaces the people in this chat can open, and pass `space` to today_publish, today_list, today_routine or today_remove to name another one. A key is yours within one space, so the same key in two spaces is two panels.

When people will use a panel together (a checklist, a tracker, a vote, a sign-up), make it an app: one html block whose page keeps what people change in `botkins.state`. `await botkins.state.get()` answers the saved object. `botkins.state.set({ pressKit: true }, "Ticked Press kit")` saves top-level keys for everyone and says in a few words what the person did; null removes a key. `botkins.state.onChange(fn)` hears what someone else changed, so draw from the state each time. Keep one key for each thing a person can change, so two people who change different things do not undo each other. Put what you computed in the block's `data`, and what people did in the state: updating the panel keeps the state unless you pass `state`.
