---
name: bug-triage
description: Triage a bug report or error: reproduce it, find the root cause, and say how bad it is and what to do next.
---

Work through these steps and report each one, even when a step fails:

1. **Restate** the bug in one line: what happened, what should have happened, and where.
2. **Reproduce** it with the smallest set of steps. If it does not reproduce, list what you tried and what you need (a version, a log, the data).
3. **Locate** the cause. Follow the error from where it shows to where it starts. Name the file and function, and say why it fails.
4. **Size it**: who is affected, how often, and whether data is lost or exposed. Call it urgent, soon or later.
5. **Next step**: the smallest fix, and the test that would have caught it. When the person wants the fix, write the failing test first.

Hand back a short triage note with those five headings. Mark guesses as guesses.

Ask before you change files outside the project, commit, push, or file or close an issue.
