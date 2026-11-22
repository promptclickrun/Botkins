// A chat's Connect card (desktop/connects.mjs): the bot's tool, one shared attempt per app, the
// check that decides it is connected, the chat going on once, and what never leaves the host.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { ComposioError, MCP_URL } from "../desktop/composio.mjs";
import { ATTEMPT_MS, Connects } from "../desktop/connects.mjs";

const PAGE = "https://connect.composio.dev/link/ln_secret";
const CATALOG = {
  revision: "r1",
  categories: [],
  toolkits: [
    { slug: "github", name: "GitHub", description: "", logo: "https://logos.composio.dev/api/github", categories: [], noAuth: false },
    { slug: "hackernews", name: "Hacker News", description: "", logo: null, categories: [], noAuth: true },
  ],
};

/** A stand-in for the workspace's Composio client, counting what it is asked. */
function fakeComposio() {
  const accounts = { github: [] };
  const calls = { connection: 0, connect: 0, removed: [] };
  return {
    accounts,
    calls,
    signedIn: true,
    statusOnly: null,
    async catalog() {
      return CATALOG;
    },
    async connection(slug) {
      calls.connection++;
      if (!this.signedIn) throw new ComposioError("Sign in with Composio first.");
      return { status: this.statusOnly, accounts: (accounts[slug] ?? []).map((account) => ({ ...account })) };
    },
    async connect(slug) {
      calls.connect++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      (accounts[slug] ??= []).push({ id: "ca_new", status: "pending" });
      return { redirectUrl: PAGE, pendingId: "ca_new", accounts: accounts[slug] };
    },
    async removeAccount(slug, id) {
      calls.removed.push(id);
      accounts[slug] = accounts[slug].filter((account) => account.id !== id);
    },
  };
}

function setup(t, { clock = { now: 1_000_000 } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-connects-"));
  const ws = new Workspace(dir, async () => ({}), () => {});
  ws.state.mcpServers.push({ id: "composio", name: "composio", type: "http", url: MCP_URL, enabled: true, oauth: {} });
  ws.composio = fakeComposio();
  // The timers never fire in these tests: each look is asked for with check().
  const connects = new Connects(ws, { now: () => clock.now, delay: () => 60 * 60_000 });
  ws.connects = connects;
  const sent = [];
  ws.submit = (chatId, text, options) => sent.push({ chatId, text, options });
  t.after(() => {
    connects.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bot = ws.state.bots[0];
  /** A chat whose turn is under way, with the tool the bot is given. */
  const turn = () => {
    const chatId = ws.createChat(bot.id);
    const run = { id: "run-" + chatId, chatId, status: "Working" };
    ws.state.runs.unshift(run);
    ws.chat(chatId).messages.push({ role: "user", text: "Show my open GitHub issues", runId: run.id, time: 1 });
    const task = { stopped: false };
    ws.active.set(chatId, task);
    const tools = connects.tools(bot, ws.chat(chatId), run, task);
    const call = async (app) => JSON.parse(await tools[0].handler({ app }));
    return { chatId, run, task, tools, call, done: () => ws.active.delete(chatId) };
  };
  return { ws, connects, composio: ws.composio, bot, turn, sent, clock };
}

test("the bot gets a card only for an app that needs connecting, and the card holds nothing private", async (t) => {
  const { composio, turn } = setup(t);
  const { run, call } = turn();
  assert.deepEqual((await call("hackernews")).status, "ready");
  composio.accounts.github = [{ id: "ca_1", status: "active" }];
  assert.equal((await call("github")).status, "connected");
  assert.equal(run.connects, undefined, "a connected app shows no card");

  composio.accounts.github = [];
  const asked = await call("GitHub ");
  assert.equal(asked.status, "needed");
  assert.match(asked.message, /press Connect/);
  assert.deepEqual(run.connects.map(({ toolkit, name, logo, status }) => ({ toolkit, name, logo, status })), [{ toolkit: "github", name: "GitHub", logo: "https://logos.composio.dev/api/github", status: "needed" }]);
  // Asking again in the same reply gives the same card.
  assert.equal((await call("github")).card, asked.card);
  assert.equal(run.connects.length, 1);
  await assert.rejects(call("not a slug!"), /toolkit slug/);
  await assert.rejects(call("nosuchapp"), /no app called nosuchapp/);
});

test("the tool is there only when this bot's turn may use the computer's Composio tool", (t) => {
  const { ws, connects, bot, turn } = setup(t);
  assert.equal(turn().tools.length, 1);
  bot.mcpOff = ["composio"];
  assert.equal(turn().tools.length, 0);
  bot.mcpOff = [];
  ws.state.mcpServers[0].enabled = false;
  assert.equal(turn().tools.length, 0);
  ws.state.mcpServers[0].enabled = true;
  // A member whose role can't use tool servers wrote the message.
  ws.teamOf = () => ({ members: [{ id: "m1", groupId: "g" }], groups: [{ id: "g", roleId: "r" }], roles: [{ id: "r", perms: { mcp: ["view"] } }] });
  const { chatId, run, task } = turn();
  ws.chat(chatId).messages.at(-1).author = { memberId: "m1" };
  assert.equal(connects.tools(bot, ws.chat(chatId), run, task).length, 0);
});

test("presses on two devices and in two chats share one attempt; connecting continues each chat once", async (t) => {
  const { ws, connects, composio, turn, sent } = setup(t);
  const first = turn();
  const second = turn();
  const a = (await first.call("github")).card;
  const b = (await second.call("github")).card;
  first.done();
  second.done();

  const [one, two, three] = await Promise.all([connects.open(first.chatId, a), connects.open(first.chatId, a), connects.open(second.chatId, b)]);
  assert.equal(composio.calls.connect, 1, "one sign-in page for the app");
  for (const state of [one, two, three]) assert.deepEqual([state.status, state.url], ["waiting", PAGE]);
  // The page and the account stay on the host: nothing of them is saved with the chat.
  const saved = JSON.stringify(ws.state);
  assert.ok(!saved.includes("ln_secret") && !saved.includes("ca_new"));

  // Not yet: the card waits.
  assert.equal((await connects.check(first.chatId, a)).status, "waiting");
  assert.equal(sent.length, 0);

  composio.accounts.github[0].status = "active";
  assert.equal((await connects.check(first.chatId, a)).status, "connected");
  assert.equal(second.run.connects[0].status, "connected");
  assert.deepEqual(sent.map((item) => [item.chatId, item.text]).sort(), [[first.chatId, "I connected GitHub. Go on with what I asked."], [second.chatId, "I connected GitHub. Go on with what I asked."]].sort());

  // Looking again, or pressing again, never sends a second message.
  await connects.check(first.chatId, a);
  assert.equal((await connects.open(first.chatId, a)).status, "connected");
  assert.equal(sent.length, 2);
  assert.deepEqual(composio.calls.removed, []);
});

test("a failed account or an expired page ends the attempt, removes its account and offers a retry", async (t) => {
  const clock = { now: 1_000_000 };
  const { connects, composio, turn } = setup(t, { clock });
  const { chatId, call, done } = turn();
  const card = (await call("github")).card;
  done();
  await connects.open(chatId, card);
  composio.accounts.github[0].status = "failed";
  const failed = await connects.check(chatId, card);
  assert.equal(failed.status, "failed");
  assert.match(failed.note, /didn't finish/);
  assert.deepEqual(composio.calls.removed, ["ca_new"]);

  // Try again: a new attempt, which expires when nobody finishes it.
  assert.equal((await connects.open(chatId, card)).status, "waiting");
  assert.equal(composio.calls.connect, 2);
  clock.now += ATTEMPT_MS;
  assert.equal((await connects.check(chatId, card)).status, "expired");
  assert.deepEqual(composio.calls.removed, ["ca_new", "ca_new"]);
});

test("a status-only reply that says active settles a card; a restart asks a waiting card to be pressed again", async (t) => {
  const { ws, composio, turn, sent } = setup(t);
  const { chatId, call, done } = turn();
  const card = (await call("github")).card;
  done();
  await ws.connects.open(chatId, card);

  // Botkins restarts: the attempt is gone with it.
  ws.connects.close();
  const after = new Connects(ws, { delay: () => 60 * 60_000 });
  t.after(() => after.close());
  composio.accounts.github = [];
  assert.equal((await after.check(chatId, card)).status, "needed");
  assert.equal(sent.length, 0);

  // Connected elsewhere meanwhile (Composio answers with the app's status and no accounts).
  composio.statusOnly = "active";
  await after.open(chatId, card);
  assert.equal(composio.calls.connect, 1, "no new page for an app that is active");
  assert.equal(sent.length, 1);
});

test("access taken away while the card shows: Connect does nothing, and says why", async (t) => {
  const { ws, connects, composio, bot, turn } = setup(t);
  const { chatId, call, done } = turn();
  const card = (await call("github")).card;
  done();
  bot.mcpOff = ["composio"];
  const before = composio.calls.connection;
  const state = await connects.open(chatId, card);
  assert.equal(state.status, "unavailable");
  assert.equal(state.url, undefined);
  assert.equal(composio.calls.connection, before, "Composio isn't asked");
  // Given back: the card can be pressed again.
  bot.mcpOff = [];
  assert.equal((await connects.open(chatId, card)).status, "waiting");
  assert.ok(ws.chat(chatId));
});

test("without Composio's sign-in the card says to sign in, and comes back once it is", async (t) => {
  const { connects, composio, turn } = setup(t);
  composio.signedIn = false;
  const { chatId, call, done } = turn();
  const asked = await call("github");
  done();
  assert.equal(asked.status, "sign_in");
  assert.match(asked.message, /Marketplace › Apps/);
  composio.signedIn = true;
  assert.equal((await connects.check(chatId, asked.card)).status, "needed");
  await assert.rejects(connects.open(chatId, "nope"), /can't be found/);
});
