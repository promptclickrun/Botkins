// Routines from the command line (cli/commands/routines.mjs), against a real service. What these hold to:
// a routine runs a bot with nobody watching, so `add` and `edit` show the whole routine as it will be
// (the bot, the schedule in words with its zone and next times, the prompt) and ask; with no terminal
// they need --yes; a long prompt comes from an option, a file or standard input; a time says its zone;
// a name that two routines have names the ids; a change leaves a log line with no prompt in it.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
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

let dir;
let paths;
let running;
let client;
before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "bk-routines-"));
  paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  running = await startService({ paths, version: "9.9.9", trial: true });
  client = controlClient(paths.socket, { timeout: 40_000 });
});
after(async () => {
  await running?.stop("the test ended");
  if (dir) rmSync(dir, { recursive: true, force: true });
});
/** `botkins(argv, { input, tty })`: one command against the service. */
const botkins = async (argv, { input = "", tty = false } = {}) => {
  let out = "";
  let err = "";
  const stdin = Readable.from(input ? [input] : []);
  stdin.isTTY = tty;
  const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
  const exit = await main(argv, { stdout: sink((text) => void (out += text)), stderr: sink((text) => void (err += text)), stdin, env: {}, client });
  return { exit, out, err, json: () => JSON.parse(out) };
};
const put = (name, value) => {
  const path = join(dir, name);
  writeFileSync(path, value);
  return path;
};
const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]);
const list = async () => (await botkins(["routines", "list", "--json"])).json();
const PROMPT = "Read the inbox. SECRET-PROMPT-TEXT";

test("`routines when` says what a schedule means, with its zone and its next times", { skip }, async () => {
  const daily = await botkins(["routines", "when", "--cadence", "daily", "--at", "09:00", "--timezone", "UTC"]);
  assert.equal(daily.exit, 0, daily.err);
  const lines = daily.out.trim().split("\n");
  assert.equal(lines[0], "Daily at 9:00 AM");
  assert.equal(lines[1], "Time zone: UTC");
  assert.equal(lines[2], "It repeats.");
  assert.equal(lines.filter((line) => /(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \w+ \d+, \d{4}, 9:00 AM UTC$/.test(line)).length, 5, "five times, each in its zone");
  // A cron line as the one word: a simple shape is said in words, and the schedule's own words come with it.
  const weekdays = (await botkins(["routines", "when", "0 9 * * 1-5", "--timezone", "UTC", "--json"])).json();
  assert.equal(weekdays.meaning, "Weekdays at 9:00 AM");
  assert.equal(weekdays.summary, "Custom · 0 9 * * 1-5");
  assert.equal(weekdays.timezone, "UTC");
  assert.equal(weekdays.repeats, true);
  assert.equal(weekdays.next.length, 5);
  for (const time of weekdays.next) assert.match(time, /^\d{4}-\d\d-\d\dT09:00:00\.000Z$/);
  assert.equal(weekdays.next.every((time) => ![0, 6].includes(new Date(time).getUTCDay())), true);
  // A line of another shape is said field by field.
  assert.match((await botkins(["routines", "when", "*/20 8-18 * * *", "--timezone", "UTC"])).out, /^Cron fields: minute \*\/20, hour 8-18, day of the month \*, month \*, day of the week \*/);
  // Without a zone the host's zone is used and said.
  assert.match((await botkins(["routines", "when", "--cron", "5 4 * * *"])).out, /Time zone: \S+ \(the zone of the computer that runs Botkins\)/);
  // One time only.
  const once = (await botkins(["routines", "when", "--cadence", "once", "--date", "2099-01-02", "--at", "13:30", "--timezone", "America/New_York", "--json"])).json();
  assert.deepEqual([once.repeats, once.next, once.timezone], [false, ["2099-01-02T18:30:00.000Z"], "America/New_York"]);
  assert.match((await botkins(["routines", "when", "--cadence", "once", "--date", "2099-01-02", "--at", "13:30", "--timezone", "America/New_York"])).out, /It runs one time\.\nNext times: \w+, Jan 2, 2099, 1:30 PM EST/);
  // Refusals: nothing named; a kind with the other kind's field; a bad line; a bad zone; a time that has passed.
  const none = await botkins(["routines", "when"]);
  assert.equal(none.exit, 2);
  assert.match(none.err, /Say when it runs: --cadence once, daily, weekdays or weekly with --at <HH:MM>/);
  assert.match((await botkins(["routines", "when", "--cadence", "daily", "--cron", "0 9 * * *"])).err, /--cron is for --cadence custom\./);
  assert.match((await botkins(["routines", "when", "0 9 *", "--json"])).json().error.message, /Enter five cron fields/);
  assert.match((await botkins(["routines", "when", "--cron", "0 9 * * *", "--timezone", "Nowhere/Land", "--json"])).json().error.message, /Unknown time zone/);
  assert.match((await botkins(["routines", "when", "--cadence", "once", "--date", "2001-01-01", "--at", "09:00"])).err, /Choose a time in the future/);
  assert.match((await botkins(["routines", "when", "--cadence", "weekly", "--at", "09:00"])).err, /Choose at least one day/);
});

test("`routines add` shows the whole routine and asks; with no terminal it needs --yes", { skip }, async () => {
  const nova = await client.call("bots.add", { name: "Nova" });
  const base = ["routines", "add", "Morning brief", "--bot", "Nova", "--cadence", "weekdays", "--at", "07:30", "--timezone", "UTC"];
  // With no terminal: the routine is shown on standard error, the refusal names the flag, and nothing is made.
  const asked = await botkins([...base, "--prompt", PROMPT]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This routine runs a bot on a schedule, with nobody watching\. It will be saved as:\n {2}Name: Morning brief\n {2}Bot: Nova\n {2}When: Weekdays at 7:30 AM\n {2}Time zone: UTC\n {2}Next: \w+, \w+ \d+, \d{4}, 7:30 AM UTC\n {8}\w+, \w+ \d+, \d{4}, 7:30 AM UTC\n {2}Result goes: in the routine's own chat\n {2}Notifies: yes\n {2}Prompt:\n {6}Read the inbox\. SECRET-PROMPT-TEXT\n/);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.deepEqual(await list(), []);
  // The same with --json: the same refusal, and the same text is shown.
  const jsonAsked = await botkins([...base, "--prompt", PROMPT, "--json"]);
  assert.equal(jsonAsked.exit, 2);
  assert.match(jsonAsked.err, /Name: Morning brief/);
  // Answered at a terminal.
  const declined = await botkins([...base, "--prompt", PROMPT], { input: "n\n", tty: true });
  assert.equal(declined.exit, 1);
  assert.match(declined.err, /Save this routine\? \[y\/N\] /);
  assert.match(declined.err, /Nothing was saved\./);
  assert.deepEqual(await list(), []);
  // What is missing, and what does not fit.
  assert.match((await botkins(["routines", "add", "x", "--cadence", "daily", "--at", "09:00", "--prompt", "p"])).err, /Name the bot that does the work: --bot <bot>\./);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--at", "09:00"])).err, /Give the prompt: --prompt <text>, --file <path>, or - to read standard input\./);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--prompt", "p"])).err, /Say when it runs/);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--at", "09:00", "--prompt", "p", "--file", "f.txt"])).err, /Give the prompt one way/);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nobody", "--cadence", "daily", "--at", "09:00", "--prompt", "p", "--yes"])).err, /There is no bot called Nobody\. See `botkins bots list`\./);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--at", "25:00", "--prompt", "p", "--yes"])).err, /Use a 24-hour time such as 09:00/);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--days", "mon", "--at", "09:00", "--prompt", "p", "--yes"])).err, /A daily schedule has no days\./);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--at", "09:00", "--prompt", "p", "--deliver", "chat", "--chat", "No such chat", "--yes"])).err, /There is no chat called No such chat/);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--at", "09:00", "--prompt", "p", "--chat", "x", "--yes"])).err, /--chat and --category go with --deliver/);
  assert.match((await botkins(["routines", "add", "x", "--bot", "Nova", "--cadence", "daily", "--at", "09:00", "--prompt", "  ", "--yes"])).err, /The prompt is empty\./);
  assert.deepEqual(await list(), []);

  // With --yes: made, the routine is shown first anyway, and the answer is the routine whole.
  const added = await botkins([...base, "--prompt", PROMPT, "--yes"]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.err, /Name: Morning brief/);
  assert.match(added.out, /^Added Morning brief \([^)]+\)\. It is on, and runs next at \w+, \w+ \d+, \d{4}, 7:30 AM UTC\.\n$/);
  const [made] = await list();
  assert.deepEqual([made.name, made.bot, made.botId, made.enabled, made.timezone], ["Morning brief", "Nova", nova.id, true, "UTC"]);
  const show = await botkins(["routines", "show", "Morning brief"]);
  assert.match(show.out, /^Morning brief {3}\S+\nBot: Nova\nWhen: Weekdays at 7:30 AM\nTime zone: UTC\nState: on\nNext: .*7:30 AM UTC\n {6}.*7:30 AM UTC\n {6}.*7:30 AM UTC\nResult goes: in the routine's own chat\nNotifies: yes\nPrompt:\n {4}Read the inbox\. SECRET-PROMPT-TEXT\n$/);
  const whole = (await botkins(["routines", "show", made.id, "--json"])).json();
  assert.deepEqual([whole.instructions, whole.schedule, whole.meaning, whole.next.length, whole.notify], [PROMPT, { kind: "weekdays", time: "07:30" }, "Weekdays at 7:30 AM", 3, undefined]);
  // The log names the call and the routine, and nothing of the prompt.
  assert.deepEqual((await changes()).filter((line) => line.startsWith("routines.")), ["routines.add Morning brief"]);
  assert.equal(readFileSync(paths.logFile, "utf8").includes("SECRET-PROMPT-TEXT"), false, "the prompt is in the workspace, not in the log");
  assert.equal(readFileSync(join(paths.dataDir, "workspace.json"), "utf8").includes("SECRET-PROMPT-TEXT"), true);
  // A routine that is not there.
  assert.match((await botkins(["routines", "show", "Nothing"])).err, /There is no routine called Nothing\. See `botkins routines list`\./);
});

test("a prompt comes from a file or from standard input, and a prompt with control characters is shown safely", { skip }, async () => {
  const nasty = "Line one\n\u001b[2Jhidden‮evil\nLast\tline";
  const file = put("prompt.txt", nasty);
  const fromFile = await botkins(["routines", "add", "From file", "--bot", "Nova", "--cadence", "daily", "--at", "08:00", "--timezone", "UTC", "--file", file, "--yes"]);
  assert.equal(fromFile.exit, 0, fromFile.err);
  // The screen never gets the escape or the mark that turns text around.
  for (const text of [fromFile.err, (await botkins(["routines", "show", "From file"])).out]) {
    assert.equal(/[\u001b‮]/.test(text), false);
    assert.match(text, /Line one\n {4,6}\\u\{1b\}\[2Jhidden\\u\{202e\}evil\n {4,6}Last {4}line/);
  }
  // --json carries the text as it is.
  assert.equal((await botkins(["routines", "show", "From file", "--json"])).json().instructions, nasty);
  const piped = await botkins(["routines", "add", "From stdin", "--bot", "Nova", "--cadence", "daily", "--at", "08:15", "--timezone", "UTC", "--yes", "-"], { input: "Piped prompt\nsecond line\n" });
  assert.equal(piped.exit, 0, piped.err);
  assert.equal((await botkins(["routines", "show", "From stdin", "--json"])).json().instructions, "Piped prompt\nsecond line");
  const same = await botkins(["routines", "add", "From dash file", "--bot", "Nova", "--cadence", "daily", "--at", "08:20", "--timezone", "UTC", "--yes", "--file", "-"], { input: "From the dash" });
  assert.equal(same.exit, 0, same.err);
  assert.match((await botkins(["routines", "add", "Missing", "--bot", "Nova", "--cadence", "daily", "--at", "08:20", "--file", join(dir, "nope.txt"), "--yes"])).err, /The prompt file .*nope\.txt can't be read/);
  for (const name of ["From file", "From stdin", "From dash file"]) await botkins(["routines", "remove", name, "--yes"]);
});

test("`routines edit` changes only what is named, shows the result and asks", { skip }, async () => {
  const [made] = (await list()).filter((entry) => entry.name === "Morning brief");
  // A new time keeps the rest of the schedule: the kind and the zone.
  const asked = await botkins(["routines", "edit", "Morning brief", "--at", "10:00"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This changes a routine that runs a bot on a schedule, with nobody watching\. After the change it is:\n {2}Name: Morning brief\n {2}Bot: Nova\n {2}When: Weekdays at 10:00 AM\n {2}Time zone: UTC\n/);
  assert.match(asked.err, /Changes: schedule\n/);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal((await botkins(["routines", "show", "Morning brief", "--json"])).json().schedule.time, "07:30", "nothing changed yet");
  const saved = await botkins(["routines", "edit", "Morning brief", "--at", "10:00", "--yes"]);
  assert.equal(saved.exit, 0, saved.err);
  assert.equal(saved.out, "Saved Morning brief.\n");
  const after = (await botkins(["routines", "show", "Morning brief", "--json"])).json();
  assert.deepEqual([after.schedule, after.timezone, after.meaning, after.instructions, after.id], [{ kind: "weekdays", time: "10:00" }, "UTC", "Weekdays at 10:00 AM", PROMPT, made.id]);
  assert.match(after.next[0], /T10:00:00\.000Z$/);
  // A change at a terminal; the prompt on standard input; a new name and a quiet routine.
  const typed = await botkins(["routines", "edit", made.id, "--name", "Brief", "--quiet", "-"], { input: "New prompt\n" });
  assert.equal(typed.exit, 2, "piped input is no terminal");
  assert.match(typed.err, /Changes: name, prompt, notifying\n {2}Prompt:\n {6}New prompt\n/);
  assert.match(typed.err, /Notifies: no, it runs quietly/);
  const yes = await botkins(["routines", "edit", made.id, "--name", "Brief", "--quiet", "--yes", "-"], { input: "New prompt\n" });
  assert.equal(yes.exit, 0, yes.err);
  const renamed = (await botkins(["routines", "show", "Brief", "--json"])).json();
  assert.deepEqual([renamed.name, renamed.instructions, renamed.notify], ["Brief", "New prompt", false]);
  assert.match((await botkins(["routines", "show", "Brief"])).out, /Notifies: no, it runs quietly/);
  // At a terminal the question is asked and a yes saves.
  const atTerminal = await botkins(["routines", "edit", "Brief", "--at", "10:30"], { input: "y\n", tty: true });
  assert.equal(atTerminal.exit, 0, atTerminal.err);
  assert.match(atTerminal.err, /Save this change\? \[y\/N\] /);
  assert.equal((await botkins(["routines", "show", "Brief", "--json"])).json().schedule.time, "10:30");
  // A kind changes with its fields; a field of another kind is refused; a result that goes elsewhere.
  const weekly = await botkins(["routines", "edit", "Brief", "--cadence", "weekly", "--days", "mon,fri", "--at", "09:00", "--yes", "--json"]);
  assert.equal(weekly.exit, 0, weekly.err);
  assert.deepEqual(weekly.json().schedule, { kind: "weekly", time: "09:00", days: [1, 5] });
  // A new kind takes its own fields only: the old time is not carried over.
  assert.match((await botkins(["routines", "edit", "Brief", "--cadence", "daily", "--yes"])).err, /Use a 24-hour time such as 09:00/);
  assert.match((await botkins(["routines", "edit", "Brief", "--date", "2099-01-01", "--yes"])).err, /A weekly schedule has no date\./);
  assert.match((await botkins(["routines", "edit", "Brief", "--cron", "0 9 * * *", "--at", "09:00", "--yes"])).err, /A custom schedule has no time of day\./);
  const goal = await botkins(["routines", "edit", "Brief", "--deliver", "goal", "--category", "career", "--notify", "--yes", "--json"]);
  assert.equal(goal.exit, 0, goal.err);
  assert.deepEqual([goal.json().deliver, goal.json().notify], [{ to: "goal", category: "career" }, undefined]);
  assert.match((await botkins(["routines", "show", "Brief"])).out, /Result goes: in Goals, category career\nNotifies: yes/);
  // A result back in the routine's own chat. A change of the result alone leaves the schedule as it is.
  await botkins(["routines", "edit", "Brief", "--deliver", "routine", "--yes"]);
  assert.equal((await botkins(["routines", "show", "Brief", "--json"])).json().deliver, undefined);
  // Nothing named; nothing changes; both ways of one switch; an unknown routine.
  assert.match((await botkins(["routines", "edit", "Brief"])).err, /Say what to change\./);
  const same = await botkins(["routines", "edit", "Brief", "--name", "Brief"]);
  assert.equal(same.exit, 0);
  assert.match(same.out, /Nothing changes/);
  assert.match((await botkins(["routines", "edit", "Brief", "--quiet", "--notify"])).err, /Give --quiet or --notify, not both\./);
  assert.match((await botkins(["routines", "edit", "Nothing", "--name", "x", "--yes"])).err, /There is no routine called Nothing/);
  assert.match((await botkins(["routines", "edit", "Brief", "--name", "x".repeat(81), "--yes"])).err, /name/i);
  // A routine that is paused stays paused, and the change says so.
  await botkins(["routines", "pause", "Brief"]);
  assert.match((await botkins(["routines", "edit", "Brief", "--at", "11:00"])).err, /It is paused\. Turn it on with `botkins routines resume Brief`\./);
  assert.equal((await botkins(["routines", "edit", "Brief", "--cadence", "weekdays", "--at", "11:00", "--yes"])).exit, 0);
  assert.equal((await botkins(["routines", "show", "Brief", "--json"])).json().enabled, false);
  await botkins(["routines", "resume", "Brief"]);
  // The log: the call and the routine's name, never the prompt.
  const lines = (await changes()).filter((line) => line.startsWith("routines.edit"));
  assert.ok(lines.length >= 6);
  assert.deepEqual([...new Set(lines)], ["routines.edit Morning brief", "routines.edit Brief"]);
  assert.equal(JSON.stringify(await changes()).includes("New prompt"), false);
});

test("a finished one-time routine takes a change of its result, and a one-time routine shows its one time", { skip }, async () => {
  const added = await botkins(["routines", "add", "Once", "--bot", "Nova", "--cadence", "once", "--date", "2099-06-01", "--at", "12:00", "--timezone", "Asia/Tokyo", "--prompt", "Do it once", "--yes", "--json"]);
  assert.equal(added.exit, 0, added.err);
  assert.match(added.err, /Next: \w+, Jun 1, 2099, 12:00 PM GMT\+9\n/);
  assert.deepEqual(added.json().next, ["2099-06-01T03:00:00.000Z"]);
  assert.match((await botkins(["routines", "show", "Once"])).out, /When: Once on 2099-06-01 at 12:00 PM\nTime zone: Asia\/Tokyo/);
  // Its time passes (made so by the test): a change of the result alone is still taken, as the app takes it.
  const { workspace } = running.runtime;
  const entry = workspace.state.chats.find((chat) => chat.id === added.json().id).schedules[0];
  entry.nextAt = null;
  entry.finishedAt = Date.now();
  assert.equal((await botkins(["routines", "edit", "Once", "--quiet", "--yes"])).exit, 0);
  assert.match((await botkins(["routines", "show", "Once"])).out, /State: finished\nNext: none/);
  assert.equal((await botkins(["routines", "remove", "Once", "--yes"])).exit, 0);
});

test("`routines duplicate` copies, and a name that two routines have names their ids", { skip }, async () => {
  await client.call("bots.add", { name: "Orbit" });
  const [first] = (await list()).filter((entry) => entry.name === "Brief");
  const copy = await botkins(["routines", "duplicate", "Brief"]);
  assert.equal(copy.exit, 0, copy.err);
  assert.match(copy.out, /^Copied to Brief \(\S+\) for Nova\. It runs next at /);
  const both = (await list()).filter((entry) => entry.name === "Brief");
  assert.equal(both.length, 2);
  const other = both.find((entry) => entry.id !== first.id);
  // The name is no longer one routine's: the refusal says which ones have it. An id still names one.
  const ambiguous = await botkins(["routines", "show", "Brief"]);
  assert.equal(ambiguous.exit, 1);
  assert.match(ambiguous.err, /More than one routine is called Brief: \S+ \(Nova\); \S+ \(Nova\)\. Use its id\./);
  assert.ok(ambiguous.err.includes(first.id) && ambiguous.err.includes(other.id), "it names both");
  assert.equal((await botkins(["routines", "show", other.id, "--json"])).json().instructions, "New prompt");
  assert.equal((await botkins(["routines", "remove", "Brief", "--yes"])).exit, 1);
  // A copy for another bot and under its own name.
  const moved = (await botkins(["routines", "duplicate", first.id, "--bot", "Orbit", "--name", "Orbit's brief", "--json"])).json();
  const original = (await botkins(["routines", "show", first.id, "--json"])).json();
  assert.deepEqual([moved.name, moved.bot, moved.instructions, moved.schedule, moved.timezone, moved.id === first.id], ["Orbit's brief", "Orbit", "New prompt", original.schedule, "UTC", false]);
  assert.match((await botkins(["routines", "duplicate", first.id, "--bot", "Nobody"])).err, /There is no bot called Nobody/);
  assert.match((await botkins(["routines", "duplicate", "Nothing"])).err, /There is no routine called Nothing/);
  assert.match((await botkins(["routines", "duplicate", first.id, "--name", "x".repeat(81)])).err, /Give a name of up to 80 characters/);
  assert.equal((await list()).length, 3, "a refused copy made nothing");
  const logged = (await changes()).filter((line) => line.startsWith("routines.duplicate"));
  assert.deepEqual(logged, ["routines.duplicate Brief", "routines.duplicate Orbit's brief"]);
  await botkins(["routines", "remove", other.id, "--yes"]);
  await botkins(["routines", "remove", moved.id, "--yes"]);
});

test("`routines remove` asks, and a removed routine is gone with its chat", { skip }, async () => {
  const [brief] = (await list()).filter((entry) => entry.name === "Brief");
  const chats = () => running.runtime.workspace.state.chats.length;
  const before = chats();
  const asked = await botkins(["routines", "remove", "Brief"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /This removes the routine "Brief" of Nova with its own chat and every run it kept\.\n/);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.ok((await list()).some((entry) => entry.id === brief.id));
  const declined = await botkins(["routines", "remove", "Brief"], { input: "no\n", tty: true });
  assert.equal(declined.exit, 1);
  assert.ok((await list()).some((entry) => entry.id === brief.id));
  const removed = await botkins(["routines", "remove", "Brief", "--yes"]);
  assert.equal(removed.out, "Removed Brief.\n");
  assert.equal((await list()).some((entry) => entry.id === brief.id), false);
  assert.equal(chats(), before - 1, "its chat went with it");
  assert.deepEqual(JSON.parse(JSON.stringify((await botkins(["routines", "remove", "Brief", "--yes", "--json"])).json())), { error: { message: "There is no routine called Brief. See `botkins routines list`.", code: "NOT_FOUND" } });
  assert.ok((await changes()).includes("routines.remove Brief"));
  await botkins(["routines", "remove", "Morning brief", "--yes"]);
  assert.deepEqual(await list(), []);
});

test("`routines schedules` and `routines schedule` list and change what chats scheduled for themselves", { skip }, async () => {
  const { workspace } = running.runtime;
  const nova = workspace.state.bots.find((entry) => entry.name === "Nova");
  const chatId = workspace.createChat(nova.id, "Daily standup");
  const other = workspace.createChat(nova.id, "Weekly report");
  const chat = workspace.chat(chatId);
  chat.schedules = [
    { id: 1, prompt: "Post the standup\nnotes", recurring: true, intervalMs: 3_600_000 * 24, nextAt: Date.now() + 3_600_000, enabled: true },
    { id: 2, prompt: "Check the build", recurring: true, cron: "*/30 * * * *", timezone: "UTC", nextAt: Date.now() + 60_000, enabled: true },
  ];
  workspace.chat(other).schedules = [{ id: 1, prompt: "Once soon", recurring: false, nextAt: Date.now() + 120_000, enabled: true }];
  workspace.save();
  const rows = (await botkins(["routines", "schedules", "--json"])).json();
  assert.deepEqual(rows.map((row) => [row.chat, row.id, row.when, row.enabled]), [["Weekly report", 1, "Once", true], ["Daily standup", 1, "Every day", true], ["Daily standup", 2, "Cron · */30 * * * *", true]]);
  assert.equal(rows[1].prompt, "Post the standup\nnotes");
  const text = (await botkins(["routines", "schedules"])).out;
  assert.match(text, /^CHAT {2,}NUMBER {2}BOT {2,}WHEN {2,}STATE {2}NEXT {2,}PROMPT {2,}CHAT ID\n/);
  assert.match(text, /Daily standup {2,}1 {2,}Nova {2,}Every day {2,}on .* Post the standup notes {2,}\S+\n/);
  assert.equal((await botkins(["routines", "schedules", "--bot", "Nobody"])).exit, 1);
  // Pause and resume by the chat's title and the number: no question.
  const paused = await botkins(["routines", "schedule", "Daily standup", "2", "pause"]);
  assert.equal(paused.out, "Paused schedule 2 of Daily standup.\n");
  assert.equal(chat.schedules[1].enabled, false);
  assert.deepEqual((await botkins(["routines", "schedule", chatId, "2", "resume", "--json"])).json(), { chatId, chat: "Daily standup", id: 2, action: "resume", enabled: true });
  assert.equal(chat.schedules[1].enabled, true);
  // Deleting asks, and says which one.
  const asked = await botkins(["routines", "schedule", "Daily standup", "1", "delete"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This deletes the schedule 1 of the chat "Daily standup": Every day, "Post the standup notes"\.\n/);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(chat.schedules.length, 2);
  const deleted = await botkins(["routines", "schedule", "Daily standup", "1", "delete", "--yes"]);
  assert.equal(deleted.out, "Deleted schedule 1 of Daily standup.\n");
  assert.deepEqual(chat.schedules.map((entry) => entry.id), [2]);
  // Refusals: a number that is not there, a chat with none, a word that is no action, a routine's own schedule.
  assert.match((await botkins(["routines", "schedule", "Daily standup", "9", "pause"])).err, /The chat Daily standup has no schedule with the number 9\. See `botkins routines schedules`\./);
  assert.match((await botkins(["routines", "schedule", "Nothing", "1", "pause"])).err, /There is no chat called Nothing\. See `botkins routines schedules`\./);
  assert.match((await botkins(["routines", "schedule", "Daily standup", "2", "stop"])).err, /Say pause, resume or delete\./);
  assert.match((await botkins(["routines", "schedule", "Daily standup"])).err, /Give the chat, the number of its schedule, and pause, resume or delete\./);
  await botkins(["routines", "add", "Own", "--bot", "Nova", "--cadence", "daily", "--at", "09:00", "--prompt", "p", "--yes"]);
  const [own] = await list();
  const ownChat = workspace.chat(own.id);
  ownChat.schedules.push({ id: 5, prompt: "In the routine's chat", recurring: true, intervalMs: 60_000, nextAt: Date.now() + 60_000, enabled: true });
  assert.match((await botkins(["routines", "schedule", own.id, "1", "delete", "--yes"])).err, /That is a routine's own schedule\. Use `botkins routines pause`, `resume` or `remove`\./);
  assert.equal(ownChat.schedules.length, 2);
  assert.equal((await botkins(["routines", "schedule", own.id, "5", "pause"])).exit, 0);
  await botkins(["routines", "remove", "Own", "--yes"]);
  // The log names the call, the chat and what was done (one of three words), and holds no prompt.
  const logged = (await changes()).filter((line) => line.startsWith("routines.schedule"));
  assert.deepEqual(logged.slice(0, 3), ["routines.schedule Daily standup (pause)", "routines.schedule Daily standup (resume)", "routines.schedule Daily standup (delete)"]);
  assert.equal(JSON.stringify(await changes()).includes("Post the standup"), false);
});

test("a schedule that runs more often than a bot's own tool allows shows its cost, and the socket needs the mark", { skip }, async () => {
  const COST = "Cost: this runs as often as every 5 minutes. Each run uses one model turn, and a model turn can cost money.";
  const fast = ["routines", "add", "Fast check", "--bot", "Nova", "--cron", "*/5 * * * *", "--timezone", "UTC"];
  const data = { bot: "Nova", name: "Direct", prompt: PROMPT, cadence: { kind: "custom", cron: "*/5 * * * *" }, timezone: "UTC" };
  // The block has the cost line; with no terminal the command asks for --yes, also with --json; nothing is made.
  const asked = await botkins([...fast, "--prompt", PROMPT]);
  assert.equal(asked.exit, 2);
  assert.ok(asked.err.includes("  Next: ") && asked.err.includes("\n  " + COST + "\n  Result goes:"), asked.err);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.match((await botkins([...fast, "--prompt", PROMPT, "--json"])).err, /Cost: this runs as often as every 5 minutes\./);
  assert.deepEqual(await list(), []);
  // The socket's own call, with no mark, is refused with a sentence that says what to do; the mark lets it through.
  await assert.rejects(client.call("routines.add", data), (error) => error.code === "NEEDS_AGREEMENT" && /as often as every 5 minutes\. Each run uses one model turn, and a model turn can cost money\. Show it to the person and ask first\..*\{ fastSchedule: true \}/.test(error.message));
  await assert.rejects(client.call("routines.add", data, { fastSchedule: false }), (error) => error.code === "NEEDS_AGREEMENT");
  assert.deepEqual(await list(), []);
  // With --yes through the command it is saved, the cost line is on standard error also with --json, and the log says how often.
  const added = await botkins([...fast, "--prompt", PROMPT, "--yes", "--json"]);
  assert.equal(added.exit, 0, added.err);
  assert.ok(added.err.includes(COST));
  assert.equal(added.json().fastMinutes, 5);
  assert.deepEqual((await list()).map((entry) => entry.name), ["Fast check"]);
  assert.equal((await botkins(["routines", "show", "Fast check", "--json"])).json().fastMinutes, 5);
  assert.ok((await changes()).includes("routines.add Fast check (each 5 minutes)"));
  assert.equal(readFileSync(paths.logFile, "utf8").includes("SECRET-PROMPT-TEXT"), false);
  // An hourly schedule has no cost line, needs no mark, and its log line is as before. So does 15 minutes, which is not more often.
  const hourly = await botkins(["routines", "add", "Hourly check", "--bot", "Nova", "--cron", "0 * * * *", "--timezone", "UTC", "--prompt", PROMPT, "--yes"]);
  assert.equal(hourly.exit, 0, hourly.err);
  assert.equal(hourly.err.includes("Cost:"), false);
  assert.equal((await botkins(["routines", "show", "Hourly check", "--json"])).json().fastMinutes, undefined);
  assert.equal((await client.call("routines.review", null, { ...data, cadence: { kind: "custom", cron: "*/15 * * * *" } })).fastMinutes, undefined);
  const direct = await client.call("routines.add", { ...data, name: "Direct hourly", cadence: { kind: "custom", cron: "0 * * * *" } });
  assert.equal(direct.name, "Direct hourly");
  assert.ok((await changes()).includes("routines.add Hourly check"));
  // An edit that makes a routine fast: the cost line, the refusal with no yes, the refusal of the call with no mark, then saved.
  const edit = ["routines", "edit", "Hourly check", "--cron", "*/10 * * * *"];
  const editAsked = await botkins(edit);
  assert.equal(editAsked.exit, 2);
  assert.ok(editAsked.err.includes("Cost: this runs as often as every 10 minutes."), editAsked.err);
  await assert.rejects(client.call("routines.edit", "Hourly check", { cadence: { cron: "*/10 * * * *" } }), (error) => error.code === "NEEDS_AGREEMENT");
  assert.equal((await botkins(["routines", "show", "Hourly check", "--json"])).json().schedule.cron, "0 * * * *");
  const edited = await botkins([...edit, "--yes"]);
  assert.equal(edited.exit, 0, edited.err);
  assert.ok(edited.err.includes("Cost: this runs as often as every 10 minutes."));
  assert.ok((await changes()).includes("routines.edit Hourly check (each 10 minutes)"));
  // A routine that is fast stays so under any change, so any change of it says the cost and needs the mark. A slower schedule takes it away.
  await assert.rejects(client.call("routines.edit", "Hourly check", { name: "Renamed" }), (error) => error.code === "NEEDS_AGREEMENT");
  const slower = await botkins(["routines", "edit", "Hourly check", "--cron", "0 */2 * * *", "--yes"]);
  assert.equal(slower.exit, 0, slower.err);
  assert.equal(slower.err.includes("Cost:"), false);
  assert.equal((await client.call("routines.edit", "Hourly check", { name: "Renamed" })).name, "Renamed");
  // A copy of a fast routine is a new fast routine: it shows the cost and asks; with no mark the call is refused.
  const copyAsked = await botkins(["routines", "duplicate", "Fast check", "--name", "Fast copy"]);
  assert.equal(copyAsked.exit, 2);
  assert.ok(copyAsked.err.includes(COST) && /This needs a yes\./.test(copyAsked.err), copyAsked.err);
  await assert.rejects(client.call("routines.duplicate", "Fast check", null, "Fast copy"), (error) => error.code === "NEEDS_AGREEMENT");
  assert.deepEqual((await list()).map((entry) => entry.name).sort(), ["Direct hourly", "Fast check", "Renamed"]);
  const copied = await botkins(["routines", "duplicate", "Fast check", "--name", "Fast copy", "--yes", "--json"]);
  assert.equal(copied.exit, 0, copied.err);
  assert.equal(copied.json().fastMinutes, 5);
  assert.ok((await changes()).includes("routines.duplicate Fast copy (each 5 minutes)"));
  // A copy of a slow routine needs no yes, as before.
  assert.equal((await botkins(["routines", "duplicate", "Renamed", "--name", "Slow copy"])).exit, 0);
  for (const name of ["Fast check", "Fast copy", "Direct hourly", "Renamed", "Slow copy"]) assert.equal((await botkins(["routines", "remove", name, "--yes"])).exit, 0, name);
  assert.deepEqual(await list(), []);
});

test("`botkins help --json` describes the routine commands", { skip }, async () => {
  const all = (await botkins(["help", "routines", "--json"])).json();
  const commands = Object.fromEntries(all.areas[0].commands.map((entry) => [entry.command, entry]));
  assert.deepEqual(Object.keys(commands), ["routines list", "routines run", "routines pause", "routines resume", "routines show", "routines when", "routines add", "routines edit", "routines remove", "routines duplicate", "routines schedules", "routines schedule"]);
  assert.deepEqual(commands["routines add"].arguments, [{ name: "name", required: true }]);
  const names = commands["routines add"].options.map((option) => option.name);
  for (const name of ["--bot", "--prompt", "--file", "--cadence", "--at", "--days", "--date", "--cron", "--timezone", "--deliver", "--chat", "--category", "--quiet", "--yes"]) assert.ok(names.includes(name), name);
  assert.deepEqual([commands["routines add"].asks, commands["routines edit"].asks, commands["routines remove"].asks, commands["routines schedule"].asks, commands["routines when"].asks, commands["routines duplicate"].asks], ["--yes", "--yes", "--yes", "--yes", undefined, "--yes"]);
  assert.deepEqual(commands["routines when"].arguments, [{ name: "cron line", required: false }]);
  assert.deepEqual(commands["routines schedule"].arguments.map((argument) => argument.name), ["chat", "number", "action"]);
  assert.match(commands["routines add"].details, /time zone/);
});

test("a script routine is shown whole before it is saved, and can take a follow-up action", { skip }, async () => {
  await client.call("bots.add", { name: "Quill" });
  const base = ["routines", "add", "Disk check", "--bot", "Quill", "--cadence", "daily", "--at", "03:00", "--timezone", "UTC"];
  assert.match((await botkins([...base, "--follow-up", "--prompt", "p"])).err, /--follow-up goes with a script/);
  assert.match((await botkins([...base, "--script", "df -h", "--follow-up"])).err, /Give the prompt/, "a follow-up action needs its prompt");
  const asked = await botkins([...base, "--script", "df -h /\necho SCRIPT-LINE"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, /^This routine runs a script on this computer on a schedule, with nobody watching\. Read the script\./);
  assert.match(asked.err, /\n {2}Runs: a script on the computer, with no model\n {2}Script:\n {6}df -h \/\n {6}echo SCRIPT-LINE\n/);
  const saved = (await botkins([...base, "--script", "df -h /", "--yes", "--json"])).json();
  assert.deepEqual([saved.script, saved.followUp, saved.instructions], ["df -h /", false, ""]);
  const edited = await botkins(["routines", "edit", saved.id, "--follow-up", "--prompt", "Warn me when the disk is full.", "--yes", "--json"]);
  assert.equal(edited.exit, 0, edited.err);
  assert.match(edited.err, /Changes: prompt, follow-up action/);
  assert.match(edited.err, /Runs: a script on the computer, with no model, then a follow-up action/);
  assert.deepEqual([edited.json().followUp, edited.json().instructions], [true, "Warn me when the disk is full."]);
  const plain = (await botkins(["routines", "edit", saved.id, "--no-script", "--yes", "--json"])).json();
  assert.equal(plain.script, undefined, "--no-script makes it a prompt routine again");
  assert.equal((await botkins(["routines", "remove", saved.id, "--yes"])).exit, 0);
});

test("`models --routines` needs a model it knows, and `none` clears the routines default", { skip }, async () => {
  assert.match((await botkins(["models", "--effort", "high"])).err, /--effort goes with --routines/);
  assert.match((await botkins(["models", "--routines", "nobody/nothing"])).err, /No connected provider offers nobody\/nothing/);
  const cleared = await botkins(["models", "--routines", "none"]);
  assert.equal(cleared.exit, 0, cleared.err);
  assert.match(cleared.out, /Routines have no default model of their own/);
});
