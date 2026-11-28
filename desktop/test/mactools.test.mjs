// iMessage and Mail as bot tools (desktop/mactools.mjs). Everything runs against stand-ins: a fake
// `imsg` program (test/fixtures/fake-imsg.mjs) and a fake AppleScript runner. No test reads or
// sends anyone's messages or mail, or touches ~/Library/Messages or Mail.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";
import test from "node:test";
import { Workspace, readPersistedWorkspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { IMSG_INSTALL, MacTools, macToolsField } from "../desktop/mactools.mjs";
import * as scripts from "../desktop/mactools-mail.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-imsg.mjs", import.meta.url));
chmodSync(FIXTURE, 0o755);

/** The real launcher's shape, run on the fake imsg with extra environment. Records every start. */
function launcher(env = {}) {
  const starts = [];
  const launch = (file, args, { timeout } = {}) => {
    starts.push({ file, args, timeout });
    return new Promise((resolve) =>
      execFile(process.execPath, [FIXTURE, ...args], { env: { ...process.env, ...env }, timeout, encoding: "utf8" }, (error, stdout, stderr) =>
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, timedOut: !!error?.killed }),
      ),
    );
  };
  return { launch, starts };
}

/** An AppleScript runner that records what it was asked and answers from `answer(script, payload)`. */
function runner(answer = () => ({ code: 0, stdout: "{}", stderr: "" })) {
  const calls = [];
  const osascript = async (script, payload, run) => {
    calls.push({ script, payload, run });
    return answer(script, payload);
  };
  return { osascript, calls };
}
const json = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function rig(t, { levels = { imessage: "off", mail: "off" }, env, answer, options = {} } = {}) {
  const log = join(tempDir(t), "imsg.log");
  const { launch, starts } = launcher({ FAKE_IMSG_LOG: log, ...env });
  const script = runner(answer);
  const opened = [];
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, {
    macTools: { platform: "darwin", launch, findImsg: () => "/fake/imsg", osascript: script.osascript, openExternal: async (url) => opened.push(url), ...options },
  });
  ws.state.settings.macTools = levels;
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stopped: false };
  ws.active.set(chat.id, task);
  const tools = (view = chat, run = { id: "r" }) => Object.fromEntries(ws.mac.tools(ws.bot("pip"), view, run, task).map((x) => [x.name, x]));
  const started = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ws, mac: ws.mac, chat, task, tools, starts, started, script, opened };
}
const call = async (tool, args) => JSON.parse(await tool.handler(args));
const READ = ["imessage_chats", "imessage_history", "imessage_search"];
const MAIL_READ = ["mail_mailboxes", "mail_search", "mail_read"];

test("the tools offered follow each tool's level, and nothing is offered when both are off", (t) => {
  const names = (levels) => Object.keys(rig(t, { levels }).tools());
  assert.deepEqual(names({ imessage: "off", mail: "off" }), []);
  assert.deepEqual(names({ imessage: "read", mail: "off" }), READ);
  assert.deepEqual(names({ imessage: "interact", mail: "off" }), [...READ, "imessage_send"]);
  assert.deepEqual(names({ imessage: "off", mail: "read" }), MAIL_READ);
  assert.deepEqual(names({ imessage: "off", mail: "interact" }), [...MAIL_READ, "mail_send", "mail_mark_read"]);
  assert.deepEqual(names({ imessage: "read", mail: "interact" }), [...READ, ...MAIL_READ, "mail_send", "mail_mark_read"]);
});

test("a tool that isn't on a Mac gets nothing, whatever was saved", (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "interact" }, options: { platform: "linux" } });
  assert.deepEqual(Object.keys(r.tools()), []);
  assert.deepEqual(r.mac.summary(), { available: false });
  assert.deepEqual(r.ws.snapshot().macTools, { available: false });
});

test("a teammate's help and an unattended run only read, and a helper in no way gets the tools", (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "interact" } });
  for (const run of [{ id: "r", scheduleId: 1 }, { id: "r", taskId: "x" }, { id: "r", panelId: "p" }])
    assert.deepEqual(Object.keys(r.tools(r.chat, run)), [...READ, ...MAIL_READ]);
  // The workspace gives a teammate's chat none of them (it only reads records).
  const helper = { ...r.chat, helper: true };
  const names = r.ws.sessionTools(r.ws.bot("pip"), helper, { id: "r" }, r.task).map((x) => x.name);
  assert.ok(!names.some((n) => /^(imessage|mail)_/.test(n)));
  const own = r.ws.sessionTools(r.ws.bot("pip"), r.chat, { id: "r" }, r.task).map((x) => x.name);
  for (const name of [...READ, "imessage_send", ...MAIL_READ, "mail_send", "mail_mark_read"]) assert.ok(own.includes(name), name);
});

test("only the tools that send or change anything go through approval", (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "interact" } });
  const tools = r.tools();
  for (const name of ["imessage_send", "mail_send", "mail_mark_read"]) assert.equal(tools[name].skipPermission, false, name);
  for (const name of [...READ, ...MAIL_READ]) assert.equal(tools[name].skipPermission, true, name);
  for (const name of ["imessage_send", "mail_send"]) assert.match(tools[name].description, /who/i);
  // imessage_react is left out: imsg react can't aim at a message, and tapback needs the IMCore bridge.
  assert.ok(!tools.imessage_react);
});

test("a tool called at a level that doesn't allow it refuses in a sentence", async (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "interact" } });
  const tools = r.tools();
  r.ws.state.settings.macTools = { imessage: "read", mail: "read" };
  await assert.rejects(tools.imessage_send.handler({ chat_id: 1, text: "hi" }), /set to Read only.*Settings › MCP servers/);
  await assert.rejects(tools.mail_send.handler({ to: ["a@example.com"], subject: "s", body: "b" }), /Read only/);
  await assert.rejects(tools.mail_mark_read.handler({ id: 1, mailbox: "INBOX" }), /Read only/);
  r.ws.state.settings.macTools = { imessage: "off", mail: "off" };
  await assert.rejects(tools.imessage_chats.handler({}), /iMessage isn't switched on/);
  await assert.rejects(tools.mail_mailboxes.handler({}), /Mail isn't switched on/);
  assert.deepEqual(r.started(), []);
  assert.deepEqual(r.script.calls, []);
});

test("a tool does nothing once its turn has ended", async (t) => {
  const r = rig(t, { levels: { imessage: "read", mail: "off" } });
  const chats = r.tools().imessage_chats;
  r.task.stopped = true;
  await assert.rejects(chats.handler({}), /no longer active/);
  assert.deepEqual(r.started(), []);
});

test("imsg is started with an argument array, and the bot's text arrives intact", async (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "off" } });
  const tools = r.tools();
  const awkward = `He said "hi" & 'bye'\nsecond line; rm -rf / && $(echo hacked) \`id\` | cat > x <y *`;
  const sent = await call(tools.imessage_send, { chat_id: 7, text: awkward });
  assert.equal(sent.sent, true);
  assert.deepEqual(r.started().at(-1), ["send", "--chat-id", "7", "--text", awkward, "--json"]);
  // A message that starts with a dash is joined to its option so it can't be read as another option.
  await call(tools.imessage_send, { to: "+1 (555) 010-0199", text: "-rf now" });
  assert.deepEqual(r.started().at(-1), ["send", "--to", "+1 (555) 010-0199", "--text=-rf now", "--json"]);
  await call(tools.imessage_search, { query: "--help", match: "exact", limit: 5 });
  assert.deepEqual(r.started().at(-1), ["search", "--query=--help", "--match", "exact", "--limit", "5", "--json"]);
  await call(tools.imessage_search, { query: `pizza "tonight"` });
  assert.deepEqual(r.started().at(-1), ["search", "--query", `pizza "tonight"`, "--match", "contains", "--limit", "20", "--json"]);
  // Nothing went through a shell: the program is the file itself, started with the array.
  assert.ok(r.starts.every((s) => s.file === "/fake/imsg" && Array.isArray(s.args)));
});

test("the real launcher starts imsg without a shell too", async (t) => {
  const log = join(tempDir(t), "imsg.log");
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {}, { macTools: { platform: "darwin", findImsg: () => FIXTURE } });
  ws.state.settings.macTools = { imessage: "interact", mail: "off" };
  process.env.FAKE_IMSG_LOG = log;
  t.after(() => delete process.env.FAKE_IMSG_LOG);
  const chat = ws.chat(ws.createChat("pip"));
  const task = { stopped: false };
  ws.active.set(chat.id, task);
  const tools = Object.fromEntries(ws.mac.tools(ws.bot("pip"), chat, { id: "r" }, task).map((x) => [x.name, x]));
  const text = "$(touch /tmp/should-not-exist) `x`; \"q\"\nnext";
  await tools.imessage_send.handler({ chat_id: "3", text });
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["send", "--chat-id", "3", "--text", text, "--json"]);
  assert.equal(existsSync("/tmp/should-not-exist"), false);
});

test("the iMessage reading tools pass what imsg takes and shape its answer", async (t) => {
  const r = rig(t, { levels: { imessage: "read", mail: "off" } });
  const tools = r.tools();
  const chats = await call(tools.imessage_chats, { limit: 2, unread_only: true });
  assert.deepEqual(r.started().at(-1), ["chats", "--limit", "2", "--unread-only", "--json"]);
  assert.equal(chats.chats.length, 2);
  assert.equal(chats.chats[0].name, "Dinner club");
  assert.match(chats.warning, /other people's writing/);
  await call(tools.imessage_chats, {});
  assert.deepEqual(r.started().at(-1), ["chats", "--limit", "20", "--json"]);
  const history = await call(tools.imessage_history, { chat_id: 2, limit: 2, since: "2026-11-01", before: "2026-11-02T10:00:00.500Z" });
  assert.deepEqual(r.started().at(-1), ["history", "--chat-id", "2", "--limit", "2", "--start", "2026-11-01T00:00:00Z", "--end", "2026-11-02T10:00:00Z", "--json"]);
  assert.equal(history.chat_id, 2);
  assert.equal(history.messages.length, 2);
  assert.equal(history.truncated, undefined);
});

test("what a bot gives is checked before imsg is started", async (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "off" } });
  const tools = r.tools();
  await assert.rejects(tools.imessage_history.handler({ chat_id: "1; rm -rf /" }), /chat as the number/);
  await assert.rejects(tools.imessage_history.handler({ chat_id: -1 }), /chat as the number/);
  await assert.rejects(tools.imessage_history.handler({ chat_id: 1, limit: 101 }), /whole number from 1 to 100/);
  await assert.rejects(tools.imessage_history.handler({ chat_id: 1, since: "last week" }), /such as 2026-11-01/);
  await assert.rejects(tools.imessage_chats.handler({ limit: 0 }), /from 1 to 50/);
  await assert.rejects(tools.imessage_search.handler({ query: "  " }), /text to search for/);
  await assert.rejects(tools.imessage_search.handler({ query: "x", match: "regex" }), /contains or exact/);
  await assert.rejects(tools.imessage_send.handler({ text: "hi" }), /either chat_id or to/);
  await assert.rejects(tools.imessage_send.handler({ chat_id: 1, to: "+15550100", text: "hi" }), /either chat_id or to/);
  await assert.rejects(tools.imessage_send.handler({ to: "--help", text: "hi" }), /phone number.*email/);
  await assert.rejects(tools.imessage_send.handler({ to: "not an address", text: "hi" }), /phone number.*email/);
  await assert.rejects(tools.imessage_send.handler({ chat_id: 1, text: "   " }), /message to send/);
  await assert.rejects(tools.imessage_send.handler({ chat_id: 1, text: "x".repeat(4001) }), /4000 characters/);
  assert.deepEqual(r.started(), []);
  // An email address is a recipient too.
  assert.equal((await call(tools.imessage_send, { to: "sam@example.com", text: "hi" })).to, "sam@example.com");
});

test("an imsg answer is capped, and the answer says when it was cut", async (t) => {
  const r = rig(t, { levels: { imessage: "read", mail: "off" }, env: { FAKE_IMSG_COUNT: "100", FAKE_IMSG_LENGTH: "1900" } });
  const big = await r.tools().imessage_history.handler({ chat_id: 1, limit: 100 });
  assert.ok(big.length < 45000, "answer is " + big.length + " characters");
  const answer = JSON.parse(big);
  assert.equal(answer.truncated, true);
  assert.match(answer.note, /Only the first \d+ of 100 fit in one answer/);
  assert.equal(answer.count, answer.messages.length);
  const long = rig(t, { levels: { imessage: "read", mail: "off" }, env: { FAKE_IMSG_COUNT: "2", FAKE_IMSG_LENGTH: "5000" } });
  const cut = await call(long.tools().imessage_search, { query: "x" });
  assert.match(cut.note, /long texts were shortened/);
  assert.ok(cut.results.every((hit) => hit.text.length <= 2000));
});

test("a message is sent even when imsg's answer can't be read", async (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "off" }, env: { FAKE_IMSG_PLAIN: "sent ok" } });
  const sent = await call(r.tools().imessage_send, { chat_id: 1, text: "hi" });
  assert.equal(sent.sent, true);
  assert.equal(sent.chat_id, 1);
});

test("imsg's failures become sentences a bot can act on", async (t) => {
  const levels = { imessage: "interact", mail: "off" };
  const failing = (FAKE_IMSG_FAIL, tool, args) => {
    const r = rig(t, { levels, env: { FAKE_IMSG_FAIL } });
    return r.tools()[tool].handler(args);
  };
  await assert.rejects(failing("Error: Operation not permitted (chat.db)\n  at Foo.bar (file.swift:12)", "imessage_chats", {}), (e) => /Full Disk Access/.test(e.message) && !/file\.swift|at Foo/.test(e.message));
  await assert.rejects(failing("unable to open database file", "imessage_history", { chat_id: 1 }), /Full Disk Access/);
  await assert.rejects(failing("Not authorized to send Apple events to Messages. (-1743)", "imessage_send", { chat_id: 1, text: "x" }), /control Messages.*Automation/);
  await assert.rejects(failing("Error: chat 99 not found", "imessage_history", { chat_id: 99 }), /That chat wasn't found.*imessage_chats/);
  await assert.rejects(failing("boom: something odd\nmore", "imessage_chats", {}), (e) => e.message === "imsg couldn't do that. It said: boom: something odd");
  // Not installed: found nowhere, or gone by the time it runs.
  const gone = rig(t, { levels, options: { findImsg: () => null } });
  await assert.rejects(gone.tools().imessage_chats.handler({}), (e) => e.message.includes(IMSG_INSTALL.command) && e.message.includes("isn't installed"));
  const vanished = rig(t, { levels, options: { launch: async () => ({ code: 1, stdout: "", stderr: "", missing: true }) } });
  await assert.rejects(vanished.tools().imessage_chats.handler({}), /brew install steipete\/tap\/imsg/);
  const slow = rig(t, { levels, options: { launch: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }) } });
  await assert.rejects(slow.tools().imessage_chats.handler({}), /took too long/);
  const garbage = rig(t, { levels, env: { FAKE_IMSG_PLAIN: "not json {" } });
  await assert.rejects(garbage.tools().imessage_chats.handler({}), /form Botkins doesn't understand.*brew upgrade imsg/);
});

test("Mail's fixed scripts get the bot's values as one JSON argument, never as script text", async (t) => {
  const answers = {
    [scripts.MAIL_SEND]: { sent: true },
    [scripts.MAIL_MARK]: { id: 5, read: false },
    [scripts.MAIL_MAILBOXES]: { mailboxes: [{ account: "iCloud", mailbox: "INBOX", unread: 3 }] },
  };
  const r = rig(t, { levels: { imessage: "off", mail: "interact" }, answer: (script) => json(answers[script] ?? {}) });
  const tools = r.tools();
  const evil = `x"); do shell script "rm -rf ~"; ("`;
  const sent = await call(tools.mail_send, { to: ["a@example.com", "b@example.com"], cc: "c@example.com; d@example.com", subject: evil, body: `line 1\n"line 2" -- ${evil}` });
  assert.deepEqual(sent, { sent: true, to: ["a@example.com", "b@example.com"], cc: ["c@example.com", "d@example.com"], subject: evil });
  const last = r.script.calls.at(-1);
  assert.equal(last.script, scripts.MAIL_SEND);
  assert.ok(!last.script.includes("rm -rf"));
  assert.deepEqual(last.payload, { to: ["a@example.com", "b@example.com"], cc: ["c@example.com", "d@example.com"], subject: evil, body: `line 1\n"line 2" -- ${evil}` });
  assert.deepEqual(await call(tools.mail_mark_read, { id: 5, mailbox: "INBOX", account: "iCloud", read: false }), { id: 5, read: false });
  assert.deepEqual(r.script.calls.at(-1).payload, { id: 5, mailbox: "INBOX", account: "iCloud", read: false });
  assert.deepEqual((await call(tools.mail_mailboxes, {})).mailboxes, [{ account: "iCloud", mailbox: "INBOX", unread: 3 }]);
  // The scripts are valid JavaScript for Automation, and none of them takes text from anywhere but argv.
  for (const [name, script] of Object.entries(scripts)) {
    assert.doesNotThrow(() => new Script(script), name);
    assert.ok(!/\$\{|eval\(|doShellScript/.test(script), name);
  }
});

test("mail_search and mail_read pass checked values, and cap what comes back", async (t) => {
  const messages = Array.from({ length: 3 }, (_, i) => ({ id: 10 + i, account: "iCloud", mailbox: "INBOX", from: "Sam <sam@example.com>", subject: "Hello " + i, date: "2026-11-01T10:00:00.000Z", read: false }));
  const body = "word ".repeat(2000);
  const r = rig(t, {
    levels: { imessage: "off", mail: "read" },
    answer: (script, payload) => (script === scripts.MAIL_SEARCH ? json({ total: 40, messages }) : json({ id: payload.id, subject: "Hello", from: "Sam", to: ["me@example.com"], cc: [], body: body.slice(0, payload.maxChars), bodyLength: body.length })),
  });
  const tools = r.tools();
  const now = Date.now();
  const found = await call(tools.mail_search, { sender: "sam", subject: "hello", mailbox: "INBOX", account: "iCloud", before: "2026-12-01", limit: 3 });
  const { payload } = r.script.calls.at(-1);
  assert.equal(r.script.calls.at(-1).script, scripts.MAIL_SEARCH);
  assert.deepEqual({ ...payload, since: undefined }, { sender: "sam", subject: "hello", mailbox: "INBOX", account: "iCloud", since: undefined, before: Date.parse("2026-12-01"), limit: 3 });
  // Without a date it looks at the last 30 days, and says so.
  assert.ok(Math.abs(payload.since - (now - 30 * 86400000)) < 60000);
  assert.equal(found.searched.since, new Date(payload.since).toISOString());
  assert.equal(found.total, 40);
  assert.equal(found.truncated, true);
  assert.match(found.note, /more than these/);
  await call(tools.mail_search, { account: "iCloud" });
  assert.equal(r.script.calls.at(-1).payload.mailbox, "INBOX");
  await call(tools.mail_search, {});
  assert.equal(r.script.calls.at(-1).payload.mailbox, null);
  await assert.rejects(tools.mail_search.handler({ limit: 51 }), /from 1 to 50/);
  await assert.rejects(tools.mail_search.handler({ since: "yesterday-ish" }), /such as 2026-11-01/);
  await assert.rejects(tools.mail_search.handler({ sender: "x".repeat(201) }), /sender as short text/);
  const read = await call(tools.mail_read, { id: 10, mailbox: " INBOX ", account: "iCloud" });
  assert.deepEqual(r.script.calls.at(-1).payload, { id: 10, mailbox: "INBOX", account: "iCloud", maxChars: 6000 });
  assert.equal(read.body.length, 6000);
  assert.equal(read.truncated, true);
  assert.match(read.note, /10000 characters long; this is the first 6000/);
  const more = await call(tools.mail_read, { id: 10, mailbox: "INBOX", max_chars: 20000 });
  assert.equal(more.body.length, 10000);
  assert.equal(more.truncated, undefined);
  await assert.rejects(tools.mail_read.handler({ id: 10, mailbox: "INBOX", max_chars: 20001 }), /from 1 to 20000/);
  await assert.rejects(tools.mail_read.handler({ id: "ten", mailbox: "INBOX" }), /message id/);
  await assert.rejects(tools.mail_read.handler({ id: 10 }), /mailbox/);
});

test("mail_send checks addresses, subject and size, and stops a loop after a few sends", async (t) => {
  const r = rig(t, { levels: { imessage: "interact", mail: "interact" }, answer: () => json({ sent: true }) });
  const tools = r.tools();
  const mail = { to: ["a@example.com"], subject: "Hi", body: "Body" };
  await assert.rejects(tools.mail_send.handler({ ...mail, to: [] }), /at least one address/);
  await assert.rejects(tools.mail_send.handler({ ...mail, to: ["nobody"] }), /email addresses/);
  await assert.rejects(tools.mail_send.handler({ ...mail, cc: ["a@b.c", "-x@y.z", "<a@b.c>"] }), /email addresses/);
  await assert.rejects(tools.mail_send.handler({ ...mail, to: Array.from({ length: 21 }, (_, i) => "u" + i + "@example.com") }), /at most 20/);
  await assert.rejects(tools.mail_send.handler({ ...mail, subject: "two\nlines" }), /subject of one line/);
  await assert.rejects(tools.mail_send.handler({ ...mail, subject: "" }), /subject/);
  await assert.rejects(tools.mail_send.handler({ ...mail, body: "" }), /message body/);
  await assert.rejects(tools.mail_send.handler({ ...mail, body: "x".repeat(50001) }), /50000 characters/);
  assert.deepEqual(r.script.calls, []);
  // Five sends or changes in one reply, shared by every tool that sends or changes something; the sixth stops.
  for (let i = 0; i < 3; i++) await tools.mail_send.handler(mail);
  await tools.imessage_send.handler({ chat_id: 1, text: "one" });
  await tools.mail_mark_read.handler({ id: 1, mailbox: "INBOX" });
  await assert.rejects(tools.mail_send.handler(mail), /already sent or changed 5 things/);
  await assert.rejects(tools.imessage_send.handler({ chat_id: 1, text: "two" }), /already sent or changed 5 things/);
});

test("Mail's errors are sentences, never script output", async (t) => {
  let reply;
  const r = rig(t, { levels: { imessage: "off", mail: "interact" }, answer: () => reply });
  const tools = r.tools();
  reply = { code: 1, stdout: "", stderr: "execution error: Not authorized to send Apple events to Mail. (-1743)" };
  await assert.rejects(tools.mail_mailboxes.handler({}), /control Mail.*Automation/);
  reply = { code: 1, stdout: "", stderr: "execution error: Error: Can't get mailbox. (-1728)\n    at run (<main>:3:4)" };
  await assert.rejects(tools.mail_mailboxes.handler({}), (e) => e.message === "Mail couldn't do that. It said: execution error: Error: Can't get mailbox. (-1728)");
  reply = { code: 1, stdout: "", stderr: "", timedOut: true };
  await assert.rejects(tools.mail_mailboxes.handler({}), /took too long/);
  reply = { code: 0, stdout: "not json", stderr: "" };
  await assert.rejects(tools.mail_mailboxes.handler({}), /form Botkins doesn't understand/);
  reply = json({ error: "mailbox" });
  await assert.rejects(tools.mail_read.handler({ id: 1, mailbox: "Nope" }), /mailbox wasn't found.*mail_mailboxes/);
  reply = json({ error: "message" });
  await assert.rejects(tools.mail_mark_read.handler({ id: 1, mailbox: "INBOX" }), /message wasn't found.*Search again/);
});

test("mail_mailboxes says when the list was cut", async (t) => {
  const many = Array.from({ length: 5 }, (_, i) => ({ account: "iCloud", mailbox: "Box " + i, unread: i }));
  const r = rig(t, { levels: { imessage: "off", mail: "read" }, answer: () => json({ mailboxes: many, more: true }) });
  const answer = await call(r.tools().mail_mailboxes, {});
  assert.equal(answer.truncated, true);
  assert.match(answer.note, /more than these/);
  assert.equal(answer.warning, undefined);
  assert.equal(r.script.calls.at(-1).payload.max, 200);
});

test("setMacTool checks its arguments, refuses off a Mac, saves, and reopens sessions", async (t) => {
  const r = rig(t);
  let released = 0;
  r.ws.releaseServerSessions = () => released++;
  await assert.rejects(r.mac.set("sms", "read"), /Unknown tool/);
  await assert.rejects(r.mac.set("imessage", "write"), /Choose Off, Read, or Read and interact/);
  await assert.rejects(r.mac.set("imessage", undefined), /Choose Off/);
  await assert.rejects(r.mac.set("__proto__", "read"), /Unknown tool/);
  assert.equal(released, 0);
  const status = await r.mac.set("imessage", "interact");
  assert.deepEqual(r.ws.state.settings.macTools, { imessage: "interact", mail: "off" });
  assert.equal(status.levels.imessage, "interact");
  assert.equal(released, 1);
  await r.mac.set("mail", "read");
  assert.deepEqual(r.ws.state.settings.macTools, { imessage: "interact", mail: "read" });
  // Saved with the workspace.
  assert.deepEqual(readPersistedWorkspace(r.ws.dir).settings.macTools, { imessage: "interact", mail: "read" });
  // Not on a Mac: anything but Off is refused, and Off still clears a choice that came along.
  const other = rig(t, { levels: { imessage: "read", mail: "off" }, options: { platform: "win32" } });
  await assert.rejects(other.mac.set("imessage", "read"), /only in Botkins on a Mac/);
  await assert.rejects(other.mac.set("mail", "interact"), /only in Botkins on a Mac/);
  await other.mac.set("imessage", "off");
  assert.equal(other.ws.state.settings.macTools.imessage, "off");
});

test("a phone can't change the choice: setPreferences refuses it, and the page-only calls aren't remote", async (t) => {
  const r = rig(t);
  assert.throws(() => r.ws.setPreferences({ macTools: { imessage: "interact", mail: "interact" } }), /only in Botkins on the computer/);
  assert.throws(() => r.ws.setPreferences({ approval: "all", macTools: { imessage: "read" } }), /only in Botkins on the computer/);
  assert.deepEqual(r.ws.state.settings.macTools, { imessage: "off", mail: "off" });
  // Unknown keys are still refused.
  assert.throws(() => r.ws.setPreferences({ macTool: "read" }), /Unknown setting/);
  assert.throws(() => r.ws.setPreferences({ mac: {} }), /Unknown setting/);
  const { REMOTE_METHODS } = await import("../desktop/link/index.mjs");
  for (const name of ["setMacTool", "macToolsStatus", "grantMacTool"]) assert.ok(!REMOTE_METHODS.has(name), name);
});

test("a new workspace has both tools off, and a damaged saved choice reads as off", (t) => {
  const fresh = new Workspace(tempDir(t), fakeClient().client, () => {}, {});
  assert.deepEqual(fresh.state.settings.macTools, { imessage: "off", mail: "off" });
  assert.deepEqual(macToolsField(undefined), { imessage: "off", mail: "off" });
  assert.deepEqual(macToolsField([]), { imessage: "off", mail: "off" });
  assert.deepEqual(macToolsField({ imessage: "root", mail: "read", extra: "interact" }), { imessage: "off", mail: "read" });
  assert.deepEqual(macToolsField("interact"), { imessage: "off", mail: "off" });
});

test("the status asks only about the permissions the switched-on tools need", async (t) => {
  const asked = [];
  const detect = {
    fullDisk: async () => (asked.push("fullDisk"), false),
    automation: async (app, run) => (asked.push(app + (run?.launch ? "+launch" : "")), app === "Mail"),
  };
  const r = rig(t, { options: { detect } });
  // Nothing is asked while both are off, nor when the workspace opens.
  assert.deepEqual(asked, []);
  let status = await r.mac.status();
  assert.deepEqual(asked, []);
  assert.deepEqual(status, { available: true, levels: { imessage: "off", mail: "off" }, imsg: { found: true, install: IMSG_INSTALL }, permissions: {} });
  r.ws.state.settings.macTools = { imessage: "read", mail: "off" };
  status = await r.mac.status();
  assert.deepEqual(status.permissions, { fullDisk: false });
  assert.deepEqual(asked, ["fullDisk"]);
  asked.length = 0;
  r.ws.state.settings.macTools = { imessage: "interact", mail: "read" };
  status = await r.mac.status();
  assert.deepEqual(status.permissions, { fullDisk: false, messagesAutomation: false, mailAutomation: true });
  // Looking never starts Messages or Mail.
  assert.deepEqual(asked, ["fullDisk", "Messages", "Mail"]);
  // A check that fails reads as not allowed.
  const broken = rig(t, { levels: { imessage: "interact", mail: "read" }, options: { detect: { fullDisk: () => { throw new Error("boom"); }, automation: async () => { throw new Error("boom"); } } } });
  assert.deepEqual((await broken.mac.status()).permissions, { fullDisk: false, messagesAutomation: false, mailAutomation: false });
});

test("the status says when imsg is missing, and says nothing is available off a Mac", async (t) => {
  const r = rig(t, { levels: { imessage: "read", mail: "off" }, options: { findImsg: () => null, detect: { fullDisk: async () => true, automation: async () => true } } });
  const status = await r.mac.status();
  assert.equal(status.imsg.found, false);
  assert.equal(status.imsg.install.command, "brew install steipete/tap/imsg");
  assert.equal(status.permissions.fullDisk, true);
  let touched = 0;
  const other = rig(t, { levels: { imessage: "interact", mail: "interact" }, options: { platform: "linux", detect: { fullDisk: async () => touched++, automation: async () => touched++ } } });
  assert.deepEqual(await other.mac.status(), { available: false, levels: { imessage: "off", mail: "off" }, imsg: { found: false, install: IMSG_INSTALL }, permissions: {} });
  assert.equal(touched, 0);
});

test("Grant tries the permission, then opens the right page of System Settings", async (t) => {
  const asked = [];
  const detect = {
    fullDisk: async () => (asked.push("fullDisk"), false),
    automation: async (app, run) => (asked.push(app + (run?.launch ? "+launch" : "")), false),
  };
  const r = rig(t, { levels: { imessage: "interact", mail: "read" }, options: { detect } });
  const base = "x-apple.systempreferences:com.apple.preference.security?";
  await r.mac.grant("fullDisk");
  await r.mac.grant("messagesAutomation");
  await r.mac.grant("mailAutomation");
  assert.deepEqual(r.opened, [base + "Privacy_AllFiles", base + "Privacy_Automation", base + "Privacy_Automation"]);
  // Granting is what may start the app, so macOS has something to ask about; looking is not.
  assert.deepEqual(asked.filter((a) => a.endsWith("+launch")), ["Messages+launch", "Mail+launch"]);
  await assert.rejects(r.mac.grant("camera"), /Unknown permission/);
  await assert.rejects(r.mac.grant("__proto__"), /Unknown permission/);
  const other = rig(t, { options: { platform: "linux" } });
  await assert.rejects(other.mac.grant("fullDisk"), /only in Botkins on a Mac/);
  assert.deepEqual(other.opened, []);
});

test("the default automation check asks Messages or Mail something harmless, with a fixed script", async (t) => {
  const answers = { "Messages": { code: 0, stdout: "ok\n", stderr: "" }, Mail: { code: 1, stdout: "", stderr: "Not authorized to send Apple events to Mail. (-1743)" } };
  const r = rig(t, { levels: { imessage: "interact", mail: "read" }, answer: (script, payload) => answers[payload.app], options: { detect: { fullDisk: async () => true } } });
  const status = await r.mac.status();
  assert.deepEqual(status.permissions, { fullDisk: true, messagesAutomation: true, mailAutomation: false });
  assert.deepEqual(r.script.calls.map((c) => [c.script === scripts.AUTOMATION_PROBE, c.payload]), [
    [true, { app: "Messages", launch: false }],
    [true, { app: "Mail", launch: false }],
  ]);
  // An app that isn't running is not started by a look, and counts as not allowed yet.
  const idle = rig(t, { levels: { imessage: "off", mail: "read" }, answer: () => ({ code: 0, stdout: "not-running\n", stderr: "" }) });
  assert.equal((await idle.mac.status()).permissions.mailAutomation, false);
});
