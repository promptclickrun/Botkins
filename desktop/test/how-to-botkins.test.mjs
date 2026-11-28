// How Botkins works, from the live FAQ (desktop/how-to-botkins.mjs): the how_to_botkins tool for every
// bot, its line in the instructions, the built-in how-to-botkins skill, and the offline fallbacks.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./starter.mjs";
import { parseFaq, searchFaq } from "../desktop/how-to-botkins.mjs";

const shipped = fileURLToPath(new URL("../desktop/skills/how-to-botkins/faq.json", import.meta.url));
const faq = (version, answer = "Turn on the relay in Settings › Phone.") => ({
  schema: 1,
  botkinsVersion: version,
  sections: [
    { id: "phone", title: "Phone, Watch and away from home", items: [
      { id: "away", question: "Can I reach my bots away from home?", answer, url: "https://botkins.app/faq#away" },
      { id: "pair", question: "How do I pair my phone?", answer: "Scan the QR code in Settings › Phone.", url: "https://botkins.app/faq#pair" },
    ] },
    { id: "fixes", title: "Troubleshooting", items: [
      { id: "relay-fix", question: "The relay won't connect", answer: "The computer needs outbound HTTPS to relay.botkins.app.", url: "https://botkins.app/faq#relay-fix" },
    ] },
  ],
});

function setup(t, fetch) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-how-to-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = { setTools: async () => {}, on: () => () => {}, disconnect: async () => {}, send: async () => "m1" };
  const client = async () => ({ createSession: async () => session, resumeSession: async () => session, deleteSession: async () => {} });
  const calls = [];
  const ws = new Workspace(dir, client, () => {}, {
    howTo: { version: "0.17.21", fetch: async (url, init) => (calls.push(url), fetch(url, init)) },
  });
  const turn = (chatId, botId) => {
    const chat = ws.chat(chatId);
    const run = { id: "run-" + chatId, chatId, botId };
    const task = { stopped: false, run };
    ws.active.set(chatId, task);
    t.after(() => ws.active.delete(chatId));
    return new Map(ws.sessionTools(ws.bot(botId), chat, run, task).map((tool) => [tool.name, tool]));
  };
  return { ws, dir, turn, calls };
}
const ok = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const down = async () => {
  throw new Error("offline");
};
const call = async (tools, args) => JSON.parse(await tools.get("how_to_botkins").handler(args));

test("every bot has how_to_botkins in every kind of turn, and is told to use it", (t) => {
  const { ws, turn } = setup(t, ok(faq("0.17.21")));
  const id = ws.createChat("pip");
  assert.ok(turn(id, "pip").has("how_to_botkins"));
  assert.match(ws.instructionsFor(ws.chat(id), ws.bot("pip")), /call how_to_botkins first/);
  const helper = ws.sessionTools(ws.bot("pip"), { ...ws.chat(id), helper: true }, { id: "r" }, { stopped: false });
  assert.ok(helper.some((tool) => tool.name === "how_to_botkins"), "a helper reads it too");
});

test("the skill is built in, on for every bot, and points at the tool", (t) => {
  const { ws } = setup(t, ok(faq("0.17.21")));
  const skill = ws.integrations.skills().find((s) => s.name === "how-to-botkins");
  assert.equal(skill?.origin, "built-in");
  assert.equal(skill.unavailable, undefined);
  assert.ok(!ws.integrations.skillsFor(ws.bot("pip")).disabled.includes("how-to-botkins"));
  assert.match(readFileSync(join(skill.path, "SKILL.md"), "utf8"), /how_to_botkins/);
});

test("a question gets ranked answers with deep links from the live FAQ, kept for the next start", async (t) => {
  const { ws, dir, turn, calls } = setup(t, ok(faq("0.17.21")));
  const tools = turn(ws.createChat("pip"), "pip");
  const out = await call(tools, { query: "how do I reach my bots away from home" });
  assert.equal(out.from, "live");
  assert.equal(out.results[0].id, "away");
  assert.equal(out.results[0].url, "https://botkins.app/faq#away");
  assert.equal(out.faqVersion, "0.17.21");
  assert.equal((await call(tools, { id: "pair" })).results[0].question, "How do I pair my phone?");
  assert.deepEqual((await call(tools, { query: "relay", section: "fixes" })).results.map((r) => r.id), ["relay-fix"]);
  assert.deepEqual((await call(tools, {})).sections.map((s) => s.id), ["phone", "fixes"], "no arguments lists every question");
  assert.equal(calls.length, 1, "fetched once, then reused");
  assert.ok(existsSync(join(dir, "cache", "faq.json")));
});

test("offline, it answers from the kept copy, then from the copy that ships with the app, and says so", async (t) => {
  const { ws, dir, turn } = setup(t, down);
  const tools = turn(ws.createChat("pip"), "pip");
  const shippedOut = await call(tools, { query: "relay" });
  assert.equal(shippedOut.from, "bundled");
  assert.match(shippedOut.note, /Offline/);
  assert.ok(shippedOut.results.length > 0, "the shipped snapshot has answers");

  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(join(dir, "cache", "faq.json"), JSON.stringify({ ...faq("0.17.20", "An older answer."), fetchedAt: "2026-11-01T00:00:00Z" }));
  ws.howTo.copy = null;
  ws.howTo.failedAt = 0;
  const cached = await call(tools, { id: "away" });
  assert.equal(cached.from, "cache");
  assert.equal(cached.results[0].answer, "An older answer.");
});

test("a broken or hostile FAQ is refused, and links stay on botkins.app", () => {
  assert.throws(() => parseFaq("{}"), /Not a Botkins FAQ/);
  assert.throws(() => parseFaq({ sections: [{ id: "x", title: "x", items: [] }] }), /no answers/);
  const parsed = parseFaq({ sections: [{ id: "s", title: "S", items: [{ id: "a", question: "Q", answer: "A", url: "https://evil.example/x" }] }] });
  assert.equal(parsed.sections[0].items[0].url, "https://botkins.app/faq#a");
});

test("the shipped snapshot is a real FAQ, and the search ranks a question match above an answer match", () => {
  const data = parseFaq(readFileSync(shipped, "utf8"));
  assert.ok(data.sections.reduce((n, s) => n + s.items.length, 0) >= 50);
  for (const id of ["unattended", "privacy", "limits", "fixes"]) assert.ok(data.sections.some((s) => s.id === id), id);
  const top = searchFaq(data, "pair my phone")[0];
  assert.match(top.question, /pair/i);
});
