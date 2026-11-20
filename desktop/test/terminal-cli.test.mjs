// The `botkins` command line (desktop/cli): how it reads its arguments, what it prints with and
// without --json, and how it ends, against a stand-in for the running service.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { COMMANDS, main, version } from "../cli/main.mjs";
import { find, help } from "../cli/commands/index.mjs";
import { examine } from "../cli/commands/service.mjs";
import { ago, duration, EXIT, table } from "../cli/output.mjs";
import { ControlError } from "../desktop/terminal/socket.mjs";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A service that answers each call from `answers` (a value, or a function of the arguments) and keeps what it was asked. */
function fakeService(answers = {}) {
  const calls = [];
  return {
    calls,
    client: {
      running: async () => answers.running !== false,
      hello: async () => ({ app: "botkins", api: 1, version: "9.9.9", pid: 1 }),
      async call(method, ...args) {
        calls.push([method, ...args]);
        if (answers.running === false) throw new ControlError("Botkins isn't running here.", "NOT_RUNNING");
        if (!Object.hasOwn(answers, method)) throw new ControlError("The service has no call named " + method + ".", "UNKNOWN_METHOD");
        const answer = answers[method];
        return typeof answer === "function" ? answer(...args) : answer;
      },
    },
  };
}
/** Runs the command line. Returns { exit, out, err, json() }. */
async function botkins(argv, { service = fakeService(), input = "", env = {}, tty = false } = {}) {
  let out = "";
  let err = "";
  const stdin = Readable.from(input ? [input] : []);
  stdin.isTTY = tty;
  const exit = await main(argv, {
    stdout: { write: (text) => void (out += text), isTTY: false },
    stderr: { write: (text) => void (err += text), isTTY: false },
    stdin,
    env: { BOTKINS_DATA_DIR: "/nowhere/botkins", ...env },
    client: service.client,
  });
  return { exit, out, err, calls: service.calls, json: () => JSON.parse(out) };
}
const STATUS = { running: true, version: "9.9.9", pid: 77, uptimeSeconds: 3725, node: "24.0.0", platform: "linux/arm64", dataDir: "/var/lib/botkins", socket: "/var/lib/botkins/run/botkins.sock", memory: { rssMb: 91.5, heapUsedMb: 20 }, link: { enabled: true, listening: true, port: 47610, name: "Studio", addresses: ["10.0.0.5:47610"], pairing: false, devices: 2, connected: 1 }, relay: { enabled: true, connected: true, url: "https://relay.botkins.app" }, workspace: { bots: 3, chats: 4, routines: 1, working: 1, waiting: 0 }, secrets: { source: "systemd", where: "systemd credential" }, vault: { locked: false, entries: 2 }, update: { status: "idle" } };
const DEVICES = [{ id: "d1", name: "Sam's iPhone", person: "Sam", kind: "phone", platform: "ios", connected: true, pairedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z" }];

test("every command explains itself, and a word that names none is a usage error", async () => {
  const top = await botkins([]);
  assert.equal(top.exit, EXIT.ok);
  for (const name of ["serve", "status", "logs", "doctor", "pair", "devices", "bots", "providers", "models", "chat", "routines", "plugins", "config", "relay", "update"]) {
    assert.match(top.out, new RegExp("^  " + name + "\\s", "m"), name + " is in the help");
    assert.ok(COMMANDS[name], name);
  }
  assert.equal((await botkins(["help"])).out, top.out);
  assert.equal((await botkins(["--help"])).out, top.out);
  // Every command and group has a summary, and every command that runs says how it is used.
  const walk = (commands, path) => {
    for (const [name, command] of Object.entries(commands)) {
      assert.ok(command.summary, [...path, name].join(" ") + " has a summary");
      if (command.commands) walk(command.commands, [...path, name]);
      else {
        assert.equal(typeof command.run, "function", [...path, name].join(" "));
        assert.match(command.usage, new RegExp("^botkins " + [...path, name].join(" ")), [...path, name].join(" "));
        assert.match(help(find([...path, name])), /Usage: botkins /);
      }
    }
  };
  walk(COMMANDS, []);
  for (const subcommands of [["devices", ["list", "rename", "set-person", "remove"]], ["bots", ["list", "add", "edit", "remove"]], ["providers", ["list", "login", "logout"]], ["routines", ["list", "run", "pause", "resume"]], ["config", ["get", "set", "edit"]], ["relay", ["on", "off", "status"]]])
    for (const name of subcommands[1]) assert.ok(COMMANDS[subcommands[0]].commands[name], subcommands[0] + " " + name);
  assert.match((await botkins(["help", "devices", "rename"])).out, /Usage: botkins devices rename <device> <name>/);
  assert.match((await botkins(["bots", "add", "--help"])).out, /--instructions-file <path>/);
  const group = await botkins(["devices"]);
  assert.deepEqual([group.exit, /set-person/.test(group.out)], [EXIT.usage, true]);
  for (const argv of [["bogus"], ["devices", "bogus"], ["help", "bogus"], ["status", "--bogus"], ["devices", "rename", "only-one"], ["bots", "add"], ["config", "set", "name"]]) {
    const result = await botkins(argv, { service: fakeService({ status: STATUS }) });
    assert.equal(result.exit, EXIT.usage, argv.join(" "));
    assert.match(result.err, /^botkins: /, argv.join(" "));
    assert.equal(result.out, "", argv.join(" ") + " prints nothing on standard output");
  }
  assert.equal((await botkins(["--version"])).out.trim(), version());
  assert.deepEqual((await botkins(["--version", "--json"])).json(), { version: version() });
});

test("options may stand anywhere, and an option's value is never taken for the command", async () => {
  const service = fakeService({ "devices.rename": (ref, name) => ({ ...DEVICES[0], name }), status: STATUS });
  const first = await botkins(["--json", "--data-dir", "/srv/status", "devices", "rename", "d1", "Kitchen phone"], { service });
  assert.equal(first.exit, EXIT.ok);
  assert.equal(first.json().name, "Kitchen phone");
  assert.deepEqual(service.calls.at(-1), ["devices.rename", "d1", "Kitchen phone"]);
  const second = await botkins(["devices", "--json", "rename", "d1", "--socket=/run/x.sock", "status"], { service });
  assert.deepEqual(service.calls.at(-1), ["devices.rename", "d1", "status"]);
  assert.equal(second.json().name, "status");
  // After "--" everything is the command's own words.
  await botkins(["devices", "rename", "--", "d1", "--odd name"], { service });
  assert.deepEqual(service.calls.at(-1), ["devices.rename", "d1", "--odd name"]);
});

test("with --json a command prints exactly one JSON document, the service's own value", async () => {
  const bots = [{ id: "b1", name: "Nova", role: "Editor", instructions: "Be brief.", model: { provider: "claude", model: "sonnet" }, chats: 2, working: false }];
  const service = fakeService({
    status: STATUS,
    "devices.list": DEVICES,
    "bots.list": bots,
    "bots.add": (data) => ({ ...bots[0], ...data, id: "b2" }),
    "providers.list": [{ id: "claude", name: "Claude", enabled: true, installed: true, connected: true, account: "sam@example.com", plan: "Claude Max" }],
    models: [{ ref: "claude/sonnet", name: "Sonnet", provider: "claude", providerName: "Claude", available: true, efforts: [] }],
    "routines.list": [],
    "plugins.list": [],
    "relay.status": STATUS.relay,
    "relay.set": (on) => ({ ...STATUS.relay, enabled: on }),
    "config.get": { name: "Studio" },
    "pair.start": { code: "ABCDEFGH12", url: "botkins://pair?c=ABCDEFGH12", expiresAt: "2026-01-01T00:05:00.000Z", qr: "██\n██" },
  });
  for (const [argv, value] of [
    [["status"], STATUS],
    [["devices", "list"], DEVICES],
    [["bots", "list"], bots],
    [["providers", "list"], service.client.call("providers.list")],
    [["models"], service.client.call("models")],
    [["routines", "list"], []],
    [["plugins", "list"], []],
    [["relay", "status"], STATUS.relay],
    [["relay", "off"], { ...STATUS.relay, enabled: false }],
    [["pair"], service.client.call("pair.start")],
  ]) {
    const result = await botkins([...argv, "--json"], { service });
    assert.equal(result.exit, EXIT.ok, argv.join(" "));
    assert.equal(result.out.trim().split("\n").length, 1, argv.join(" ") + " prints one line");
    assert.deepEqual(result.json(), await value, argv.join(" "));
  }
  // Without it, the same value is laid out for a person.
  const status = await botkins(["status"], { service });
  assert.match(status.out, /Botkins 9\.9\.9  running for 1h 2m/);
  assert.match(status.out, /Devices\s+2 paired, 1 connected/);
  assert.match(status.out, /Relay\s+connected/);
  assert.match(status.out, /Memory\s+91\.5 MB/);
  const devices = await botkins(["devices", "list"], { service });
  assert.match(devices.out, /^NAME\s+PERSON\s+KIND\s+PLATFORM\s+STATE\s+ID$/m);
  assert.match(devices.out, /^Sam's iPhone\s+Sam\s+phone\s+ios\s+connected\s+d1$/m);
  // What a command is given goes to the service as it stands.
  const added = await botkins(["bots", "add", "Scout", "--role", "Research partner", "--model", "claude/sonnet", "--json"], { service });
  assert.deepEqual(service.calls.at(-1), ["bots.add", { name: "Scout", role: "Research partner", model: "claude/sonnet" }]);
  assert.equal(added.json().id, "b2");
  const pairing = await botkins(["pair", "--no-wait", "--no-qr"], { service });
  assert.match(pairing.out, /Code\s+ABCDEFGH12/);
  assert.doesNotMatch(pairing.out, /██/);
});

test("a failure is one sentence on standard error, an error document with --json, and an exit code a script can test", async () => {
  const stopped = fakeService({ running: false });
  const status = await botkins(["status"], { service: stopped });
  assert.deepEqual([status.exit, /Botkins is not running/.test(status.out)], [EXIT.notRunning, true]);
  const asJson = await botkins(["status", "--json"], { service: stopped });
  assert.equal(asJson.exit, EXIT.notRunning);
  assert.deepEqual(asJson.json(), { running: false, dataDir: "/nowhere/botkins", socket: "/nowhere/botkins/run/botkins.sock" });
  const list = await botkins(["bots", "list", "--json"], { service: stopped });
  assert.equal(list.exit, EXIT.notRunning);
  assert.deepEqual(list.json(), { error: { message: "Botkins isn't running here.", code: "NOT_RUNNING" } });
  assert.match(list.err, /^botkins: Botkins isn't running here\.\n$/);
  const denied = fakeService({ "bots.list": () => { throw new ControlError("This user may not talk to the Botkins service.", "DENIED"); } });
  assert.equal((await botkins(["bots", "list"], { service: denied })).exit, EXIT.denied);
  const failing = fakeService({ "bots.remove": () => { throw new ControlError("There is no bot called Nobody.", "NOT_FOUND"); } });
  const removed = await botkins(["bots", "remove", "Nobody", "--yes", "--json"], { service: failing });
  assert.deepEqual([removed.exit, removed.json().error.code], [EXIT.failed, "NOT_FOUND"]);
  // What changes or removes something asks first, and a script has to say yes.
  const unasked = await botkins(["bots", "remove", "Nova"], { service: failing });
  assert.deepEqual([unasked.exit, /--yes/.test(unasked.err), failing.calls.length], [EXIT.usage, true, 1]);
});

test("a token is typed or piped, never an argument", async () => {
  const service = fakeService({ "providers.login": () => ({ connected: true, account: "sam@example.com", plan: "Claude Max" }) });
  const piped = await botkins(["providers", "login", "claude", "--token", "--json"], { service, input: "sk-ant-oat01-fixture\n" });
  assert.equal(piped.exit, EXIT.ok);
  assert.deepEqual(service.calls.at(-1), ["providers.login", "claude", { token: "sk-ant-oat01-fixture", service: undefined }]);
  assert.doesNotMatch(piped.out + piped.err, /sk-ant-oat01-fixture/, "the token is never printed back");
  assert.equal(piped.json().account, "sam@example.com");
  // A token given as a word is refused as a mistake in the command, before anything is sent.
  const before = service.calls.length;
  const wrong = await botkins(["providers", "login", "claude", "--token", "sk-ant-oat01-fixture"], { service });
  assert.deepEqual([wrong.exit, service.calls.length], [EXIT.usage, before]);
  const empty = await botkins(["providers", "login", "claude", "--token"], { service, input: "\n" });
  assert.deepEqual([empty.exit, /Nothing was entered/.test(empty.err)], [EXIT.usage, true]);
});

test("a sign-in the service runs is followed line by line, and a piped line answers its question", async () => {
  const views = [
    { events: [{ n: 1, type: "output", text: "Open https://example.com/device" }, { n: 2, type: "open", url: "https://example.com/device" }, { n: 3, type: "code", url: "https://github.com/login/device", code: "ABCD-1234" }], next: 3, done: false },
    { events: [{ n: 4, type: "prompt", text: "Paste the code" }], next: 4, done: false },
    { events: [], next: 4, done: true, result: { connected: true, account: "sam", plan: null } },
  ];
  const service = fakeService({ "providers.login": { session: "s1" }, "providers.login.read": () => views.shift(), "providers.login.input": null, "providers.login.cancel": true });
  const result = await botkins(["providers", "login", "copilot"], { service, input: "the-code\n" });
  assert.equal(result.exit, EXIT.ok);
  assert.match(result.out, /https:\/\/github\.com\/login\/device/);
  assert.match(result.out, /ABCD-1234/);
  assert.match(result.out, /Signed in as sam\./);
  assert.deepEqual(service.calls.find(([name]) => name === "providers.login.input"), ["providers.login.input", "s1", "the-code"]);
  // With nothing to answer with, the sign-in is cancelled and the command says how to do it instead.
  const stuck = fakeService({ "providers.login": { session: "s2" }, "providers.login.read": { events: [{ n: 1, type: "prompt", text: "" }], next: 1, done: false }, "providers.login.cancel": true });
  const failed = await botkins(["providers", "login", "claude"], { service: stuck });
  assert.deepEqual([failed.exit, /Run it at a terminal, or sign in with --token/.test(failed.err)], [EXIT.failed, true]);
  assert.ok(stuck.calls.some(([name]) => name === "providers.login.cancel"));
});

test("one message is sent and its reply printed, and a script gets the reply as JSON", async () => {
  const reads = [
    { working: true, stream: "Hello", messages: [], count: 1, seen: "a", run: null },
    { working: true, stream: "Hello there", messages: [], count: 1, seen: "b", run: null },
    { working: false, stream: "", messages: [{ index: 1, role: "assistant", text: "Hello there, Sam." }], count: 2, seen: "c", run: { status: "Completed" } },
  ];
  const answers = { "chat.open": { chatId: "c1", bot: { id: "b1", name: "Nova" } }, "chat.send": { chatId: "c1", after: 0 }, "chat.read": () => reads.shift() };
  const live = await botkins(["chat", "Nova", "-m", "Hi"], { service: fakeService(answers) });
  assert.deepEqual([live.exit, live.out], [EXIT.ok, "Hello there\nHello there, Sam.\n"]);
  reads.push({ working: false, stream: "", messages: [{ index: 1, role: "assistant", text: "Done." }], count: 2, seen: "c", run: { status: "Completed" } });
  const service = fakeService(answers);
  const scripted = await botkins(["chat", "Nova", "--message", "-", "--json"], { service, input: "From a pipe" });
  assert.deepEqual(scripted.json(), { chatId: "c1", reply: "Done.", status: "Completed" });
  assert.deepEqual(service.calls.find(([name]) => name === "chat.send"), ["chat.send", "c1", "From a pipe"]);
  // A bot that asks for approval with nobody at a terminal is refused, never approved by default.
  reads.push({ working: true, stream: "", messages: [], count: 1, seen: "a", run: null, request: { id: "r1", kind: "permission", title: "Run rm -rf build" } }, { working: false, stream: "", messages: [{ index: 1, role: "assistant", text: "Not done." }], count: 2, seen: "b", run: { status: "Completed" } });
  const asked = fakeService({ ...answers, "chat.respond": null });
  await botkins(["chat", "Nova", "-m", "Clean up", "--json"], { service: asked });
  assert.deepEqual(asked.calls.find(([name]) => name === "chat.respond"), ["chat.respond", "r1", { action: "deny" }]);
  // A turn that failed ends the command with a failure.
  reads.push({ working: false, stream: "", messages: [], count: 1, seen: "a", run: { status: "Failed", detail: "The model is unavailable." } });
  const failed = await botkins(["chat", "Nova", "-m", "Hi", "--json"], { service: fakeService(answers) });
  assert.deepEqual([failed.exit, failed.json().status, failed.json().detail], [EXIT.failed, "Failed", "The model is unavailable."]);
  const noTerminal = await botkins(["chat", "Nova"], { service: fakeService(answers) });
  assert.deepEqual([noTerminal.exit, /use -m/.test(noTerminal.err)], [EXIT.usage, true]);
});

test("the log is read through the service, and from its file only when no service holds it", async (t) => {
  const entries = [{ n: 1, time: "2026-01-01T00:00:00.000Z", level: "info", text: "Ready." }, { n: 2, time: "2026-01-01T00:00:01.000Z", level: "error", text: "Phone link: bind failed" }];
  const service = fakeService({ "logs.read": (options) => ({ entries: entries.slice(-(options.tail ?? 2)), next: 2 }) });
  const shown = await botkins(["logs", "-n", "1"], { service });
  assert.equal(shown.out, "2026-01-01T00:00:01.000Z error Phone link: bind failed\n");
  assert.deepEqual(service.calls[0], ["logs.read", { tail: 1 }]);
  assert.deepEqual((await botkins(["logs", "--json"], { service })).json(), entries);
  assert.equal((await botkins(["logs", "-n", "many"], { service })).exit, EXIT.usage);
  const dir = tempDir(t);
  const root = join(dir, "root");
  const stopped = fakeService({ running: false });
  const none = await botkins(["logs", "--json"], { service: stopped, env: { BOTKINS_DATA_DIR: root } });
  assert.deepEqual(none.json(), []);
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, "logs", "botkins.log"), "2026-01-01T00:00:00.000Z info  Ready.\n2026-01-01T00:00:09.000Z info  Stopped.\n");
  const fromFile = await botkins(["logs", "-n", "1", "--json"], { service: stopped, env: { BOTKINS_DATA_DIR: root } });
  assert.deepEqual(fromFile.json().map((entry) => entry.text), ["Stopped."]);
  const follow = await botkins(["logs", "-f"], { service: stopped, env: { BOTKINS_DATA_DIR: root } });
  assert.equal(follow.exit, EXIT.notRunning);
});

test("settings are changed through the service while it runs, and in the file only when it doesn't", async (t) => {
  const root = join(tempDir(t), "root");
  const live = fakeService({ "config.get": { name: "Studio", link: { enabled: true, port: 47610, announce: true, addresses: [] }, relay: { enabled: false, url: "https://relay.botkins.app" }, providers: { only: [] }, secrets: { source: "auto", keyFile: null }, updates: { check: true }, logs: { level: "info", lines: 5000 } }, "config.replace": (next) => ({ changed: ["link.port"], restart: ["link.port"], next }) });
  const set = await botkins(["config", "set", "link.port", "47611"], { service: live, env: { BOTKINS_DATA_DIR: root } });
  assert.equal(set.exit, EXIT.ok);
  assert.match(set.out, /Saved: link\.port\.\nlink\.port takes effect when the service restarts/);
  assert.equal(live.calls.at(-1)[1].link.port, 47611);
  assert.throws(() => statSync(join(root, "config.json")), "the command line wrote no file of the running service's");
  assert.equal((await botkins(["config", "get", "name"], { service: live })).out, "Studio\n");
  assert.equal((await botkins(["config", "get", "link.port", "--json"], { service: live })).out, "47610\n");
  assert.equal((await botkins(["config", "set", "link.port", "abc"], { service: live })).exit, EXIT.failed);
  assert.equal((await botkins(["config", "get", "nope"], { service: live })).exit, EXIT.failed);
  // No service: the file is nobody's to hold, and is written whole and checked.
  const stopped = fakeService({ running: false });
  const offline = await botkins(["config", "set", "name", "Workshop", "--json"], { service: stopped, env: { BOTKINS_DATA_DIR: root } });
  assert.deepEqual(offline.json(), { changed: ["name"], restart: [], value: "Workshop" });
  assert.equal(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).name, "Workshop");
  assert.equal(statSync(join(root, "config.json")).mode & 0o777, 0o600);
  assert.equal((await botkins(["config", "get", "name"], { service: stopped, env: { BOTKINS_DATA_DIR: root } })).out, "Workshop\n");
  assert.deepEqual((await botkins(["config", "path", "--json"], { service: stopped, env: { BOTKINS_DATA_DIR: root } })).json(), { path: join(root, "config.json"), exists: true });
  assert.equal((await botkins(["config", "edit"], { service: stopped })).exit, EXIT.usage, "an editor needs a terminal");
});

test("doctor checks the computer with the service stopped, and more with it running", async (t) => {
  const root = join(tempDir(t), "root");
  const paths = { root, config: join(root, "config.json"), socket: join(root, "run", "botkins.sock") };
  const reachable = async () => ({ status: 200 });
  const stopped = await examine({ paths, client: fakeService({ running: false }).client, env: {}, fetcher: reachable, node: "24.1.0" });
  const names = (report) => Object.fromEntries(report.checks.map((entry) => [entry.name, entry.ok]));
  assert.deepEqual(names(stopped), { "Node.js": true, "Data folder": null, Config: true, Service: null, "Phone link port": true, Relay: null });
  assert.equal(stopped.ok, true);
  assert.equal((await examine({ paths, client: fakeService({ running: false }).client, env: {}, fetcher: reachable, node: "20.11.0" })).ok, false, "a Node.js too old is a failure");
  assert.equal(names(await examine({ paths, client: fakeService({ running: false }).client, env: {}, fetcher: reachable, node: "22.14.0" }))["Node.js"], null);
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o755 });
  writeFileSync(join(root, "data", "vault.json"), "{}", { mode: 0o644 });
  writeFileSync(paths.config, '{ "relay": { "enabled": true }, "nope": 1 }', { mode: 0o600 });
  chmodSync(root, 0o755);
  const loose = await examine({ paths, client: fakeService({ running: false }).client, env: {}, fetcher: reachable, node: "24.1.0" });
  assert.deepEqual([names(loose)["Data folder"], names(loose)["Private files"], names(loose).Config, loose.ok], [false, false, false, false]);
  assert.match(loose.checks.find((entry) => entry.name === "Private files").detail, /data\/vault\.json \(644\)/);
  assert.match(loose.checks.find((entry) => entry.name === "Data folder").fix, /chmod 700/);
  chmodSync(root, 0o700);
  chmodSync(join(root, "data", "vault.json"), 0o600);
  writeFileSync(paths.config, '{ "relay": { "enabled": true } }', { mode: 0o600 });
  const seen = { version: "9.9.9", node: "24.1.0", link: { enabled: true, listening: true, port: 47610, locked: false }, relay: { enabled: true, connected: false, url: "https://relay.botkins.app" }, vault: { locked: false }, secrets: { source: "systemd", where: "systemd credential" }, providers: [{ id: "claude", name: "Claude", enabled: true, installed: true, connected: true, account: "sam@example.com" }, { id: "codex", name: "Codex", enabled: true, installed: false, connected: false, message: "Install the Codex CLI." }, { id: "grok", name: "Grok", enabled: false, installed: true, connected: false }], desktopOnly: ["Viewing and controlling the screen"] };
  const down = async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
  const running = await examine({ paths, client: fakeService({ doctor: seen }).client, env: {}, fetcher: down, node: "24.1.0" });
  assert.deepEqual(names(running), { "Node.js": true, "Data folder": true, "Private files": true, Config: true, Service: true, "Control socket": true, "Secrets at rest": true, "Phone link": true, "Provider: Claude": true, "Provider: Codex": null, Relay: false });
  assert.match(running.checks.find((entry) => entry.name === "Relay").detail, /can't be reached from this computer \(ENOTFOUND\)/);
  assert.deepEqual(running.desktopOnly, ["Viewing and controlling the screen"]);
  // The command ends with a failure when something needs fixing, and prints what.
  const report = await botkins(["doctor"], { service: fakeService({ doctor: { ...seen, providers: [] } }), env: { BOTKINS_DATA_DIR: root } });
  assert.equal(report.exit, EXIT.failed);
  assert.match(report.out, /FAIL  Model providers: No provider is signed in/);
  assert.match(report.out, /Not available on a terminal host/);
});

test("tables, times and durations read well", () => {
  assert.equal(table(["NAME", "N"], [["a", 1], ["longer", ""]]), "NAME    N\na       1\nlonger  -");
  assert.equal(ago("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:03:00Z")), "3 minutes ago");
  assert.equal(ago("2026-01-01T02:00:00Z", Date.parse("2026-01-01T00:00:00Z")), "in 2 hours");
  assert.equal(ago(null), "never");
  assert.deepEqual([duration(42), duration(125), duration(3725), duration(90000)], ["42s", "2m 5s", "1h 2m", "1d 1h"]);
});
