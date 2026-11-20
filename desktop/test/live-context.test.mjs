import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveContextFor } from "../desktop/live-context.mjs";

test("liveContextFor returns the person's chosen name and bounded bot profiles only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botkins-live-context-"));
  try {
    const profile = join(dir, "files", "bot-1");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(join(profile, "IDENTITY.md"), "# Pip\n\n" + "identity ".repeat(500));
    writeFileSync(join(profile, "USER.md"), "Name: Alex Example\n\nPrefers short answers.");
    const workspace = {
      dir,
      state: {
        settings: {},
        userName: "machine-login-must-not-win",
        bots: [{ id: "bot-1", name: "Pip" }],
        chats: [{ id: "chat-1", botId: "bot-1" }],
      },
      bot(id) {
        if (id !== "bot-1") throw new Error("unknown bot");
      },
    };
    const context = liveContextFor(workspace, { chatId: "chat-1", botId: "bot-1" });
    assert.equal(context.userName, "Alex Example");
    assert.equal(context.user.length, "Name: Alex Example\n\nPrefers short answers.".length);
    assert.equal(context.identity.length, 2000);
    assert.ok(!JSON.stringify(context).includes("machine-login"));
    assert.deepEqual(liveContextFor(workspace, { chatId: "missing", botId: "bot-1" }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
