// Several computers on one phone: the list the phone keeps and what each step does to it
// (src/state/computers.ts). The phone follows one computer at a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addable, addLabel, agentLine, agentNotes, copyLine, firstPick, foundLine, pickedKeys } from "../src/features/bots/agents";
import type { Pairing } from "../src/link/client";
import type { ImportableAgent } from "../src/link/types";
import { computerActions, computerChoice, currentOf, hasRoom, indexOf, isPairing, MAX_COMPUTERS, NO_COMPUTERS, pairingKey, readKeptComputers, moveComputer, startupComputers, startupProfilePairing, tidy, using, withDetails, withPairing, without } from "../src/state/computers";

const pairing = (id: string, name = "Mac " + id, hosts = ["10.0.0.2:47610"]): Pairing => ({ serverId: id, serverKey: "k-" + id, deviceId: "d-" + id, secretKey: "s-" + id, hosts, name });
const a = pairing("aaa");
const b = pairing("bbb");
const c = pairing("ccc");

test("pairing with a second computer keeps the first, and the new one is in use", () => {
  let kept = withPairing(NO_COMPUTERS, a);
  assert.deepEqual(kept, { current: "aaa", list: [a] });
  kept = withPairing(kept, b);
  assert.deepEqual(kept.list, [a, b]);
  assert.equal(currentOf(kept), b);
  // Pairing again with a computer the phone has replaces that entry only, in its place.
  const again = { ...a, secretKey: "new", deviceId: "d2" };
  kept = withPairing(kept, again);
  assert.deepEqual(kept.list, [again, b]);
  assert.equal(kept.current, "aaa");
});

test("switching uses another kept computer and nothing else changes", () => {
  const kept = withPairing(withPairing(NO_COMPUTERS, a), b);
  const back = using(kept, "aaa");
  assert.equal(currentOf(back), a);
  assert.deepEqual(back.list, kept.list);
  assert.equal(using(kept, "nowhere"), kept, "a computer that is not kept can't be used");
});

test("unpairing removes one computer; the phone goes on with another, or with none", () => {
  const kept = withPairing(withPairing(withPairing(NO_COMPUTERS, a), b), c);
  assert.deepEqual(without(kept, "bbb"), { current: "ccc", list: [a, c] });
  const next = without(kept, "ccc");
  assert.deepEqual(next, { current: "aaa", list: [a, b] }, "the one in use is gone: the first of the rest is used");
  assert.deepEqual(without(without(next, "aaa"), "bbb"), NO_COMPUTERS);
  assert.equal(currentOf(NO_COMPUTERS), null);
});

test("a computer's new addresses are kept with its pairing, and never bring a removed computer back", () => {
  const kept = withPairing(withPairing(NO_COMPUTERS, a), b);
  const moved = { ...a, hosts: ["192.168.1.9:47610"] };
  assert.deepEqual(withDetails(kept, moved).list, [moved, b]);
  assert.equal(withDetails(kept, moved).current, "bbb");
  assert.deepEqual(withDetails(without(kept, "aaa"), moved).list, [b]);
});

test("at most eight computers, and pairing again with a kept one is always allowed", () => {
  let kept = NO_COMPUTERS;
  for (let n = 0; n < MAX_COMPUTERS; n++) {
    assert.equal(hasRoom(kept), true);
    kept = withPairing(kept, pairing("id" + n));
  }
  assert.equal(hasRoom(kept), false);
  assert.equal(hasRoom(kept, "new"), false);
  assert.equal(hasRoom(kept, "id3"), true);
});

test("what was saved is read back whole, and a damaged entry is left out", () => {
  const kept = withPairing(withPairing(NO_COMPUTERS, a), b);
  const saved = new Map([[pairingKey("aaa"), JSON.stringify(a)], [pairingKey("bbb"), JSON.stringify(b)]]);
  const read = (id: string) => saved.get(pairingKey(id)) ?? null;
  assert.deepEqual(readKeptComputers(indexOf(using(kept, "aaa")), read, null), { current: "aaa", list: [a, b] });
  // One pairing's text is gone or broken: the other still works, and it is the one in use.
  saved.set(pairingKey("aaa"), "{broken");
  assert.deepEqual(readKeptComputers(indexOf(using(kept, "aaa")), read, null), { current: "bbb", list: [b] });
  saved.delete(pairingKey("bbb"));
  assert.deepEqual(readKeptComputers(indexOf(kept), read, null), NO_COMPUTERS);
  assert.deepEqual(readKeptComputers("not json", read, null), NO_COMPUTERS);
});

test("a pairing saved before several computers becomes a list of one", () => {
  assert.deepEqual(readKeptComputers(null, () => null, JSON.stringify(a)), { current: "aaa", list: [a] });
  assert.deepEqual(readKeptComputers(null, () => null, "{}"), NO_COMPUTERS);
  assert.deepEqual(readKeptComputers(null, () => null, null), NO_COMPUTERS);
  // Once the list exists it is the truth, also when the old entry is still there.
  assert.deepEqual(readKeptComputers(indexOf(withPairing(NO_COMPUTERS, b)), () => JSON.stringify(b), JSON.stringify(a)), { current: "bbb", list: [b] });
});

test("a pairing needs every field, a list has each computer once, and a key is safe for the keychain", () => {
  assert.equal(isPairing(a), true);
  for (const field of ["serverId", "serverKey", "deviceId", "secretKey", "hosts"]) assert.equal(isPairing({ ...a, [field]: undefined }), false, field);
  assert.equal(isPairing({ ...a, hosts: [1] }), false);
  assert.equal(isPairing(null), false);
  assert.deepEqual(tidy([a, b, { ...a, name: "twice" }], "zzz"), { current: "aaa", list: [a, b] });
  assert.equal(pairingKey("AbC-_9.x"), "botkins.computer.AbC-_9.x");
  assert.equal(pairingKey("a/b+c=d e"), "botkins.computer.a_b_c_d_e");
});

test("the switcher lists every computer, ticks the one in use, and ends with a way to add one", () => {
  assert.deepEqual(computerActions([a, b], "bbb"), [
    { id: "all", title: "All computers", state: "off", image: "square.grid.2x2" },
    { id: "use:aaa", title: "Mac aaa", state: "off" },
    { id: "use:bbb", title: "Mac bbb", state: "on" },
    { id: "add", title: "Connect a computer…", image: "plus" },
  ]);
  assert.deepEqual(computerActions([a, b], "bbb", [], [], true), [
    { id: "all", title: "All computers", state: "on", image: "square.grid.2x2" },
    { id: "use:aaa", title: "Mac aaa", state: "off" },
    { id: "use:bbb", title: "Mac bbb", state: "off" },
    { id: "add", title: "Connect a computer…", image: "plus" },
  ]);
  assert.deepEqual(computerActions([], null), [{ id: "add", title: "Connect a computer…", image: "plus" }]);
  assert.deepEqual(computerActions([{ ...a, name: "" }], null)[0], { id: "use:aaa", title: "Computer", state: "off" });
  assert.deepEqual(computerChoice("use:bbb"), { use: "bbb" });
  assert.equal(computerChoice("all"), "all");
  assert.equal(computerChoice("add"), "add");
  assert.equal(computerChoice("use:"), null);
  assert.equal(computerChoice("delete"), null);
});

test("the normal switcher adds every profile directory host once, without duplicating local pairings", () => {
  const directory = [
    { serverId: "aaa", serverKey: "k-aaa", name: "Mac aaa", hosts: ["10.0.0.2:1"] },
    { serverId: "remote", serverKey: "k-remote", name: "Work PC", hosts: ["10.0.0.3:1"] },
    { serverId: "team", serverKey: "k-team", name: "The team", hosts: ["10.0.0.4:1"], member: true },
  ];
  assert.deepEqual(computerActions([a], "aaa", directory), [
    { id: "use:aaa", title: "Mac aaa", state: "on" },
    { id: "profile:remote", title: "Work PC", state: "off" },
    { id: "profile:team", title: "The team", state: "off" },
    { id: "add", title: "Connect a computer…", image: "plus" },
  ]);
  assert.deepEqual(computerChoice("profile:remote"), { use: "remote", profile: true });
});

// ---- a computer with no bots: bringing in the agents a person already has

test("bringing in agents: what is ticked, what is added, and the words", () => {
  const agent = (key: string, more: Partial<ImportableAgent> = {}): ImportableAgent => ({ key, provider: "copilot", providerName: "GitHub Copilot", agent: key, name: key, role: "Role of " + key, summary: "", instructions: "Do it.", ...more });
  const list = [agent("backend", { summary: "APIs and data" }), agent("broken", { problem: "Its file has no instructions." }), agent("notes", { added: true }), agent("docs", { missingModel: "gpt-9", ownTools: true })];
  assert.deepEqual(firstPick(list), ["backend", "docs"]);
  // The order is the list's, whatever order they were ticked in, and one that can't be added never goes.
  assert.deepEqual(pickedKeys(list, ["docs", "broken", "notes", "backend"]), ["backend", "docs"]);
  assert.deepEqual(addable(list).map((item) => item.key), ["backend", "docs"]);
  assert.deepEqual([addLabel(0), addLabel(1), addLabel(3)], ["Choose an agent", "Add 1 bot", "Add 3 bots"]);
  assert.equal(foundLine(list), "Botkins found 3 agents you already use with GitHub Copilot. Each one you choose becomes a bot with the same instructions.");
  assert.match(foundLine([list[0]!]), /^Botkins found an agent you already use/);
  assert.deepEqual(list.map(agentLine), ["APIs and data", "Can't be added. Its file has no instructions.", "Already a bot", "Role of docs"]);
  assert.deepEqual(agentNotes(list[3]!), ["Its model, gpt-9, isn't on your account. The bot will use your default model.", "Sets its own tools in GitHub Copilot. As a bot it uses Botkins' Skills, MCP servers and approvals."]);
  assert.deepEqual(agentNotes(list[1]!), []);
  assert.equal(copyLine(list), "Botkins copies each agent. Your GitHub Copilot files stay as they are.");
});

test("the saved order interleaves profile and local computers and keeps the active check", () => {
  const host = { serverId: "remote", serverKey: "key", name: "Office", hosts: ["office"] };
  const order = ["removed", "remote", "bbb"];
  assert.deepEqual(computerActions([a, b], a.serverId, [host], order).map(row => row.id), ["all", "profile:remote", "use:bbb", "use:aaa", "add"]);
  assert.equal(computerActions([a, b], a.serverId, [host], order)[3]?.state, "on");
});

test("reordering changes the picker without switching hosts or changing the primary", () => {
  const first = tidy([a, b], b.serverId);
  const order = moveComputer([a.serverId, b.serverId], 1, -1);
  assert.deepEqual(order, [b.serverId, a.serverId]);
  assert.equal(moveComputer(order, 0, -1), order);
  const saved = JSON.parse(JSON.stringify({ primaryHost: a.serverId, computerOrder: order }));
  assert.equal(currentOf(first), b);
  assert.equal(currentOf(startupComputers(first, saved.primaryHost)), a);
  assert.equal(currentOf(startupComputers(first, "removed")), b);
  assert.equal(currentOf(startupComputers(first, null)), b);
  assert.equal(computerActions([a, b], a.serverId, [], saved.computerOrder)[1]?.id, "use:" + b.serverId);
});

test("a manual primary wins over a saved profile selection and a profile primary uses its own pairing", () => {
  const local = [a, b];
  const profile = { [c.serverId]: c };
  assert.equal(startupProfilePairing(a.serverId, c.serverId, local, profile, []), undefined);
  assert.equal(startupProfilePairing(c.serverId, b.serverId, local, profile, []), c);
  assert.equal(startupProfilePairing("removed", c.serverId, local, profile, []), c);
  assert.equal(startupProfilePairing(null, b.serverId, local, profile, [b.serverId]), b);
  assert.equal(startupProfilePairing(null, null, [], profile, []), undefined);
});
