// The dashboard (`botkins tui`, desktop/cli/tui): what it draws from what the service says, and
// what each key asks the service to do. A stand-in service answers; no terminal is needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createApp, runDashboard } from "../cli/tui/app.mjs";
import { main } from "../cli/main.mjs";
import { COMMANDS } from "../cli/commands/index.mjs";
import { areasOf, leavesOf } from "../cli/tui/menu.mjs";
import { fit, KEYS, render, TABS, width, wrap } from "../cli/tui/view.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient, ControlError } from "../desktop/terminal/socket.mjs";

const NOW = Date.parse("2026-01-02T12:00:00Z");
const STATUS = { running: true, version: "9.9.9", pid: 77, uptimeSeconds: 3725, node: "24.0.0", platform: "linux/arm64", dataDir: "/var/lib/botkins", socket: "/var/lib/botkins/run/botkins.sock", memory: { rssMb: 91.5 }, link: { enabled: true, listening: true, port: 47610, name: "Studio", addresses: ["10.0.0.5:47610"], pairing: false, devices: 1, connected: 1 }, relay: { enabled: false, connected: false, url: "https://relay.botkins.app" }, workspace: { bots: 2, chats: 1, routines: 1, working: 1, waiting: 0 }, secrets: { source: "systemd", where: "systemd credential" }, vault: { locked: false, entries: 0 } };
const DATA = {
  status: STATUS,
  "providers.list": [{ id: "claude", name: "Claude", enabled: true, installed: true, connected: true, account: "sam@example.com", plan: "Claude Max" }, { id: "codex", name: "Codex", enabled: true, installed: false, connected: false }, { id: "grok", name: "Grok", enabled: false, installed: true, connected: false }],
  "devices.list": [{ id: "d1", name: "Sam's iPhone", person: "Sam", kind: "phone", platform: "ios", connected: true, lastSeenAt: "2026-01-02T11:59:00Z" }, { id: "d2", name: "Old iPad", kind: "phone", platform: "ios", connected: false, lastSeenAt: "2026-01-01T12:00:00Z" }],
  "bots.list": [{ id: "b1", name: "Nova", role: "Editor", instructions: "Be brief.", model: { provider: "claude", model: "sonnet" }, chats: 1, working: true }, { id: "b2", name: "Pip", role: "Helper", instructions: "Help.", chats: 0, working: false }],
  "chat.list": [{ id: "c1", title: "Plan the week", botId: "b1", bot: "Nova", messages: 4, working: true }],
  "routines.list": [{ id: "r1", name: "Morning brief", bot: "Nova", cadence: "Every day at 8:00", enabled: true, running: false, finished: false, nextRun: "2026-01-03T08:00:00Z" }],
  "runs.list": [{ id: "run1", chatId: "c1", title: "Plan the week", status: "Working", bot: "Nova", time: "2026-01-02T11:58:00Z" }, { id: "run0", chatId: "c1", title: "Hello", status: "Completed", bot: "Nova", time: "2026-01-02T11:00:00Z" }],
};
/** A service that answers from `answers` over DATA, keeps its calls, and never answers a call that waits. */
function fakeService(answers = {}) {
  const calls = [];
  const all = { ...DATA, ...answers };
  return {
    calls,
    client: {
      async call(method, ...args) {
        if (method === "events.wait" || (method === "logs.read" && args[0]?.wait) || (method === "chat.read" && args[1]?.wait)) return new Promise(() => {});
        calls.push([method, ...args]);
        if (method === "logs.read") return { entries: [{ n: 1, time: "2026-01-02T11:59:30.000Z", level: "info", text: "Ready." }, { n: 2, time: "2026-01-02T11:59:40.000Z", level: "error", text: "Phone link: bind failed" }], next: 2 };
        if (!Object.hasOwn(all, method)) throw new ControlError("The service has no call named " + method + ".", "UNKNOWN_METHOD");
        const answer = all[method];
        return typeof answer === "function" ? answer(...args) : answer;
      },
    },
  };
}
async function dashboard(answers, size = { width: 100, height: 30 }) {
  const service = fakeService(answers);
  const written = [];
  const app = createApp({ client: service.client, write: (text) => written.push(text), size: () => size, colors: false, now: () => NOW });
  await app.start();
  await new Promise((resolve) => setImmediate(resolve));
  const screen = () => app.frame().join("\n");
  const type = (text) => [...text].forEach((ch) => app.key({ ch, name: ch === " " ? "space" : undefined }));
  return { app, service, written, screen, type, press: (name) => app.key({ name }), done: () => app.idle() };
}
const stateOf = (tab, more = {}) => ({ tab, selected: 0, now: NOW, logs: [], follow: true, scroll: 0, status: STATUS, providers: DATA["providers.list"], devices: DATA["devices.list"], bots: DATA["bots.list"], chats: DATA["chat.list"], routines: DATA["routines.list"], runs: DATA["runs.list"], ...more });

test("the screen is exactly as large as the terminal, at every size and on every tab", () => {
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }, { width: 40, height: 12 }, { width: 200, height: 60 }])
    for (const tab of TABS)
      for (const colors of [true, false]) {
        const lines = render(stateOf(tab), size, { colors });
        assert.equal(lines.length, size.height, tab + " at " + size.width + "×" + size.height);
        for (const line of lines) assert.equal(width(line), size.width, tab + " at " + size.width + "×" + size.height + ": " + JSON.stringify(line));
      }
  // A terminal too small to be useful still gets a whole screen, and nothing throws.
  assert.equal(render(stateOf("Overview"), { width: 10, height: 3 }, { colors: false }).length, 8);
  assert.equal(fit("a long name", 6), "a lon…");
  assert.equal(fit("ab", 5), "ab   ");
  assert.equal(fit("two\nlines", 12), "two lines   ");
  assert.deepEqual(wrap("one two three four five six", 12), ["one two", "     three", "     four", "     five", "     six"]);
});

test("each tab shows what the service said", () => {
  const draw = (tab, more) => render(stateOf(tab, more), { width: 110, height: 30 }, { colors: false }).join("\n");
  const overview = draw("Overview", { logs: [{ n: 1, time: "2026-01-02T11:59:30.000Z", level: "info", text: "Ready." }] });
  assert.match(overview, /^Botkins 9\.9\.9  Studio  running 1h 2m  91\.5 MB/);
  assert.match(overview, / 1 Overview  2 Devices  3 Bots  4 Chats  5 Routines  6 Logs /);
  assert.match(overview, /Phone link\s+“Studio” on port 47610\s+10\.0\.0\.5:47610/);
  assert.match(overview, /Relay\s+off/);
  assert.match(overview, /Workspace\s+2 bots, 1 chats, 1 routines, 1 working/);
  assert.match(overview, /Claude\s+signed in\s+sam@example\.com, Claude Max/);
  assert.match(overview, /Codex\s+not installed/);
  assert.doesNotMatch(overview, /Grok/, "a provider that is switched off is not listed");
  assert.match(overview, /Nova\s+Working\s+Plan the week\s+2 minutes ago/);
  assert.match(overview, /11:59:30 Ready\./);
  assert.match(overview, /R relay on\/off  p pair a phone  ←→ or 1-6 tabs  ↑↓ select  \? help  q quit/);
  const devices = draw("Devices");
  assert.match(devices, /NAME\s+PERSON\s+KIND\s+PLATFORM\s+STATE/);
  assert.match(devices, /Sam's iPhone\s+Sam\s+phone\s+ios\s+connected/);
  assert.match(devices, /Old iPad\s+phone\s+ios\s+last seen 1 day ago/);
  assert.match(draw("Bots"), /Nova \(working\)\s+Editor\s+claude\/sonnet\s+1/);
  assert.match(draw("Bots"), /Pip\s+Helper\s+default\s+0/);
  assert.match(draw("Chats"), /Plan the week\s+Nova\s+4\s+working/);
  assert.match(draw("Routines"), /Morning brief\s+Nova\s+Every day at 8:00\s+on\s+in 20 hours/);
  assert.match(draw("Logs", { logs: [{ n: 2, time: "2026-01-02T11:59:40.000Z", level: "error", text: "Phone link: bind failed" }] }), /11:59:40 error Phone link: bind failed/);
  // Nothing to list is said in words, with the key that changes it.
  assert.match(draw("Devices", { devices: [] }), /No device is paired\. Press p to show a pairing code\./);
  assert.match(draw("Bots", { bots: [] }), /There are no bots yet\. Press a to add one\./);
  assert.match(draw("Overview", { providers: [] }), /No provider is signed in: run `botkins providers login <provider>`\./);
  // No service: said plainly, and how to start one.
  const offline = render({ tab: "Overview", offline: true, logs: [], now: NOW }, { width: 100, height: 20 }, { colors: false }).join("\n");
  assert.match(offline, /^Botkins  not running/);
  assert.match(offline, /Start it with `botkins service start`/);
  // The help lists every key of every tab.
  const help = draw("Overview", { help: true });
  for (const list of Object.values(KEYS)) for (const [, what] of list) assert.ok(help.includes(what), what);
});

test("keys move between tabs and through a list, and the selected row is the one a key acts on", async () => {
  const { app, service, press, type, done } = await dashboard();
  assert.equal(app.state.tab, "Overview");
  press("right");
  assert.equal(app.state.tab, "Devices");
  type("3");
  assert.equal(app.state.tab, "Bots");
  press("left");
  press("left");
  assert.equal(app.state.tab, "Overview");
  press("left");
  assert.equal(app.state.tab, "Logs", "the tabs go round");
  type("2");
  press("down");
  press("down");
  assert.equal(app.state.selected, 1, "the selection stops at the last row");
  // r renames the selected device: a question at the bottom, answered with what is typed.
  type("r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state.prompt.question, "New name for Old iPad:");
  assert.equal(app.state.prompt.value, "Old iPad");
  for (let index = 0; index < 8; index++) press("backspace");
  type("Kitchen iPad");
  assert.match(app.frame().at(-2), /New name for Old iPad: Kitchen iPad/);
  service.calls.length = 0;
  press("return");
  await done();
  assert.deepEqual(service.calls[0], ["devices.rename", "d2", "Kitchen iPad"]);
  // q inside a question is a letter; outside one it quits.
  type("s");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.key({ ch: "q" }), undefined);
  assert.equal(app.state.prompt.value, "q");
  press("escape");
  await done();
  assert.equal(app.state.prompt, null);
  assert.equal(app.key({ ch: "q" }), "quit");
  assert.equal(app.key({ name: "c", ctrl: true }), "quit");
  app.stop();
});

test("the common edits are one key and an answer each, and a refusal is shown and changes nothing", async () => {
  const answers = {
    "devices.rename": (id, name) => ({ id, name }),
    "devices.setPerson": (id, person) => ({ id, name: "Sam's iPhone", ...(person && { person }) }),
    "devices.remove": (id) => ({ removed: id, name: "Sam's iPhone" }),
    "bots.add": (data) => ({ id: "b3", ...data }),
    "bots.edit": (id, patch) => ({ id, name: patch.name ?? "Nova" }),
    "bots.remove": () => { throw new ControlError("Keep at least one bot.", "FAILED"); },
    models: [{ ref: "claude/sonnet" }, { ref: "claude/opus" }],
    "relay.set": (on) => ({ enabled: on, connected: false }),
    "routines.run": () => ({ name: "Morning brief" }),
    "routines.pause": () => ({ name: "Morning brief" }),
    "chat.open": () => ({ chatId: "c9", bot: { name: "Pip" } }),
    "chat.send": () => ({ chatId: "c9", after: 0 }),
    "chat.read": () => ({ chatId: "c9", working: true, stream: "Thinking", messages: [{ index: 0, role: "user", text: "Hello Pip" }], count: 1, seen: "x" }),
    "chat.stop": null,
    "pair.start": { code: "ABCDEFGH12", url: "botkins://pair?c=ABCDEFGH12", expiresAt: "2026-01-02T12:05:00Z", qr: "██  ██\n  ██  " },
    "devices.list": () => [...DATA["devices.list"], ...arrived],
  };
  const arrived = [];
  const { app, service, press, type, done, screen } = await dashboard(answers);
  const asked = () => service.calls.filter(([name]) => !["status", "providers.list", "devices.list", "bots.list", "chat.list", "routines.list", "runs.list", "logs.read"].includes(name));
  const answer = async (text) => {
    await new Promise((resolve) => setImmediate(resolve));
    type(text);
    press("return");
  };
  // Overview: the relay.
  type("R");
  await done();
  assert.deepEqual(asked().at(-1), ["relay.set", true]);
  assert.match(screen(), /The relay is on\./);
  // Devices: whose it is, and unpairing after a yes.
  type("2");
  type("s");
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 3; index++) press("backspace");
  await answer("Alex");
  await done();
  assert.deepEqual(asked().at(-1), ["devices.setPerson", "d1", "Alex"]);
  type("x");
  await answer("n");
  await done();
  assert.notEqual(asked().at(-1)[0], "devices.remove", "a no unpairs nothing");
  type("x");
  await answer("y");
  await done();
  assert.deepEqual(asked().at(-1), ["devices.remove", "d1"]);
  // Bots: add, model, and a refusal from the service.
  type("3");
  type("a");
  await answer("Scout");
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 9; index++) press("backspace");
  await answer("Research partner");
  await done();
  assert.deepEqual(asked().at(-1), ["bots.add", { name: "Scout", role: "Research partner" }]);
  type("m");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(app.state.prompt.question, /Model for Nova \(claude\/sonnet, claude\/opus; empty for the default\):/);
  for (let index = 0; index < 13; index++) press("backspace");
  await answer("claude/opus");
  await done();
  assert.deepEqual(asked().at(-1), ["bots.edit", "b1", { model: "claude/opus" }]);
  type("x");
  await answer("y");
  await done();
  assert.match(screen(), /Keep at least one bot\./);
  // A message to a bot opens its chat, where the reply shows as it is written.
  press("down");
  type("c");
  await answer("Hello Pip");
  await done();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(asked().filter(([name]) => name.startsWith("chat.")).slice(0, 3).map(([name, ...args]) => [name, args[0]]), [["chat.open", "b2"], ["chat.send", "c9"], ["chat.read", "c9"]]);
  assert.equal(app.state.tab, "Chats");
  assert.match(screen(), /you  Hello Pip/);
  assert.match(screen(), /Pip  Thinking/);
  type("S");
  await done();
  assert.deepEqual(asked().at(-1), ["chat.stop", "c9"]);
  press("escape");
  assert.equal(app.state.reading, null);
  // Routines: run now, and pause.
  type("5");
  type("r");
  await done();
  assert.deepEqual(asked().at(-1), ["routines.run", "r1"]);
  app.key({ name: "space", ch: " " });
  await done();
  assert.deepEqual(asked().at(-1), ["routines.pause", "r1"]);
  // Pairing: the code is on the screen until a new device appears.
  type("2");
  type("p");
  await done();
  assert.match(screen(), /██  ██/);
  assert.match(screen(), /Code   ABCDEFGH12/);
  arrived.push({ id: "d3", name: "New phone", kind: "phone", platform: "ios", connected: true });
  await app.refresh();
  assert.equal(app.state.overlay, null);
  assert.match(screen(), /Paired: New phone/);
  app.stop();
});

test("the log follows new lines, scrolls back, and the screen says so when the service goes away", async () => {
  let down = false;
  const { app, screen, press, type } = await dashboard({ status: () => { if (down) throw new ControlError("Botkins isn't running here.", "NOT_RUNNING"); return STATUS; } }, { width: 90, height: 14 });
  type("6");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(screen(), /11:59:40 error Phone link: bind failed/);
  for (let index = 3; index <= 40; index++) app.state.logs.push({ n: index, time: "2026-01-02T12:00:00.000Z", level: "info", text: "line " + index });
  assert.match(screen(), /line 40/);
  assert.doesNotMatch(screen(), /line 20 /);
  press("pageup");
  assert.equal(app.state.follow, false);
  assert.doesNotMatch(screen(), /line 40/);
  type("f");
  assert.equal(app.state.follow, true);
  assert.match(screen(), /line 40/);
  down = true;
  await app.refresh();
  assert.match(screen(), /Botkins is not running on this data folder\./);
  down = false;
  await app.refresh();
  assert.match(screen(), /^Botkins 9\.9\.9/);
  app.stop();
});

// ---- The commands screen, against a real service and a stand-in terminal.
const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
/** A real service with one bot, and the dashboard open on a stand-in terminal of 80 by 24 that is also the commands' terminal. */
async function liveDashboard(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-tui-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ providers: { only: ["grok"] }, link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  await client.call("bots.add", { name: "Scout", role: "Helper" });
  let out = "";
  const stdout = new Writable({ write: (chunk, _encoding, done) => (void (out += String(chunk)), done()) });
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24 });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
  const run = (words, io) => main(words, { env: { NO_COLOR: "1" }, client, stdin, stdout, stderr: stdout, ...io });
  const closed = runDashboard({ client, stdin, stdout, stderr: stdout, env: { NO_COLOR: "1" }, run });
  t.after(async () => {
    // Ctrl-C quits the dashboard from its screens; at the end of a command it first brings the dashboard back.
    stdin.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("\u0003");
    await closed;
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const screen = () => stripVTControlCharacters(out.split("\u001b[H").at(-1));
  const until = async (pattern, from = () => out, what = pattern) => {
    for (let waited = 0; waited < 8000; waited += 10) {
      if (pattern.test(stripVTControlCharacters(from()))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("never seen: " + what + "\n" + stripVTControlCharacters(from()).slice(-1500));
  };
  const keys = { down: "\u001b[B", enter: "\r" };
  // The way to a command: the commands screen, the area, the picked row, the command.
  const areaAt = areasOf(COMMANDS).findIndex((area) => area.word === "bots");
  const leafAt = (name) => leavesOf({ word: "bots", command: COMMANDS.bots }).findIndex((leaf) => leaf.name === name);
  const to = async (name, rowPicked) => {
    stdin.write(":");
    await until(/Commands {2}each area of the command line/, screen);
    stdin.write(keys.down.repeat(areaAt) + keys.enter);
    await until(/State \(botkins bots list\)[\s\S]*Scout/, screen);
    if (rowPicked) stdin.write(keys.enter);
    else stdin.write("\t");
    await until(/Commands/, screen);
    stdin.write(keys.down.repeat(leafAt(name)) + keys.enter);
    await until(new RegExp("Usage: botkins bots " + name), screen);
  };
  return { client, stdin, out: () => out, screen, until, keys, to, closed, mark: () => out.length };
}

test("the commands screen lists the areas of the tree, shows an area's list, and runs the command it shows", { skip }, async (t) => {
  const { stdin, screen, until, to, out, mark, keys } = await liveDashboard(t);
  await until(/Botkins 9\.9\.9/, screen);
  stdin.write(":");
  await until(/Commands {2}each area/, screen);
  // Each word of the tree is a row, with its summary, in the order of the tree.
  assert.match(screen(), new RegExp("bots\\s+" + COMMANDS.bots.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(screen(), /routines\s+/);
  assert.doesNotMatch(screen(), /^tui\s/m, "the dashboard is not in its own list");
  stdin.write("\u001b");
  await until(/^Botkins 9\.9\.9/, screen);
  // The area: the list command's rows, then its commands, then one command with its line.
  await to("list");
  assert.match(screen(), /botkins bots list \|/, "the line, with the cursor");
  assert.doesNotMatch(screen(), /--yes/);
  const before = mark();
  stdin.write(keys.enter);
  await until(/The command ended with exit code 0\. Press a key/, () => out().slice(before), "the real command's end");
  const shown = stripVTControlCharacters(out().slice(before));
  assert.match(shown, /\$ botkins bots list\n/);
  assert.match(shown, /NAME\s+ROLE[\s\S]*Scout\s+Helper/, "what `botkins bots list` prints");
  stdin.write(" ");
  await until(/Last run: bots list ended with exit code 0\./, screen);
});

test("the dashboard passes no --yes and answers no question: a command that asks asks on the terminal, and a no changes nothing", { skip }, async (t) => {
  const { client, stdin, screen, until, to, out, mark } = await liveDashboard(t);
  // The picked row gives its name to the line; the flags are the person's to write.
  await to("remove", true);
  assert.match(screen(), /It asks first\./);
  assert.match(screen(), /botkins bots remove Scout \|/);
  const before = mark();
  stdin.write("\r");
  await until(/\[y\/N\]/, () => out().slice(before), "the command's own question");
  const shown = () => stripVTControlCharacters(out().slice(before));
  assert.match(shown(), /\$ botkins bots remove Scout\n/);
  assert.doesNotMatch(shown(), /--yes|-y\b/);
  // Nobody has answered: the command waits, and the bot is there.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.doesNotMatch(shown(), /exit code/);
  assert.equal((await client.call("bots.list")).length, 1);
  stdin.write("n\r");
  await until(/exit code [1-9]/, shown, "the end of the refused command");
  assert.equal((await client.call("bots.list")).length, 1, "a no removes nothing");
  assert.equal((await client.call("bots.list"))[0].name, "Scout");
});
