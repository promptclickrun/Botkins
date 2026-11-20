---
name: today-panel
description: Build or update a rich panel on Botkins’s Today screen and keep it current on a schedule.
---

Use today_list to find panels owned by this bot. Use today_publish to create a panel or update the same key and current revision. Choose a metric, table, labeled bar chart, line chart, progress bar, badges, bullet list or Markdown block to fit the information. Use a line chart for a trend over time, a progress bar for progress toward a target, and badges for short statuses. Use real sources for factual panels. If a source cannot be reached, say so on the panel.

When the user asks for recurring updates, use today_routine to set a five-field cron expression, timezone and precise refresh instructions. Each scheduled check is a Copilot turn. Use the user's timezone unless they specify another. Report the panel title and its cadence after the tools confirm success.
