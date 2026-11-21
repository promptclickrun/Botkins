// Sharing a space from the command line (cli/commands/sharing.mjs), against a real service. What these hold to:
// a space is named by its name or id; who can open it is set, ordered and read back; a link, a space shared with all
// members and the team's switch for links each show what they open and need a yes (with no terminal, `--yes`), and the
// service's own call refuses them with no mark; the link is printed by `sharing link` and nowhere else, and never in the log.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main } from "../cli/main.mjs";
import { COMMANDS, describe } from "../cli/commands/index.mjs";
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
/** A real service with two members, a space called Launch, and `botkins(argv, { input, tty })` to run a command against it. */
async function service(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-sharing-"));
  const paths = terminalPaths({ root: join(dir, "r"), env: {} });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false } }));
  const running = await startService({ paths, version: "9.9.9", trial: true });
  t.after(async () => {
    await running.stop("the test ended");
    rmSync(dir, { recursive: true, force: true });
  });
  const { handlers, link } = running.runtime;
  // Two members whose role can open spaces. A trial run keeps the relay off the network, so links are made as the demo computer makes them.
  link.setTeam({ ...link.store.data.team, members: ["Avery", "Blake"].map((name, index) => ({ id: "m_" + name.toLowerCase(), name, groupId: "g_everyone", joinedAt: index + 1, deviceIds: [] })) });
  link.spaces.demoLinks = true;
  const launch = handlers["spaces.create"]({ name: "Launch" });
  const client = controlClient(paths.socket, { timeout: 40_000 });
  const botkins = async (argv, { input = "", tty = false } = {}) => {
    let out = "";
    let err = "";
    const stdin = Readable.from(input ? [input] : []);
    stdin.isTTY = tty;
    const sink = (take) => new Writable({ write: (chunk, _encoding, done) => (take(String(chunk)), done()) });
    const stdout = sink((text) => void (out += text));
    stdout.isTTY = false;
    const exit = await main(argv, { stdout, stderr: sink((text) => void (err += text)), stdin, env: {}, client });
    return { exit, out, err, json: () => JSON.parse(out) };
  };
  const changes = async () => (await client.call("logs.read", { tail: 400 })).entries.map((entry) => entry.text).filter((text) => text.includes("Changed from the command line")).map((text) => text.split("Changed from the command line: ")[1]);
  const everything = () => readFileSync(paths.logFile, "utf8");
  return { botkins, client, changes, everything, launch, link };
}

test("sharing: people are picked and read back, the order, pins and Notify me are the owner's, and the switch for links is set", { skip }, async (t) => {
  const { botkins, launch, link, changes } = await service(t);
  // The list is the owner's: four built-in spaces and Launch, private, with no link in it.
  const listed = (await botkins(["sharing", "list", "--json"])).json();
  assert.deepEqual(listed.map((s) => s.name).sort(), ["Feed", "Goals", "Ideas", "Launch", "Today"]);
  assert.equal(listed.find((s) => s.name === "Launch").access, "private");
  assert.match((await botkins(["sharing", "list"])).out, /^NAME\s+WHO CAN OPEN\s+NOTIFY\s+PINNED\s+ID\n/);
  // Members are picked by name; the list replaces the one before it; a name that nobody has, a twin and a mix are refused.
  const picked = await botkins(["sharing", "set", "launch", "--view", "avery", "--edit", "Blake", "--json"]);
  assert.equal(picked.exit, 0, picked.err);
  assert.deepEqual([picked.json().access, picked.json().people.map((one) => [one.name, one.can])], ["members", [["Avery", "view"], ["Blake", "edit"]]]);
  assert.match((await botkins(["sharing", "show", "Launch"])).out, /Who can open it: Members picked: Avery and Blake\.\n {2}Avery: can only look at it\n {2}Blake: can change it\n/);
  assert.match((await botkins(["sharing", "set", "Launch", "--view", "Nobody"])).err, /There is no person called Nobody\./);
  assert.match((await botkins(["sharing", "set", "Launch", "--view", "Avery", "--edit", "Avery"])).err, /Avery is named twice\./);
  assert.equal((await botkins(["sharing", "set", "Launch", "--private", "--view", "Avery"])).exit, 2);
  assert.equal((await botkins(["sharing", "set", "Launch"])).exit, 2);
  assert.match((await botkins(["sharing", "set", "Launch", "--view", "Avery", "--can", "edit"])).err, /--can goes with --all-members/);
  assert.equal((await botkins(["sharing", "set", "Launch", "--private", "--json"])).json().access, "private");
  // The order and the pins: the spaces named come first; a pin follows the new order.
  assert.deepEqual((await botkins(["sharing", "order", "Goals", "Launch", "--json"])).json().slice(0, 2).map((s) => s.name), ["Goals", "Launch"]);
  await botkins(["sharing", "pin", "Launch"]);
  assert.deepEqual((await botkins(["sharing", "list", "--json"])).json().filter((s) => s.pinned).map((s) => s.name).at(-1), "Launch", "a pin goes after the pinned ones");
  assert.match((await botkins(["sharing", "unpin", "Launch"])).out, /^The space Launch is not pinned now\.\n?$/);
  assert.equal((await botkins(["sharing", "list", "--json"])).json().find((s) => s.name === "Launch").pinned, false);
  // Notify me: shown, set, refused for a word that is no choice.
  assert.match((await botkins(["sharing", "notify", "Launch"])).out, /^Notify me for Launch: Once a day\.\n?$/);
  assert.match((await botkins(["sharing", "notify", "Launch", "all"])).out, /^Notify me for Launch is now: Every change\.\n?$/);
  assert.equal((await botkins(["sharing", "notify", "Launch", "hourly"])).exit, 2);
  assert.equal((await botkins(["sharing", "show", launch, "--json"])).json().notify, "all");
  // The switch for links: off asks nothing; the state is the link's own.
  assert.match((await botkins(["sharing", "links", "off"])).out, /^Members may not make new links now\. The links that exist stay as they are\.\n?$/);
  assert.equal(link.store.data.team.linkSharing, false);
  // The command cannot read the switch: with no word, or another word, it says that it can only set it.
  for (const words of [[], ["maybe"]]) {
    const read = await botkins(["sharing", "links", ...words]);
    assert.equal(read.exit, 2);
    assert.match(read.err, /This command can only set the switch, with `on` or `off`\. It cannot say what the switch is now\./);
  }
  // The commands are in `help --json`, and the ones that ask say so.
  const area = describe("9.9.9").areas.find((one) => one.name === "sharing");
  const asks = Object.fromEntries(area.commands.filter((one) => one.asks).map((one) => [one.command, one.asks]));
  assert.deepEqual(asks, { "sharing set": "--yes", "sharing link": "--yes", "sharing links": "--yes" });
  assert.ok(COMMANDS.sharing.commands.order);
  // Each change is in the log by the space's name and what it got.
  const lines = (await changes()).filter((line) => line.startsWith("sharing."));
  assert.ok(lines.includes("sharing.set Launch (picked people)"));
  assert.ok(lines.includes("sharing.set Launch (private)"));
  assert.ok(lines.includes("sharing.pin Launch"));
  assert.ok(lines.includes("sharing.notify Launch"));
  assert.ok(lines.includes("sharing.setLinks off"));
});

test("sharing: a link, all members and the switch for links show what they open and need a yes; the link is printed once and is never in a list or the log", { skip }, async (t) => {
  const { botkins, client, launch, link, changes, everything } = await service(t);
  const accessOf = async () => (await botkins(["sharing", "show", launch, "--json"])).json().access;
  const SENTENCE = /Anyone with the link can see everything on this space\. They can't change it\./;
  // With no terminal the link needs --yes. The block is on standard error, the refusal names the flag, and nothing is made.
  const asked = await botkins(["sharing", "link", "Launch"]);
  assert.equal(asked.exit, 2);
  assert.match(asked.err, SENTENCE);
  assert.match(asked.err, /This needs a yes\. Run it again with --yes\./);
  assert.equal(asked.out, "");
  assert.equal(await accessOf(), "private");
  // At a terminal "n" leaves it; with --json and no --yes it still asks.
  assert.equal((await botkins(["sharing", "link", "Launch"], { tty: true, input: "n\n" })).exit, 1);
  assert.equal((await botkins(["sharing", "link", "Launch", "--json"])).exit, 2);
  assert.equal(await accessOf(), "private");
  // The service's own call refuses it with no mark, so the command cannot be gone round.
  await assert.rejects(client.call("sharing.link", launch), { code: "NEEDS_YES" });
  await assert.rejects(client.call("sharing.link", launch, { agreed: false }), { code: "NEEDS_YES" });
  await assert.rejects(client.call("sharing.set", launch, { access: "team" }), { code: "NEEDS_YES" });
  await assert.rejects(client.call("sharing.setLinks", true), { code: "NEEDS_YES" });
  assert.equal(await accessOf(), "private");
  assert.notEqual(link.store.data.team.linkSharing, true);
  // With --yes the block is still shown (also with --json), and the link is the only thing on standard output.
  const made = await botkins(["sharing", "link", "Launch", "--yes"]);
  assert.equal(made.exit, 0, made.err);
  assert.match(made.err, SENTENCE);
  assert.match(made.out, /^https:\/\/[^\s/]+\/s\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}\n$/);
  const first = made.out.trim();
  const key = first.split("#k=")[1];
  const asJson = await botkins(["sharing", "link", "Launch", "--json"]);
  assert.equal(asJson.exit, 0, "a space that has a link prints it with no question: nothing is made");
  assert.deepEqual([asJson.json().link, asJson.json().made, asJson.json().new, asJson.err], [first, false, false, ""]);
  // Nothing that lists or shows has the link, and the app's own answer to the window does have it.
  for (const argv of [["sharing", "list", "--json"], ["sharing", "show", "Launch", "--json"], ["sharing", "show", "Launch"], ["sharing", "list"]]) {
    const shown = await botkins(argv);
    assert.equal(shown.out.includes(key) || shown.out.includes("#k="), false, argv.join(" "));
  }
  assert.match((await botkins(["sharing", "show", "Launch"])).out, /Anyone with the link\.\nThey can see everything on it\. They can't change it\./);
  assert.ok(JSON.stringify(link.spacesFor("owner")).includes(key), "the app does give it to the owner's window");
  // A new link replaces the old one, with a block and a yes.
  assert.equal((await botkins(["sharing", "link", "Launch", "--new"])).exit, 2);
  const newer = await botkins(["sharing", "link", "Launch", "--new", "--yes"]);
  assert.notEqual(newer.out.trim(), first);
  assert.match(newer.err, /The old link stops working\./);
  // All members: a block and a yes, then it is shared and the link is taken back.
  const everyone = await botkins(["sharing", "set", "Launch", "--all-members"]);
  assert.equal(everyone.exit, 2);
  assert.match(everyone.err, /This shares the space Launch with all members\.\nNow: Anyone with the link\.\nEvery member whose role can open spaces will be able to open it, and look at it\. They will not be able to change it\./);
  assert.equal(await accessOf(), "link");
  const shared = await botkins(["sharing", "set", "Launch", "--all-members", "--can", "edit", "--yes", "--json"]);
  assert.equal(shared.exit, 0, shared.err);
  assert.deepEqual([shared.json().access, shared.json().teamCan], ["team", "edit"]);
  assert.match(shared.err, /look at it and change it\./);
  assert.equal("link" in shared.json(), false);
  // The link goes away with --off, which asks nothing; a space with no link says so.
  await botkins(["sharing", "link", "Launch", "--yes"]);
  assert.match((await botkins(["sharing", "link", "Launch", "--off"])).out, /^The space Launch is private now\. Its link is taken back: it stops working\.\n?$/);
  assert.equal(await accessOf(), "private");
  assert.match((await botkins(["sharing", "link", "Launch", "--off"])).err, /The space Launch is not shared by link\./);
  // The switch for links: on shows what it lets members do, and needs a yes.
  const on = await botkins(["sharing", "links", "on"]);
  assert.equal(on.exit, 2);
  assert.match(on.err, /This lets members share by link\.\nA member whose role can change spaces will be able to make a link for a space that the member made/);
  assert.notEqual(link.store.data.team.linkSharing, true);
  assert.match((await botkins(["sharing", "links", "on", "--yes"])).out, /^Members may share by link now\.\n?$/);
  assert.equal(link.store.data.team.linkSharing, true);
  // The log names the space and its level, never the link or its key; neither does the service's log file. `seen` and `here` are the window's own: the socket has no call for them.
  const lines = (await changes()).filter((line) => line.startsWith("sharing."));
  assert.ok(lines.includes("sharing.link Launch (link)"));
  assert.ok(lines.includes("sharing.set Launch (all members)"));
  assert.ok(lines.includes("sharing.setLinks on"));
  assert.equal(lines.some((line) => line.includes("#k=") || line.includes(key) || line.includes("/s/")), false);
  assert.equal(everything().includes(key), false);
  await assert.rejects(client.call("link.spaces.here", launch), { code: "UNKNOWN_METHOD" });
});
