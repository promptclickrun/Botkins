// Unit tests for desktop Projects redesign logic: Overview index, grouping, search, paging, feature hiding.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDesktopProjectIndex,
  filterProjectArtifacts,
  groupProjectChats,
  pageItems,
  PROJECT_PAGE_SIZE,
  PROJECT_WEEK_MS,
} from "../src/projectLogic.ts";

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const chat = (id, time, extra = {}) => ({
  id,
  botId: "glory",
  title: id,
  time,
  messages: [],
  projectId: "p1",
  ...extra,
});

const bot = (id, name, extra = {}) => ({
  id,
  name,
  role: "Helper",
  instructions: "",
  face: "",
  ...extra,
});

test("desktop groupProjectChats groups Active, This week, Earlier and pages at 20", () => {
  assert.equal(PROJECT_PAGE_SIZE, 20);
  const chats = [
    chat("active-old", NOW - 30 * DAY),
    chat("needs-old", NOW - 25 * DAY),
    ...Array.from({ length: 5 }, (_, i) => chat(`week-${i}`, NOW - (i + 1) * 3600_000)),
    ...Array.from({ length: 18 }, (_, i) => chat(`earlier-${i}`, NOW - (i + 10) * DAY)),
  ];
  const state = {
    requests: [{ chatId: "needs-old" }],
    streams: { "active-old": "working" },
  };
  const page1 = groupProjectChats(chats, state, { now: NOW });
  assert.equal(page1.total, 25);
  assert.equal(page1.shown, 20);
  assert.equal(page1.older, 5);
  assert.deepEqual(
    page1.groups.map((g) => [g.key, g.chats.length]),
    [
      ["active", 2],
      ["week", 5],
      ["earlier", 13],
    ],
  );
  assert.deepEqual(
    page1.groups[0].chats.map((c) => c.id),
    ["needs-old", "active-old"],
  );

  const filtered = groupProjectChats(chats, state, { now: NOW, query: "week-2" });
  assert.deepEqual(
    filtered.groups.map((g) => [g.key, g.chats.map((c) => c.id)]),
    [["week", ["week-2"]]],
  );
});

test("desktop filterProjectArtifacts and pageItems filter and page artifacts", () => {
  const items = Array.from({ length: 24 }, (_, i) => ({
    id: `a-${i}`,
    name: i === 2 ? "Mockup.html" : `doc-${i}.md`,
    chatTitle: i === 4 ? "Design review" : "General",
    botId: i === 6 ? "alfie" : "glory",
    time: NOW - i * 1000,
  }));
  const paged = pageItems(items, 20);
  assert.equal(paged.visible.length, 20);
  assert.equal(paged.older, 4);

  const botName = (id) => ({ alfie: "Alfie", glory: "Glory" }[id]);
  assert.deepEqual(
    filterProjectArtifacts(items, "mockup", botName).map((a) => a.id),
    ["a-2"],
  );
  assert.deepEqual(
    filterProjectArtifacts(items, "design review", botName).map((a) => a.id),
    ["a-4"],
  );
  assert.deepEqual(
    filterProjectArtifacts(items, "alfie", botName).map((a) => a.id),
    ["a-6"],
  );
});

test("buildDesktopProjectIndex produces all three groups and hides disabled features", () => {
  const project = {
    id: "p1",
    name: "Botkins",
    folder: "/Users/colt/code/Botkins",
    folders: ["/Users/colt/code/Botkins"],
    todos: [
      { id: "t1", text: "First open", done: false, createdAt: 1 },
      { id: "t2", text: "Done one", done: true, createdAt: 2, doneAt: 3 },
    ],
    artifacts: ["a1"],
    lastUsed: NOW,
    createdAt: NOW - DAY,
  };
  const state = {
    bots: [bot("glory", "Glory", { access: { all: false, projects: ["p1"] } }), bot("alfie", "Alfie", { access: { all: false, projects: [] } })],
    chats: [
      chat("c1", NOW - 5000, { title: "Latest chat" }),
      chat("c2", NOW - 10_000, { title: "Running job", job: { where: "worktree", state: "open", createdAt: NOW - 10_000 } }),
      chat("c3", NOW - PROJECT_WEEK_MS - DAY, { title: "Older chat" }),
    ],
    panels: [{ id: "pan1", title: "Status", projectId: "p1" }],
    spaces: [{ id: "sp1", name: "Release board", projectId: "p1" }],
    settings: { access: { allBots: false } },
    requests: [],
    streams: { c2: "running" },
  };

  const full = buildDesktopProjectIndex({
    state,
    project,
    artifacts: [{ id: "a1", name: "projects-redesign.html", time: NOW }],
    changedFiles: 1,
    features: { jobs: true, artifacts: true, spaces: true, changes: true },
    now: NOW,
  });
  assert.equal(full.recentChat?.id, "c1");
  assert.deepEqual(full.work.map((r) => [r.key, r.subtitle, r.count, r.badge?.label]), [
    ["jobs", "Running job", undefined, "1 running"],
    ["todos", "Next: First open", 1, undefined],
    ["chats", "2 active this week", 3, undefined],
  ]);
  assert.deepEqual(full.files.map((r) => [r.key, r.title, r.subtitle, r.count]), [
    ["artifacts", "Artifacts", "projects-redesign.html", 1],
    ["panels", "Spaces", "Release board", 2],
    ["changes", "Changes", "1 file changed", undefined],
  ]);
  assert.deepEqual(full.settings.map((r) => [r.key, r.subtitle, r.count]), [
    ["access", "Glory", undefined],
    ["folders", "code/Botkins", 1],
  ]);

  const minimal = buildDesktopProjectIndex({
    state: { ...state, settings: { access: { allBots: true } } },
    project: { ...project, folder: undefined, folders: undefined, todos: [] },
    features: { jobs: false, artifacts: false, spaces: false, changes: false },
    now: NOW,
  });
  assert.deepEqual(minimal.work.map((r) => r.key), ["todos", "chats"]);
  assert.deepEqual(minimal.files.map((r) => [r.key, r.title]), [["panels", "Panels"]]);
  assert.equal(minimal.settings[0].subtitle, "All bots");
});
