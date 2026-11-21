// A tool's sign-in from a terminal (`botkins tools sign-in`, `botkins plugins sign-in`), against a
// real service and the stand-in sign-in server (test/oauth-server.mjs). The browser is on another
// device: the test plays it, takes the address that it is sent back to, and gives that to the
// command line. What these hold to: the pasted address is never a word on the command line; it
// is judged as the browser's own answer is, and a wrong one leaves the sign-in open; neither it
// nor its code nor its mark reaches the log or the workspace's file; nothing hangs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";
import { SignIns } from "../desktop/terminal/signin.mjs";
import { controlClient } from "../desktop/terminal/socket.mjs";
import { oauthMcpServer } from "./oauth-server.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what) => {
  for (let waited = 0; waited < 8000; waited += 10) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("never saw: " + what);
};

/**
 * A real service that answers sign-ins on a port the system gave (never the app's own), the
 * stand-in sign-in server, and `botkins(argv, { input, tty })` to run a command against it.
 */
async function world(t, serverOptions) {
  const remote = await oauthMcpServer(serverOptions);
  t.after(() => remote.close());
  const dir = mkdtempSync(join(tmpdir(), "bk-signin-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  // The app on this computer may hold the sign-in port: this service listens on a free one.
  running.runtime.workspace.integrations.oauth.port = 0;
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const io = (stdin, take) => {
    const sink = (write) => new Writable({ write: (chunk, _encoding, done) => (write(String(chunk)), done()) });
    return { stdout: sink((text) => take.out(text)), stderr: sink((text) => take.err(text)), stdin, env: {}, client };
  };
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const exit = await main(argv, io(stdin, { out: (text) => void (out += text), err: (text) => void (err += text) }));
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  /** A person at a terminal: what is printed so far can be waited for, and each line is typed when the person chooses. */
  const converse = (argv) => {
    let out = "";
    let err = "";
    const stdin = new PassThrough();
    stdin.isTTY = true;
    const finished = main(argv, io(stdin, { out: (text) => void (out += text), err: (text) => void (err += text) }));
    const until = async (read, pattern) => {
      for (let waited = 0; waited < 10_000; waited += 25) {
        const found = pattern.exec(read());
        if (found) return found;
        await sleep(25);
      }
      throw new Error("never saw " + pattern + " in: " + read());
    };
    return { out: () => out, err: () => err, type: (line) => void stdin.write(line + "\n"), hangUp: () => void stdin.destroy(), stdinWrite: (text) => void stdin.write(text), interrupt: () => void stdin.write("\u0003"), seen: (pattern) => until(() => out + err, pattern), finished };
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => /(Changed|Tried) from the command line/.test(text)).map((text) => text.slice(text.search(/(Changed|Tried) from/)).replace("Changed from the command line: ", ""));
  const everything = () => [readFileSync(join(paths.dataDir, "workspace.json"), "utf8"), readFileSync(paths.logFile, "utf8")].join("\n");
  const write = (path, value) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  /** Plays the browser on another device: opens the sign-in page, and gives the address that it is sent back to. */
  const visit = async (page) => {
    const reply = await fetch(page, { redirect: "manual" });
    const back = reply.headers.get("location");
    assert.ok(back, "the sign-in page sent the browser back: " + reply.status);
    const params = new URL(back).searchParams;
    return { back, code: params.get("code"), state: params.get("state") };
  };
  assert.equal((await botkins(["tools", "add", "words", "--url", remote.url, "--scope", "tools.read"])).exit, 0);
  return { remote, dir, paths, client, running, botkins, converse, changes, everything, write, visit };
}
/** The last lines of a sign-in that is done, when the sign-in server names no account: the host to check it at, and the name. */
const unnamed = (remote, name) => "Botkins cannot tell which account this is. Check it at " + new URL(remote.url).host + ".\n" + name + " is signed in.\n";
/** The pieces of the pasted address that must never be shown or kept: all of it, its query and its code. */
const secretsOf = ({ back, code }) => [back, new URL(back).search, code];
/** What is not kept either: the mark of the sign-in too (it is in the page's address, which the person is shown). */
const keptOf = (answer) => [...secretsOf(answer), answer.state];
/** None of the secrets is in any of the texts. */
const absent = (secrets, ...texts) => {
  for (const text of texts) for (const secret of secrets) assert.equal(text.includes(secret), false, "found " + secret + " in " + text.slice(0, 200));
};

test("with no terminal a tool signs in in two steps: the page, then the address from standard input", { skip }, async (t) => {
  const { botkins, remote, visit, changes, everything, running } = await world(t);
  const started = await botkins(["tools", "sign-in", "words", "--start", "--json"]);
  assert.equal(started.exit, 0, started.err);
  const step = started.json();
  assert.deepEqual(Object.keys(step).sort(), ["back", "host", "id", "minutes", "name", "next", "open"]);
  assert.equal(step.name, "words");
  // The host of the page, made on the service's side from the address it made: the one thing in the page a person can check.
  assert.equal(step.host, new URL(remote.url).host);
  assert.equal(step.host, new URL(step.open).host);
  assert.equal(step.minutes, 10);
  assert.match(step.open, new RegExp("^" + remote.origin + "/authorize\\?"));
  assert.match(step.back, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  // The next step is a command that works as it is printed, and has no address in it.
  assert.equal(step.next, "botkins tools sign-in --finish -- " + step.id);
  // The sign-in is not done by looking at the page on this computer: nothing was opened or listened to by a browser.
  const answer = await visit(step.open);
  assert.ok(answer.back.startsWith(step.back + "?"), "the browser is sent to the address that was named");
  assert.equal(remote.state.log.some((entry) => entry.path === "/token"), false);
  assert.match((await botkins(["tools", "show", "words"])).out, /Sign-in: not signed in\. Sign it in with `botkins tools sign-in words`\./);
  // The address is read from standard input, and is not a word on the command line.
  const done = await botkins(step.next.split(" ").slice(1), { input: answer.back + "\n" });
  assert.equal(done.exit, 0, done.err);
  assert.equal(done.out, unnamed(remote, "words"));
  assert.match((await botkins(["tools", "show", "words"])).out, /Sign-in: signed in/);
  assert.equal((await botkins(["tools", "show", "words", "--json"])).json().auth.signedIn, true);
  // The tokens are the server's: the code was used once, with the secret of this sign-in.
  const exchange = new URLSearchParams(remote.state.log.find((entry) => entry.path === "/token").body);
  assert.equal(exchange.get("code"), answer.code);
  assert.ok(exchange.get("code_verifier").length >= 43);
  // The log has one line for the sign-in, when it is done, by the tool's name; nowhere is the address, its code or its mark.
  assert.deepEqual(await changes(), ["tools.add words", "tools.signIn words (signed in)"]);
  absent(keptOf(answer), everything(), JSON.stringify(await running.runtime.workspace.integrations.publicServers()));
  absent(secretsOf(answer), started.out, started.err, done.out, done.err);
});

test("an address that is not the answer is refused with the reason, and the sign-in stays open for the right one", { skip }, async (t) => {
  const { botkins, remote, visit, changes, everything } = await world(t);
  // Nothing is open: the sentence says to start one.
  const none = await botkins(["tools", "sign-in", "words", "--finish"], { input: "http://127.0.0.1:1/callback?code=x&state=y\n" });
  assert.equal(none.exit, 1);
  assert.match(none.err, /No sign-in of this tool waits for an address\. Start one first \(`--start`\)\./);
  assert.equal(none.err.includes("code=x"), false);
  // Nothing on standard input is a mistake of the caller.
  const empty = await botkins(["tools", "sign-in", "words", "--finish"]);
  assert.equal(empty.exit, 2);
  assert.match(empty.err, /No address was given\. Give the address the browser was sent back to on standard input\./);

  const step = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const answer = await visit(step.open);
  const wrong = [
    [answer.back.replace("/callback", "/elsewhere"), /That is not the address this sign-in sends the browser back to\. That address starts with http:\/\/127\.0\.0\.1:\d+\/callback\./],
    [answer.back.replace(/state=[^&]+/, "state=from-another-sign-in"), /That address is not the answer to this sign-in\./],
    [answer.back.replace(/&?code=[^&]+/, ""), /That address has no code in it\./],
    ["this is not an address", /That is not a web address\./],
  ];
  const attempts = [];
  for (const [address, said] of wrong) {
    const refused = await botkins(["tools", "sign-in", "words", "--finish"], { input: address + "\n" });
    attempts.push(refused);
    assert.equal(refused.exit, 1, address);
    assert.match(refused.err, said);
    assert.match(refused.err, /The sign-in is still open: run --finish again with the right address\./);
    // The reason is a sentence of Botkins: it does not say the address that was given, nor the code, nor the mark.
    absent([answer.code], refused.err, refused.out);
    assert.equal(refused.err.includes(address), false);
  }
  assert.equal((await botkins(["tools", "sign-in", "words", "--finish", "--json"], { input: "nope\n" })).json().error.code, "BAD_ADDRESS");
  assert.equal(remote.state.log.some((entry) => entry.path === "/token"), false, "nothing went to the token address");
  // A sign-in server that fails at the last step ends the sign-in with its own words, made plain, and the command does not wait.
  remote.state.tokenStatus = 503;
  const failed = await botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back });
  assert.equal(failed.exit, 1);
  assert.match(failed.err, /^botkins: temporarily_unavailable\n$/);
  remote.state.tokenStatus = null;
  // That sign-in is over; the right address is no answer to anything now.
  assert.match((await botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back })).err, /No sign-in of this tool waits for an address/);

  // A new one: the right address, after the wrong ones, finishes it.
  const again = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const right = await visit(again.open);
  assert.match((await botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back })).err, /That is not the address this sign-in sends the browser back to|not the answer to this sign-in/, "the address of the sign-in before is no answer to this one");
  const done = await botkins(["tools", "sign-in", "words", "--finish"], { input: right.back + "\n" });
  assert.equal(done.exit, 0, done.err);
  assert.equal(done.out, unnamed(remote, "words"));
  // A refused address, a start and a sign-in that failed leave no line in the log: only the one that was done does.
  assert.deepEqual(await changes(), ["tools.add words", "tools.signIn words (signed in)"]);
  absent([...keptOf(answer), ...keptOf(right)], everything());
  absent([...secretsOf(answer), ...secretsOf(right)], ...attempts.flatMap((attempt) => [attempt.out, attempt.err]));
});

test("what a sign-in server says in an address is shown as plain text, and an access that was denied ends the sign-in", { skip }, async (t) => {
  const { botkins, visit } = await world(t);
  const step = async () => (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const first = await visit((await step()).open);
  const hostile = first.back.replace(/&?code=[^&]+/, "") + "&error=server_error&error_description=" + encodeURIComponent("it broke\u001b[2J‮ after");
  const failed = await botkins(["tools", "sign-in", "words", "--finish", "--json"], { input: hostile });
  assert.equal(failed.exit, 1);
  const message = failed.json().error.message;
  // (Each character that would move or hide text is written as its number.)
  assert.match(message, /^Sign-in failed: it broke\\u\{1b\}\[2J\\u\{202e\} after$/);
  assert.equal(/[\u0000-\u001f‮]/.test(message), false);
  assert.equal(/[\u001b‮]/.test(failed.err), false);
  // The person said no at the sign-in server.
  const second = await visit((await step()).open);
  const denied = await botkins(["tools", "sign-in", "words", "--finish"], { input: second.back.replace(/&?code=[^&]+/, "") + "&error=access_denied" });
  assert.equal(denied.exit, 1);
  assert.match(denied.err, /Sign-in was cancelled\./);
  assert.match((await botkins(["tools", "show", "words"])).out, /not signed in/);
});

test("with no terminal and no flag the command says the two steps", { skip }, async (t) => {
  const { botkins, remote } = await world(t);
  for (const argv of [["tools", "sign-in", "words"], ["tools", "sign-in", "words", "--json"]]) {
    const refused = await botkins(argv);
    assert.equal(refused.exit, 2);
    assert.match(refused.err, /With no terminal this sign-in has two steps\. Run it with --start: it prints the page to open, and leaves the sign-in open\. Then run it with --finish: it reads the address the browser was sent back to from standard input\./);
  }
  // At a terminal --json is no terminal either: an answer to a question cannot be read from it.
  assert.equal((await botkins(["tools", "sign-in", "words", "--json"], { tty: true })).exit, 2);
  assert.equal((await botkins(["tools", "sign-in", "words", "--start", "--finish"])).exit, 2);
  // It started nothing: the stand-in was not asked.
  assert.equal(remote.state.log.length, 0);
});

test("at a terminal the page is shown, a wrong paste is explained and asked again, and the right one signs in", { skip }, async (t) => {
  const { converse, visit, botkins, changes, everything, remote } = await world(t);
  const person = converse(["tools", "sign-in", "words"]);
  const [page] = await person.seen(/http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+|https?:\/\/\S+\/authorize\?\S+/);
  // The person is told what the sign-in is for, and the host of the page, before the page.
  assert.match(person.out(), new RegExp("\\nSign in to words, on " + new URL(remote.url).host.replace(".", "\\.") + "\\.\\nOpen this page on any device to sign in:\\n\\n {4}\\S+/authorize\\?"));
  // The question says which address to paste.
  await person.seen(/Paste only the address that your own browser was sent to, from a page that you opened from this output\./);
  await person.seen(/The address that starts with|address that starts with http:\/\/127\.0\.0\.1:\d+\/callback\. On another device than this computer that page does not load, which is expected\./);
  const answer = await visit(page);
  // A line that is no address is explained, and the question comes again.
  person.type("garbage that is no address");
  await person.seen(/That is not a web address\. Copy the whole address from the browser's address bar\. Paste the whole address again\./);
  // The address of another place is explained too.
  person.type(answer.back.replace("/callback", "/elsewhere"));
  await person.seen(/That is not the address this sign-in sends the browser back to[^\n]*Paste the whole address again\./);
  person.type(answer.back);
  assert.equal(await person.finished, 0, person.err());
  assert.ok(person.out().endsWith(unnamed(remote, "words")), person.out());
  // What was pasted is not shown: not typed back, and not in what the sentences say.
  absent([...secretsOf(answer), "garbage that is no address"], person.out(), person.err());
  assert.match((await botkins(["tools", "show", "words"])).out, /Sign-in: signed in/);
  assert.deepEqual(await changes(), ["tools.add words", "tools.signIn words (signed in)"]);
  absent(keptOf(answer), everything());

  // The second step at a terminal asks for the address and does not show it either.
  const step = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const next = await visit(step.open);
  const finish = await botkins(["tools", "sign-in", "words", "--finish"], { input: next.back + "\n", tty: true });
  assert.equal(finish.exit, 0, finish.err);
  assert.match(finish.err, /The address that your own browser was sent to, from a page that you opened from this output \(not shown\): /);
  absent(secretsOf(next), finish.out, finish.err);
  // At a terminal the step 1 is the same as with none: the text says what to do.
  const text = await botkins(["tools", "sign-in", "words", "--start"], { tty: true });
  assert.equal(text.exit, 0, text.err);
  assert.match(text.out, /^Sign in to words, on 127\.0\.0\.1:\d+\.\n\nOpen this page on any device and sign in:\n\n {4}http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+\n\nThe browser then goes to an address that starts with http:\/\/127\.0\.0\.1:\d+\/callback\. On another device than this computer that page does not load, which is expected\.\nCopy the whole address from the browser's address bar, and give it to the second step in the next 10 minutes\. Give only the address that your own browser was sent to, from a page that you opened from this output:\n\n {4}botkins tools sign-in --finish -- \S+\n\nThat step reads the address from standard input, or asks for it and does not show it\.\n$/);
});

test("Ctrl-C at the question ends the sign-in, and nothing is left open", { skip }, async (t) => {
  const { converse, running } = await world(t);
  const person = converse(["tools", "sign-in", "words"]);
  await person.seen(/Paste the whole address again|paste it here\./);
  person.interrupt();
  assert.equal(await person.finished, 130);
  for (let waited = 0; running.runtime.workspace.integrations.oauth.flows.size && waited < 5000; waited += 25) await sleep(25);
  assert.equal(running.runtime.workspace.integrations.oauth.flows.size, 0, "the sign-in is over and its port is free");
});

test("a second --start for an open sign-in gives the same page again, and the first address still signs in", { skip }, async (t) => {
  const { botkins, visit, running, remote } = await world(t);
  const first = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  assert.equal("already" in first, false, "the first one is new");
  const answer = await visit(first.open);
  // Nobody has read it for a long while: it is still not taken over (it waits for its address on purpose).
  for (const session of running.service.signIns.sessions.values()) session.read -= 60_000;
  const second = await botkins(["tools", "sign-in", "words", "--start", "--json"]);
  assert.equal(second.exit, 0, second.err);
  const again = second.json();
  assert.equal(again.already, true);
  assert.deepEqual([again.open, again.back, again.next, again.id], [first.open, first.back, first.next, first.id]);
  assert.ok(again.minutes >= 9 && again.minutes <= 10, "the minutes are what is left: " + again.minutes);
  // In text, the first line says the sign-in is already open, and for how long.
  const text = await botkins(["tools", "sign-in", "words", "--start"]);
  assert.match(text.out, /^This sign-in is already open\. It stays open for (9|10) more minutes\.\n\nSign in to words, on 127\.0\.0\.1:\d+\.\n\nOpen this page on any device and sign in:\n\n {4}http/);
  assert.equal(text.out.includes(first.open), true, "the same page");
  assert.equal(new URL(first.open).searchParams.get("state"), new URL(again.open).searchParams.get("state"));
  assert.equal(running.runtime.workspace.integrations.oauth.flows.size, 1, "one sign-in only");
  // The address of the first one signs in.
  const done = await botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back });
  assert.equal(done.exit, 0, done.err);
  assert.equal(done.out, unnamed(remote, "words"));
  assert.equal(remote.state.log.filter((entry) => entry.path === "/token").length, 1);
});

test("the plain form refuses a sign-in that waits for its address, and --cancel then --start gives a new page", { skip }, async (t) => {
  const { botkins, visit, running, remote } = await world(t);
  const first = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const stale = await visit(first.open);
  const refused = await botkins(["tools", "sign-in", "words"], { tty: true });
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /A sign-in for words is open and waits for its address\. Give it the address with `--finish`, or end it with `--cancel`\./);
  assert.equal(running.runtime.workspace.integrations.oauth.flows.size, 1, "the open sign-in was not touched");
  // --cancel ends the open one and says so; the address is then no answer to anything.
  const ended = await botkins(["tools", "sign-in", "words", "--cancel"]);
  assert.equal(ended.out, "The sign-in to words is ended.\n");
  assert.equal(running.runtime.workspace.integrations.oauth.flows.size, 0, "the sign-in's port is free");
  assert.match((await botkins(["tools", "sign-in", "words", "--finish"], { input: stale.back })).err, /No sign-in of this tool waits for an address/);
  assert.deepEqual((await botkins(["tools", "sign-in", "words", "--cancel", "--json"])).json(), { id: first.id, name: "words", cancelled: false });
  assert.equal((await botkins(["tools", "sign-in", "words", "--cancel"])).out, "words has no open sign-in.\n");
  assert.equal(remote.state.log.some((entry) => entry.path === "/token"), false);
  // A new one is a new sign-in: another page, with another mark, and the old address is no answer to it.
  const second = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  assert.equal("already" in second, false);
  assert.notEqual(second.open, first.open);
  assert.notEqual(new URL(second.open).searchParams.get("state"), new URL(first.open).searchParams.get("state"));
  const fresh = await visit(second.open);
  assert.match((await botkins(["tools", "sign-in", "words", "--finish"], { input: stale.back })).err, /That is not the address this sign-in sends the browser back to|not the answer to this sign-in/);
  assert.equal((await botkins(["tools", "sign-in", "words", "--finish"], { input: fresh.back })).exit, 0);
});

test("a sign-in that is followed is not taken over, and one that nobody follows any more is replaced", { skip }, async (t) => {
  const { converse, botkins, running } = await world(t);
  const person = converse(["tools", "sign-in", "words"]);
  await person.seen(/paste it here\./);
  // The person reads it: a --start is refused, in a sentence that says what to do.
  const busy = await botkins(["tools", "sign-in", "words", "--start", "--json"]);
  assert.equal(busy.exit, 1);
  assert.match(busy.json().error.message, /A sign-in to words is already in progress, and somebody follows it\. Finish it there, or end it with `--cancel`/);
  person.interrupt();
  assert.equal(await person.finished, 130);
  // A follower that went away leaves one that nobody reads: the next one replaces it.
  const left = await running.service.signIns.startTool({ id: "left", name: "left" }, waiting());
  const session = running.service.signIns.sessions.get(left.session);
  session.read -= 60_000;
  const next = await running.service.signIns.startTool({ id: "left", name: "left" }, waiting());
  assert.notEqual(next.session, left.session);
  assert.equal(session.done, true, "the one nobody followed is over");
  await running.service.signIns.cancelTool("left");
});

test("when the browser is on the host itself the sign-in ends by itself, and the command ends with its result", { skip }, async (t) => {
  const { converse, visit, running, botkins, remote } = await world(t);
  // What the terminal sends to the sign-in as typed lines: a half-typed line is never one.
  const typed = [];
  const { signIns } = running.service;
  const input = signIns.input.bind(signIns);
  signIns.input = (...args) => (typed.push(args), input(...args));
  const person = converse(["tools", "sign-in", "words"]);
  const [page] = await person.seen(/(https?:\/\/\S+\/authorize\?\S+)/);
  await person.seen(/paste it here\./);
  person.stdinWrite("half of an addr");
  // The person's browser is on this computer: it goes to the listener on its own, and the listener takes the answer.
  const reply = await fetch(page, { redirect: "follow" });
  assert.equal(reply.status, 200);
  assert.equal(await Promise.race([person.finished, sleep(8000).then(() => "still waiting")]), 0, person.err());
  assert.match(person.out(), /words is signed in\.\n$/);
  assert.equal(/Cancelled/.test(person.err() + person.out()), false);
  assert.equal(person.err().includes("half of an addr"), false);
  assert.deepEqual(typed, [], "the half-typed line was not sent");
  assert.match((await botkins(["tools", "show", "words"])).out, /Sign-in: signed in/);
  assert.equal(remote.state.log.filter((entry) => entry.path === "/token").length, 1);
  assert.equal(running.runtime.workspace.integrations.oauth.flows.size, 0);
});

test("a sign-in that fails by another way ends the command with the failure, and one ended from elsewhere too", { skip }, async (t) => {
  const { converse, running } = await world(t);
  const person = converse(["tools", "sign-in", "words"]);
  await person.seen(/paste it here\./);
  // Ended from another command (`--cancel`), while the question is open.
  assert.deepEqual(await running.service.signIns.cancelTool((await running.runtime.workspace.integrations.publicServers())[0].id), { cancelled: true });
  assert.equal(await Promise.race([person.finished, sleep(8000).then(() => "still waiting")]), 1, person.err());
  assert.match(person.err(), /Sign-in was cancelled\./);
});

test("a tool that is a program has no sign-in, and a tool that is not there is said", { skip }, async (t) => {
  const { botkins } = await world(t);
  assert.equal((await botkins(["tools", "add", "prog", "--command", "node", "--yes", "--", "server.js"])).exit, 0);
  const refused = await botkins(["tools", "sign-in", "prog", "--start"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /prog is a program on this computer\. It signs in with its environment values \(`botkins tools edit`\)\./);
  assert.match((await botkins(["tools", "sign-in", "nobody", "--start"])).err, /There is no tool called nobody\. See `botkins tools list`\./);
  assert.equal((await botkins(["tools", "sign-in"])).exit, 2);
  assert.equal((await botkins(["tools", "sign-in", "words", "extra"])).exit, 2);
});

/** A tool's own sign-in as `SignIns.startTool` is given it, with no browser and no service: it waits until it is cancelled. */
function waiting() {
  let end;
  return { signIn: () => new Promise((_resolve, reject) => (end = reject)), answer() {}, cancel: () => end?.(new Error("Sign-in was cancelled.")) };
}

/** A folder plugin with remote tools that sign in, added and switched on. It runs nothing, so it needs no yes. */
async function plugin(t, names) {
  const env = await world(t);
  const folder = join(env.dir, "signs");
  env.write(join(folder, "plugin.json"), { name: "signs", version: "1.0.0" });
  env.write(join(folder, ".mcp.json"), { mcpServers: Object.fromEntries(names.map((name) => [name, { type: "http", url: env.remote.url, oauth: true }])) });
  assert.equal((await env.botkins(["plugins", "add-folder", folder])).exit, 0);
  assert.equal((await env.botkins(["plugins", "enable", "signs"])).exit, 0);
  return env;
}

test("a plugin's tool that signs in is signed in with the same two steps", { skip }, async (t) => {
  const { botkins, visit, changes, everything, running, remote } = await plugin(t, ["docs"]);
  const plugins = running.runtime.workspace.plugins;
  const [server] = plugins.knownOAuthServers(plugins.records[0]);
  assert.match(server.id, /^plugin-/);
  const started = await botkins(["plugins", "sign-in", "signs", "--start", "--json"]);
  assert.equal(started.exit, 0, started.err);
  const step = started.json();
  assert.deepEqual(Object.keys(step).sort(), ["back", "host", "id", "minutes", "name", "next", "open", "plugin", "tool"]);
  assert.deepEqual([step.id, step.name, step.tool, step.minutes], [server.id, "signs / docs", "docs", 10]);
  assert.equal(step.next, "botkins plugins sign-in --finish --tool=docs -- " + step.plugin);
  const answer = await visit(step.open);
  assert.equal(plugins.oauth.status(server).signedIn, false);
  // A wrong address is refused and leaves it open, as for any tool.
  const wrong = await botkins(["plugins", "sign-in", "signs", "--finish"], { input: answer.back.replace("/callback", "/elsewhere") });
  assert.equal(wrong.exit, 1);
  assert.match(wrong.err, /That is not the address this sign-in sends the browser back to\./);
  assert.match(wrong.err, /The sign-in is still open/);
  // The command that was printed finishes it.
  const done = await botkins(step.next.split(" ").slice(1), { input: answer.back });
  assert.equal(done.exit, 0, done.err);
  assert.equal(done.out, unnamed(remote, "signs / docs"));
  assert.equal(plugins.oauth.status(server).signedIn, true);
  assert.equal(remote.state.log.filter((entry) => entry.path === "/token").length, 1);
  assert.deepEqual((await botkins(["plugins", "sign-out", "signs", "--json"])).json().signedOut, 1);
  assert.equal(plugins.oauth.status(server).signedIn, false);
  // Again, ended with --cancel, with no tool named since it has one.
  await botkins(["plugins", "sign-in", "signs", "--start"]);
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--cancel"])).out, "The sign-in to signs / docs is ended.\n");
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--cancel"])).out, "signs / docs has no open sign-in.\n");
  assert.deepEqual((await changes()).filter((line) => /signIn|signOut/.test(line)), ["plugins.signIn signs / docs (signed in)", "plugins.signOut signs"]);
  absent(keptOf(answer), everything());
  absent(secretsOf(answer), wrong.err, done.out);
});

test("a plugin with several tools that sign in needs --tool, and the refusal lists the names", { skip }, async (t) => {
  const { botkins, visit, remote } = await plugin(t, ["docs", "wiki"]);
  const refused = await botkins(["plugins", "sign-in", "signs", "--start"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /signs has 2 tools that sign in: docs, wiki\. Say which with --tool\./);
  for (const flag of ["--finish", "--cancel"]) assert.match((await botkins(["plugins", "sign-in", "signs", flag], { input: "x" })).err, /has 2 tools that sign in: docs, wiki/);
  const unknown = await botkins(["plugins", "sign-in", "signs", "--tool", "nope", "--start"]);
  assert.match(unknown.err, /signs has no tool by that name that signs in\. It has: docs, wiki\./);
  const step = (await botkins(["plugins", "sign-in", "signs", "--tool", "wiki", "--start", "--json"])).json();
  assert.equal(step.name, "signs / wiki");
  assert.match(step.next, /^botkins plugins sign-in --finish --tool=wiki -- /);
  // The other tool of the plugin has its own sign-in: it is not open, and this one is.
  assert.match((await botkins(["plugins", "sign-in", "signs", "--tool", "docs", "--finish"], { input: "http://127.0.0.1:1/callback" })).err, /No sign-in of this tool waits for an address/);
  const answer = await visit(step.open);
  const done = await botkins(step.next.split(" ").slice(1), { input: answer.back });
  assert.equal(done.exit, 0, done.err);
  assert.equal(done.out, unnamed(remote, "signs / wiki"));
  // A plugin with no tool that signs in, and one that is not there.
  assert.match((await botkins(["plugins", "sign-in", "nobody", "--start"])).err, /No installed plugin is called nobody\./);
});

test("a plugin that has no tool that signs in says so", { skip }, async (t) => {
  const { botkins, dir, write } = await world(t);
  const folder = join(dir, "plain");
  write(join(folder, "plugin.json"), { name: "plain", version: "1.0.0" });
  write(join(folder, ".mcp.json"), { mcpServers: { open: { type: "http", url: "https://open.example.test/mcp" } } });
  assert.equal((await botkins(["plugins", "add-folder", folder])).exit, 0);
  assert.match((await botkins(["plugins", "sign-in", "plain", "--start"])).err, /plain has no tool that signs in\./);
});

test("the command that is printed for the second step has each word quoted for a shell, and the page and the names are shown as safe text", async () => {
  const run = async (argv, started) => {
    let out = "";
    let err = "";
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const client = {
      call: async (method) => {
        if (method === "tools.signIn.read") return { events: [{ n: 1, type: "open", url: "https://login.example/authorize?x=1\u001b[2J\u202e", back: "http://127.0.0.1:1/callback" }], next: 1, done: false };
        return { session: "s1", minutes: 10, ...started };
      },
    };
    const stdin = Readable.from([]);
    stdin.isTTY = false;
    const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err };
  };
  // A tool: an id with a quote in it is one word to a shell, and one that cannot be written is a placeholder.
  const quoted = await run(["tools", "sign-in", "words", "--start"], { id: "it's;$(x)", name: "words" });
  assert.equal(quoted.exit, 0, quoted.err);
  assert.match(quoted.out, /^Sign in to words\.\n\nOpen this page/);
  assert.match(quoted.out, /\n {4}botkins tools sign-in --finish -- 'it'\\''s;\$\(x\)'\n/);
  assert.match(quoted.out, /\n {4}https:\/\/login\.example\/authorize\?x=1\\u\{1b\}\[2J\\u\{202e\}\n/, "the page is written with each hidden character as its number");
  assert.equal(/[\u001b\u202e]/.test(quoted.out + quoted.err), false);
  const hidden = await run(["tools", "sign-in", "words", "--start"], { id: "a\u202eb", name: "words" });
  assert.match(hidden.out, /\n {4}botkins tools sign-in --finish -- <its id>\n/);
  assert.match(hidden.out, /A word of the second step has a character that cannot be written in a command, so it is a placeholder in angle brackets\. Take the real word from `botkins tools list --json`\./);
  // The JSON answer has the same command, and the page as it is.
  const json = JSON.parse((await run(["tools", "sign-in", "words", "--start", "--json"], { id: "a\u202eb", name: "words" })).out);
  assert.equal(json.next, "botkins tools sign-in --finish -- <its id>");
  assert.equal(json.open, "https://login.example/authorize?x=1\u001b[2J\u202e");
  // A plugin: the id and the tool's name are the plugin's own words.
  // The name is a word of the tool's or the plugin's own: each hidden character is written as its number.
  assert.match((await run(["tools", "sign-in", "words", "--start"], { id: "x", name: "wo\u202erds" })).out, /^Sign in to wo\\u\{202e\}rds\.\n/);
  const plugin = await run(["plugins", "sign-in", "signs", "--start"], { id: "plugin-1", name: "signs / docs", plugin: "signs@my market;rm", tool: "docs" });
  assert.match(plugin.out, /^Sign in to signs \/ docs\.\n/);
  assert.match(plugin.out, /\n {4}botkins plugins sign-in --finish --tool=docs -- 'signs@my market;rm'\n/);
  const strange = await run(["plugins", "sign-in", "signs", "--start"], { id: "plugin-1", name: "signs / x", plugin: "signs@market", tool: "do\u202ecs" });
  assert.match(strange.out, /\n {4}botkins plugins sign-in --finish --tool=<the tool> -- signs@market\n/);
  assert.match(strange.out, /Take the real word from `botkins plugins list --json`\./);
});

test("an answer in which the server names itself wrongly ends the sign-in, and the sentence says to start again", { skip }, async (t) => {
  const { botkins, visit, remote } = await world(t, { tweak: { server: (doc) => ({ ...doc, authorization_response_iss_parameter_supported: true }) } });
  const step = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const answer = await visit(step.open);
  const wrong = new URL(answer.back);
  wrong.searchParams.set("iss", "https://someone-else.example");
  const refused = await botkins(["tools", "sign-in", "words", "--finish"], { input: wrong.href });
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /The sign-in answer came from a different server than the one asked\. The sign-in is over\. Start it again\./);
  // The sentence is not the one for an address that was turned away: nothing is open.
  assert.equal(/still open/.test(refused.err), false);
  absent(secretsOf(answer), refused.err, refused.out);
  assert.match((await botkins(["tools", "show", "words"])).out, /not signed in/);
  assert.equal(remote.state.log.some((entry) => entry.path === "/token"), false, "the code of another server was not sent anywhere");
  // The sign-in is over: a second --finish finds none open.
  assert.match((await botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back })).err, /No sign-in of this tool waits for an address\. Start one first/);
});

test("a refusal of the sign-in itself has its own code, and only an address that was turned away says the sign-in is open", { skip }, async () => {
  const signIns = new SignIns({ providers: () => ({}), vault: () => ({}) });
  const refusing = (error) => {
    const how = waiting();
    const signIn = how.signIn;
    // It shows a page as the real one does, which is when the sign-in starts to wait for an address.
    return {
      ...how,
      signIn: (options) => (void options.open("https://login.example/authorize", { redirect: "http://127.0.0.1:1/callback" }), signIn()),
      answer: () => {
        throw error;
      },
    };
  };
  const codeOf = async (error) => {
    const tool = { id: "t" + Math.random(), name: "t" };
    await signIns.startTool(tool, refusing(error));
    try {
      await signIns.answerTool(tool.id, "http://127.0.0.1:1/callback");
    } catch (thrown) {
      return thrown.code;
    } finally {
      await signIns.cancelTool(tool.id);
    }
  };
  assert.equal(await codeOf(new Error("That address has no code in it.")), "BAD_ADDRESS");
  assert.equal(await codeOf(Object.assign(new Error("This sign-in has its answer already."), { code: "ANSWERED" })), "ANSWERED");
  assert.equal(await codeOf(Object.assign(new Error("No sign-in is waiting for that address."), { code: "NO_SIGN_IN" })), "NO_SIGN_IN");
  // A code that is not one of these is not passed on: it is an address that was turned away.
  assert.equal(await codeOf(Object.assign(new Error("odd"), { code: "EPIPE" })), "BAD_ADDRESS");
  assert.equal(await signIns.answerTool("nobody", "x").catch((error) => error.code), "NO_SIGN_IN");
});

test("two callers at once never both get a session for one tool", { skip }, async () => {
  const signIns = new SignIns({ providers: () => ({}), vault: () => ({}) });
  const tool = { id: "once", name: "once" };
  const first = await signIns.startTool(tool, waiting());
  // Nobody follows it any more, so a caller may replace it: two of them come at the same time and both wait for its end.
  signIns.sessions.get(first.session).read -= 60_000;
  const results = await Promise.allSettled([signIns.startTool(tool, waiting()), signIns.startTool(tool, waiting())]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /A sign-in to once is already in progress/);
  assert.equal([...signIns.sessions.values()].filter((session) => session.key === "tool:once" && !session.done).length, 1);
  // The same two with --start (held): both get the one sign-in.
  await signIns.cancelTool("once");
  const [a, b] = await Promise.all([signIns.startTool(tool, waiting(), { hold: true }), signIns.startTool(tool, waiting(), { hold: true })]);
  assert.equal(a.session, b.session);
  assert.equal(b.already, true);
  await signIns.cancelTool("once");
});

test("a sign-in that already has its answer says so, and where to look", async () => {
  const client = {
    call: async () => {
      throw Object.assign(new Error("This sign-in has its answer already."), { code: "ANSWERED" });
    },
  };
  const run = async (argv) => {
    let err = "";
    const sink = new Writable({ write: (chunk, _encoding, done) => ((err += String(chunk)), done()) });
    const stdin = Readable.from(["http://127.0.0.1:1/callback?code=x&state=y\n"]);
    stdin.isTTY = false;
    const exit = await main(argv, { stdout: sink, stderr: sink, stdin, env: {}, client });
    return { exit, err };
  };
  const tool = await run(["tools", "sign-in", "words", "--finish"]);
  assert.equal(tool.exit, 1);
  assert.equal(tool.err, "botkins: This sign-in has its answer already. Look at the result with `botkins tools show words`.\n");
  assert.equal((await run(["tools", "sign-in", "words", "--finish", "--json"])).err.includes("code=x"), false);
  const plugin = await run(["plugins", "sign-in", "signs", "--finish"]);
  assert.match(plugin.err, /Look at the result with `botkins plugins show signs`\./);
});

// ---- What the review of the pull request asked for.

const tokenRequests = (remote) => remote.state.log.filter((entry) => entry.path === "/token").length;
/** A sign-in that is done: the page, the browser's answer, and --finish. Gives the answer that the browser had. */
const signedIn = async ({ botkins, visit }, name = "words") => {
  const step = (await botkins(["tools", "sign-in", name, "--start", "--json"])).json();
  const answer = await visit(step.open);
  const done = await botkins(["tools", "sign-in", name, "--finish"], { input: answer.back });
  assert.equal(done.exit, 0, done.err);
  return { step, answer, done };
};

test("the account that the sign-in server names is said in the last lines, and so is a sign-in that replaces one", { skip }, async (t) => {
  const env = await world(t, { idToken: { email: "sam@example.com", name: "Sam" } });
  const { botkins, remote, changes, running } = env;
  const first = await signedIn(env);
  assert.equal(first.done.out, "The sign-in server says that the account is sam@example.com.\nwords is signed in.\n");
  assert.equal(first.step.host, new URL(remote.url).host);
  // The second sign-in writes over the first, and says so, and the log says so.
  const step = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const answer = await env.visit(step.open);
  const again = await botkins(["tools", "sign-in", "words", "--finish", "--json"], { input: answer.back });
  assert.equal(again.exit, 0, again.err);
  assert.deepEqual(again.json(), { done: true, id: step.id, name: "words", signedIn: true, again: true, host: step.host, account: "sam@example.com" });
  const text = await signedIn(env);
  assert.equal(text.done.out, "The sign-in server says that the account is sam@example.com.\nSigned in to words again. This replaces the sign-in that was there.\n");
  assert.deepEqual(await changes(), ["tools.add words", "tools.signIn words (signed in)", "tools.signIn words (signed in again)", "tools.signIn words (signed in again)"]);
  // The id token is not kept.
  absent(["sam@example.com"], env.everything(), JSON.stringify(running.runtime.workspace.integrations.oauth.read(running.runtime.workspace.integrations.server(step.id))));
  // A server that names no account: the command says it cannot tell, and where to check. `account` is not in the result.
  const unnamedWorld = await world(t);
  const bare = await signedIn(unnamedWorld);
  assert.equal(bare.done.out, unnamed(unnamedWorld.remote, "words"));
  const next = (await unnamedWorld.botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const last = await unnamedWorld.botkins(["tools", "sign-in", "words", "--finish", "--json"], { input: (await unnamedWorld.visit(next.open)).back });
  assert.equal("account" in last.json(), false);
  assert.equal(last.json().host, next.host);
});

test("the account is the server's own word, shown as text and cut", { skip }, async (t) => {
  const env = await world(t, { idToken: { email: "a\u202eb\u001b[2J" + "x".repeat(300) } });
  const done = await signedIn(env);
  assert.match(done.done.out, /^The sign-in server says that the account is a\\u\{202e\}b\\u\{1b\}\[2Jx+\.\nwords is signed in\.\n$/);
  assert.equal(/[\u001b\u202e]/.test(done.done.out), false);
  const account = /account is (.*)\.\n/.exec(done.done.out)[1];
  assert.ok(account.length < 140, "cut: " + account.length);
});

test("a cancel after the address was given ends the sign-in and writes nothing, and a cancel after the write says it was done", { skip }, async (t) => {
  const env = await world(t);
  const { botkins, visit, remote, running } = env;
  await signedIn(env);
  const oauth = running.runtime.workspace.integrations.oauth;
  const server = running.runtime.workspace.integrations.publicServers()[0];
  const earlier = oauth.read(server).accessToken;
  // The sign-in server holds its answer to the token request. The address was given, so the sign-in is past the page.
  let release;
  remote.state.tokenGate = new Promise((resolve) => (release = resolve));
  const step = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const answer = await visit(step.open);
  const finishing = botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back });
  await until(() => tokenRequests(remote) === 2, "the token request");
  const ended = await botkins(["tools", "sign-in", "words", "--cancel"]);
  assert.equal(ended.out, "The sign-in to words is ended.\n");
  const result = await finishing;
  assert.equal(result.exit, 1);
  assert.match(result.err, /Sign-in was cancelled\./);
  assert.equal(result.out.includes("signed in"), false, "it does not say that the tool is signed in");
  release();
  await sleep(100);
  assert.equal(oauth.read(server).accessToken, earlier, "the earlier sign-in is as it was");
  assert.equal(oauth.flows.size, 0);
  // Ctrl-C at the same place ends it too: the command asks the service to end the sign-in, and says what is true.
  remote.state.tokenGate = new Promise((resolve) => (release = resolve));
  const step2 = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const answer2 = await visit(step2.open);
  const interrupted = botkins(["tools", "sign-in", "words", "--finish"], { input: answer2.back });
  await until(() => tokenRequests(remote) === 3, "the second token request");
  process.emit("SIGINT");
  const stopped = await interrupted;
  assert.equal(stopped.exit, 1);
  assert.match(stopped.err, /Sign-in was cancelled\./);
  release();
  await sleep(100);
  assert.equal(oauth.read(server).accessToken, earlier);
  remote.state.tokenGate = null;
  // After the write the cancel says the truth: the sign-in was done already, and it is not ended.
  const done = await signedIn(env);
  assert.match(done.done.out, /words is signed in|again/);
  assert.equal((await botkins(["tools", "sign-in", "words", "--cancel"])).out, "The sign-in to words was done already, so it is not ended. The tool is signed in.\n");
  assert.deepEqual((await botkins(["tools", "sign-in", "words", "--cancel", "--json"])).json(), { id: step.id, name: "words", cancelled: false, finished: true });
  assert.notEqual(oauth.read(server).accessToken, earlier, "the last sign-in is the one that was written");
});

test("a line that is too long at the question is explained, and the question is asked again", { skip }, async (t) => {
  const { converse, visit } = await world(t);
  const person = converse(["tools", "sign-in", "words"]);
  const [page] = await person.seen(/(https?:\/\/\S+\/authorize\?\S+)/);
  await person.seen(/paste it here\./);
  const answer = await visit(page);
  person.type("x".repeat(9000));
  await person.seen(/That is too long to be the address\./);
  // It does not wait for ever: the same question is there again, and the right address ends the sign-in.
  person.type(answer.back);
  assert.equal(await Promise.race([person.finished, sleep(8000).then(() => "still waiting")]), 0, person.err());
  assert.match(person.out(), /words is signed in\.\n$/);
  absent([...secretsOf(answer), "x".repeat(100)], person.out(), person.err());
  // For a provider's sign-in the word is "code".
  const signIns = new SignIns({ providers: () => ({}), vault: () => ({}) });
  signIns.sessions.set("s", { id: "s", done: false, input: () => {} });
  assert.throws(() => signIns.input("s", "x".repeat(4001)), /That is too long to be a code\./);
});

test("a hang-up of the terminal ends the sign-in as Ctrl-C does, and so does the close of its input", { skip }, async (t) => {
  const { converse, running } = await world(t);
  const oauth = running.runtime.workspace.integrations.oauth;
  const hungUp = converse(["tools", "sign-in", "words"]);
  await hungUp.seen(/paste it here\./);
  assert.equal(oauth.flows.size, 1);
  process.emit("SIGHUP");
  assert.equal(await Promise.race([hungUp.finished, sleep(8000).then(() => "still waiting")]), 1, hungUp.err());
  assert.match(hungUp.err(), /Sign-in was cancelled\./);
  await until(() => oauth.flows.size === 0, "the sign-in is over");
  const closed = converse(["tools", "sign-in", "words"]);
  await closed.seen(/paste it here\./);
  closed.hangUp();
  assert.equal(await Promise.race([closed.finished, sleep(8000).then(() => "still waiting")]), 1, closed.err());
  await until(() => oauth.flows.size === 0, "the sign-in is over again");
  // Nothing is left that listens for a hang-up.
  assert.equal(process.listenerCount("SIGHUP"), 0);
});

test("a plugin whose installed copy was changed after install is refused for a sign-in, from the command line and through the app's call", { skip }, async (t) => {
  const { botkins, running, remote, changes } = await plugin(t, ["docs"]);
  const plugins = running.runtime.workspace.plugins;
  const [server] = plugins.knownOAuthServers(plugins.records[0]);
  // Whole: it signs in as before (the check does not refuse a copy that was reviewed).
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--start"])).exit, 0);
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--cancel"])).exit, 0);
  // A file is added to the installed copy.
  writeFileSync(join(plugins.records[0].folder, "added.txt"), "not reviewed");
  const refused = await botkins(["plugins", "sign-in", "signs", "--start"]);
  assert.equal(refused.exit, 1);
  assert.match(refused.err, /The installed files of this plugin are not the files that were reviewed\. Update the plugin: Botkins writes its files again and keeps your settings\./);
  await assert.rejects(running.runtime.handlers.signInMcpServer(server.id), /The installed files of this plugin are not the files that were reviewed\./);
  assert.equal(plugins.oauth.flows.size, 0, "no sign-in was opened");
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--tool", "docs", "--start"])).exit, 1);
  assert.equal(remote.state.log.some((entry) => entry.path === "/authorize"), false);
  assert.deepEqual((await changes()).filter((line) => /signIn/.test(line)), [], "a sign-in that was refused leaves no line");
});

test("two tools that sign in at once on one port: the second says who holds it, and it works after the first is over", { skip }, async (t) => {
  const { botkins, running, visit } = await world(t);
  const second = await oauthMcpServer();
  t.after(() => second.close());
  assert.equal((await botkins(["tools", "add", "other", "--url", second.url])).exit, 0);
  running.runtime.workspace.integrations.oauth.port = await freePort();
  const first = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const refused = await botkins(["tools", "sign-in", "other", "--start", "--json"]);
  assert.equal(refused.exit, 1);
  assert.equal(refused.json().error.message, "Another sign-in (to words) is open on this computer and holds the port. Finish it or cancel it, then try again.");
  assert.equal(second.state.log.some((entry) => entry.path === "/register"), false, "no client was registered");
  assert.equal((await botkins(["tools", "sign-in", "words", "--cancel"])).exit, 0);
  const next = (await botkins(["tools", "sign-in", "other", "--start", "--json"])).json();
  assert.equal((await botkins(["tools", "sign-in", "other", "--finish"], { input: (await visit(next.open)).back })).exit, 0);
  assert.ok(first.open);
});

test("--no-input never asks: the plain form names the two steps, and --finish reads standard input only when it is not a terminal", { skip }, async (t) => {
  const { botkins, visit, remote } = await world(t);
  // At a terminal, which an agent's harness can give, the plain form fails at once and starts nothing.
  const plain = await botkins(["tools", "sign-in", "words", "--no-input"], { tty: true });
  assert.equal(plain.exit, 2);
  assert.match(plain.err, /With no terminal this sign-in has two steps\. Run it with --start/);
  assert.equal(remote.state.log.length, 0, "nothing was started");
  // --finish at a terminal fails at once with the sentence that gives the example, and does not wait for a line.
  const first = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const waited = Date.now();
  const typed = await botkins(["tools", "sign-in", "words", "--finish", "--no-input"], { tty: true });
  assert.equal(typed.exit, 2);
  assert.match(typed.err, /With --no-input this step reads the address from standard input, and standard input is a terminal\. Give the address on standard input, for example: botkins tools sign-in <tool> --finish < address\.txt/);
  assert.ok(Date.now() - waited < 3000);
  // Not a terminal: the address is read from standard input, as without the switch, and no question is asked.
  const done = await botkins(["tools", "sign-in", "words", "--finish", "--no-input"], { input: (await visit(first.open)).back });
  assert.equal(done.exit, 0, done.err);
  assert.equal(/not shown/.test(done.err), false, "no question was asked");
  // With nothing on standard input it is a mistake of the caller, as before.
  assert.equal((await botkins(["tools", "sign-in", "words", "--finish", "--no-input"])).exit, 2);
  // It is the same for a plugin, with the plugin's word in the example.
  const plugin = await botkins(["plugins", "sign-in", "signs", "--finish", "--no-input"], { tty: true });
  assert.match(plugin.err, /for example: botkins plugins sign-in <plugin> --finish < address\.txt|has no tool|No installed plugin/);
  // The switch is in the usage line, so that `botkins help --json` has it.
  assert.equal((await botkins(["help", "tools", "sign-in", "--json"])).json().areas[0].commands[0].options.some((option) => option.name === "--no-input"), true);
});

test("the log has one line for a sign-in that is done, and none for one that was started, cancelled, turned away or timed out", { skip }, async (t) => {
  const env = await world(t);
  const { botkins, visit, changes, running, everything } = await env;
  const lines = async () => (await changes()).filter((line) => /signIn/.test(line));
  const step = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  const answer = await visit(step.open);
  assert.deepEqual(await lines(), [], "a start leaves none");
  assert.equal((await botkins(["tools", "sign-in", "words", "--finish"], { input: answer.back.replace(/state=[^&]+/, "state=x") })).exit, 1);
  assert.deepEqual(await lines(), [], "an address that is turned away leaves none");
  assert.equal((await botkins(["tools", "sign-in", "words", "--cancel"])).exit, 0);
  assert.deepEqual(await lines(), [], "a cancel leaves none");
  // A sign-in that runs out of time: the same call with a patience of 50 ms.
  const { signIns } = running.service;
  const quick = { ...signIns, startTool: (tool, how, options) => signIns.startTool(tool, how, { ...options, patience: 50 }) };
  const { toolsApi } = await import("../desktop/terminal/control-tools.mjs");
  const api = toolsApi({ workspace: running.runtime.workspace, handlers: running.runtime.handlers, bot: () => null, signIns: quick, log: (line) => running.service.log.info(line) });
  const started = await api["tools.signIn"](["words", { hold: true }]);
  await until(() => signIns.sessions.get(started.session)?.done === true, "the time-out");
  assert.match(signIns.sessions.get(started.session).error, /timed out/);
  assert.deepEqual(await lines(), [], "a time-out leaves none");
  // A sign-in that fails at the last step leaves none either.
  env.remote.state.tokenStatus = 503;
  const failing = (await botkins(["tools", "sign-in", "words", "--start", "--json"])).json();
  assert.equal((await botkins(["tools", "sign-in", "words", "--finish"], { input: (await visit(failing.open)).back })).exit, 1);
  env.remote.state.tokenStatus = null;
  assert.deepEqual(await lines(), []);
  // The one that is done leaves one, with the tool's name.
  await signedIn(env);
  assert.deepEqual(await lines(), ["tools.signIn words (signed in)"]);
  assert.equal((await botkins(["tools", "sign-in", "words", "--cancel"])).exit, 0);
  assert.deepEqual(await lines(), ["tools.signIn words (signed in)"], "a cancel after it leaves none");
  // A code where the name belongs is nowhere in the log.
  const code = "http://127.0.0.1:1/callback?code=SECRETCODE&state=SECRETSTATE";
  for (const call of [["tools", "sign-in", code, "--finish"], ["tools", "sign-in", code, "--start"], ["tools", "sign-in", code, "--cancel"], ["plugins", "sign-in", code, "--finish"]]) assert.equal((await botkins(call, { input: "x" })).exit, 1);
  assert.deepEqual(await lines(), ["tools.signIn words (signed in)"]);
  absent(["SECRETCODE", "SECRETSTATE"], everything());
});

test("a plugin's sign-in that is done leaves one line with the plugin's name and the tool's", { skip }, async (t) => {
  const env = await plugin(t, ["docs"]);
  const { botkins, visit, changes } = env;
  const step = (await botkins(["plugins", "sign-in", "signs", "--start", "--json"])).json();
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--finish"], { input: (await visit(step.open)).back })).exit, 0);
  const again = (await botkins(["plugins", "sign-in", "signs", "--start", "--json"])).json();
  assert.equal((await botkins(["plugins", "sign-in", "signs", "--finish"], { input: (await visit(again.open)).back })).out.split("\n").at(-2), "Signed in to signs / docs again. This replaces the sign-in that was there.");
  assert.deepEqual((await changes()).filter((line) => /signIn/.test(line)), ["plugins.signIn signs / docs (signed in)", "plugins.signIn signs / docs (signed in again)"]);
});

test("two callers at once for one tool: the one that waits for the other's end does not also get a session", { skip }, async () => {
  const signIns = new SignIns({ providers: () => ({}), vault: () => ({}) });
  const tool = { id: "slow", name: "slow" };
  // A sign-in whose end is slow: the cancel is asked twice (once by each caller), and the run ends after a while.
  const slow = () => {
    let end;
    return { signIn: () => new Promise((_resolve, reject) => (end = reject)), answer() {}, cancel: async () => (await sleep(40), end?.(new Error("Sign-in was cancelled."))) };
  };
  const first = await signIns.startTool(tool, slow());
  signIns.sessions.get(first.session).read -= 60_000;
  const results = await Promise.allSettled([signIns.startTool(tool, slow()), signIns.startTool(tool, slow())]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"], "one gets a session, and the other is told");
  assert.equal([...signIns.sessions.values()].filter((session) => session.key === "tool:slow" && !session.done).length, 1);
  await signIns.cancelTool("slow");
});
