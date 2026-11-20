// The terminal host as a running service (desktop/terminal): its control socket, and what the
// command line asks over it, against a whole workspace on the headless host. A stand-in agent
// (test/fixtures/standin-agent.mjs) is the model provider, and a stand-in phone
// (test/fixtures/phone.mjs) pairs and chats, each a real process.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { API, controlClient, ControlError, listenControl } from "../desktop/terminal/socket.mjs";

const run = promisify(execFile);
const skip = process.platform === "win32" && "The terminal host uses Unix sockets.";
const agent = fileURLToPath(new URL("./fixtures/standin-agent.mjs", import.meta.url));
const phone = fileURLToPath(new URL("./fixtures/phone.mjs", import.meta.url));
// A socket's path must be short, and a test's own: the system's temporary folder can be long.
const tempDir = (t) => {
  const dir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

test("the control socket is the owner's only, answers calls, and says plainly when nothing is there", { skip }, async (t) => {
  const dir = tempDir(t);
  const socket = join(dir, "run", "botkins.sock");
  const client = controlClient(socket, { timeout: 5000 });
  await assert.rejects(client.call("status"), { code: "NOT_RUNNING", message: /Botkins isn't running here/ });
  assert.equal(await client.running(), false);
  const calls = [];
  const close = await listenControl(
    socket,
    async (method, args, { signal }) => {
      calls.push([method, args]);
      if (method === "echo") return { said: args };
      if (method === "nothing") return undefined;
      if (method === "wait") return new Promise((resolve) => signal.addEventListener("abort", () => resolve(calls.push(["abandoned"]))));
      throw new ControlError("No such call.", "UNKNOWN_METHOD");
    },
    () => ({ version: "1.2.3", pid: 42 }),
  );
  t.after(close);
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "run")).mode & 0o777, 0o700);
  assert.deepEqual(await client.hello(), { app: "botkins", api: API, version: "1.2.3", pid: 42 });
  assert.equal(await client.running(), true);
  assert.deepEqual(await client.call("echo", 1, "two", { three: [3] }), { said: [1, "two", { three: [3] }] });
  assert.equal(await client.call("nothing"), null);
  await assert.rejects(client.call("missing"), { name: "ControlError", code: "UNKNOWN_METHOD", message: "No such call." });
  // A second service on the same folder is refused; the first keeps its socket.
  await assert.rejects(listenControl(socket, () => {}), { code: "ALREADY_RUNNING" });
  assert.equal(await client.running(), true);
  // A caller that goes away ends its call's wait.
  await assert.rejects(controlClient(socket, { timeout: 150 }).call("wait"), { code: "TIMEOUT" });
  for (let tries = 0; tries < 50 && !calls.some(([name]) => name === "abandoned"); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some(([name]) => name === "abandoned"));
  await close();
  assert.equal(existsSync(socket), false);
  // A socket left by a service that was killed is replaced; a file in its place is not.
  const left = createServer().listen(socket);
  await new Promise((resolve) => left.once("listening", resolve));
  left.unref();
  await new Promise((resolve) => left.close(resolve));
  const again = await listenControl(socket, () => "ok");
  assert.equal(await client.call("anything"), "ok");
  await again();
  writeFileSync(socket, "not a socket");
  await assert.rejects(listenControl(socket, () => {}), { code: "SOCKET_PATH" });
  await assert.rejects(listenControl(join(dir, "x".repeat(120), "botkins.sock"), () => {}), { code: "SOCKET_PATH", message: /too long/ });
});

/** A service on a folder of its own, with the stand-in agent as its only provider. */
async function service(t, { signedIn = true, config = {} } = {}) {
  const dir = tempDir(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The provider "grok" finds its tool on the PATH: the stand-in takes that name.
  writeFileSync(join(bin, "grok"), "#!/bin/sh\nexec " + JSON.stringify(process.execPath) + " " + JSON.stringify(agent) + ' "$@"\n');
  chmodSync(join(bin, "grok"), 0o755);
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, STANDIN_AGENT_HOME: join(dir, "agent"), STANDIN_AGENT_PIECE_MS: "25" };
  const before = { PATH: process.env.PATH, STANDIN_AGENT_HOME: process.env.STANDIN_AGENT_HOME, STANDIN_AGENT_PIECE_MS: process.env.STANDIN_AGENT_PIECE_MS, BOTKINS_PROVIDERS: process.env.BOTKINS_PROVIDERS };
  // The tools the service starts inherit its environment.
  Object.assign(process.env, { PATH: env.PATH, STANDIN_AGENT_HOME: env.STANDIN_AGENT_HOME, STANDIN_AGENT_PIECE_MS: "25" });
  t.after(() => {
    for (const [name, value] of Object.entries(before)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  if (signedIn) {
    mkdirSync(env.STANDIN_AGENT_HOME, { recursive: true });
    writeFileSync(join(env.STANDIN_AGENT_HOME, "auth"), "signed in\n");
  }
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  const port = await freePort();
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ providers: { only: ["grok"] }, link: { port, announce: false }, ...config }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(() => running.stop("the test ended"));
  const client = controlClient(paths.socket, { timeout: 40_000 });
  await client.call("providers.enable", "grok", true);
  return { dir, paths, port, running, client, env };
}

test("the service starts on its settings, keeps its folder to itself and answers the command line", { skip }, async (t) => {
  const { paths, port, client, running } = await service(t, { config: { name: "Studio server" } });
  for (const [path, mode] of [[paths.root, 0o700], [paths.runDir, 0o700], [paths.socket, 0o600], [paths.config, 0o600], [paths.logFile, 0o600], [join(paths.dataDir, "workspace.json"), 0o600], [join(paths.dataDir, "link", "link.json"), 0o600]])
    assert.equal(statSync(path).mode & 0o777, mode, path);
  const status = await client.call("status");
  assert.equal(status.running, true);
  assert.equal(status.version, "9.9.9");
  assert.equal(status.pid, process.pid);
  assert.deepEqual([status.link.enabled, status.link.listening, status.link.port, status.link.name], [true, true, port, "Studio server"]);
  assert.deepEqual(status.relay, { enabled: false, connected: false, url: "https://relay.botkins.app" });
  assert.deepEqual(status.workspace, { bots: 0, chats: 0, routines: 0, working: 0, waiting: 0 });
  assert.ok(status.memory.rssMb > 10);
  assert.equal(status.dataDir, paths.root);
  // The log says the service is up, and names no secret.
  const log = await client.call("logs.read", { tail: 20 });
  assert.ok(log.entries.some((entry) => /Ready\. Control socket/.test(entry.text)));
  // Settings: read, changed while it runs, checked whole.
  assert.equal(await client.call("config.get", "name"), "Studio server");
  assert.deepEqual(await client.call("config.set", "name", "Workshop"), { changed: ["name"], restart: [] });
  assert.equal((await client.call("status")).link.name, "Workshop");
  assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).name, "Workshop");
  assert.deepEqual(await client.call("config.set", "link.announce", "true"), { changed: ["link.announce"], restart: ["link.announce"] });
  await assert.rejects(client.call("config.set", "link.port", "abc"), { code: "INVALID_CONFIG", message: /link\.port must be a whole number/ });
  await assert.rejects(client.call("config.replace", { nope: true }), { code: "INVALID_CONFIG" });
  assert.equal((await client.call("config.describe")).find((entry) => entry.key === "link.port").restart, true);
  // Phone access off and on again, from the settings.
  await client.call("config.set", "link.enabled", "false");
  assert.deepEqual([(await client.call("status")).link.enabled, (await client.call("status")).link.listening], [false, false]);
  await assert.rejects(client.call("pair.start"), { code: "LINK_OFF" });
  await assert.rejects(client.call("relay.set", true), { code: "LINK_OFF" });
  await client.call("config.set", "link.enabled", "true");
  assert.equal((await client.call("status")).link.listening, true);
  // The relay is the person's choice, saved in the settings. (A trial run keeps the connection itself off the network: nothing here leaves the computer.)
  running.runtime.link.relayOptions = null;
  await client.call("relay.set", true);
  assert.equal(JSON.parse(readFileSync(paths.config, "utf8")).relay.enabled, true);
  await client.call("relay.set", false);
  assert.equal((await client.call("relay.status")).enabled, false);
  // What isn't a call is said so, and a call of the workspace's own is reached by name.
  await assert.rejects(client.call("nope"), { code: "UNKNOWN_METHOD" });
  assert.equal((await client.call("call", "appInfo", [])).host, "terminal");
  await assert.rejects(client.call("call", "nope", []), { code: "UNKNOWN_METHOD" });
  await assert.rejects(client.call("call", "chooseFiles", []), /Choosing a file or folder is not available on this host\./);
  assert.ok((await client.call("methods")).control.includes("bots.add"));
  await assert.rejects(client.call("update.check"), { code: "UNSUPPORTED" });
  // Asked to stop, it stops, and leaves no socket behind.
  await client.call("stop");
  await running.stop();
  assert.equal(existsSync(paths.socket), false);
  await assert.rejects(client.call("status"), { code: "NOT_RUNNING" });
});

test("bots are added, changed and removed by name, and a bot answers in a chat as its reply is written", { skip }, async (t) => {
  const { client } = await service(t);
  const providers = await client.call("providers.list", true);
  assert.deepEqual(providers.map((entry) => [entry.id, entry.enabled, entry.installed, entry.connected]), [["grok", true, true, true]]);
  assert.deepEqual((await client.call("models")).map((model) => model.ref), ["grok/standin-1"]);
  const nova = await client.call("bots.add", { name: "Nova", role: "Editor", instructions: "Be brief.", model: "grok/standin-1" });
  assert.deepEqual([nova.name, nova.role, nova.model.model, nova.chats], ["Nova", "Editor", "standin-1", 0]);
  const plain = await client.call("bots.add", { name: "Pip" });
  assert.deepEqual([plain.role, plain.instructions], ["Assistant", "Help with what you are asked, clearly and briefly."]);
  await assert.rejects(client.call("bots.add", {}), { code: "BAD_ARGUMENT" });
  await assert.rejects(client.call("bots.add", { name: "Half", model: "grok/nope" }), { code: "NOT_FOUND" });
  assert.deepEqual((await client.call("bots.list")).map((bot) => bot.name), ["Nova", "Pip"], "a bot that couldn't be given its model is not left behind");
  assert.equal((await client.call("bots.edit", "nova", { role: "Copy editor" })).role, "Copy editor");
  assert.equal((await client.call("bots.edit", nova.id, { name: "Nova II", model: "" })).model, undefined);
  await assert.rejects(client.call("bots.get", "Nobody"), { code: "NOT_FOUND" });
  await client.call("bots.add", { name: "pip" });
  await assert.rejects(client.call("bots.get", "PIP"), { code: "AMBIGUOUS" });
  assert.deepEqual(await client.call("bots.remove", plain.id), { removed: plain.id, name: "Pip" });
  await client.call("models.default", "grok/standin-1");
  // A chat: the reply is read while it grows, then whole.
  const { chatId } = await client.call("chat.open", "Nova II");
  const sent = await client.call("chat.send", chatId, "What is the capital of France?");
  const lengths = new Set();
  let view;
  for (let seen; ; ) {
    view = await client.call("chat.read", chatId, { after: sent.after + 1, wait: seen !== undefined, seen });
    seen = view.seen;
    if (view.working && view.stream) lengths.add(view.stream.length);
    if (!view.working && view.messages.some((message) => message.role === "assistant")) break;
  }
  assert.ok(lengths.size > 1, "the reply was seen growing (" + lengths.size + " lengths)");
  assert.equal(view.messages.at(-1).text, "Stand-in reply to: What is the capital of France? — this answer arrives in pieces, a few words at a time, the way a model's does.");
  assert.equal(view.run.status, "Completed");
  assert.deepEqual((await client.call("chat.list", "Nova II")).map((chat) => [chat.title, chat.messages]), [["What is the capital of France?", 2]]);
  assert.equal((await client.call("status")).workspace.chats, 1);
  // A second turn: the run a chat shows is its latest, and the list of runs has the newest first.
  const again = await client.call("chat.send", chatId, "And of Italy?");
  for (let seen; ; ) {
    view = await client.call("chat.read", chatId, { after: again.after + 1, wait: seen !== undefined, seen });
    seen = view.seen;
    if (!view.working && view.messages.some((message) => message.role === "assistant")) break;
  }
  assert.equal(view.run.title, "And of Italy?");
  assert.deepEqual((await client.call("runs.list", 5)).map((run) => [run.title, run.status, run.bot]), [["And of Italy?", "Completed", "Nova II"], ["What is the capital of France?", "Completed", "Nova II"]]);
});

test("a provider signs in from the terminal: its own sign-in is followed, and a pasted token is kept sealed", { skip }, async (t) => {
  const { client, running, paths } = await service(t, { signedIn: false });
  assert.equal((await client.call("providers.list", true))[0].connected, false);
  await assert.rejects(client.call("bots.add", { name: "Early", model: "grok/standin-1" }), { code: "NOT_FOUND" });
  // The tool's own sign-in runs in the service; what it prints comes here, and what is typed goes back.
  const { session } = await client.call("providers.login", "grok", {});
  await assert.rejects(client.call("providers.login", "grok", {}), /already in progress/);
  const events = [];
  let view;
  let typed = false;
  for (let after = 0; ; ) {
    view = await client.call("providers.login.read", session, after);
    after = view.next;
    events.push(...view.events);
    if (!typed && view.events.some((event) => event.type === "prompt")) {
      typed = true;
      await client.call("providers.login.input", session, "confirm-123");
    }
    if (view.done) break;
  }
  assert.deepEqual(events.filter((event) => event.type === "open").map((event) => event.url), ["https://example.com/device"]);
  assert.ok(events.some((event) => event.type === "output" && /enter the code STAND-1234/.test(event.text)));
  assert.deepEqual(view.result, { connected: true, account: null, plan: null });
  assert.equal(view.error, undefined);
  assert.equal((await client.call("providers.list"))[0].connected, true);
  // Nothing of a sign-in is in the log: not the page, not the code, not what was typed.
  const log = readFileSync(paths.logFile, "utf8");
  for (const secret of ["example.com/device", "STAND-1234", "confirm-123"]) assert.ok(!log.includes(secret), secret + " is in the log");
  await assert.rejects(client.call("providers.login.read", "no-such-session", 0), /That sign-in is over/);
  // A sign-in nobody finishes is cancelled, and says so.
  await run(process.execPath, [agent, "logout"], { env: { ...process.env } });
  const second = await client.call("providers.login", "grok", {});
  await client.call("providers.login.cancel", second.session);
  for (;;) {
    view = await client.call("providers.login.read", second.session, 0);
    if (view.done) break;
  }
  assert.match(view.error, /cancelled/i);
  // A token pasted for Claude Code is sealed in the vault and handed to the tool in its environment; none is ever in the config or the log.
  const signIns = running.service.signIns;
  const env = signIns.env;
  const kept = { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN };
  t.after(() => {
    for (const [name, value] of Object.entries(kept)) value === undefined ? delete env[name] : (env[name] = value);
  });
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const vault = running.runtime.workspace.vault;
  vault.put("sk-ant-oat01-fixture-token-000000000000", { label: "Claude", kind: "provider-token", owner: "terminal:provider:claude" }, "terminal-provider-claude");
  signIns.restore();
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-fixture-token-000000000000");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  vault.put("sk-ant-api03-fixture-key-0000000000000000", {}, "terminal-provider-claude");
  signIns.restore();
  assert.deepEqual([env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN], ["sk-ant-api03-fixture-key-0000000000000000", undefined]);
  assert.equal(signIns.copilotGitHub(), undefined);
  vault.put("gho_fixturetoken0000000000000000000000", {}, "terminal-provider-copilot");
  assert.deepEqual(signIns.copilotGitHub(), { token: "gho_fixturetoken0000000000000000000000" });
  for (const file of [join(paths.dataDir, "vault.json"), paths.config, paths.logFile, join(paths.dataDir, "workspace.json")]) assert.doesNotMatch(readFileSync(file, "utf8"), /fixture-token|fixture-key|fixturetoken/, file);
  assert.equal(signIns.forget("claude"), true);
  assert.deepEqual([env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN], [undefined, undefined]);
  // What can't be a token is refused before it goes anywhere.
  await assert.rejects(client.call("providers.login", "grok", { token: "two words" }), /one word with no spaces/);
  await assert.rejects(client.call("providers.login", "grok", { token: "abc" }), /doesn't take a pasted token/);
  await assert.rejects(client.call("providers.login", "nope", {}), /Unknown model provider/);
});

test("a phone pairs from the terminal's code, chats with a bot and is listed, renamed and removed", { skip }, async (t) => {
  const { client, dir, env } = await service(t);
  await client.call("bots.add", { name: "Nova", model: "grok/standin-1" });
  assert.deepEqual(await client.call("devices.list"), []);
  const pairing = await client.call("pair.start");
  assert.match(pairing.url, /^botkins:\/\/pair\?/);
  assert.match(pairing.code, /^[0-9A-Z]{8,}$/);
  assert.ok(pairing.qr.split("\n").length > 10, "a QR code a terminal can draw");
  assert.ok(new Date(pairing.expiresAt) > new Date());
  assert.equal((await client.call("pair.status")).pairing.code, pairing.code);
  assert.equal((await client.call("status")).link.pairing, true);
  // The phone: a process of its own, with the phone app's link client, on this computer's own address.
  const link = new URL(pairing.url);
  link.searchParams.set("h", "127.0.0.1:" + (await client.call("status")).link.port);
  const saved = join(dir, "pairing.json");
  const { stdout } = await run(process.execPath, [phone, "--link", link.href, "--via", "lan", "--save", saved, "--bot", "Nova", "--message", "Hello from the phone", "--name", "Sam's iPhone"], { env, timeout: 60_000 });
  const result = JSON.parse(stdout);
  assert.deepEqual([result.bots, result.host, result.route], [["Nova"], "terminal", "direct"]);
  assert.ok(result.chat.pieces > 1, "the phone saw the reply grow (" + result.chat.pieces + " pieces)");
  assert.equal(result.chat.reply, "Stand-in reply to: Hello from the phone — this answer arrives in pieces, a few words at a time, the way a model's does.");
  assert.equal(result.chat.status, "Completed");
  // The code worked once.
  assert.equal((await client.call("pair.status")).pairing, null);
  const [device] = await client.call("devices.list");
  assert.deepEqual([device.id, device.name, device.kind, device.platform], [result.device.id, "Sam's iPhone", "phone", "ios"]);
  assert.equal((await client.call("status")).link.devices, 1);
  assert.equal((await client.call("status")).workspace.chats, 1);
  assert.equal((await client.call("devices.rename", "sam's iphone", "Kitchen phone")).name, "Kitchen phone");
  await assert.rejects(client.call("devices.rename", "Nobody's", "x"), { code: "NOT_FOUND" });
  // The person behind a device is the link's own to keep: with a link that has it, it is set; without, it is said so.
  await client.call("devices.setPerson", device.id, "Sam").then(
    (named) => assert.equal(named.person, "Sam"),
    (error) => assert.equal(error.code, "UNSUPPORTED"),
  );
  // The paired phone comes back with what it kept, then is removed and can't.
  const again = JSON.parse((await run(process.execPath, [phone, "--pairing", saved, "--via", "lan"], { env, timeout: 60_000 })).stdout);
  assert.deepEqual(again.bots, ["Nova"]);
  assert.deepEqual(await client.call("devices.remove", "Kitchen phone"), { removed: device.id, name: "Kitchen phone" });
  await assert.rejects(run(process.execPath, [phone, "--pairing", saved, "--via", "lan", "--timeout", "4"], { env, timeout: 30_000 }));
  assert.deepEqual(await client.call("devices.list"), []);
});
