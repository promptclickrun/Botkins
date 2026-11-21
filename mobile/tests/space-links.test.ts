// A space shared by link (docs/spaces.md, "Share by link"): the computer puts a sealed copy on the
// relay, keeps it fresh and takes it back. The relay here is in memory and decides with the real
// relay's own checks (relay/src/shared.ts); no socket is opened to any relay.
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { newRelayKey } from "../link-host/relay.mjs";
import { SEAL_BYTES, sealSpaceCopy, SpaceLinks } from "../link-host/space-links.mjs";
import { shareIdOf } from "../link-host/spaces.mjs";
import { checkSpaceDelete, checkSpacePut, SPACE_ROUTE, spacePutAllowed } from "../relay/src/shared.ts";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { SpaceSummary } from "../src/link/types";
import { FakeRelay } from "./fake-relay";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end && !check(); ) await sleep(10);
  assert.ok(check(), what);
}

/** A relay's space routes, kept in memory. `fail` makes one method answer 503, as a relay that is down would. */
function memoryRelay() {
  const copies = new Map<string, { body: Uint8Array; time: number; expiresAt: number; owner: string }>();
  const gone = new Map<string, number>();
  const asked: { method: string; id: string; status: number; at: number }[] = [];
  const relay = {
    copies,
    asked,
    fail: null as string | null,
    count: (method: string, id?: string) => asked.filter((one) => one.method === method && one.status < 300 && (!id || one.id === id)).length,
    fetch: async (input: unknown, init: any = {}) => {
      const url = new URL(String(input));
      const id = SPACE_ROUTE.exec(url.pathname)?.[1];
      if (!id) return new Response("Not found\n", { status: 404 });
      const method: string = init.method ?? "GET";
      const request = new Request(url, { method, headers: init.headers, ...(init.body && { body: init.body, duplex: "half" }) } as RequestInit);
      let status = 404;
      if (relay.fail === method) status = 503;
      else if (method === "PUT") {
        const checked = await checkSpacePut(request, id);
        if (checked instanceof Response) status = checked.status;
        else if (!spacePutAllowed(copies.get(id)?.time ?? null, gone.get(id) ?? null, checked.time)) status = 409;
        else {
          copies.set(id, checked);
          status = 204;
        }
      } else if (method === "DELETE") {
        const checked = await checkSpaceDelete(request, id);
        if (checked instanceof Response) status = checked.status;
        else if (copies.has(id) && checked.time <= copies.get(id)!.time) status = 409;
        else {
          status = copies.delete(id) ? 204 : 404;
          gone.set(id, Math.max(gone.get(id) ?? 0, checked.time));
        }
      }
      asked.push({ method, id, status, at: Date.now() });
      return new Response(null, { status });
    },
  };
  return relay;
}

/** What a browser with the link does: the copy under the link's id, opened with the link's key. */
function open(relay: ReturnType<typeof memoryRelay>, link: string) {
  const { id, key } = parse(link);
  const body = Buffer.from(relay.copies.get(id)!.body);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), body.subarray(0, 12));
  decipher.setAAD(Buffer.from("botkins-space-v1:" + id));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()])).toString("utf8"));
}
const parse = (link: string) => {
  const match = /^https:\/\/relay\.test\/s\/([A-Za-z0-9_-]{22})#k=([A-Za-z0-9_-]{43})$/.exec(link);
  assert.ok(match, "a link is the relay's address, the id and the key in the fragment");
  return { id: match[1]!, key: match[2]! };
};

/** The demo computer with a relay, and the owner's phone. */
async function computer(relay: ReturnType<typeof memoryRelay>, dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-space-links-")))) {
  if (!folders.includes(dir)) folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: { url: "https://relay.test", WebSocket: new FakeRelay().WebSocket }, fetch: relay.fetch, spaceLinkTiming: { gap: 300, retry: [40, 40] } });
  await link.setEnabled(true);
  link.setRelay({ enabled: true });
  return { link, backend, dir };
}
async function phone(link: any) {
  const parts: Record<string, any> = {};
  const client = new LinkClient(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" }), { fetch: real, onState() {}, onParts: (next) => void Object.assign(parts, next) });
  client.start();
  const space = (name: string) => (parts.spaces as SpaceSummary[] | undefined)?.find((one) => one.name === name);
  return { client, parts, space, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args) };
}

test("a space shared by link is put on the relay sealed, follows the space, and is taken back", async () => {
  const relay = memoryRelay();
  const { link, backend } = await computer(relay);
  const owner = await phone(link);
  try {
    await until(() => owner.space("Launch"), "the owner is sent spaces");
    const launch = owner.space("Launch")!;
    const { link: address } = await owner.call<{ link: string }>("link.spaces.share", launch.id, { access: "link" });
    const first = parse(address);
    assert.equal(first.id, shareIdOf(link.store.relayKey().publicKey, link.store.data.team.spaces[launch.id].share.salt), "the id is the relay key's and the salt's");
    await until(() => relay.copies.has(first.id), "the copy is on the relay");
    await until(() => owner.space("Launch")?.link === address, "its maker is sent the link");
    assert.equal(owner.space("Launch")!.linkState, undefined);

    // What an app that runs apart from the link is told of the team: how the space is shared, never the link's key.
    const told = link.teamForApp();
    assert.deepEqual(told.spaces[launch.id], { access: "link", grants: [], teamCan: "view" });
    assert.ok(!JSON.stringify(told).includes(first.key) && !JSON.stringify(told).includes(first.id));
    assert.deepEqual(Object.keys(told).sort(), ["chats", "groups", "members", "name", "owner", "roles", "spaces"]);

    // What anyone with the link reads: the panels and what they say, and nothing that names anything on the computer.
    const copy = open(relay, address);
    assert.deepEqual([copy.v, copy.name, copy.kind], [1, "Launch", "panels"]);
    assert.deepEqual(copy.panels.map((panel: any) => panel.title), ["Launch checklist", "Signups"]);
    const app = copy.panels[0].blocks.find((block: any) => block.type === "html");
    assert.ok(app.page.includes("botkins") && Array.isArray(app.data.items), "an app panel's own page and data go with it");
    assert.equal(app.frame, undefined);
    assert.deepEqual(copy.panels[0].state, { ticked: { "Pricing page copy": true, "Press kit": true } });
    const text = JSON.stringify(copy);
    const panels = backend.state.panels.filter((panel: any) => panel.spaceId === launch.id);
    for (const secret of [launch.id, link.store.data.serverId, ...panels.flatMap((panel: any) => [panel.id, panel.chatId, panel.botId]), ...backend.state.chats.map((chat: any) => chat.id), "Changelog needs one more pass"]) {
      assert.ok(!secret || !text.includes(secret), "a copy names nothing on the computer: " + secret);
    }
    for (const field of ["notes", "last", "chatId", "botId", "projectId", "routine", "createdBy", "id"]) assert.ok(!text.includes('"' + field + '"'), field);
    // The relay holds bytes it cannot read.
    assert.ok(!Buffer.from(relay.copies.get(first.id)!.body).toString("latin1").includes("Launch"));

    // The space changes: its copy follows, but not sooner than the gap after the last one.
    const putAt = relay.asked.find((one) => one.method === "PUT" && one.id === first.id)!.at;
    await owner.call("spaces.patchState", panels[0].id, { ticked: { "Press kit": true } }, "Unticked Pricing page copy");
    await until(() => relay.count("PUT", first.id) === 2, "the changed space is put out again");
    assert.ok(relay.asked.filter((one) => one.method === "PUT").at(-1)!.at - putAt >= 290, "not before the gap");
    assert.deepEqual(open(relay, address).panels[0].state, { ticked: { "Press kit": true } });
    await sleep(400);
    assert.equal(relay.count("PUT", first.id), 2, "an unchanged space is left alone");

    // A new link while the relay can't be reached to take the old one back: the sheet says so until it is gone.
    relay.fail = "DELETE";
    const { link: second } = await owner.call<{ link: string }>("link.spaces.newLink", launch.id);
    assert.notEqual(parse(second).id, first.id);
    assert.notEqual(parse(second).key, first.key);
    await until(() => relay.copies.has(parse(second).id), "the new link's copy is out");
    await until(() => owner.space("Launch")?.linkState === "leaving", "the old link is still being taken back");
    assert.equal(owner.space("Launch")!.link, second);
    assert.ok(relay.copies.has(first.id));
    relay.fail = null;
    await until(() => !relay.copies.has(first.id), "it is tried again until the relay says it is gone");
    await until(() => owner.space("Launch")?.linkState === undefined, "and then the sheet stops saying so");
    assert.deepEqual(link.store.data.team.spaceCopies, []);

    // The relay is switched off: the copy leaves it, the space keeps its level and has no link.
    link.setRelay({ enabled: false });
    await until(() => !relay.copies.has(parse(second).id), "the copy left the relay");
    await until(() => owner.space("Launch")?.linkState === "off" && !owner.space("Launch")?.link, "links are off");
    assert.equal(owner.space("Launch")!.access, "link");
    await assert.rejects(owner.call("link.spaces.share", owner.space("Money")!.id, { access: "link" }), /Turn on the relay on your computer to share by link\./);
    link.setRelay({ enabled: true });
    await until(() => relay.copies.has(parse(second).id), "back on: the same link is out again");
    await until(() => owner.space("Launch")?.link === second && !owner.space("Launch")?.linkState, "and its maker has it again");
    assert.deepEqual(link.store.data.team.spaceCopies, [], "the old take-back does not remove the new copy");

    // A new relay key: a link's id belongs to the key, so the link is a new one and the old copy is taken back with the old key.
    link.resetRelay();
    await until(() => owner.space("Launch")?.link && owner.space("Launch")!.link !== second, "a new link");
    const third = owner.space("Launch")!.link!;
    await until(() => relay.copies.has(parse(third).id) && !relay.copies.has(parse(second).id), "the new copy is out and the old one is gone");
    assert.equal(open(relay, third).name, "Launch");
    await until(() => link.store.data.team.spaceCopies.length === 0, "the old key is kept no longer than it is needed");

    // No longer shared by link: the copy is taken back.
    assert.deepEqual(await owner.call("link.spaces.share", launch.id, { access: "private" }), {});
    await until(() => !relay.copies.has(parse(third).id), "the copy is gone");
    assert.equal(link.store.data.team.spaces[launch.id], undefined);

    // A space that is deleted takes its copy along.
    const tripId = await owner.call<string>("spaces.create", { name: "Trip" });
    const trip = parse((await owner.call<{ link: string }>("link.spaces.share", tripId, { access: "link" })).link);
    await until(() => relay.copies.has(trip.id), "Trip is out");
    await owner.call("spaces.remove", tripId);
    await until(() => !relay.copies.has(trip.id), "and gone with its space");
    assert.equal(relay.copies.size, 0);
  } finally {
    owner.client.stop();
    await link.stop();
  }
});

test("a copy that could not be taken back is taken back at the next start", async () => {
  const relay = memoryRelay();
  const first = await computer(relay);
  const owner = await phone(first.link);
  let shareId = "";
  try {
    await until(() => owner.space("Launch"), "the owner is sent spaces");
    const launch = owner.space("Launch")!;
    shareId = parse((await owner.call<{ link: string }>("link.spaces.share", launch.id, { access: "link" })).link).id;
    await until(() => relay.copies.has(shareId), "the copy is out");
    relay.fail = "DELETE";
    await owner.call("link.spaces.share", launch.id, { access: "private" });
    await until(() => relay.asked.some((one) => one.method === "DELETE" && one.status === 503), "the relay did not take it");
  } finally {
    owner.client.stop();
    await first.link.stop();
  }
  assert.ok(relay.copies.has(shareId), "it is still out");
  assert.equal(first.link.store.data.team.spaceCopies.length, 1, "and still owed");
  relay.fail = null;
  const second = await computer(relay, first.dir);
  try {
    await until(() => !relay.copies.has(shareId), "the next start takes it back");
    await until(() => second.link.store.data.team.spaceCopies.length === 0, "and it is owed no longer");
  } finally {
    await second.link.stop();
  }
});

test("the publisher: a copy too large is not sent, and a copy nobody can take back is let go", async () => {
  const key = newRelayKey();
  const share = { id: shareIdOf(key.publicKey, "s".repeat(22)), salt: "s".repeat(22), key: Buffer.alloc(32, 7).toString("base64url"), createdAt: 1 };
  // The seal adds a nonce and a tag to the gzip, and nothing else.
  const sealed = sealSpaceCopy({ v: 1, name: "x" }, share);
  assert.equal(sealed.length - SEAL_BYTES, gzipSync(Buffer.from(JSON.stringify({ v: 1, name: "x" }))).length);

  const asked: string[] = [];
  let team: any = {
    spaces: { s_big: { access: "link", grants: [], teamCan: "view", share } },
    spaceCopies: [
      { id: "ended-by-itself-000000", salt: "a".repeat(22), relay: "https://relay.test", until: Date.now() - 1 },
      { id: "another-computers-0000", salt: "b".repeat(22), relay: "https://relay.test" },
    ],
  };
  const links = new SpaceLinks({
    team: () => team,
    setTeam: (next: any) => void (team = next),
    records: () => [{ id: "s_big", rev: 1 }],
    relay: () => ({ on: true, base: "https://relay.test", key }),
    snapshot: () => ({ v: 1, blob: Array.from({ length: 4000 }, () => Math.random().toString(36)).join("") }),
    newShare: () => share,
    fetch: async (url: unknown, init: any) => {
      asked.push(init.method + " " + new URL(String(url)).pathname.split("/").pop());
      return new Response(null, { status: init.method === "DELETE" ? 403 : 204 });
    },
    timing: { max: 1000, retry: [10_000] },
  });
  links.sync();
  await until(() => team.spaceCopies.length === 0, "both copies are let go");
  links.stop();
  // The one that ended by itself needed no request; the one the relay says is not this key's got one.
  assert.deepEqual(asked, ["DELETE another-computers-0000"]);
  assert.equal(team.spaces.s_big.share.putAt, undefined, "a copy over the relay's size was never sent");
});
