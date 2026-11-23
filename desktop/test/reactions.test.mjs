import assert from "node:assert/strict";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

test("a bot can acknowledge the current message with just a reaction", async (t) => {
  const dir = tempDir(t);
  const { client } = fakeClient(async (_id, _options, session) => {
    await session.tool("react", { emoji: "👍🏽" });
    await session.tool("react", { emoji: "👍🏽" });
    return { data: { content: "" } };
  });
  const ws = new Workspace(dir, client, () => {});
  const id = ws.createChat("pip");
  await ws.send(id, "Thanks!");
  assert.equal(ws.state.runs[0].status, "Completed", ws.state.runs[0].detail);
  const [message] = ws.chat(id).messages;
  assert.equal(ws.chat(id).messages.length, 1);
  ws.reactToMessage(id, 0, message.time, "👩🏽‍💻", "owner");
  ws.reactToMessage(id, 0, message.time, "🇨🇦", "owner");
  assert.throws(() => ws.reactToMessage(id, 0, message.time, "🍎🍎", "owner"));
  assert.throws(() => ws.reactToMessage(id, 0, message.time + 1, "😄", "owner"));
  const restarted = new Workspace(dir, client, () => {});
  assert.deepEqual(restarted.chat(id).messages[0].reactions, [
    { actor: "bot:pip", emoji: "👍🏽" }, { actor: "owner", emoji: "🇨🇦" },
  ]);
});
