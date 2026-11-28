// Unit tests for the Channels-style Projects index and subpage logic:
// active / this week / earlier grouping, search, 20-item paging with older count,
// index row subtitles/counts/badges, and hiding rows when features are off.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProjectIndex,
  filterProjectArtifacts,
  filterProjectChats,
  groupProjectChats,
  orderJobsRunningFirst,
  PAGE_SIZE,
  pageItems,
  WEEK_MS,
} from "../src/features/projects/logic";
import type { Artifact, Bot, ChatSummary, Panel, Project, SpaceSummary } from "../src/link/types";

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const mkChat = (id: string, time: number, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  botId: "glory",
  title: id,
  time,
  count: 2,
  projectId: "p1",
  ...extra,
});

const mkBot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id,
  name,
  role: "Helper",
  instructions: "",
  face: "",
  ...extra,
});

const mkProject = (extra: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "Botkins",
  description: "The app for teams of AI bots",
  todos: [],
  lastUsed: NOW,
  createdAt: NOW - 10 * DAY,
  ...extra,
});

test("groupProjectChats buckets Active, This week, and Earlier in newest-first order", () => {
  const chats = [
    mkChat("old-active", NOW - 30 * DAY), // active overrides age
    mkChat("needs-you", NOW - 20 * DAY),
    mkChat("week-new", NOW - 1 * DAY),
    mkChat("week-old", NOW - 6 * DAY),
    mkChat("earlier-new", NOW - 8 * DAY),
    mkChat("earlier-old", NOW - 40 * DAY),
  ];
  const live = {
    requests: [{ chatId: "needs-you" }],
    streams: { "old-active": "reply" },
    active: [],
  };
  const result = groupProjectChats(chats, live, { now: NOW });
  assert.deepEqual(
    result.groups.map((g) => [g.key, g.title, g.chats.map((c) => c.id)]),
    [
      ["active", "Active", ["needs-you", "old-active"]],
      ["week", "This week", ["week-new", "week-old"]],
      ["earlier", "Earlier", ["earlier-new", "earlier-old"]],
    ],
  );
  assert.equal(result.total, 6);
  assert.equal(result.shown, 6);
  assert.equal(result.older, 0);
});

test("groupProjectChats omits empty buckets and filters by chat title or bot name", () => {
  const chats = [
    mkChat("Notification filter", NOW - 1000, { botId: "glory" }),
    mkChat("Release prep", NOW - 10 * DAY, { botId: "alfie" }),
    mkChat("Relay limits", NOW - 12 * DAY, { botId: "alfie" }),
  ];
  const botName = (id: string) => ({ glory: "Glory", alfie: "Alfie" }[id]);

  const byTitle = groupProjectChats(chats, undefined, { now: NOW, query: "filter", botName });
  assert.deepEqual(
    byTitle.groups.map((g) => [g.key, g.chats.map((c) => c.id)]),
    [["week", ["Notification filter"]]],
  );

  const byBot = groupProjectChats(chats, undefined, { now: NOW, query: "ALFIE", botName });
  assert.deepEqual(
    byBot.groups.map((g) => [g.key, g.chats.map((c) => c.id)]),
    [["earlier", ["Release prep", "Relay limits"]]],
  );

  const noMatch = groupProjectChats(chats, undefined, { now: NOW, query: "zzzz", botName });
  assert.deepEqual(noMatch.groups, []);
  assert.equal(noMatch.total, 0);
  assert.equal(noMatch.older, 0);
});

test("20-item paging returns first 20 items and accurate older count across chats and artifacts", () => {
  assert.equal(PAGE_SIZE, 20);
  const chats = Array.from({ length: 26 }, (_, idx) =>
    mkChat(`chat-${idx}`, NOW - (idx < 3 ? idx * 60_000 : (idx + 8) * DAY)),
  );
  const page1 = groupProjectChats(chats, undefined, { now: NOW, limit: 20 });
  assert.equal(page1.total, 26);
  assert.equal(page1.shown, 20);
  assert.equal(page1.older, 6);
  assert.deepEqual(
    page1.groups.map((g) => [g.key, g.chats.length]),
    [
      ["week", 3],
      ["earlier", 17],
    ],
  );

  const page2 = groupProjectChats(chats, undefined, { now: NOW, limit: 40 });
  assert.equal(page2.shown, 26);
  assert.equal(page2.older, 0);

  const artifacts = Array.from({ length: 25 }, (_, i) => ({
    id: `a-${i}`,
    name: i === 0 ? "projects-redesign.png" : `file-${i}.md`,
    botId: i % 2 === 0 ? "glory" : "alfie",
    chatTitle: i === 5 ? "Release board" : "General",
    time: NOW - i * 1000,
  })) as Artifact[];

  const pagedArtifacts = pageItems(artifacts, 20);
  assert.equal(pagedArtifacts.visible.length, 20);
  assert.equal(pagedArtifacts.older, 5);

  const filtered = filterProjectArtifacts(artifacts, "release", (id) => (id === "glory" ? "Glory" : "Alfie"));
  assert.deepEqual(filtered.map((a) => a.id), ["a-5"]);
  assert.equal(filterProjectChats(chats, "chat-25").length, 1);
});

test("orderJobsRunningFirst puts active jobs before finished/brought-in/closed jobs", () => {
  const jobs = [
    mkChat("finished-new", NOW - 100, { job: { where: "worktree", state: "open", createdAt: NOW - 100 } }),
    mkChat("working-old", NOW - 5000, { job: { where: "worktree", state: "open", createdAt: NOW - 5000 } }),
    mkChat("needs-older", NOW - 9000, { job: { where: "worktree", state: "open", createdAt: NOW - 9000 } }),
    mkChat("brought-in", NOW - 50, { job: { where: "worktree", state: "brought-in", createdAt: NOW - 50 } }),
  ];
  const live = { requests: [{ chatId: "needs-older" }], streams: { "working-old": "" }, active: [] };
  const ordered = orderJobsRunningFirst(jobs, live);
  assert.deepEqual(
    ordered.map((j) => j.id),
    ["working-old", "needs-older", "brought-in", "finished-new"],
  );
});

test("buildProjectIndex computes subtitles, counts, badges, and recent chat", () => {
  const bots = [
    mkBot("alfie", "Alfie", { access: { all: false, projects: ["p1"] } }),
    mkBot("glory", "Glory", { access: { all: false, projects: ["p1"] } }),
    mkBot("gordie", "Gordie", { access: { all: false, projects: ["p1"] } }),
    mkBot("chirp", "Chirp", { access: { all: false, projects: [] } }),
  ];
  const project = mkProject({
    folder: "/Users/colt/code/Botkins",
    folders: ["/Users/colt/code/Botkins", "/Users/colt/code/relay"],
    todos: [
      { id: "t1", text: "Ship release", done: true, createdAt: 1, doneAt: 2 },
      { id: "t2", text: "Deploy relay after 0.17.25", done: false, createdAt: 3 },
      { id: "t3", text: "Write notes", done: false, createdAt: 4 },
    ],
    artifacts: ["a1", "a2"],
  });
  const chats = [
    mkChat("c-latest", NOW - 12 * 60_000, { title: "Notification filter", botId: "glory" }),
    mkChat("c-job-1", NOW - 40 * 60_000, {
      title: "Unified spaces merge",
      botId: "glory",
      job: { where: "worktree", state: "open", createdAt: NOW - 40 * 60_000 },
    }),
    mkChat("c-job-2", NOW - 90 * 60_000, {
      title: "Fix push",
      botId: "alfie",
      job: { where: "worktree", state: "open", createdAt: NOW - 90 * 60_000 },
    }),
    mkChat("c-old", NOW - WEEK_MS - DAY, { title: "Old chat", botId: "alfie" }),
    mkChat("c-archived", NOW - 1000, { title: "Archived", archived: true }),
  ];
  const live = {
    requests: [{ chatId: "c-job-2" }],
    streams: { "c-job-1": "working" },
    active: [],
  };
  const artifacts = [
    { id: "a1", name: "Projects mockup", time: NOW - 1000 },
    { id: "a2", name: "Spec.md", time: NOW - 5000 },
  ];
  const spaces = [{ id: "s1", name: "Release board", projectId: "p1" }] as SpaceSummary[];
  const panels = [] as Panel[];

  const index = buildProjectIndex({
    project,
    chats,
    live,
    bots,
    settings: { access: { allBots: false } },
    artifacts,
    spaces,
    panels,
    changedFiles: 3,
    features: { jobs: true, artifacts: true, spaces: true, changes: true },
    now: NOW,
  });

  assert.equal(index.recentChat?.id, "c-latest");
  assert.deepEqual(
    index.work.map((r) => ({ key: r.key, title: r.title, subtitle: r.subtitle, count: r.count, badge: r.badge })),
    [
      { key: "jobs", title: "Jobs", subtitle: "Unified spaces merge", count: undefined, badge: { label: "2 running", tone: "accent" } },
      { key: "todos", title: "To-dos", subtitle: "Next: Deploy relay after 0.17.25", count: 2, badge: undefined },
      { key: "chats", title: "Chats", subtitle: "3 active this week", count: 4, badge: undefined },
    ],
  );
  assert.deepEqual(
    index.files.map((r) => ({ key: r.key, title: r.title, subtitle: r.subtitle, count: r.count })),
    [
      { key: "artifacts", title: "Artifacts", subtitle: "Projects mockup", count: 2 },
      { key: "spaces", title: "Spaces", subtitle: "Release board", count: 1 },
      { key: "changes", title: "Changes", subtitle: "3 files changed", count: undefined },
    ],
  );
  assert.deepEqual(
    index.settings.map((r) => ({ key: r.key, title: r.title, subtitle: r.subtitle, count: r.count })),
    [
      { key: "access", title: "Who can use it", subtitle: "Alfie, Glory, Gordie", count: undefined },
      { key: "folders", title: "Folders", subtitle: "code/Botkins", count: 2 },
    ],
  );
});

test("buildProjectIndex hides rows when features are off and handles empty state + global access", () => {
  const index = buildProjectIndex({
    project: mkProject({ todos: [] }),
    chats: [],
    live: undefined,
    bots: [mkBot("alfie", "Alfie")],
    settings: { access: { allBots: true } },
    panels: [{ id: "pan1", title: "Daily build", projectId: "p1" } as Panel],
    features: { jobs: false, artifacts: false, spaces: false, changes: false },
    now: NOW,
  });

  assert.equal(index.recentChat, null);
  assert.deepEqual(index.work.map((r) => r.key), ["todos", "chats"]);
  assert.deepEqual(index.files.map((r) => [r.key, r.title, r.subtitle, r.count]), [
    ["spaces", "Panels", "Daily build", 1],
  ]);
  assert.deepEqual(index.settings.map((r) => [r.key, r.subtitle, r.count]), [
    ["access", "All bots", undefined],
    ["folders", "No folder", undefined],
  ]);
});
