// The cases of the two-container check (run.sh starts the containers and calls this).
//
// Two stand-in phones talk to the `host` container as a real phone does: the owner's, paired with
// the code the host wrote for it, and a team member's, which joins by an invite. Everything they
// ask for crosses to the `workspace` container through the socket between the two, with the
// person who asked and the cut of the team (desktop/headless). No model is used.
//
//   node drive.mjs <desktop dir> <compose project> <port>
//
// Prints one line for each case. Exits 0 when all passed; otherwise it names the case that failed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [desktop, project, port] = process.argv.slice(2);
const phone = join(desktop, "test/fixtures/phone.mjs");
const dir = mkdtempSync(join(tmpdir(), "bk-display-e2e-"));
const address = "127.0.0.1:" + port;
const LAUNCH = "s_e2elaunch2"; // seeded with two panels, one by each of two bots (seed-workspace.json)
const compose = (...args) => run("docker", ["compose", "-p", project, "--profile", "display", ...args], { cwd: desktop, timeout: 30_000, env: { ...process.env, BOTKINS_BIND_PORT: port } });
/** One run of the stand-in phone. Its answer, or an error with the phone's own last line. */
const phoneDoes = (args, seconds = 60) =>
  run(process.execPath, [phone, "--via", "lan", "--timeout", String(seconds), ...args], { timeout: (seconds + 20) * 1000 }).then(
    ({ stdout }) => JSON.parse(stdout),
    (error) => {
      throw new Error(String(error.stderr ?? error.message).trim().split("\n").at(-1));
    },
  );
const calls = async (pairing, list) => (await phoneDoes(["--pairing", pairing, "--call", JSON.stringify(list)])).calls;
const until = async (what, seconds, look) => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const found = await look().catch(() => null);
    if (found) return found;
  }
  throw new Error("Waited " + seconds + " seconds for " + what + ".");
};
const builtin = { capability: true, builtin: ["Today", "Feed", "Ideas", "Goals"], made: { sameId: true, can: "own", access: "private", pinned: true }, read: { sameId: true, panels: 0, cards: 0, seenAt: "number" }, refused: "Today can't be renamed.", left: 0 };
const gone = { error: "This space no longer exists." };

let current = "";
let failed = false;
/** One case: its name is printed with "ok" when its checks held. The first that does not ends the run. */
async function check(name, body) {
  current = name;
  await body();
  console.log("ok - " + name);
}
const owners = join(dir, "owner.json");
const members = join(dir, "member.json");
const state = {};

try {
  await check("the two containers are up, and the host wrote a pairing code for the owner", async () => {
    // As the README says to read it. The code itself is never printed.
    state.pairing = await until("the owner's pairing file in the host container", 120, () => compose("exec", "-T", "host", "cat", "/run/botkins-owner/pairing.json").then(({ stdout }) => JSON.parse(stdout)));
    assert.match(state.pairing.url, /^botkins:\/\/pair\?/);
  });

  await check("the owner's phone pairs and uses Spaces: the four built-in ones, the seeded one, and one it makes, names, reads and deletes", async () => {
    const link = new URL(state.pairing.url);
    link.searchParams.set("h", address);
    const first = await until("the owner's phone to pair", 120, () => phoneDoes(["--link", link.href, "--save", owners, "--name", "Owner's phone", "--space", "Owner try", "--call", JSON.stringify([["spaces.read", LAUNCH], ["link.team.get"]])], 40));
    assert.equal(first.you.kind, "owner");
    // (The seeded space is there before and after: one space that is not built in is left when the owner's own is deleted.)
    assert.deepEqual(first.spaces, { ...builtin, others: ["Launch"], left: 1 });
    const [launch, team] = first.calls;
    assert.deepEqual(launch.panels.map((panel) => panel.title), ["Plan", "Research"]);
    Object.assign(state, { server: first.device.server, team });
  });

  await check("a member joins by invite, the owner approves, and the member gets their own four spaces and makes one of their own", async () => {
    // The team's role may do everything with spaces and sees every bot.
    const role = state.team.roles.find((item) => item.id === state.team.groups.find((group) => group.id === "g_everyone").roleId);
    state.role = { ...role, bots: "all", perms: { ...role.perms, agents: ["view", "chat"], today: ["view", "use", "create", "manage", "delete"] } };
    const [, invite] = await calls(owners, [["link.team.saveRole", state.role], ["link.team.createInvite", { groupId: "g_everyone", days: 1, maxUses: 1 }]]);
    assert.match(invite.link, /join/);
    const joining = phoneDoes(["--join", invite.link, "--host", address, "--server", state.server, "--save", members, "--name", "Member's phone", "--space", "Member try", "--call", JSON.stringify([["spaces.read", LAUNCH], ["spaces.rename", LAUNCH, "Mine now"]])], 90);
    joining.catch(() => {});
    const request = await until("the request to join to reach the owner", 60, async () => (await calls(owners, [["link.team.get"]]))[0].requests?.[0]);
    await calls(owners, [["link.team.approve", request.id]]);
    const member = await joining;
    assert.equal(member.you.kind, "member");
    // Their four spaces come through the socket's own call for them, and they open them only because the workspace was told the team.
    assert.deepEqual(member.spaces, { ...builtin, others: [] });
    state.memberId = member.you.memberId;
    state.private = member.calls;
  });

  await check("the member cannot open the owner's private space: it is not there for them", async () => {
    assert.deepEqual(state.private, [gone, gone]);
  });

  await check("a space shared after the member joined opens for them, and one shared to look at cannot be changed", async () => {
    // The workspace was told the team before this share. It must be told again, or the member's read is refused there.
    assert.deepEqual(await calls(owners, [["link.spaces.share", LAUNCH, { access: "team", teamCan: "view" }]]), [{}]);
    const [read, rename, panel, note] = await calls(members, [["spaces.read", LAUNCH], ["spaces.rename", LAUNCH, "Mine now"], ["spaces.newPanel", { spaceId: LAUNCH, botId: "pip", prompt: "Track it" }], ["spaces.note", "e2e-plan", "hello"]]);
    assert.deepEqual([read.id, read.panels.map((item) => item.title)], [LAUNCH, ["Plan", "Research"]]);
    assert.deepEqual(rename, { error: "Only the person who made this space can do that." });
    assert.deepEqual(panel, { error: "You can look at this space, not change it." });
    assert.deepEqual(note, { error: "You can look at this space, not change it." });
    // Shared to change: the member's note is taken, with their name on it.
    await calls(owners, [["link.spaces.share", LAUNCH, { access: "team", teamCan: "edit" }]]);
    const [noteId, after] = await calls(members, [["spaces.note", "e2e-plan", "Looks right"], ["spaces.read", LAUNCH]]);
    assert.match(noteId, /^n_/);
    assert.deepEqual(after.panels[0].notes.map((item) => [item.by, item.text]), [[state.memberId, "Looks right"]]);
  });

  await check("a role made smaller between two calls shows in the member's very next read", async () => {
    // The member's role now shows one bot of the two. Nothing else happens in between.
    await calls(owners, [["link.team.saveRole", { ...state.role, bots: ["pip"] }]]);
    const [read] = await calls(members, [["spaces.read", LAUNCH]]);
    assert.deepEqual(read.panels.map((item) => item.title), ["Plan"]);
    // And wider again.
    await calls(owners, [["link.team.saveRole", state.role]]);
    assert.deepEqual((await calls(members, [["spaces.read", LAUNCH]]))[0].panels.map((item) => item.title), ["Plan", "Research"]);
    // A role that may not see spaces at all: nothing of them is there.
    await calls(owners, [["link.team.saveRole", { ...state.role, perms: { ...state.role.perms, today: [] } }]]);
    const [refused] = await calls(members, [["spaces.read", LAUNCH]]);
    assert.ok(refused.error, "refused: " + JSON.stringify(refused));
    await calls(owners, [["link.team.saveRole", state.role]]);
  });

  await check("a share that is taken back closes the space for the member again", async () => {
    await calls(owners, [["link.spaces.share", LAUNCH, { access: "private" }]]);
    assert.deepEqual(await calls(members, [["spaces.read", LAUNCH]]), [gone]);
  });

  await check("a removed member's phone is refused", async () => {
    const [, team] = await calls(owners, [["link.team.removeMember", state.memberId], ["link.team.get"]]);
    assert.deepEqual(team.members, []);
    await assert.rejects(phoneDoes(["--pairing", members, "--call", JSON.stringify([["spaces.read", LAUNCH]])], 8), /revoked|removed|not paired|Timed out/);
  });

  await check("the workspace container keeps nothing of who a space is shared with on disk", async () => {
    // The space was shared three ways above, and the workspace was told each time. None of that is in a file there.
    // (A member's name is: on the note they wrote, as on a message they send. That is the content's own.)
    const { stdout } = await compose("exec", "-T", "workspace", "sh", "-c", "grep -rlE 'teamCan|\"grants\"' /var/lib/botkins-workspace 2>/dev/null | head -5; true");
    assert.equal(stdout.trim(), "");
  });
} catch (error) {
  failed = true;
  console.log("FAILED - " + current + ": " + String(error.message).split("\n").slice(0, 12).join("\n  "));
} finally {
  // The two pairing files hold the phones' keys.
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
