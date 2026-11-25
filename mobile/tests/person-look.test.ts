// People's looks in a chat ("people-avatars-v1"): the accent color each keeps, their initial, which
// pictures are drawn, the photo made into a picture that fits the limit, and the demo computer's
// `setMyAvatar` for the owner and a member.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAvatarImage, MockBackend } from "../link-host/mock-backend.mjs";
import { teamPeople } from "../link-host/team.mjs";
import { accentOf, AVATAR_MAX_BASE64, AVATAR_PREFIX, hashId, initialOf, isAvatar, PERSON_ACCENTS, peopleLooks, personColor } from "../src/features/chat/personLook";
import { AVATAR_QUALITIES, AvatarError, type Manipulator, makeAvatar, middleSquare } from "../src/features/profile/avatarImage";

test("a person's color is the desktop app's: 32-bit FNV-1a of the id, modulo 6, into the same six colors", () => {
  assert.equal(PERSON_ACCENTS.length, 6);
  // The fixed values the desktop app asserts too.
  assert.equal(personColor("owner"), 0);
  assert.equal(personColor("m_sam"), 4);
  assert.equal(personColor("m_kim"), 2);
  // desktop/src/people.css, .person-color-0 and .person-color-4, light and dark.
  assert.equal(accentOf("owner", false), "#2F6BD8");
  assert.equal(accentOf("owner", true), "#7EAAFF");
  assert.equal(accentOf("m_sam", false), "#C23B78");
  assert.equal(accentOf("m_sam", true), "#F483B6");
});

test("a person's accent is stable, from their id, and has a light and a dark shade", () => {
  assert.equal(accentOf("m_ana", false), accentOf("m_ana", false));
  assert.equal(hashId("m_ana"), hashId("m_ana"));
  const index = hashId("m_ana") % PERSON_ACCENTS.length;
  assert.equal(accentOf("m_ana", false), PERSON_ACCENTS[index]!.light);
  assert.equal(accentOf("m_ana", true), PERSON_ACCENTS[index]!.dark);
  // Ids spread over the palette, and every color is a plain hex the theme's tint can use.
  const used = new Set(["owner", "m_ana", "m_ben", "m_cy", "m_dee", "m_eli", "m_fay", "m_gus", "m_hal", "m_ivy"].map((id) => accentOf(id, false)));
  assert.ok(used.size >= 4);
  for (const pair of PERSON_ACCENTS) {
    assert.match(pair.light, /^#[0-9A-F]{6}$/);
    assert.match(pair.dark, /^#[0-9A-F]{6}$/);
    assert.notEqual(pair.light, pair.dark);
  }
  // No id still has one.
  assert.equal(accentOf("", false), accentOf("owner", false));
});

test("a badge's initial", () => {
  assert.equal(initialOf("ana"), "A");
  assert.equal(initialOf("  ben okafor"), "B");
  assert.equal(initialOf("Émile"), "É");
  assert.equal(initialOf(""), "?");
  assert.equal(initialOf(undefined), "?");
});

test("only a JPEG or PNG data URL within the limit is drawn; the owner without one shows their profile emoji", () => {
  const small = AVATAR_PREFIX + "QUJD";
  assert.ok(isAvatar(small));
  assert.ok(isAvatar("data:image/png;base64,QUJD"));
  assert.equal(isAvatar(AVATAR_PREFIX + "A".repeat(AVATAR_MAX_BASE64 + 4)), false);
  assert.equal(isAvatar("https://example.com/me.jpg"), false);
  assert.equal(isAvatar("data:image/svg+xml;base64,QUJD"), false);
  assert.equal(isAvatar(undefined), false);
  const looks = peopleLooks([{ id: "owner", name: "Studio" }, { id: "m_ana", name: "Ana", avatar: small }, { id: "m_ben", name: "Ben", avatar: "nope" }], "🦊");
  assert.deepEqual(looks.get("owner"), { id: "owner", name: "Studio", emoji: "🦊" });
  assert.deepEqual(looks.get("m_ana"), { id: "m_ana", name: "Ana", avatar: small });
  assert.deepEqual(looks.get("m_ben"), { id: "m_ben", name: "Ben" });
  // A picture wins over the emoji.
  assert.deepEqual(peopleLooks([{ id: "owner", name: "Studio", avatar: small }], "🦊").get("owner"), { id: "owner", name: "Studio", avatar: small });
});

/** A stand-in image library: it records what was asked and answers base64 of a size per quality. */
function fakeManipulator(sizeAt: (compress: number) => number) {
  const calls: { op: string; value: unknown }[] = [];
  const context = {
    crop: (rect: unknown) => (calls.push({ op: "crop", value: rect }), context),
    resize: (size: unknown) => (calls.push({ op: "resize", value: size }), context),
    renderAsync: async () => ({
      saveAsync: async (options: { format?: unknown; compress?: number; base64?: boolean }) => {
        calls.push({ op: "save", value: options });
        return { base64: "A".repeat(sizeAt(options.compress ?? 1)) };
      },
    }),
  };
  const manipulator: Manipulator = { ImageManipulator: { manipulate: (uri) => (calls.push({ op: "open", value: uri }), context) }, SaveFormat: { JPEG: "jpeg" } };
  return { manipulator, calls };
}

test("a photo is cut to its middle square, made 256 px and saved as JPEG at 0.85, as a data URL", async () => {
  const { manipulator, calls } = fakeManipulator(() => 30_000);
  const image = await makeAvatar(manipulator, "file:///photo.jpg", 4032, 3024);
  assert.ok(image.startsWith(AVATAR_PREFIX));
  assert.ok(image.length - AVATAR_PREFIX.length <= AVATAR_MAX_BASE64);
  assert.ok(isAvatar(image));
  assert.deepEqual(calls, [
    { op: "open", value: "file:///photo.jpg" },
    { op: "crop", value: { originX: 504, originY: 0, width: 3024, height: 3024 } },
    { op: "resize", value: { width: 256, height: 256 } },
    { op: "save", value: { format: "jpeg", compress: 0.85, base64: true } },
  ]);
  assert.deepEqual(middleSquare(300, 500), { originX: 0, originY: 100, width: 300, height: 300 });
});

test("a picture over 96 KB is saved again at lower quality, and refused when it never fits", async () => {
  const { manipulator, calls } = fakeManipulator((compress) => (compress > 0.6 ? AVATAR_MAX_BASE64 + 1 : AVATAR_MAX_BASE64));
  const image = await makeAvatar(manipulator, "file:///busy.jpg", 256, 256);
  assert.equal(image.length - AVATAR_PREFIX.length, AVATAR_MAX_BASE64);
  assert.deepEqual(calls.filter((call) => call.op === "save").map((call) => (call.value as { compress: number }).compress), [0.85, 0.7, 0.55]);
  const never = fakeManipulator(() => AVATAR_MAX_BASE64 + 1);
  await assert.rejects(makeAvatar(never.manipulator, "file:///noise.jpg", 256, 256), AvatarError);
  assert.equal(never.calls.filter((call) => call.op === "save").length, AVATAR_QUALITIES.length);
  await assert.rejects(makeAvatar(never.manipulator, "file:///none.jpg", 0, 0), AvatarError);
  await assert.rejects(makeAvatar(fakeManipulator(() => 0).manipulator, "file:///empty.jpg", 10, 10), AvatarError);
});

test("the demo computer keeps each caller's own picture on the team's people, and clears it", async () => {
  const backend = new MockBackend();
  assert.ok(backend.capabilities.includes("people-avatars-v1"));
  const team = { members: [{ id: "m_ana", name: "Ana", groupId: "g_everyone", joinedAt: 0, deviceIds: [] }] } as { members: { id: string; name: string }[]; avatars?: Record<string, string> };
  let told = 0;
  Object.assign(backend, { teamOf: () => team, onTeamChanged: () => told++ });
  const picture = AVATAR_PREFIX + "QUJD";
  assert.deepEqual(await backend.call("setMyAvatar", [picture], { principal: { kind: "owner" } }), { avatar: picture });
  assert.deepEqual(await backend.call("setMyAvatar", [picture], { principal: { kind: "member", memberId: "m_ana", name: "Ana" } }), { avatar: picture });
  assert.deepEqual(teamPeople(team, "Studio"), [
    { id: "owner", name: "Studio", avatar: picture },
    { id: "m_ana", name: "Ana", avatar: picture },
  ]);
  // A member clears only their own.
  assert.deepEqual(await backend.call("setMyAvatar", [null], { principal: { kind: "member", memberId: "m_ana", name: "Ana" } }), {});
  assert.deepEqual(teamPeople(team, "Studio"), [{ id: "owner", name: "Studio", avatar: picture }, { id: "m_ana", name: "Ana" }]);
  assert.equal(told, 3);
  // Kept by person id, as the link keeps them; the members' entries don't repeat them.
  assert.deepEqual(team.avatars, { owner: picture });
  assert.equal("avatar" in team.members[0]!, false);
  // It takes no person: an extra argument is refused, and so is anything but a picture within the limit.
  await assert.rejects(backend.call("setMyAvatar", [picture, "m_ana"], { principal: { kind: "owner" } }));
  await assert.rejects(backend.call("setMyAvatar", ["https://example.com/me.jpg"], { principal: { kind: "owner" } }));
  await assert.rejects(backend.call("setMyAvatar", [AVATAR_PREFIX + "A".repeat(AVATAR_MAX_BASE64 + 4)], { principal: { kind: "owner" } }));
  assert.equal(isAvatarImage(picture), true);
  // The demo's group chat has two members' messages and @mentions.
  const chat = backend.state.chats.find((item: { id: string }) => item.id === "chat-team");
  assert.ok(chat.messages.some((message: { author?: { memberId: string } }) => message.author?.memberId === "m_ana"));
  assert.ok(chat.messages.some((message: { author?: { memberId: string } }) => message.author?.memberId === "m_ben"));
});
