import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, expect } from "@playwright/test";
import { skipWelcome } from "./welcome-helper.mjs";
import { createSources } from "./fixtures/sources.mjs";
import { seedApp } from "./starter.mjs";

const dir = mkdtempSync(join(tmpdir(), "botkins-approval-ui-"));
const data = createSources(dir);
const env = { ...process.env, BOTKINS_DATA_DIR: dir, COMMANDER_DATA_DIR: dir };
// A new workspace has no bots; this smoke starts with the three test bots (test/starter.mjs).
seedApp(dir);
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  args: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY) ? [] : ["."],
  executablePath: (process.env.BOTKINS_BINARY ?? process.env.COMMANDER_BINARY),
  env,
});
let chatId;
try {
  const page = await skipWelcome(await app.firstWindow());
  const button = (n) => page.getByRole("button", { name: n, exact: true });
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 560));
  // The sample MCP server is added once for every bot, as Settings › MCP servers › Import does.
  const imported = await page.evaluate((json) => window.botkins.importMcpServers(json), readFileSync(data.mcp, "utf8"));
  assert.deepEqual(imported.added, ["botkins-sample"]);
  await button("New chat").click();
  await page.getByRole("dialog").getByRole("button", { name: /Pip/ }).click();
  await page
    .locator(".chathead")
    .getByRole("heading", { name: "Pip", exact: true })
    .waitFor();
  const snap = () => page.evaluate(() => window.botkins.snapshot());
  chatId = (await snap()).chats[0].id;
  const entry = page.getByRole("combobox", { name: "Message" });
  const send = async (text) => {
    await entry.fill(text);
    await button("Send message").click();
  };
  const r = page.getByRole("region", { name: "Approval request" });
  const note = Array.from(
    { length: 48 },
    (_, i) => "sample " + (i + 1) + ": review this synthetic fixture line.",
  ).join("\n");
  await send(
    "/tool:botkins-sample-review_note Call review_note once with the following complete note verbatim, including newlines. Then reply with the returned identifier.\n" +
      note,
  );
  await r.waitFor({ timeout: 120000 });
  await expect(r).toContainText("review_note");
  await expect(r).toContainText("sample 48");
  const geometry = await r.evaluate((el) => {
    const scroller = el.querySelector(".request-scroll"),
      rect = el.getBoundingClientRect();
    const buttons = [...el.querySelectorAll(".request-controls button")].map(
      (b) => b.getBoundingClientRect(),
    );
    return {
      scrolls: scroller.scrollHeight > scroller.clientHeight,
      contained:
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight &&
        buttons.every(
          (b) =>
            b.right <= innerWidth &&
            b.left >= 0 &&
            b.bottom <= innerHeight &&
            b.top >= 0,
        ),
    };
  });
  assert.ok(geometry.scrolls && geometry.contained, JSON.stringify(geometry));
  if ((process.env.BOTKINS_QA_DIR ?? process.env.COMMANDER_QA_DIR)) {
    mkdirSync((process.env.BOTKINS_QA_DIR ?? process.env.COMMANDER_QA_DIR), { recursive: true });
    await page.screenshot({
      path: join((process.env.BOTKINS_QA_DIR ?? process.env.COMMANDER_QA_DIR), "approval.png"),
    });
  }
  await send("/btw Is the pending note synthetic? Respond with Yes or No.");
  await expect(page.getByRole("region", { name: "Side answer" })).toContainText(
    /yes[.!]?$/i,
    { timeout: 120000 },
  );
  assert.equal((await snap()).requests.length, 1);
  await button("Dismiss side answer").click();
  await r.getByRole("button", { name: "Allow for this chat" }).click();
  await expect
    .poll(
      async () =>
        (await snap()).runs[0].steps?.some(
          (s) => s.name.includes("review_note") && s.status === "Running",
        ),
      { timeout: 15000, intervals: [50, 100] },
    )
    .toBe(true);
  await expect
    .poll(async () => (await snap()).runs[0].status, { timeout: 120000 })
    .toBe("Completed");
  assert.ok(readFileSync(data.receipt, "utf8").includes(data.toolProof));
  await send(
    "/tool:botkins-sample-review_note Call the same tool now with note 'second sample', then return the identifier.",
  );
  await expect
    .poll(
      async () =>
        (await snap()).runs.filter((r) => r.status === "Completed").length,
      { timeout: 120000 },
    )
    .toBe(2);
  // A real model now and then calls the tool twice in one turn. That is its own choice and says
  // nothing about approvals, so receipts are counted as "more than before", never as an exact number.
  const receipts = () => readFileSync(data.receipt, "utf8").trim().split("\n").length;
  assert.ok(receipts() >= 2, "the tool ran again in the second turn");
  await button("Settings").click();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await button("Clear remembered approvals").click();
  await page.getByLabel("Approval level").selectOption("all");
  await button("Close dialog").click();
  await send(
    "/tool:botkins-sample-review_note Call this tool once with note 'global policy sample', then return the identifier.",
  );
  await expect
    .poll(
      async () =>
        (await snap()).runs.filter((r) => r.status === "Completed").length,
      { timeout: 120000 },
    )
    .toBe(3);
  const allowed = receipts();
  assert.ok(allowed >= 3, "the tool ran in each of the three turns");
  await button("Settings").click();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.getByLabel("Approval level").selectOption("ask");
  await button("Close dialog").click();
  await send(
    "/tool:botkins-sample-review_note Call this tool once with note 'denial sample'. If the user declines, finish the turn immediately without calling any other tool.",
  );
  await r.waitFor({ timeout: 120000 });
  await r.getByRole("button", { name: "Deny", exact: true }).click();
  await expect
    .poll(async () => (await snap()).runs[0].status, { timeout: 120000 })
    .not.toBe("Working");
  assert.equal(receipts(), allowed, "the denied call left no receipt");
  console.log(
    "A native side question worked during an approval. Global approve-all permitted the tool after grants were cleared. Returning to Ask and denying prevented the next invocation.",
  );
  console.log(
    "At 760 × 560 a long actual SDK approval scrolled inside the chat with all buttons on screen. Remembering the MCP tool covered the next invocation. Live execution was visible before its result.",
  );
} finally {
  await app.close();
  // The conversation's Copilot state lives in the test's data folder and goes with it.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
