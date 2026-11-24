// Non-live smoke for Markdown in the chat: tables, task lists, strikethrough, footnotes, callouts,
// headings, links, images shown as links, and code blocks with a language label, colors and Copy.
// The chat is seeded, so no model runs. Set MARKDOWN_SHOTS to a folder to save light and dark screenshots.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { home } from "./welcome-helper.mjs";
import { starterBots } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-markdown-"));
const shots = process.env.MARKDOWN_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const env = { ...process.env, BOTKINS_DATA_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE;

// The reply that showed its table as a line of pipes before tables were supported.
const calendar = `Your next meeting is **12:35–1:00 p.m. CT: Review the rollout schedule.** It overlaps with Required Learning by 15 minutes.

**Wednesday, November 18 · Central time**

| Time | What's still ahead |
|---|---|
| 12:35–1:00 p.m. | Review the rollout schedule |
| 12:45–1:30 p.m. | Required Learning |
| 2:00–3:00 p.m. | AIBS Command Center – Use Case & Demo for CSAs |
| 3:30–4:00 p.m. | Following: HP Usage Excellence & Copilot Gap Tracking — marked free |

**All day:** Ignite Watch Party! — marked free.`;

const everything = `# Release plan

Some **bold**, *italic*, ~~struck out~~ and \`inline code\`. About ~5 minutes for $5 and ~10 for $10.

## Checklist

- [x] Build signed
- [ ] Notes written
  - nested point with a [link](https://example.com/docs)
  - www.example.org is linked on its own

1. First step
2. Second step

### Numbers

| Metric | Before | After |
|:--|--:|:-:|
| Reply time | 9.4 s | **2.1 s** |
| Tokens | 15,300 | 13,000 |

> A plain quote
> on two lines.

> [!WARNING]
> Back up the workspace before you swap builds.

> [!TIP]
> Keep sessions open.

\`\`\`ts
// Adds two numbers
export function add(a: number, b: number): string {
  return \`sum: \${a + b}\`;
}
\`\`\`

\`\`\`
plain | text | with | pipes
\`\`\`

\`\`\`made-up-language
left as it is
\`\`\`

A picture: ![Architecture diagram](https://example.com/diagram.png) and a claim.[^1]

Changes: [Review PR](https://github.com/example/botkins/pull/42/files).

A badge: [![build passing](https://example.com/badge.svg)](https://example.com/builds)

---

<b onclick="alert(1)">raw html stays text</b>

[^1]: The source of the claim.`;

const mine = `Compare these:

| A | B |
|---|---|
| 1 | 2 |

\`\`\`sh
npm test
\`\`\``;

const now = Date.now();
const chats = [
  {
    id: "md-chat",
    botId: "pip",
    title: "Markdown",
    time: now,
    established: false,
    messages: [
      { role: "user", text: "What's on my calendar?" },
      { role: "assistant", text: calendar },
      { role: "user", text: mine },
      { role: "assistant", text: everything },
    ],
  },
];
mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(join(dir, "data", "workspace.json"), JSON.stringify({ bots: starterBots, chats, runs: [] }));

const app = await _electron.launch({ args: process.env.BOTKINS_BINARY ? [] : ["."], executablePath: process.env.BOTKINS_BINARY, env });
try {
  const page = await home(app);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1190, 900));
  async function shoot(name, target) {
    if (!shots) return;
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => window.botkins.setPreferences({ appearance: { theme } }), theme);
      await page.locator(`html[data-mode="${theme}"]`).waitFor();
      await target?.scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(shots, `${name}-${theme}.png`) });
    }
    await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
  }
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.evaluate(() => window.botkins.setPreferences({ appearance: { theme: "light" } }));
  await page.getByRole("navigation").getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByRole("button", { name: /Markdown/ }).first().click();
  const replies = page.locator("article.assistant");
  await expect(replies).toHaveCount(2);

  // 1. The calendar reply: a real table, with no pipes or dashes left in the text.
  const first = replies.nth(0);
  const table = first.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Time", "What's still ahead"]);
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row").nth(3).getByRole("cell")).toHaveText(["2:00–3:00 p.m.", "AIBS Command Center – Use Case & Demo for CSAs"]);
  assert.doesNotMatch(await first.innerText(), /\|/, "no table pipes show as text");
  assert.doesNotMatch(await first.innerText(), /---/);
  await expect(first.locator("strong").first()).toHaveCSS("display", "inline");
  await shoot("calendar-table", first);

  // 2. Everything else in one reply.
  const reply = replies.nth(1);
  // Headings are sized for running text, not as page titles.
  const h1 = reply.getByRole("heading", { name: "Release plan", level: 1 });
  assert.ok(parseFloat(await h1.evaluate((el) => getComputedStyle(el).fontSize)) < 24, "a # heading in a reply is not a page title");
  await reply.getByRole("heading", { name: "Checklist", level: 2 }).waitFor();
  await reply.getByRole("heading", { name: "Numbers", level: 3 }).waitFor();
  // Strikethrough needs two tildes; one tilde and dollar amounts are ordinary text.
  await expect(reply.locator("del")).toHaveText(["struck out"]);
  await reply.getByText("About ~5 minutes for $5 and ~10 for $10.", { exact: false }).waitFor();
  // Task list boxes show their state and can't be changed.
  const boxes = reply.getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect(boxes.nth(1)).toBeDisabled();
  await expect(reply.locator("ol > li")).toHaveCount(3, { timeout: 5000 }); // two steps and the footnote
  // Ordinary Markdown links still use the browser. A GitHub PR opens the local pane.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("link.pullRequest");
    ipcMain.handle("link.pullRequest", (_event, { url }) => ({ available: true, pull: {
      url, number: 42, title: "Review the rollout", state: "open", author: "mira", head: "release", base: "main",
      createdAt: "2026-11-21T00:00:00Z", body: "Ready for **review**.", checks: [], summary: "No checks", review: "approved", files: [],
    } }));
    globalThis.__opened = [];
    ipcMain.removeHandler("openLink");
    ipcMain.handle("openLink", (_event, url) => void globalThis.__opened.push(url));
  });
  await reply.getByRole("link", { name: "link", exact: true }).click();
  await reply.getByRole("link", { name: "www.example.org" }).click();
  // An image is a link to it: the page loads nothing remote.
  // The only picture in a reply is the bot's own avatar: an image in the text is shown as a link.
  await expect(reply.locator("img:not(.botkin-art)")).toHaveCount(0);
  await reply.getByRole("link", { name: "Architecture diagram" }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.__opened))
    .toEqual(["https://example.com/docs", "http://www.example.org", "https://example.com/diagram.png"]);
  // A linked image is one link, to where the link goes: one click opens one page.
  const badge = reply.getByRole("link", { name: "build passing" });
  await expect(badge).toHaveCount(1);
  await badge.click();
  await expect.poll(() => app.evaluate(() => globalThis.__opened.slice(3))).toEqual(["https://example.com/builds"]);
  assert.equal(await reply.locator("a a").count(), 0, "no link inside a link");
  await reply.getByRole("link", { name: "Review PR" }).click();
  await expect(page.getByRole("region", { name: "Pull request" })).toContainText("Review the rollout");
  await expect(page.getByRole("button", { name: "Open on GitHub" })).toBeVisible();
  // The second table keeps its column alignment.
  const numbers = reply.getByRole("table");
  await expect(numbers.getByRole("columnheader")).toHaveText(["Metric", "Before", "After"]);
  await expect(numbers.getByRole("row").nth(1).getByRole("cell").nth(1)).toHaveCSS("text-align", "right");
  await expect(numbers.getByRole("row").nth(1).getByRole("cell").nth(2)).toHaveCSS("text-align", "center");
  // Quotes and callouts.
  await expect(reply.locator("blockquote")).toHaveText(/A plain quote\s+on two lines\./);
  const notes = reply.getByRole("note");
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toHaveText(/^Warning\s*Back up the workspace before you swap builds\.\s*$/);
  await expect(notes.nth(1)).toHaveText(/^Tip\s*Keep sessions open\.\s*$/);
  assert.doesNotMatch(await reply.innerText(), /\[!(WARNING|TIP)\]/);
  // Code: a language label, colors for a known language, and Copy.
  const code = reply.locator(".md-code");
  await expect(code).toHaveCount(3);
  await expect(code.locator(".md-code-bar > span")).toHaveText(["ts", "text", "made-up-language"]);
  assert.ok((await code.nth(0).locator(".hljs-keyword").count()) > 0, "TypeScript is colored");
  assert.equal(await code.nth(1).locator("[class^=hljs-]").count(), 0, "a block with no language is plain");
  await expect(code.nth(1).locator("pre")).toHaveText("plain | text | with | pipes\n");
  await expect(code.nth(2).locator("pre")).toHaveText("left as it is\n");
  await code.nth(0).getByRole("button", { name: "Copy code" }).click();
  await code.nth(0).getByRole("button", { name: "Copied" }).waitFor();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    "// Adds two numbers\nexport function add(a: number, b: number): string {\n  return `sum: ${a + b}`;\n}",
  );
  await code.nth(0).getByRole("button", { name: "Copy code" }).waitFor({ timeout: 5000 });
  // The footnote and its marker.
  await expect(reply.locator("sup")).toHaveText("1");
  await expect(reply.locator(".footnotes li")).toHaveText(/The source of the claim\./);
  // HTML in a reply is text, never markup.
  await reply.getByText('<b onclick="alert(1)">raw html stays text</b>').waitFor();
  assert.equal(await reply.locator("[onclick]").count(), 0);
  await shoot("reply-top", h1);
  await shoot("reply-code", code.nth(0));
  await shoot("reply-end", reply.locator(".footnotes"));

  // 3. A person's own message renders the same way inside its bubble.
  const bubble = page.locator("article.user").nth(1);
  await expect(bubble.getByRole("table").getByRole("row")).toHaveCount(2);
  await expect(bubble.locator(".md-code-bar > span")).toHaveText("sh");
  await shoot("user-bubble", bubble);

  // A wide table scrolls inside its own frame at the smallest window; the chat does not.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
  await first.scrollIntoViewIfNeeded();
  const overflow = await page.locator(".messages").evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 1, "the chat itself never scrolls sideways (" + overflow + "px)");
  await shoot("calendar-table-min", first);

  assert.deepEqual(errors, [], "no page errors");
  console.log("markdown smoke: ok");
} finally {
  await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
