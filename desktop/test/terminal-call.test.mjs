// `botkins call` keeps the rules of the named commands (desktop/desktop/terminal/control.mjs, `callRule`).
// The socket cannot know that a person is there, so a call that reaches a secret which the caller
// cannot read by itself, or that sends one somewhere, is not for it. A call that a command covers is
// done by that command, and a call with a reason is done where the reason says. A real service on a
// socket in a temporary folder, and the command line run against it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { COVERED_BY_COMMAND, callRule, HELD, REFUSED_BY_REASON } from "../desktop/terminal/control.mjs";
import { LINK, REASONS, WORKSPACE } from "../desktop/terminal/coverage.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const SECRET = "sk-MADE-UP-secret-value-4711";
const json = (value) => JSON.stringify(value);
/** What the command line prints for a failure, with its "botkins: " left off. */
const said = (err) => err.trim().replace(/^botkins: /, "");

/** A real service, and `botkins(argv)` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-callrule-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv) => {
    let out = "";
    let err = "";
    const stdin = Readable.from([]);
    stdin.isTTY = false;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err };
  };
  const { handlers, workspace } = running.runtime;
  /** What a refused call must leave as it was: the workspace, the voice settings, the saved credentials and the vault. */
  const fingerprint = async () => JSON.stringify({ state: workspace.state, voice: await handlers.voiceSettings(), saved: await handlers.savedCredentials(), vault: workspace.vault.list() });
  const log = () => readFileSync(paths.logFile, "utf8");
  const lines = async () => (await client.call("logs.read", { tail: 2000 })).entries.map((entry) => entry.text).filter((text) => /(Changed|Tried) from the command line/.test(text)).map((text) => text.slice(text.search(/(Changed|Tried) from/)));
  return { paths, running, client, botkins, fingerprint, log, lines, handlers, workspace };
}

test("a call that takes a secret, removes saved secrets, sets an address or loosens a rule is refused, and nothing of it is kept in the log", { skip }, async (t) => {
  const { botkins, fingerprint, log, lines } = await service(t);
  const ADDRESS = "https://evil.example/MADE-UP-4711";
  const SECRET_ARGUMENT = "takes a secret as an argument, and a secret is never a word on the command line\\. Do it in the app's window or on a paired phone\\. A command for it comes\\.";
  const REMOVES = "removes saved secrets with no question\\. Do it in the app's window or on a paired phone, where a person is asked\\. A command for it comes, and it asks first\\.";
  const YOLO = "with the mode yolo gives each request of the chat a yes, with no question\\. Set it in the app's window or on a paired phone\\. A command for it comes, and it shows this and asks\\.";
  const PERSON = "needs a person at the app: the window, or a phone with its owner check\\. The terminal host cannot know that a person is there\\.";
  // [handler, its arguments as the command line gives them (JSON), a value in them that must not show, the rest of the sentence]
  const held = [
    ["setVoiceKey", [json("openai"), json(SECRET)], SECRET, SECRET_ARGUMENT],
    ["providerUseToken", [json("codex"), json(SECRET)], SECRET, SECRET_ARGUMENT],
    ["saveSavedCredential", [json({ name: "A key", kind: "token", value: SECRET })], SECRET, SECRET_ARGUMENT],
    ["connectProviderService", [json("opencode"), json("a-service"), json({ key: SECRET })], SECRET, SECRET_ARGUMENT],
    ["finishProviderService", [json("opencode"), json("a-service"), json("an-attempt"), json(SECRET)], SECRET, SECRET_ARGUMENT],
    ["resetVault", [json("x-" + SECRET)], SECRET, REMOVES],
    ["removeCredential", [json("x-" + SECRET)], SECRET, REMOVES],
    ["removeSavedCredential", [json("x-" + SECRET)], SECRET, REMOVES],
    ["setVoice", [json({ providers: { openai: { baseUrl: ADDRESS } } })], ADDRESS, "with a provider's web address says where that provider's key goes\\. Set an address in the app's window or on a paired phone, where it is shown\\. A command for it comes\\. Choices that are no address run here\\."],
    ["setVoice", [json({ providers: { azure: { endpoint: ADDRESS } } })], ADDRESS, "with a provider's web address says where"],
    ["setVoice", [json({ providers: { azure: { region: "evil-4711" } } })], "evil-4711", "with a provider's web address says where"],
    ["setVoice", [json({ providers: { custom: { baseUrl: ADDRESS } } })], ADDRESS, "with a provider's web address says where"],
    ["setChatProject", [json("chat-4711"), json("project-4711"), json("yolo")], "chat-4711", YOLO],
    ["startProjectChat", [json(["bot-4711"]), json("project-4711"), json("yolo")], "bot-4711", YOLO],
    ["setPreferences", [json({ approval: "all", clarificationInstructions: "NOTE-4711" })], "NOTE-4711", "with an approval level or an access changes what the bots may do without a question\\. Set it in the app's window or on a paired phone\\. A command for it comes, and it shows this and asks\\."],
    ["setPreferences", [json({ approval: "ask", clarificationInstructions: "NOTE-4711" })], "NOTE-4711", "with an approval level or an access changes"],
    ["setPreferences", [json({ access: "all", clarificationInstructions: "NOTE-4711" })], "NOTE-4711", "with an approval level or an access changes"],
    // A Mac tool that is switched on gives the bots more. Switching one off runs (it is in the next test's rule walk).
    ["setMacTool", [json("imessage-4711"), json("read")], "imessage-4711", "gives the bots a tool of this Mac\\. Switch it on in the app's window, where it is shown\\."],
    // The five that need a person at the app (the reason "person").
    ["unlockPasswordManager", [json("bitwarden"), json(SECRET)], SECRET, PERSON],
    ["passwordManagerVaults", [json("bitwarden-4711")], "bitwarden-4711", PERSON],
    ["passwordManagerItems", [json("bitwarden"), json("vault-4711"), json("query-4711")], "vault-4711", PERSON],
    ["passwordManagerItem", [json("bitwarden"), json("vault"), json("item-4711")], "item-4711", PERSON],
    ["linkPasswordManagerField", [json({ manager: "bitwarden", vaultId: "v", itemId: "i", fieldId: "f", name: "NAME-4711" })], "NAME-4711", PERSON],
  ];
  const before = await fingerprint();
  for (const [name, args, needle, sentence] of held) {
    const ran = await botkins(["call", name, ...args]);
    assert.equal(ran.exit, 1, name);
    assert.match(said(ran.err), new RegExp("^`" + name + "` " + sentence), name);
    for (const output of [ran.out, ran.err]) assert.equal(output.includes(needle), false, name + " prints what it was given");
    assert.equal(await fingerprint(), before, name + " changed nothing");
    assert.equal((await lines()).at(-1), "Tried from the command line: call " + name + " (it failed)");
  }
  assert.equal((await lines()).length, held.length, "one line for each refused call, and no other");
  // Not one value that was given is in the log file.
  const written = log();
  for (const [, , needle] of held) assert.equal(written.includes(needle), false, "the log holds " + needle);
  // With --json, the code is one that a script can test.
  const asJson = await botkins(["call", "setVoiceKey", json("openai"), json(SECRET), "--json"]);
  assert.equal(asJson.exit, 1);
  assert.equal(JSON.parse(asJson.out).error.code, "NOT_FOR_CALL");
  assert.equal(asJson.out.includes(SECRET), false);
});

test("a call that is held for some of its arguments runs with the others", { skip }, async (t) => {
  const { botkins, client, handlers, workspace, fingerprint } = await service(t);
  // Voice settings that are choices and no address run, also with the empty sections that a whole settings answer has.
  const voiced = await botkins(["call", "setVoice", json({ tts: { speed: 1.5, auto: true } })]);
  assert.equal(voiced.exit, 0, voiced.err);
  assert.equal((await handlers.voiceSettings()).tts.speed, 1.5);
  assert.equal((await botkins(["call", "setVoice", json({ providers: { openai: {}, azure: {}, custom: {}, elevenlabs: { agentId: "agent_4711" } } })])).exit, 0);
  // The mode default (and plan) of a chat runs; yolo is held.
  const bot = (await client.call("bots.add", { name: "Nova" })).id;
  const chat = (await client.call("chat.open", "Nova")).chatId;
  assert.equal((await botkins(["call", "setChatProject", json(chat), "null", json("plan")])).exit, 0);
  assert.equal(workspace.chat(chat).mode, "plan");
  assert.equal((await botkins(["call", "setChatProject", json(chat), "null", json("default")])).exit, 0);
  assert.equal(workspace.chat(chat).mode, "default");
  const yolo = await botkins(["call", "setChatProject", json(chat), "null", json("yolo")]);
  assert.equal(yolo.exit, 1);
  assert.match(yolo.err, /`setChatProject` with the mode yolo gives each request of the chat a yes/);
  assert.equal(workspace.chat(chat).mode, "default", "the mode did not change");
  // A new chat in a project: the mode is no reason to refuse it, except yolo. (There is no such project: the app says so.)
  for (const args of [[json("default")], [json("plan")], []]) {
    const started = await botkins(["call", "startProjectChat", json([bot]), json("no-such-project"), ...args]);
    assert.equal(started.exit, 1);
    assert.doesNotMatch(started.err, /mode yolo/);
    assert.match(started.err, /Unknown project/);
  }
  assert.match((await botkins(["call", "startProjectChat", json([bot]), json("no-such-project"), json("yolo")])).err, /`startProjectChat` with the mode yolo/);
  // Preferences that name no approval level run, and any that names one is refused.
  const before = await fingerprint();
  assert.equal((await botkins(["call", "setPreferences", json({ appearance: { theme: "dark" } })])).exit, 0);
  assert.notEqual(await fingerprint(), before);
  assert.equal((await botkins(["call", "setPreferences", json({ approval: "all" })])).exit, 1);
  assert.equal(workspace.state.settings.approval, "ask");
  // The same, by the rule's own function.
  assert.equal(callRule("setVoice", [{ tts: { speed: 1 } }]), null);
  assert.equal(callRule("connectProviderService", ["opencode", "a-service", { method: "oauth" }]), null);
  assert.equal(callRule("connectProviderService", ["opencode", "a-service"]), null);
  assert.equal(callRule("setPreferences", []), null);
  assert.equal(callRule("setChatProject", ["c", null, "default"]), null);
  assert.equal(callRule("setChatProject", ["c"]), null);
  assert.equal(callRule("startProjectChat", [["b"], "p", "plan"]), null);
});

test("a call that a command covers is done by that command, and one with a reason says where it is done", { skip }, async (t) => {
  const { botkins, client, fingerprint, lines } = await service(t);
  const before = await fingerprint();
  // A read and a change that a command covers.
  const read = await botkins(["call", "skills"]);
  assert.equal(read.exit, 1);
  assert.equal(said(read.err), "`skills` is done by `botkins skills list`. Run that command: it shows what it changes and leaves a line in the log.");
  const change = await botkins(["call", "saveMcpServer", json({ name: "Sneaky", command: "touch", args: [SECRET] })]);
  assert.equal(change.exit, 1);
  assert.equal(said(change.err), "`saveMcpServer` is done by `botkins tools add`. Run that command: it shows what it changes and leaves a line in the log.");
  assert.equal(change.err.includes(SECRET), false);
  assert.deepEqual(await client.call("tools.list"), [], "no tool was added");
  assert.equal(await fingerprint(), before);
  // Reasons: the window, and what the window draws.
  assert.equal(said((await botkins(["call", "copyText", json(SECRET)])).err), "`copyText` needs the app's window (a dialog, the clipboard, a notification, a microphone or a permission on the screen). It is done there, not from a terminal.");
  assert.equal(said((await botkins(["call", "sidePane"])).err), "`sidePane` is what the app's window uses to draw itself (a pane, a preview or a thumbnail). The window makes it, and a terminal has no use for it.");
  // The command that a sentence names does the work.
  assert.equal((await botkins(["skills", "list"])).exit, 0);
  assert.deepEqual((await lines()).filter((line) => /call /.test(line)), ["skills", "saveMcpServer", "copyText", "sidePane"].map((name) => "Tried from the command line: call " + name + " (it failed)"));
});

test("a dotted name that is a call of the service and of the app runs the service's own call; `stop` and `models` do not", { skip }, async (t) => {
  const { botkins, client, log } = await service(t);
  const { control, workspace } = await client.call("methods");
  const both = control.filter((name) => name.includes(".") && workspace.includes(name));
  assert.ok(both.includes("plugins.setEnabled") && both.includes("plugins.install"), "the plugins' calls are in both: " + both);
  assert.deepEqual(both.filter((name) => !name.startsWith("plugins.")), [], "only the plugins' calls are in both today; the rule holds for any dotted name that is");
  // The table says `cmd` for these, and `call` still runs the service's own version (its rules are in it).
  assert.deepEqual(await client.call("call", "plugins.marketplaces", []), await client.call("plugins.marketplaces"));
  await assert.rejects(client.call("call", "plugins.setEnabled", ["no-such-plugin", true]), (error) => error.code !== "NOT_FOR_CALL");
  // The two names without a dot are other things on the socket than in the app. `call stop` is the app's `stop` (a chat's): it is refused, and it never stops the service.
  assert.ok(["stop", "models"].every((name) => control.includes(name) && workspace.includes(name)));
  const stopped = await botkins(["call", "stop", json("a-chat")]);
  assert.equal(stopped.exit, 1);
  assert.match(said(stopped.err), /^`stop` is done by `botkins chat`\./);
  await assert.rejects(client.call("call", "stop", []), { code: "NOT_FOR_CALL" });
  await assert.rejects(client.call("call", "models", []), { code: "NOT_FOR_CALL", message: /`models` is done by `botkins models`\./ });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await client.call("status")).running, true, "the service still runs");
  assert.equal(log().includes("asked to stop"), false);
});

test("a refused call writes its name in the log and nothing it was given; a name that the app does not have is not written", { skip }, async (t) => {
  const { client, log, lines } = await service(t);
  await assert.rejects(client.call("call", SECRET, [SECRET]), { code: "UNKNOWN_METHOD" });
  await assert.rejects(client.call("call", "setVoiceKey", ["openai", SECRET]), { code: "NOT_FOR_CALL" });
  await assert.rejects(client.call("call", "resetVault", [SECRET]), { code: "NOT_FOR_CALL" });
  await assert.rejects(client.call("call", "skills", [SECRET]), { code: "NOT_FOR_CALL" });
  await assert.rejects(client.call("call", "setVoice", [{ providers: { custom: { baseUrl: SECRET } } }]), { code: "NOT_FOR_CALL" });
  assert.deepEqual(await lines(), ["call", "call setVoiceKey", "call resetVault", "call skills", "call setVoice"].map((what) => "Tried from the command line: " + what + " (it failed)"));
  // A call that runs leaves its name too, and nothing of what it was given.
  await client.call("call", "setPreferences", [{ clarificationInstructions: SECRET }]);
  assert.equal((await lines()).at(-1), "Changed from the command line: call setPreferences");
  assert.equal(log().includes(SECRET), false);
});

// (The held rules look at an argument by its place. Those places were read from the handlers in desktop/runtime.mjs on
// 2026-11-21. This walk holds the names; a handler that takes the same thing in another shape needs its rule changed with it.)
test("the table decides what `call` may reach: a call with a command or a reason is refused, and only a call that is owed and not held runs", { skip }, async (t) => {
  const { client } = await service(t);
  const { workspace: names, control } = await client.call("methods");
  const open = [];
  for (const [name, entry] of Object.entries(WORKSPACE)) {
    const rule = callRule(name, []);
    if ("command" in entry) assert.equal(rule, COVERED_BY_COMMAND(name, entry.command), name);
    else if ("reason" in entry) assert.equal(rule, REFUSED_BY_REASON[entry.reason](name), name);
    else if (!Object.hasOwn(HELD, name)) {
      // Owed and not held: it runs, whatever it is given.
      open.push(name);
      assert.equal(callRule(name, [{ approval: "all", value: "x", key: "x", providers: { openai: { baseUrl: "x" } } }, "p", "yolo"]), null, name);
    }
    if (rule) {
      assert.ok(rule.includes("`" + name + "`"), "the sentence names " + name);
      assert.ok(!/\b(should|don't|doesn't|can't|isn't|won't|cannot't)\b/.test(rule), "plain words: " + rule);
    }
  }
  assert.ok(open.length > 100, "most of what the app does is still owed and open");
  // A held call is an owed call (once it has a command or a reason, the table refuses it), and each reason has its sentence.
  for (const name of Object.keys(HELD)) assert.ok("owed" in WORKSPACE[name], name + " is held, so it must be owed");
  assert.deepEqual(Object.keys(REFUSED_BY_REASON), Object.keys(REASONS));
  // The five that need a person, and the two password-manager calls that stay owed.
  for (const name of ["unlockPasswordManager", "passwordManagerVaults", "passwordManagerItems", "passwordManagerItem", "linkPasswordManagerField"]) assert.deepEqual(WORKSPACE[name], { reason: "person" });
  for (const name of ["passwordManagers", "lockPasswordManager"]) assert.deepEqual(WORKSPACE[name], { owed: "d" });
  assert.equal(Object.values(LINK).some((entry) => entry.reason === "person"), false);
  // End to end, as the service answers: every call with a command or a reason is refused. (The owed ones are not run here.)
  let refused = 0;
  for (const name of names) {
    const entry = WORKSPACE[name];
    if (!entry || "owed" in entry || (name.includes(".") && control.includes(name))) continue;
    await assert.rejects(client.call("call", name, []), { code: "NOT_FOR_CALL" }, name);
    refused++;
  }
  assert.ok(refused > 60, "the walk reached the calls that have a command or a reason");
});
