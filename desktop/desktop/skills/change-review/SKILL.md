---
name: change-review
description: Review a code change (a diff, a branch or a pull request) for real bugs and risks, ranked by severity, each tied to a line.
---

1. **Understand the change.** Read the diff and enough of the code around it to know what it is meant to do. Write that in one sentence first. If the intent is unclear, say so.
2. **Look for what breaks.** Wrong results, missed edge cases (empty, null, very large, concurrent, offline), errors swallowed, data lost or leaked, a caller or a stored file that the change no longer fits, and a missing or weakened test.
3. **Check each finding.** Point to the file and line. Run the code or a test when you can. Drop anything you can't point to; style preferences are not findings.
4. **Rank** each finding high (wrong or unsafe in normal use), medium (wrong in an edge case) or low (a risk worth a note).

Hand back:

- Findings, highest first. Each: where, what happens, why it matters, and a suggested fix.
- One line on what you did not check (no tests run, a part you could not read).

Never post comments, push commits or approve a pull request without showing the exact text first and getting a yes.
