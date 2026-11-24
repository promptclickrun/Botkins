import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { checkJoin, type FetchLike, LinkClient, pair, startJoin } from "../src/link/client";
import { chatMentionPeople, formatTypingLabel } from "../src/features/chat/people";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

test("chatMentionPeople lists other chat participants excluding self", () => {
  const people = [
    { id: "owner", name: "Colt Coan" },
    { id: "m_j", name: "Jordan" },
    { id: "m_a", name: "Alex" },
  ];
  const chat = { createdBy: "owner", invited: ["m_j"] };

  assert.deepEqual(chatMentionPeople(people, chat, "owner"), [{ id: "m_j", name: "Jordan", subtitle: "Member" }]);
  assert.deepEqual(chatMentionPeople(people, chat, "m_j"), [{ id: "owner", name: "Colt Coan", subtitle: "Owner" }]);
  // Solo chat returns no one
  assert.deepEqual(chatMentionPeople(people, { createdBy: "owner", invited: [] }, "owner"), []);
});

test("formatTypingLabel excludes self, deduplicates ids, and formats 1, 2, and 3+ typers", () => {
  assert.equal(formatTypingLabel([], "owner"), null);
  assert.equal(formatTypingLabel([{ id: "owner", name: "Colt" }], "owner"), null);
  assert.equal(
    formatTypingLabel(
      [
        { id: "m_j", name: "Jordan" },
        { id: "m_j", name: "Jordan" },
        { id: "owner", name: "Colt" },
      ],
      "owner",
    ),
    "Jordan is typing",
  );
  assert.equal(
    formatTypingLabel(
      [
        { id: "m_j", name: "Jordan" },
        { id: "m_a", name: "Alex" },
      ],
      "owner",
    ),
    "Jordan and Alex are typing",
  );
  assert.equal(
    formatTypingLabel(
      [
        { id: "m_j", name: "Jordan" },
        { id: "m_a", name: "Alex" },
        { id: "m_b", name: "Ben" },
      ],
      "owner",
    ),
    "Jordan, Alex, and 1 other are typing",
  );
  assert.equal(
    formatTypingLabel(
      [
        { id: "m_j", name: "Jordan" },
        { id: "m_a", name: "Alex" },
        { id: "m_b", name: "Ben" },
        { id: "m_c", name: "Cara" },
      ],
      "owner",
    ),
    "Jordan, Alex, and 2 others are typing",
  );
});

test("chat-typing-v1 syncs typing over LinkHost and respects chat privacy", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-typing-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
  link.setName("Studio");

  const clients: LinkClient[] = [];
  const follow = (pairing: any) => {
    const parts: Record<string, any> = {};
    const client = new LinkClient(pairing, { fetch: real, onState() {}, onParts: (next) => void Object.assign(parts, next) });
    clients.push(client);
    client.start();
    const until = async (check: () => unknown, what: string) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(check(), what);
    };
    return { client, parts, until, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args) };
  };

  try {
    assert.ok(link.meta().capabilities.includes("chat-typing-v1"));

    const owner = follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Colt Phone", platform: "ios" }));
    const guest = structuredClone(link.store.data.team.roles.find((item: any) => item.id === "r_guest"));
    guest.bots = "all";
    await owner.call("link.team.saveRole", guest);

    const joinMember = async (name: string) => {
      const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_everyone", days: 7, maxUses: 1 });
      const target = {
        hosts: ["127.0.0.1:" + link.port],
        code: invite.code,
        serverId: link.status().serverId,
        serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"),
        name: link.status().name,
      };
      const started = await startJoin(real, target, { name, platform: "ios", kind: "phone" });
      if (started.result.status !== "pending") throw new Error("not pending");
      await owner.call("link.team.approve", started.result.requestId);
      const checked = await checkJoin(real, started.attempt);
      if (checked.status !== "approved") throw new Error("not approved");
      return follow(checked.pairing);
    };

    const jordan = await joinMember("Jordan");
    const sam = await joinMember("Sam");
    await owner.until(() => Array.isArray(owner.parts.chats) && owner.parts.chats.length > 0, "owner sees chats");
    await jordan.until(() => jordan.parts.meta?.you?.kind === "member", "Jordan synced");
    await sam.until(() => sam.parts.meta?.you?.kind === "member", "Sam synced");

    const chatId = owner.parts.chats[0].id as string;
    const jordanId = jordan.parts.meta.you.memberId as string;
    await owner.call("link.team.inviteToChat", chatId, jordanId);
    await jordan.until(() => jordan.parts.chats?.some((c: any) => c.id === chatId), "Jordan sees shared chat");

    // Jordan starts typing -> owner sees Jordan in live.typing[chatId], Sam does not
    await jordan.call("link.chat.typing", chatId, true);
    await owner.until(() => owner.parts.live?.typing?.[chatId]?.length === 1, "owner sees Jordan typing");
    assert.deepEqual(owner.parts.live.typing[chatId], [{ id: jordanId, name: "Jordan" }]);
    assert.equal(sam.parts.live?.typing?.[chatId], undefined);

    // Sam cannot emit typing into a chat they're not part of
    await assert.rejects(() => sam.call("link.chat.typing", chatId, true), /belongs to/i);

    // Jordan stops typing -> cleared for owner
    await jordan.call("link.chat.typing", chatId, false);
    await owner.until(() => !owner.parts.live?.typing?.[chatId], "owner sees typing cleared");

    // Sending a message also clears typing automatically
    await jordan.call("link.chat.typing", chatId, true);
    await owner.until(() => owner.parts.live?.typing?.[chatId]?.length === 1, "owner sees Jordan typing again");
    await jordan.call("send", chatId, "Hello @Studio", {});
    await owner.until(() => !owner.parts.live?.typing?.[chatId], "send clears typing");
  } finally {
    clients.forEach((client) => client.stop());
    await link.stop();
  }
});
