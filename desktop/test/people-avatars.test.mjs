// People in a chat: "@Name" tags, which side a message is on, and each person's own picture
// ("people-avatars-v1"): what the host keeps, who may set it, and where it is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mentionNames, splitMentions } from "../src/mentionTags.ts";
import { authorOf, initialOf, messageSide, personColor, PERSON_COLORS, startsPersonRun } from "../src/messageSides.ts";
import { centerSquare, payloadLength } from "../src/avatarImage.ts";
import { LinkHost, REMOTE_METHODS } from "../desktop/link/index.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";
import { AVATAR_MAX, authorize, cleanAvatar, cleanAvatars, filterParts, ownerParts, TEAM_METHODS, teamPeople } from "../desktop/link/team.mjs";
import { LinkStore } from "../desktop/link/store.mjs";

// ── Pictures as bytes ──
/** The first bytes of a PNG that says it is `width` by `height`: enough for the host's check. */
function png(width, height = width) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return "data:image/png;base64," + bytes.toString("base64");
}
/** A JPEG's start, an APP0 segment, then its frame header with the size. */
function jpeg(width, height = width) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]).toString("base64");
}

// ── Tags ──
const NAMES = [
  { key: "owner", name: "Colt" },
  { key: "m_sam", name: "Sam Lee" },
  { key: "m_al", name: "Al" },
  { key: "m_alex", name: "Alex" },
  { key: "bot:pip", name: "Pip" },
];
const tags = (text) => splitMentions(text, NAMES).filter((piece) => typeof piece !== "string");

test("a mention tag is the longest name first, in any case, and ends where a word does", () => {
  assert.deepEqual(splitMentions("Hi @Sam Lee, ask @pip", NAMES), ["Hi ", { key: "m_sam", text: "@Sam Lee" }, ", ask ", { key: "bot:pip", text: "@pip" }]);
  // "Alex" is longer than "Al", so it wins; "@Alexander" is neither.
  assert.deepEqual(tags("@alex and @Al and @Alexander"), [{ key: "m_alex", text: "@alex" }, { key: "m_al", text: "@Al" }]);
  assert.deepEqual(tags("@COLT!"), [{ key: "owner", text: "@COLT" }]);
  assert.deepEqual(mentionNames(NAMES).map((entry) => entry.name), ["Sam Lee", "Colt", "Alex", "Pip", "Al"]);
});

test("a name that is nobody in the chat, an email and a doubled @ stay plain text", () => {
  assert.deepEqual(splitMentions("Ask @Jordan or mail colt@pip.dev", NAMES), ["Ask @Jordan or mail colt@pip.dev"]);
  assert.deepEqual(tags("@@Colt"), []);
  assert.deepEqual(splitMentions("no at sign", NAMES), ["no at sign"]);
  assert.deepEqual(splitMentions("@Colt", []), ["@Colt"]);
});

test("a mention inside code is never a tag", async () => {
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const { mentionMarkup } = await import("../src/mentionTags.ts");
  const tree = unified().use(remarkParse).parse("Hey @Colt, run `@Pip go` then:\n\n```\n@Sam Lee\n```\n\n[@Colt](https://x.test) and **@sam lee**");
  mentionMarkup(NAMES)()(tree);
  const found = [];
  const walk = (node, inCode) => {
    if (node.type === "personMention") found.push({ key: node.data.hProperties["data-mention"], text: node.children[0].value, inCode });
    for (const child of node.children ?? []) walk(child, inCode || node.type === "code" || node.type === "inlineCode");
  };
  walk(tree, false);
  assert.deepEqual(found, [{ key: "owner", text: "@Colt", inCode: false }, { key: "m_sam", text: "@sam lee", inCode: false }], "code and links keep their text");
});

// ── Sides ──
const owner = (text) => ({ role: "user", text });
const by = (memberId, text) => ({ role: "user", text, author: { memberId, name: memberId } });
const bot = (text) => ({ role: "assistant", text });

test("only the viewer's own messages are on the right", () => {
  // The owner looks at a member's message, and at their own (no author).
  assert.equal(messageSide(owner("hi"), "owner"), "mine");
  assert.equal(messageSide(by("m_sam", "hi"), "owner"), "person");
  // A member looks at the owner's message, another member's and their own.
  assert.equal(messageSide(owner("hi"), "m_sam"), "person");
  assert.equal(messageSide(by("m_kim", "hi"), "m_sam"), "person");
  assert.equal(messageSide(by("m_sam", "hi"), "m_sam"), "mine");
  // A bot's reply and the computer's output are never a person's.
  assert.equal(messageSide(bot("hi"), "owner"), "other");
  assert.equal(messageSide({ role: "command", text: "ls" }, "m_sam"), "other");
  assert.equal(authorOf(owner("x")), "owner");
});

test("a run of one person's messages shows the name tag and badge on the first only", () => {
  const messages = [by("m_sam", "1"), by("m_sam", "2"), { role: "assistant", text: "thinking", interim: true }, by("m_sam", "3"), owner("4"), by("m_kim", "5"), bot("6"), by("m_kim", "7")];
  const heads = messages.map((_, i) => startsPersonRun(messages, i, "owner"));
  assert.deepEqual(heads, [true, false, false, false, false, true, false, true]);
  // The member Sam sees the owner's message as someone else's, and their own as theirs.
  const samSees = messages.map((_, i) => startsPersonRun(messages, i, "m_sam"));
  assert.deepEqual(samSees, [false, false, false, false, true, true, false, true]);
});

test("a person's color is stable and their badge falls back to an initial", () => {
  assert.equal(personColor("m_sam"), personColor("m_sam"));
  // The phone draws the same color for the same person: these values are the shared fixture.
  assert.deepEqual(["owner", "m_sam", "m_kim"].map(personColor), [0, 4, 2]);
  const colors = new Set(["owner", "m_a", "m_b", "m_c", "m_d", "m_e", "m_f", "m_g"].map(personColor));
  assert.ok(colors.size > 2 && [...colors].every((color) => color >= 0 && color < PERSON_COLORS));
  assert.equal(initialOf(" élodie"), "É");
  assert.equal(initialOf(""), "?");
  assert.deepEqual(centerSquare(400, 300), { x: 50, y: 0, side: 300 });
  assert.equal(payloadLength("data:image/jpeg;base64,abcd"), 4);
});

// ── The host's check of a picture ──
test("the host keeps a small square JPEG or PNG and refuses anything else", () => {
  assert.equal(cleanAvatar(png(256)), png(256));
  assert.equal(cleanAvatar(jpeg(256)), jpeg(256));
  assert.equal(cleanAvatar(null), null);
  assert.equal(cleanAvatar(""), null);
  // The wrong type, a type its bytes do not match, and what is no picture at all.
  assert.throws(() => cleanAvatar("data:image/gif;base64,R0lGODlhAQABAAAAACw="), /JPEG or PNG/);
  assert.throws(() => cleanAvatar("data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64")), /JPEG or PNG/);
  assert.throws(() => cleanAvatar(png(256).replace("image/png", "image/jpeg")), /can't be read/);
  assert.throws(() => cleanAvatar("data:image/png;base64," + Buffer.from("not a picture").toString("base64")), /can't be read/);
  assert.throws(() => cleanAvatar("https://example.com/me.png"), /JPEG or PNG/);
  assert.throws(() => cleanAvatar("data:image/png;base64,@@@"), /JPEG or PNG/);
  assert.throws(() => cleanAvatar(42), /Choose a picture/);
  // The size: square, 32 to 512 pixels wide, and at most 96 KB of base64.
  assert.throws(() => cleanAvatar(png(256, 200)), /square/);
  assert.throws(() => cleanAvatar(jpeg(16)), /square/);
  assert.throws(() => cleanAvatar(jpeg(1024)), /square/);
  const big = Buffer.concat([Buffer.from(png(256).split(",")[1], "base64"), Buffer.alloc(AVATAR_MAX)]);
  assert.throws(() => cleanAvatar("data:image/png;base64," + big.toString("base64")), /too large/);
  // A saved team keeps only pictures that pass.
  assert.deepEqual(cleanAvatars({ owner: png(64), m_sam: "data:image/gif;base64,AAAA", m_kim: 7 }), { owner: png(64) });
  // The phone link checks the same shape before the app sees the call.
  assert.deepEqual(remoteArgs("setMyAvatar", [jpeg(256)]), [jpeg(256)]);
  assert.deepEqual(remoteArgs("setMyAvatar", []), [null]);
  assert.throws(() => remoteArgs("setMyAvatar", [png(256), "m_kim"]), /one picture/);
});

// ── Who may set a picture, and where it is sent ──
function hostWithTeam(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-avatars-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const host = new LinkHost({
    dir,
    backend: { snapshot: () => ({ bots: [], chats: [], requests: [], runs: [] }), subscribe: () => () => {}, call: async (method) => (calls.push(method), null) },
  });
  host.store.data.devices = [
    { id: "dev-sam", name: "Sam's phone", memberId: "m_sam", pub: "x" },
    { id: "dev-kim", name: "Kim's phone", memberId: "m_kim", pub: "x" },
    { id: "dev-owner", name: "Owner's phone", pub: "x" },
    { id: "dev-gadget", name: "Desk gadget", kind: "gadget", pub: "x" },
  ];
  host.store.data.team = {
    ...host.store.data.team,
    members: [
      { id: "m_sam", name: "Sam", groupId: "g_everyone" },
      { id: "m_kim", name: "Kim", groupId: "g_everyone" },
    ],
  };
  return { host, dir, calls };
}

test("setMyAvatar sets the caller's own picture and nobody else's", async (t) => {
  const { host, dir, calls } = hostWithTeam(t);
  assert.ok(REMOTE_METHODS.has("setMyAvatar") && TEAM_METHODS.setMyAvatar, "it is a call a phone makes, with a rule for members");
  // Any member may set their own, even a Guest with no settings rights.
  assert.equal(authorize({ kind: "member", memberId: "m_sam", groupId: "g_everyone" }, host.store.data.team, "setMyAvatar", [png(256)]), "");

  assert.deepEqual(await host.dispatch({ deviceId: "dev-sam" }, { m: "setMyAvatar", a: [png(256)] }), { avatar: png(256) });
  assert.deepEqual(host.store.data.team.avatars, { m_sam: png(256) }, "only Sam's picture is set");
  // Naming someone else is refused: the call has no person in it.
  await assert.rejects(host.dispatch({ deviceId: "dev-kim" }, { m: "setMyAvatar", a: [jpeg(256), "m_sam"] }), /one picture/);
  await assert.rejects(host.dispatch({ deviceId: "dev-kim" }, { m: "setMyAvatar", a: ["data:image/gif;base64,AAAA"] }), /JPEG or PNG/);
  assert.deepEqual(host.store.data.team.avatars, { m_sam: png(256) });
  // An owner device sets the owner's; a gadget has none.
  assert.deepEqual(await host.dispatch({ deviceId: "dev-owner" }, { m: "setMyAvatar", a: [jpeg(128)] }), { avatar: jpeg(128) });
  await assert.rejects(host.dispatch({ deviceId: "dev-gadget" }, { m: "setMyAvatar", a: [png(64)] }), /gadget/);
  // Clearing takes away the caller's alone.
  assert.deepEqual(await host.dispatch({ deviceId: "dev-sam" }, { m: "setMyAvatar", a: [null] }), {});
  assert.deepEqual(host.store.data.team.avatars, { owner: jpeg(128) });
  assert.deepEqual(calls, [], "the app on the computer never sees the call");

  // The desktop window sets the owner's (runtime.handlers.setMyAvatar calls this).
  assert.match(readFileSync(new URL("../desktop/runtime.mjs", import.meta.url), "utf8"), /setMyAvatar: \(image\) => \{[^}]*link\.setAvatar\("owner", image \?\? null\)/);
  assert.deepEqual(host.setAvatar("owner", png(256)), { avatar: png(256) });
  assert.equal(host.store.data.team.avatars.owner, png(256));
  // An unchanged picture is not saved or sent again.
  const before = host.teamRev;
  host.setAvatar("owner", png(256));
  assert.equal(host.teamRev, before);

  // It is kept on the host and read back after a restart; a member who leaves takes theirs along.
  await host.dispatch({ deviceId: "dev-kim" }, { m: "setMyAvatar", a: [png(48)] });
  const saved = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
  assert.deepEqual(saved.team.avatars, { owner: png(256), m_kim: png(48) });
  assert.deepEqual(new LinkStore(dir).data.team.avatars, { owner: png(256), m_kim: png(48) });
  host.removeMember("m_kim");
  assert.deepEqual(host.store.data.team.avatars, { owner: png(256) });
});

test("people lists carry each person's picture: the team, the owner's view, a member's view and meta.you", async (t) => {
  const { host } = hostWithTeam(t);
  await host.dispatch({ deviceId: "dev-owner" }, { m: "setMyAvatar", a: [jpeg(256)] });
  await host.dispatch({ deviceId: "dev-sam" }, { m: "setMyAvatar", a: [png(256)] });
  const team = host.store.data.team;
  const people = teamPeople(team, "Colt");
  assert.deepEqual(people, [{ id: "owner", name: "Colt", avatar: jpeg(256) }, { id: "m_sam", name: "Sam", avatar: png(256) }, { id: "m_kim", name: "Kim" }]);
  // The owner's team (the window's state and an owner phone): the picture is in `people` once, not again in `members`.
  const owned = host.team();
  assert.equal(owned.people.find((person) => person.id === "m_sam").avatar, png(256));
  assert.ok(owned.members.every((member) => !("avatar" in member)));
  assert.equal(ownerParts({ meta: { name: "Mac" } }, team).meta.you.avatar, jpeg(256));
  // A member's own view: the people with their pictures, and their own in meta.you.
  const sam = filterParts({ meta: { name: "Mac" }, team: owned }, host.principalOfMember("m_sam"), team);
  assert.equal(sam.meta.you.avatar, png(256));
  assert.equal(sam.team.people.find((person) => person.id === "owner").avatar, jpeg(256));
  const kim = filterParts({ meta: { name: "Mac" }, team: owned }, host.principalOfMember("m_kim"), team);
  assert.equal("avatar" in kim.meta.you, false, "a member with no picture has none in meta.you");
});
