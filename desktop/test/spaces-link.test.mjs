// Spaces on the host with the real link beside it, as the desktop app and the terminal host have
// them: one process, the link's own rule for who can open a space (`spaceCan`), and a real team
// member. The other tests of the host use a stand-in for that rule; this one shares a space
// through the link and reads it as the member.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkHost } from "../desktop/link/index.mjs";
import { linkCapabilities } from "../desktop/runtime.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { Workspace } from "./starter.mjs";

const blocks = [{ type: "markdown", text: "Hello" }];

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-spaces-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let script = async () => {};
  let broke = null;
  const fake = fakeClient(async (_id, _options, session) => {
    const tool = async (name, args = {}) => {
      const out = await session.tool(name, args);
      return typeof out === "string" ? JSON.parse(out) : out;
    };
    await script(tool).catch((error) => void (broke = error));
    return { data: { content: "done" } };
  });
  let link;
  // The app asks the link, as desktop/runtime.mjs wires it.
  const ws = new Workspace(join(dir, "app"), fake.client, () => {}, {
    team: () => link?.team(),
    people: (chatId) => link?.chatPeople?.(chatId),
    spaceCan: (space, person) => link?.spaceCan?.(space, person),
  });
  link = new LinkHost({
    dir: join(dir, "link"),
    port: 0,
    relay: false,
    backend: {
      info: () => ({ app: "botkins", version: "0", platform: process.platform }),
      capabilities: linkCapabilities(),
      snapshot: () => ws.snapshot(),
      subscribe: () => () => {},
      call: async () => {},
      spaces: { ensure: (person) => ws.spaces.ensure(person), release: (id) => ws.spaces.memberRemoved(id), snapshot: (id) => ws.spaces.snapshot(id) },
    },
  });
  t.after(() => link.stop?.());
  // Two members in the link's own team. Their role may do everything with spaces and sees every bot.
  const team = link.store.data.team;
  const role = team.roles.find((item) => item.id === team.groups.find((group) => group.id === "g_everyone").roleId);
  await link.saveRole({ ...structuredClone(role), bots: "all", perms: { ...role.perms, agents: ["view", "chat"], today: ["view", "use", "create", "manage", "delete"] } });
  for (const [id, name] of [["m_avery", "Avery"], ["m_blake", "Blake"]]) link.store.data.team.members.push({ id, name, groupId: "g_everyone", joinedAt: 1, deviceIds: [] });
  /** A message from a person in a chat, with the bot doing `run` in that turn. */
  const turn = async (chatId, run, memberId) => {
    script = run;
    broke = null;
    await ws.send(chatId, "do it", memberId ? { author: ws.memberAuthor(memberId) } : {});
    script = async () => {};
    if (broke) throw broke;
  };
  const chatOf = (botId, memberId) => {
    const id = ws.createChat(botId);
    if (memberId) ws.chat(id).createdBy = memberId;
    return id;
  };
  return { ws, link, turn, chatOf };
}
const refusal = (run) => {
  try {
    run();
    return null;
  } catch (error) {
    return error.message;
  }
};

test("a space shared through the real link opens for the member it was shared with, as far as it was shared, and not after it is taken back", async (t) => {
  const { ws, link, turn, chatOf } = await setup(t);
  const launch = ws.spaces.create({ name: "Launch" }, "owner");
  const owners = chatOf("pip");
  ws.chat(owners).spaceId = launch;
  await turn(owners, async (tool) => void (await tool("today_publish", { key: "plan", title: "Plan", blocks, state: { done: false } })));
  const [plan] = ws.spaces.panels(launch);
  const card = ws.board.post("pip", { kind: "feed", title: "Board minutes", body: "PRIVATE-NUMBERS" }, ws.spaces.ensure("owner").feed.id);

  // Private: it is not there for a member, by any way in.
  const gone = /This space no longer exists\./;
  assert.equal(link.spaceCan(ws.spaces.get(launch), "m_avery"), null);
  assert.throws(() => ws.spaces.read(launch, "m_avery"), gone);
  assert.throws(() => ws.spaces.patchState(plan.id, { done: true }, "Ticked", "m_avery"), gone);
  assert.throws(() => ws.spaces.ask({ spaceId: launch, botId: "pip", text: "x" }, "m_avery"), gone);

  // The owner shares it with Avery to look at.
  link.shareSpace("owner", launch, { access: "members", grants: [{ id: "m_avery", can: "view" }] });
  assert.deepEqual(["owner", "m_avery", "m_blake"].map((person) => ws.spaces.can(ws.spaces.get(launch), person)), ["own", "view", null]);
  const read = ws.spaces.read(launch, "m_avery");
  assert.deepEqual([read.id, read.panels.map((panel) => panel.title), read.panels[0].state], [launch, ["Plan"], { done: false }]);
  assert.equal("chatId" in read.panels[0], false, "the chat the panel was made in is the owner's");
  assert.match(refusal(() => ws.spaces.patchState(plan.id, { done: true }, "Ticked", "m_avery")), /You can look at this space, not change it\./);
  assert.match(refusal(() => ws.spaces.note(plan.id, "hello", "m_avery")), /not change it/);
  assert.throws(() => ws.spaces.read(launch, "m_blake"), gone, "shared with one member is not shared with another");
  // A bot that works for Avery sees the space, and may not write there.
  let seen;
  const averys = chatOf("pip", "m_avery");
  await turn(averys, async (tool) => {
    seen = { spaces: (await tool("space_list")).filter((space) => space.id === launch).map((space) => [space.name, space.change, space.panels]), wrote: await tool("today_publish", { key: "mine", space: "Launch", title: "Mine", blocks }).then(() => "written", (error) => error.message) };
  }, "m_avery");
  assert.deepEqual(seen.spaces, [["Launch", false, 1]]);
  assert.match(seen.wrote, /can look at Launch, not change it/);

  // Now to change. Avery ticks the box and writes a note; the panel says who did.
  link.shareSpace("owner", launch, { access: "members", grants: [{ id: "m_avery", can: "edit" }] });
  assert.equal(ws.spaces.can(ws.spaces.get(launch), "m_avery"), "edit");
  ws.spaces.patchState(plan.id, { done: true }, "Ticked Plan", "m_avery");
  ws.spaces.note(plan.id, "Looks right", "m_avery");
  assert.deepEqual([plan.state, plan.last.name, plan.notes.map((note) => [note.name, note.text])], [{ done: true }, "Avery", [["Avery", "Looks right"]]]);
  await turn(averys, async (tool) => void (seen = await tool("today_publish", { key: "mine", space: "Launch", title: "Mine", blocks })), "m_avery");
  assert.deepEqual(ws.spaces.panels(launch).map((panel) => [panel.title, panel.createdBy]), [["Plan", undefined], ["Mine", "m_avery"]]);
  // Only its maker renames or deletes it, with the link's own word for who that is.
  assert.match(refusal(() => ws.spaces.rename(launch, "Avery's now", "m_avery")), /Only the person who made this space can do that\./);

  // With every member, to look.
  link.shareSpace("owner", launch, { access: "team", teamCan: "view" });
  assert.deepEqual(["m_avery", "m_blake"].map((person) => ws.spaces.can(ws.spaces.get(launch), person)), ["view", "view"]);
  assert.equal(ws.spaces.read(launch, "m_blake").panels.length, 2);

  // A card of the owner's own Feed: a member reads it by a mention only while that space is shared with them.
  const mention = [{ kind: "board", id: card.id }];
  const avery = ws.memberAuthor("m_avery");
  assert.deepEqual(ws.mentions.resolve(ws.chat(averys), mention, avery).list, []);
  link.shareSpace("owner", card.spaceId, { access: "members", grants: [{ id: "m_avery", can: "view" }] });
  assert.match(ws.mentions.resolve(ws.chat(averys), mention, avery).context, /PRIVATE-NUMBERS/);
  link.shareSpace("owner", card.spaceId, { access: "private" });
  assert.deepEqual(ws.mentions.resolve(ws.chat(averys), mention, avery).list, []);

  // Taken back: it is gone for both again, also for the bot that works for Avery.
  link.shareSpace("owner", launch, { access: "private" });
  assert.throws(() => ws.spaces.read(launch, "m_avery"), gone);
  assert.throws(() => ws.spaces.read(launch, "m_blake"), gone);
  await turn(averys, async (tool) => void (seen = (await tool("space_list")).map((space) => space.name)), "m_avery");
  assert.equal(seen.includes("Launch"), false);
  // The owner opens every space, a member's too; a member's own is theirs.
  const theirs = ws.spaces.create({ name: "Avery's" }, "m_avery");
  assert.deepEqual(["owner", "m_avery", "m_blake"].map((person) => ws.spaces.can(ws.spaces.get(theirs), person)), ["own", "own", null]);
});
