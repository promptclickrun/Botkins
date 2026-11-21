// What a person does in a space (a note, a change to an app panel) reaches the link's alerts on
// every host (desktop/headless/space-events.mjs; docs/spaces.md, "Notifications"). On one process
// the app calls `link.spaceEvent` itself. On the two-container host the workspace's container
// keeps the events in a short queue, and the link's container takes them with its next look.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { headlessBackend } from "../desktop/headless/backend.mjs";
import { handSpaceEvents, LOOK_LIMIT, QUEUE_LIMIT, spaceEventQueue } from "../desktop/headless/space-events.mjs";
import { listenWorkspace, workspaceRequest } from "../desktop/headless/transport.mjs";
import { workspaceActions } from "../desktop/headless/workspace.mjs";
import { createRuntime } from "../desktop/runtime.mjs";
import { fakeHost } from "./fake-host.mjs";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";

const event = (n) => ({ spaceId: "s_one", panelId: "p1", by: "owner", kind: "change", label: "Change " + n });
const sockets = process.platform === "win32" && "The Docker host uses Unix sockets.";

/** A workspace container's backend for `state`, with a queue of events, and the link's side looking at it. */
function sides({ spaceEvent } = {}) {
  const queue = spaceEventQueue();
  const state = { bots: [], chats: [], runs: [], settings: {} };
  const backend = {
    snapshot: () => state,
    capabilities: ["models-v2"],
    subscribe: () => () => {},
    call: () => "ok",
    takeSpaceEvents: queue.take,
    screen: { displays: async () => [{ id: "1", width: 10, height: 10 }] },
  };
  const actions = workspaceActions(backend, () => {});
  const link = headlessBackend((method, args) => actions.dispatch(method, args), "test", { spaceEvent });
  return { queue, actions, ...link };
}

test("the queue keeps the newest 50 events in order and gives them once", () => {
  const queue = spaceEventQueue();
  for (let n = 0; n < QUEUE_LIMIT + 10; n++) queue.add(event(n));
  const taken = queue.take();
  assert.equal(taken.length, QUEUE_LIMIT);
  assert.deepEqual([taken[0].label, taken.at(-1).label], ["Change 10", "Change 59"], "the oldest were dropped");
  assert.deepEqual(queue.take(), [], "taken once");
  queue.add(event(1));
  assert.deepEqual(queue.take(), [event(1)]);
});

test("the answer of `state` carries the events once, and only when there are some", async () => {
  const { queue, actions } = sides();
  const first = await actions.dispatch("state", [null, null]);
  assert.equal("spaceEvents" in first, false, "none waiting, no field");
  queue.add(event(1));
  queue.add(event(2));
  const second = await actions.dispatch("state", [first.version, null]);
  assert.deepEqual(second.spaceEvents, [event(1), event(2)]);
  const third = await actions.dispatch("state", [first.version, null]);
  assert.equal("spaceEvents" in third, false, "told once");
  // A workspace from before this has no queue and sends none; its answer is as it was.
  const older = workspaceActions({ snapshot: () => ({}), capabilities: [], subscribe: () => () => {}, screen: { displays: async () => [] } }, () => {});
  assert.equal("spaceEvents" in (await older.dispatch("state", [null, null])), false);
  older.unsubscribe();
  actions.unsubscribe();
});

test("the link's side hands each event to its listener once, in order, and takes at most 20 at a look", async () => {
  const heard = [];
  const { queue, refresh, actions } = sides({ spaceEvent: (one) => void heard.push(one) });
  await refresh();
  assert.deepEqual(heard, []);
  for (let n = 0; n < 3; n++) queue.add(event(n));
  await refresh();
  assert.deepEqual(heard.splice(0), [event(0), event(1), event(2)], "in order");
  await refresh();
  assert.deepEqual(heard, [], "once");
  // More than the queue holds (50) and more than one look takes (20): the newest 50 wait, one look takes the first 20 of those, and the next looks take the rest.
  for (let n = 0; n < QUEUE_LIMIT + 5; n++) queue.add(event(n));
  await refresh();
  assert.equal(heard.length, LOOK_LIMIT);
  assert.deepEqual([heard[0].label, heard.at(-1).label], ["Change 5", "Change " + (4 + LOOK_LIMIT)]);
  heard.length = 0;
  await refresh();
  assert.deepEqual([heard.length, heard[0].label, heard.at(-1).label], [LOOK_LIMIT, "Change " + (5 + LOOK_LIMIT), "Change " + (4 + 2 * LOOK_LIMIT)], "the next look takes the next 20");
  heard.length = 0;
  await refresh();
  assert.deepEqual([heard.length, heard[0].label, heard.at(-1).label], [QUEUE_LIMIT - 2 * LOOK_LIMIT, "Change " + (5 + 2 * LOOK_LIMIT), "Change " + (QUEUE_LIMIT + 4)], "then the rest");
  heard.length = 0;
  await refresh();
  assert.deepEqual(heard, [], "told once");
  actions.unsubscribe();
});

test("what is not a plain object is dropped, and a listener that fails for one event never stops the look or the next event", async () => {
  const heard = [];
  const failures = [];
  const listener = (one) => {
    heard.push(one.label);
    if (one.label === "throws") throw new Error("sync failure");
    if (one.label === "rejects") return Promise.reject(new Error("async failure"));
  };
  const unhandled = (error) => failures.push(error);
  process.on("unhandledRejection", unhandled);
  try {
    handSpaceEvents([null, "text", 5, [event(1)], new Map(), undefined, { label: "throws" }, { label: "rejects" }, { label: "after" }], listener);
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(heard, ["throws", "rejects", "after"]);
    assert.deepEqual(failures, [], "a failed alert is not an unhandled error");
    // Not a list, and no listener (an older link never gives one): nothing happens.
    handSpaceEvents("nope", listener);
    handSpaceEvents({ length: 1, 0: event(1) }, listener);
    handSpaceEvents([event(1)], undefined);
    assert.equal(heard.length, 3);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
  // Through the look: a listener that throws at the first event does not break the look; the snapshot still arrives and the next events are told.
  const told = [];
  const { queue, refresh, backend, actions } = sides({ spaceEvent: (one) => { told.push(one.label); throw new Error("no"); } });
  let changes = 0;
  backend.subscribe(() => changes++);
  queue.add(event(1));
  queue.add(event(2));
  await refresh();
  assert.deepEqual(told, ["Change 1", "Change 2"]);
  assert.deepEqual([changes, backend.displayStatus().available], [1, true], "the look went on");
  actions.unsubscribe();
});

test("an older link ignores the field: no listener, no failure", async () => {
  const { queue, refresh, backend, actions } = sides();
  queue.add(event(1));
  await refresh();
  assert.equal(backend.displayStatus().available, true);
  actions.unsubscribe();
});

test("a person's note and change in a real workspace cross the socket once, in order, and reach the link's listener", { skip: sockets }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  const queue = spaceEventQueue();
  const ws = new Workspace(join(dir, "app"), fakeClient().client, () => {}, { spaceEvent: queue.add });
  const socket = join(dir, "workspace.sock");
  const actions = workspaceActions({ snapshot: () => ws.snapshot(), capabilities: [], subscribe: () => () => {}, call: async () => "ok", takeSpaceEvents: queue.take, screen: { displays: async () => [] } }, () => {});
  const close = await listenWorkspace(socket, actions.dispatch);
  t.after(() => { close(); actions.unsubscribe(); rmSync(dir, { recursive: true, force: true }); });
  const heard = [];
  const { refresh } = headlessBackend((method, args) => workspaceRequest(socket, method, args), "test", { spaceEvent: (one) => void heard.push(one) });
  const space = ws.spaces.ensure("owner").today.id;
  const chat = ws.createChat("pip");
  ws.panels.write("pip", chat, { key: "list", title: "List", blocks: [{ type: "markdown", text: "Hi" }], state: {} }, undefined);
  const panel = ws.state.panels[0];
  await refresh();
  assert.deepEqual(heard, [], "what a bot publishes is not told");
  ws.spaces.patchState(panel.id, { milk: true }, "Ticked Milk", "owner");
  ws.spaces.note(panel.id, "Looks right", "owner");
  await refresh();
  assert.deepEqual(heard.splice(0), [
    { spaceId: space, panelId: panel.id, by: "owner", kind: "change", label: "Ticked Milk" },
    { spaceId: space, panelId: panel.id, by: "owner", kind: "note", text: "Looks right" },
  ]);
  await refresh();
  assert.deepEqual(heard, [], "told once");
});

// ── The one-process hosts (the window, `botkins serve`) call the link themselves ─────────────

async function runtimeOn(t) {
  const before = process.env.BOTKINS_PROVIDERS;
  process.env.BOTKINS_PROVIDERS = "grok";
  const dir = mkdtempSync(join(tmpdir(), "bk-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = await createRuntime({ host: fakeHost(), dataDir: join(dir, "data"), trial: true, link: { port: 0 } });
  if (before === undefined) delete process.env.BOTKINS_PROVIDERS;
  else process.env.BOTKINS_PROVIDERS = before;
  t.after(() => runtime.stop());
  return runtime;
}

test("on one process the link hears once of a person's note and once of a person's change, and of nothing else a panel goes through", async (t) => {
  const runtime = await runtimeOn(t);
  const { workspace, handlers } = runtime;
  assert.equal("takeSpaceEvents" in runtime.linkBackend, false, "the queue is for the two-container host only");
  const heard = [];
  runtime.link.spaceEvent = (one) => void heard.push(one);
  workspace.state.bots.push({ id: "pip", name: "Pip", role: "", instructions: "", face: "idle" });
  const space = workspace.spaces.ensure("owner").today.id;
  const other = workspace.spaces.create({ name: "Other" }, "owner");
  const chat = workspace.createChat("pip");
  const write = (key, args = {}) => workspace.panels.write("pip", chat, { key, title: key, blocks: [{ type: "markdown", text: "Hi" }], ...args }, undefined);
  // What a bot does: a publish, an update, a routine, none of it is a person's.
  write("list", { state: {} });
  write("second");
  const [list, second] = workspace.state.panels;
  write("list", { revision: list.revision, title: "List again" });
  handlers.routine(list.id, { action: "set", cron: "0 8 * * *", prompt: "Look" }, "owner");
  // What a person does to the panel itself: hide, show, a size, an order, a move, a project, a refresh of its routine.
  for (const action of ["hide", "show", "small", "wide", "tall", "later", "earlier"]) handlers.changePanel(list.id, action);
  handlers["spaces.movePanel"](second.id, { spaceId: other }, "owner");
  handlers["spaces.movePanel"](second.id, { spaceId: space, before: list.id }, "owner");
  workspace.state.projects = [{ id: "project-1", name: "Launch" }];
  handlers["spaces.setPanelProject"](list.id, "project-1", "owner");
  assert.deepEqual(heard, []);
  // A person's note, and a person's change to the panel's state: once each.
  handlers["spaces.note"](list.id, "Looks right", "owner");
  assert.deepEqual(heard.splice(0), [{ spaceId: space, panelId: list.id, by: "owner", kind: "note", text: "Looks right" }]);
  handlers["spaces.patchState"](list.id, { milk: true }, "Ticked Milk", "owner");
  assert.deepEqual(heard.splice(0), [{ spaceId: space, panelId: list.id, by: "owner", kind: "change", label: "Ticked Milk" }]);
  // Taking a note away is not news.
  handlers["spaces.removeNote"](list.id, list.notes[0].id, "owner");
  assert.deepEqual(heard, []);
});
