// Alerts about spaces ("space-alerts-v1"; docs/spaces.md, "Notifications") on the computer's side
// (link-host/space-alerts.mjs): the words, who is told of a note and of a change, the ten minutes
// between two "Every change" alerts, and the once-a-day alert. With a real LinkHost, an owner's
// phone and two members' phones, and a stand-in for the relay's push route: nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { cleanSpaceEvent, digestAlert, eventAlert, SPACE_ALERTS, spaceName } from "../link-host/space-alerts.mjs";
import { OWNER, spaceNews } from "../link-host/team.mjs";
import { spaceRoute } from "../src/features/spaces/logic";
import { checkJoin, type FetchLike, LinkClient, pair, type Pairing, startJoin } from "../src/link/client";
import { agree, fromUtf8, hkdf, open, unb64u, utf8 } from "../src/link/crypto";
import type { SpaceContent, SpaceSummary } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const launch = { id: "s1", name: "Launch", mine: true, by: { id: "owner", name: "Alex Kim" } };

test("the words of a note, a change and the once-a-day alert", () => {
  // Another person's built-in space says whose it is.
  assert.equal(spaceName(launch), "Launch");
  assert.equal(spaceName({ name: "Today", builtin: "today", mine: false, by: { id: "m1", name: "Maya Chen" } }), "Maya's Today");
  // A note: who and where, then the note's first line with no Markdown marks.
  assert.deepEqual(eventAlert({ kind: "note", text: "**Macros** are done.\nMore below." }, launch, "Maya Chen"), { t: "Maya in Launch", m: "Macros are done." });
  // A change: the page's own words with a capital, else the panel's title.
  assert.deepEqual(eventAlert({ kind: "change", label: "ticked Press kit" }, launch, "Maya Chen", "Launch checklist"), { t: "Maya in Launch", m: "Ticked Press kit" });
  assert.deepEqual(eventAlert({ kind: "change" }, launch, "Maya Chen", "Launch checklist"), { t: "Maya in Launch", m: "Changed Launch checklist" });
  assert.deepEqual(eventAlert({ kind: "change" }, launch, "", undefined), { t: "Someone in Launch", m: "Changed a panel." });
  // With previews off, what was written stays out; who and where stay.
  assert.deepEqual(eventAlert({ kind: "note", text: "The password is on my desk." }, launch, "Maya Chen", undefined, false), { t: "Maya in Launch", m: "Wrote a note." });
  assert.deepEqual(eventAlert({ kind: "change", label: "Ticked Press kit" }, launch, "Maya Chen", "Launch checklist", false), { t: "Maya in Launch", m: "Changed a panel." });

  // Once a day. One space: its name, how many changed and which.
  assert.deepEqual(digestAlert([{ space: launch, titles: ["Signups", "Launch checklist", "Runway"], total: 3 }]), { t: "Launch", m: "3 panels changed overnight: Signups, Launch checklist and 1 more." });
  assert.deepEqual(digestAlert([{ space: launch, titles: ["Signups"], total: 1 }]), { t: "Launch", m: "1 panel changed overnight: Signups." });
  assert.deepEqual(digestAlert([{ space: { ...launch, name: "Feed", builtin: "feed" }, titles: ["A", "B"], total: 2, cards: true }]), { t: "Feed", m: "2 cards changed overnight: A and B." });
  assert.deepEqual(digestAlert([{ space: launch, titles: [], total: 2 }]), { t: "Launch", m: "2 panels changed overnight." });
  // Several spaces: their names.
  const money = { ...launch, id: "s2", name: "Money" };
  assert.deepEqual(digestAlert([{ space: launch, titles: ["a"] }, { space: money, titles: ["b"] }]), { t: "Spaces", m: "Launch and Money changed overnight." });
  assert.deepEqual(digestAlert([{ space: launch, titles: ["a"] }, { space: money, titles: ["b"] }, { space: { ...launch, name: "Trip" }, titles: ["c"] }, { space: { ...launch, name: "Home" }, titles: ["d"] }]), { t: "Spaces", m: "Launch, Money and 2 more changed overnight." });
  assert.deepEqual(digestAlert([{ space: launch, titles: ["Signups"], total: 1 }], false), { t: "Launch", m: "1 panel changed overnight." });
  assert.deepEqual(digestAlert([{ space: launch, titles: ["a"] }, { space: money, titles: ["b"] }], false), { t: "Spaces", m: "2 spaces changed overnight." });
  assert.equal(digestAlert([]), null);
});

test("the day's news for a person: what changed since they last looked or since the last alert, never their own change", () => {
  const role = { id: "r", name: "R", perms: { agents: ["view", "chat"], today: ["view", "use", "create", "manage", "delete"], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["mira"] };
  const made = (views: Record<string, unknown> = {}) => ({ roles: [role], groups: [{ id: "g", name: "G", roleId: "r" }], members: [{ id: "m_a", name: "Ana", groupId: "g" }], chats: {}, views, spaces: { s_launch: { access: "team", teamCan: "edit" }, s_money: { access: "team", teamCan: "view" } }, linkSharing: false });
  const records = [
    { id: "s_launch", name: "Launch", createdAt: 1, updatedAt: 1, rev: 1, items: [{ id: "p1", botId: "mira", updatedAt: 500 }, { id: "p2", botId: "mira", updatedAt: 900, by: "m_a" }, { id: "p3", botId: "patch", updatedAt: 950 }, { id: "p4", botId: "mira", updatedAt: 100 }] },
    { id: "s_money", name: "Money", createdAt: 2, updatedAt: 2, rev: 1, items: [{ id: "p5", botId: "mira", updatedAt: 800 }] },
  ];
  const context = { role, names: new Map([[OWNER, "Alex"], ["m_a", "Ana"]]) };
  const news = (views: Record<string, unknown>, since: number, person = "m_a") => (spaceNews(made(views), records, person, person === OWNER ? { names: context.names } : context, since) as { space: { id: string }; items: string[] }[]).map((one) => [one.space.id, one.items]);
  const notify = { s_launch: "daily", s_money: "all" };
  // Since the last alert (300): what changed after it, but her own change (p2) and a bot her role can't see (p3).
  assert.deepEqual(news({ m_a: { spaces: { notify } } }, 300), [["s_launch", ["p1"]], ["s_money", ["p5"]]]);
  // She opened Launch at 600, after p1 changed: it is no news to her.
  assert.deepEqual(news({ m_a: { spaces: { notify, seen: { s_launch: 600 } } } }, 300), [["s_money", ["p5"]]]);
  // Nothing changed since the last alert at 950.
  assert.deepEqual(news({ m_a: { spaces: { notify } } }, 950), []);
  // A space shared with all members is Off for her until she chooses: nothing about it.
  assert.deepEqual(news({}, 0), []);
  assert.deepEqual(news({ m_a: { spaces: { notify: { s_money: "daily" } } } }, 0), [["s_money", ["p5"]]]);
  // The owner made both: "Once a day" by default, every bot, and Ana's change is news to the owner.
  assert.deepEqual(news({}, 300, OWNER), [["s_launch", ["p1", "p2", "p3"]], ["s_money", ["p5"]]]);
});

test("what the app may say happened is cut to its shape", () => {
  assert.deepEqual(cleanSpaceEvent({ spaceId: "s1", panelId: "p1", by: "m1", kind: "note", text: "hi", label: "x", extra: 1 }), { spaceId: "s1", by: "m1", kind: "note", panelId: "p1", text: "hi", label: "x" });
  assert.deepEqual(cleanSpaceEvent({ spaceId: "s1", by: "owner", kind: "change", label: "  Ticked   Press kit  " }), { spaceId: "s1", by: "owner", kind: "change", label: "Ticked Press kit" });
  assert.equal(cleanSpaceEvent({ spaceId: "s1", by: "owner", kind: "change", label: "x".repeat(200) })!.label!.length, SPACE_ALERTS.label);
  for (const bad of [null, "note", {}, { spaceId: "s1", kind: "note" }, { spaceId: "s1", by: "m1", kind: "deleted" }, { spaceId: "", by: "m1", kind: "note" }, { spaceId: "a\0b", by: "m1", kind: "note" }]) assert.equal(cleanSpaceEvent(bad), null, JSON.stringify(bad));
});

test("where a tapped alert opens: the panel, the space, or the list", () => {
  assert.equal(spaceRoute("s 1", "p/2"), "/space/panel?spaceId=s%201&id=p%2F2");
  assert.equal(spaceRoute("s 1"), "/space/s%201");
  assert.equal(spaceRoute(), "/spaces");
});

type Sent = { token: string; payload: any };

/** The demo computer with an owner's phone and two members' phones, each with notifications on, and a relay that only records. */
async function team() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-space-alerts-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const sent: Sent[] = [];
  const relay = (async (_url: string, init: any) => {
    const items = JSON.parse(JSON.parse(init.body).sends) as Sent[];
    sent.push(...items);
    return new Response(JSON.stringify({ results: items.map(() => ({ status: 200 })) }), { status: 200 });
  }) as unknown as typeof fetch;
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false, fetch: relay });
  (link as any).relayUrl = () => "https://relay.test";
  // The app says what a person did in a space, as dev-host.mjs wires the demo.
  (backend as any).onSpaceEvent = (event: unknown) => link.spaceEvent(event);
  await link.setEnabled(true);
  link.setName("Studio");
  const clients: LinkClient[] = [];
  let phones = 0;
  const follow = async (pairing: Pairing) => {
    const parts: Record<string, any> = {};
    const client = new LinkClient(pairing, { fetch: real, onState() {}, onParts: (next) => void Object.assign(parts, next) });
    clients.push(client);
    client.start();
    const until = async (check: () => unknown, what: string) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(check(), what);
    };
    const token = (++phones).toString(16).padStart(2, "0").repeat(32);
    const call = <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args);
    await call("link.push.register", { token, env: "production" });
    const space = (name: string) => (parts.spaces as SpaceSummary[] | undefined)?.find((one) => one.name === name);
    /** The alerts this phone was sent since the last look, opened the way its notification extension opens them. */
    const alerts = () => {
      const deviceKey = hkdf(agree(unb64u(pairing.secretKey), unb64u(pairing.serverKey)), utf8(pairing.deviceId), "botkins/device/v1");
      const key = hkdf(deviceKey, utf8(pairing.deviceId), "botkins/push/v1");
      const mine = sent.filter((item) => item.token === token && item.payload?.b);
      for (const item of mine) sent.splice(sent.indexOf(item), 1);
      return mine.map((item) => {
        const bytes = new Uint8Array(Buffer.from(item.payload.b, "base64"));
        return { ...JSON.parse(fromUtf8(open(key, bytes.subarray(0, 12), bytes.subarray(12), "botkins-push-v1"))), shown: item.payload.aps.alert.body } as Record<string, string>;
      });
    };
    return { client, parts, until, space, call, alerts, id: pairing.deviceId };
  };
  const owner = await follow(await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" }));
  const collab = structuredClone(link.store.data.team.roles.find((one: any) => one.id === "r_collab"));
  collab.bots = "all";
  await owner.call("link.team.saveRole", collab);
  await owner.call("link.team.saveGroup", { id: "g_makers", name: "Makers", roleId: "r_collab" });
  const join_ = async (name: string) => {
    const invite = await owner.call<any>("link.team.createInvite", { groupId: "g_makers", days: 7, maxUses: 1 });
    const target = { hosts: ["127.0.0.1:" + link.port], code: invite.code, serverId: link.status().serverId, serverKey: Buffer.from(link.store.data.keys.publicKey).toString("base64url"), name: link.status().name };
    const started = await startJoin(real, target, { name, platform: "ios", kind: "phone" });
    if (started.result.status !== "pending") throw new Error("not pending");
    await owner.call("link.team.approve", started.result.requestId);
    const checked = await checkJoin(real, started.attempt);
    if (checked.status !== "approved") throw new Error("not approved");
    return follow(checked.pairing);
  };
  /** Waits for the sends that are on their way, then says nothing else is. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  return { link, backend, owner, join: join_, sent, settle, stop: async () => (clients.forEach((client) => client.stop()), await link.stop()) };
}

test("a note and a change reach the people who want to hear of them, sealed, and nobody else", async () => {
  const { link, backend, owner, join, sent, settle, stop } = await team();
  try {
    const ana = await join("Ana");
    const ben = await join("Ben");
    assert.ok(owner.parts.meta.capabilities.includes("space-alerts-v1"));
    await owner.until(() => owner.space("Launch"), "the owner's spaces");
    const launchId = owner.space("Launch")!.id;
    const anaId = link.store.data.team.members.find((member: any) => member.name === "Ana").id;
    const benId = link.store.data.team.members.find((member: any) => member.name === "Ben").id;
    await owner.call("link.spaces.share", launchId, { access: "members", grants: [{ id: anaId, can: "edit" }, { id: benId, can: "view" }] });
    await ana.until(() => ana.space("Launch"), "Ana is sent Launch");
    await ben.until(() => ben.space("Launch"), "Ben is sent Launch");
    const content = await ana.call<SpaceContent>("spaces.read", launchId);
    const checklist = content.panels[0];
    await settle();
    sent.length = 0;

    // A note goes right away to everyone who can open the space and has not set Off; never to its writer.
    await ana.call("spaces.note", checklist.id, "**Macros** are done.");
    await settle();
    const ownerGot = owner.alerts();
    assert.deepEqual(ownerGot.map((one) => [one.t, one.m, one.k, one.s, one.p]), [["Ana in Launch", "Macros are done.", "space", launchId, checklist.id]]);
    // What Apple and the relay carry says only that a space changed.
    assert.equal(ownerGot[0].shown, "A space changed");
    assert.deepEqual(ben.alerts().map((one) => one.t), ["Ana in Launch"]);
    assert.deepEqual(ana.alerts(), []);

    // A change goes only to those who chose "Every change".
    const tick = (name: string) => ana.call("spaces.patchState", checklist.id, { ticked: { [name]: true } }, "Ticked " + name);
    await tick("Support macros");
    await settle();
    assert.deepEqual([owner.alerts(), ben.alerts(), ana.alerts()], [[], [], []]);
    await owner.call("link.spaces.notify", launchId, "all");
    await owner.until(() => owner.space("Launch")!.notify === "all", "every change");
    await tick("Status page");
    await settle();
    assert.deepEqual(owner.alerts().map((one) => [one.t, one.m, one.p]), [["Ana in Launch", "Ticked Status page", checklist.id]]);
    assert.deepEqual(ben.alerts(), []);
    // At most one such alert for each space and person in ten minutes; a note still comes through.
    await tick("Press kit");
    await settle();
    assert.deepEqual(owner.alerts(), []);
    await ana.call("spaces.note", checklist.id, "All ticked.");
    await settle();
    assert.deepEqual(owner.alerts().map((one) => one.m), ["All ticked."]);
    ben.alerts();
    // Ten minutes on, the next change is told again.
    const real_ = link.spaceAlerts.now;
    link.spaceAlerts.now = () => Date.now() + SPACE_ALERTS.throttleMs + 1000;
    await tick("Changelog reviewed");
    await settle();
    assert.deepEqual(owner.alerts().map((one) => one.m), ["Ticked Changelog reviewed"]);
    link.spaceAlerts.now = real_;

    // "Notify me" Off: nothing, a note neither.
    await ben.call("link.spaces.notify", launchId, "off");
    await ben.until(() => ben.space("Launch")!.notify === "off", "off for Ben");
    await ana.call("spaces.note", checklist.id, "One more.");
    await settle();
    assert.deepEqual(ben.alerts(), []);
    assert.equal(owner.alerts().length, 1);

    // Someone who is looking at the space now needs no alert about it.
    await owner.call("link.spaces.here", launchId);
    await ana.call("spaces.note", checklist.id, "You can see this.");
    await settle();
    assert.deepEqual(owner.alerts(), []);
    await owner.call("link.spaces.here", null);

    // The phone's own "Spaces" choice turns them all off for that phone; previews off keeps the words out.
    await owner.call("link.push.prefs", { spaces: false });
    await ana.call("spaces.note", checklist.id, "Quiet.");
    await settle();
    assert.deepEqual(owner.alerts(), []);
    await owner.call("link.push.prefs", { spaces: true, previews: false });
    await ana.call("spaces.note", checklist.id, "The door code is 4471.");
    await settle();
    assert.deepEqual(owner.alerts().map((one) => [one.t, one.m]), [["Ana in Launch", "Wrote a note."]]);
    assert.ok(!JSON.stringify(sent).includes("4471"));

    // The owner's own note reaches Ana, who was picked for the space ("Once a day" still lets a note through).
    await owner.call("spaces.note", checklist.id, "Thanks, Ana.");
    await settle();
    const anas = ana.alerts();
    assert.equal(anas.length, 1);
    assert.match(anas[0].t, /^\S+ in Launch$/);
    assert.equal(anas[0].m, "Thanks, Ana.");
    // Nothing a person wrote is kept by the alerts.
    assert.ok(!JSON.stringify(link.store.data.team).includes("Macros"));
    void backend;
  } finally {
    await stop();
  }
});

test("once a day, between 8:00 and noon, each person is told what changed since they last looked", async () => {
  const { link, owner, join, settle, stop } = await team();
  try {
    const ana = await join("Ana");
    const ben = await join("Ben");
    await owner.until(() => owner.space("Launch"), "the owner's spaces");
    const launchId = owner.space("Launch")!.id;
    const idOf = (name: string) => link.store.data.team.members.find((member: any) => member.name === name).id;
    await owner.call("link.spaces.share", launchId, { access: "members", grants: [{ id: idOf("Ana"), can: "edit" }, { id: idOf("Ben"), can: "view" }] });
    await ana.until(() => ana.space("Launch"), "Ana is sent Launch");
    await ben.until(() => ben.space("Launch"), "Ben is sent Launch");
    // The days are tomorrow and after: a time earlier today could be before what the test does, whatever
    // the hour and the time zone it runs in.
    const at = (hour: number, day = 1) => {
      const time = new Date();
      time.setDate(time.getDate() + day);
      time.setHours(hour, 30, 0, 0);
      return time.getTime();
    };

    // (The owner's phone was told of the two requests to join; those are not about spaces.)
    await settle();
    owner.alerts();
    // The first look, as the computer started, only noted the time: nobody is told that everything they
    // never opened "changed overnight". What changed before that look is never news.
    assert.equal(link.store.data.team.spaceDigest.day, "");
    assert.ok(link.store.data.team.spaceDigest.at <= Date.now());
    assert.deepEqual([owner.alerts(), ana.alerts(), ben.alerts()], [[], [], []]);

    // Ana ticks an item. Nobody chose "Every change", so nothing is sent right away.
    const checklist = (await ana.call<SpaceContent>("spaces.read", launchId)).panels[0];
    await ana.call("spaces.patchState", checklist.id, { ticked: { "Status page": true } }, "Ticked Status page");
    await settle();
    assert.deepEqual([owner.alerts(), ben.alerts()], [[], []]);

    // The next day, before 8:00 and after noon, nothing is sent and the day stays open.
    link.spaceAlerts.now = () => at(7, 2);
    assert.equal(link.spaceAlerts.daily(), 0);
    link.spaceAlerts.now = () => at(13, 2);
    assert.equal(link.spaceAlerts.daily(), 0);

    // At 8:30 the owner and Ben are each told once: the space's name, and what changed. Ana is not told of her own change.
    link.spaceAlerts.now = () => at(8, 2);
    assert.equal(link.spaceAlerts.daily(), 2);
    await settle();
    for (const phone of [owner, ben]) {
      const got = phone.alerts();
      assert.deepEqual(got.map((one) => [one.t, one.m, one.k, one.s, one.p]), [["Launch", "1 panel changed overnight: " + checklist.title + ".", "space", launchId, undefined]]);
      assert.equal(got[0].shown, "A space changed");
    }
    assert.deepEqual(ana.alerts(), []);

    // Once for each day, also after a restart (the day is kept with the team).
    assert.equal(link.spaceAlerts.daily(), 0);
    assert.match(link.store.data.team.spaceDigest.day, /^\d{4}-\d{2}-\d{2}$/);

    // The day after tells only of what changed since: nothing did, so nobody is told.
    link.spaceAlerts.now = () => at(9, 3);
    assert.equal(link.spaceAlerts.daily(), 0);
    await settle();
    assert.deepEqual([owner.alerts(), ben.alerts()], [[], []]);

  } finally {
    await stop();
  }
});
