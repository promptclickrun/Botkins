// Unit tests for the Channels-style Projects index and subpage logic:
// active / this week / earlier grouping, search, 20-item paging with older count,
// index row subtitles/counts/badges, and hiding rows when features are off.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el, Fragment } from "react";
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
import { mount, phoneModule } from "./render-phone";

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

// ---- Confirmation guards on phone remove handlers -------------------------------------------

type AlertCall = {
  title: string;
  message?: string;
  buttons?: Array<{ text?: string; style?: string; onPress?: () => void }>;
};

function makePhoneTestEnv(options: {
  project: Project;
  bots: Bot[];
  chats: ChatSummary[];
  artifacts: Artifact[];
  spaces: SpaceSummary[];
}) {
  const alerts: AlertCall[] = [];
  const apiCalls: { setChatProject: unknown[][]; removeProjectArtifact: unknown[][]; spacesSetProject: unknown[][] } = {
    setChatProject: [],
    removeProjectArtifact: [],
    spacesSetProject: [],
  };
  let lastPanConfig: any = null;

  const stub = (name: string) => (props: any) => el(name, props, props?.children);
  const icon = (name: string) => () => el("icon", { name });

  const imports: Record<string, unknown> = {
    "expo-router": {
      router: { push() {}, back() {} },
      Stack: { Screen: () => null },
      useLocalSearchParams: () => ({ id: options.project.id }),
    },
    "@react-native-menu/menu": {
      MenuView: stub("MenuView"),
    },
    "lucide-react-native": {
      LayoutGrid: icon("LayoutGrid"),
      MessagesSquare: icon("MessagesSquare"),
      Paperclip: icon("Paperclip"),
      Plus: icon("Plus"),
    },
    "react-native": {
      Alert: {
        alert: (title: string, message?: string, buttons?: AlertCall["buttons"]) => {
          alerts.push({ title, message, buttons });
        },
      },
      ScrollView: stub("ScrollView"),
      View: stub("View"),
    },
    "react-native-gesture-handler": {
      GestureDetector: ({ children }: any) => el(Fragment, {}, children),
      usePanGesture: (cfg: any) => {
        lastPanConfig = cfg;
        return cfg;
      },
    },
    "react-native-reanimated": {
      __esModule: true,
      default: { View: stub("AnimatedView") },
      useSharedValue: (v: unknown) => ({ value: v }),
      useAnimatedStyle: () => ({}),
      withSpring: (v: unknown) => v,
    },
    "@/features/chat/navigate": { openChat() {} },
    "@/features/bots/projectAccess": { canUseProject: () => true },
    "@/features/artifacts/ArtifactBits": { ArtifactRow: stub("ArtifactRow") },
    "@/features/spaces/data": {
      openSpace() {},
      useSpaces: () => options.spaces,
      useSpacesOn: () => true,
    },
    "@/features/spaces/logic": {
      spaceTitle: (s: SpaceSummary) => s.name,
      rowLine: () => "1 panel",
    },
    "@/features/spaces/SpaceView": { PanelCard: stub("SpacePanelCard") },
    "@/features/today/Today": { PanelCard: stub("PanelCard") },
    "@/state/hooks": {
      useBots: () => options.bots,
      useCan: () => true,
      useCapability: () => true,
      useChats: () => options.chats,
      useOnline: () => true,
      usePart: (key: string) =>
        ({
          live: { requests: [], streams: {}, active: [] },
          settings: { access: { allBots: true } },
          panels: [],
          projectPanels: [],
        } as Record<string, unknown>)[key],
    },
    "@/state/link": {
      api: {
        setChatProject: (...args: unknown[]) => {
          apiCalls.setChatProject.push(args);
          return Promise.resolve();
        },
        removeProjectArtifact: (...args: unknown[]) => {
          apiCalls.removeProjectArtifact.push(args);
          return Promise.resolve([]);
        },
        projectArtifacts: () => Promise.resolve({ items: options.artifacts }),
        "spaces.setProject": (...args: unknown[]) => {
          apiCalls.spacesSetProject.push(args);
          return Promise.resolve();
        },
      },
      attempt: (p: Promise<unknown>) => p,
    },
    "@/state/prefs": {
      usePrefs: (sel: (p: { backdrop: string }) => unknown) => sel({ backdrop: "clean" }),
    },
    "@/state/store": {
      useApp: (sel: (s: unknown) => unknown) => sel({ synced: true, parts: { projects: [options.project] } }),
    },
    "@/state/time": { ago: () => "2m" },
    "@/ui": {
      Badge: stub("Badge"),
      BotAvatar: stub("BotAvatar"),
      Button: stub("Button"),
      Chip: stub("Chip"),
      EmptyState: stub("EmptyState"),
      Field: stub("Field"),
      Group: stub("Group"),
      HoldMenu: stub("HoldMenu"),
      IconButton: stub("IconButton"),
      IconTile: stub("IconTile"),
      Label: stub("Label"),
      Loading: stub("Loading"),
      Page: stub("Page"),
      Row: stub("Row"),
      Segmented: stub("Segmented"),
      T: stub("T"),
      radius: { pill: 999 },
      space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20 },
      useTheme: () => ({ colors: { info: "#0aa", accent: "#36f" } }),
    },
    "./ProjectFolders": { FolderChoice: () => null },
  };

  return { imports, alerts, apiCalls, getLastPan: () => lastPanConfig };
}

test("phone ProjectChatsPage confirms before removing a chat (both hold menu and swipe Remove)", async () => {
  const project = mkProject({ name: "Botkins" });
  const chat = mkChat("c1", NOW - 1000, { title: "Notification filter", botId: "glory" });
  const env = makePhoneTestEnv({
    project,
    bots: [mkBot("glory", "Glory")],
    chats: [chat],
    artifacts: [],
    spaces: [],
  });

  const { ProjectChatsContent } = phoneModule("../src/features/projects/ProjectChatsPage", env.imports);
  const mounted = await mount(el(ProjectChatsContent, { project }));
  try {
    // 1. Hold menu removal asks first; Cancel does not call setChatProject.
    const holdMenu = mounted.root.root.findByType("HoldMenu" as any);
    await act(async () => {
      holdMenu.props.onPressAction({ nativeEvent: { event: "remove" } });
    });
    assert.equal(env.alerts.length, 1);
    assert.equal(env.alerts[0]!.title, "Remove from Botkins?");
    assert.match(env.alerts[0]!.message ?? "", /Notification filter/);
    assert.equal(env.apiCalls.setChatProject.length, 0, "API must not run before confirm");

    const cancelBtn = env.alerts[0]!.buttons?.find((b) => b.style === "cancel");
    assert.ok(cancelBtn);
    cancelBtn.onPress?.();
    assert.equal(env.apiCalls.setChatProject.length, 0, "Cancel must not call API");

    // Confirming calls setChatProject(chatId, null).
    const removeBtn = env.alerts[0]!.buttons?.find((b) => b.style === "destructive");
    assert.ok(removeBtn);
    await act(async () => {
      removeBtn.onPress?.();
    });
    assert.deepEqual(env.apiCalls.setChatProject, [["c1", null]]);

    // 2. Swipe-left reveal + Remove button also asks first before calling setChatProject.
    await act(async () => {
      env.getLastPan()?.onDeactivate({ translationX: -50 });
    });
    const row = mounted.root.root.findByType("Row" as any);
    const swipeRemoveBtn = row.props.trailing;
    assert.equal(swipeRemoveBtn.props.title, "Remove");
    await act(async () => {
      swipeRemoveBtn.props.onPress();
    });
    assert.equal(env.alerts.length, 2);
    assert.equal(env.apiCalls.setChatProject.length, 1, "Swipe Remove must confirm before calling API");
    await act(async () => {
      env.alerts[1]!.buttons?.find((b) => b.style === "destructive")?.onPress?.();
    });
    assert.deepEqual(env.apiCalls.setChatProject, [["c1", null], ["c1", null]]);
  } finally {
    await mounted.unmount();
  }
});

test("phone ProjectArtifactsPage confirms before calling removeProjectArtifact", async () => {
  const project = mkProject({ name: "Botkins", artifacts: ["a1"] });
  const artifact = {
    id: "a1",
    name: "mockup.png",
    botId: "glory",
    chatId: "c1",
    chatTitle: "Design",
    kind: "image",
    mime: "image/png",
    size: 1024,
    time: NOW - 1000,
    path: "/tmp/mockup.png",
  } as Artifact;
  const env = makePhoneTestEnv({
    project,
    bots: [mkBot("glory", "Glory")],
    chats: [],
    artifacts: [artifact],
    spaces: [],
  });

  const { ProjectArtifactsContent } = phoneModule("../src/features/projects/ProjectArtifactsPage", env.imports);
  const mounted = await mount(el(ProjectArtifactsContent, { project }));
  try {
    await act(async () => {
      await Promise.resolve();
    });
    const holdMenu = mounted.root.root.findByType("HoldMenu" as any);
    await act(async () => {
      holdMenu.props.onPressAction({ nativeEvent: { event: "remove" } });
    });
    assert.equal(env.alerts.length, 1);
    assert.equal(env.alerts[0]!.title, "Remove from Botkins?");
    assert.match(env.alerts[0]!.message ?? "", /mockup\.png/);
    assert.equal(env.apiCalls.removeProjectArtifact.length, 0, "API must not run before confirm");

    const removeBtn = env.alerts[0]!.buttons?.find((b) => b.style === "destructive");
    assert.ok(removeBtn);
    await act(async () => {
      removeBtn.onPress?.();
    });
    assert.deepEqual(env.apiCalls.removeProjectArtifact, [["p1", "a1"]]);
  } finally {
    await mounted.unmount();
  }
});

test("phone ProjectSpacesPage confirms before calling spaces.setProject(spaceId, null)", async () => {
  const project = mkProject({ name: "Botkins" });
  const space = { id: "sp1", name: "Release board", projectId: "p1", mine: true } as SpaceSummary;
  const env = makePhoneTestEnv({
    project,
    bots: [],
    chats: [],
    artifacts: [],
    spaces: [space],
  });

  const { ProjectSpacesContent } = phoneModule("../src/features/projects/ProjectSpacesPage", env.imports);
  const mounted = await mount(el(ProjectSpacesContent, { project }));
  try {
    const holdMenu = mounted.root.root.findByType("HoldMenu" as any);
    await act(async () => {
      holdMenu.props.onPressAction({ nativeEvent: { event: "remove" } });
    });
    assert.equal(env.alerts.length, 1);
    assert.equal(env.alerts[0]!.title, "Remove from Botkins?");
    assert.match(env.alerts[0]!.message ?? "", /Release board/);
    assert.equal(env.apiCalls.spacesSetProject.length, 0, "API must not run before confirm");

    const removeBtn = env.alerts[0]!.buttons?.find((b) => b.style === "destructive");
    assert.ok(removeBtn);
    await act(async () => {
      removeBtn.onPress?.();
    });
    assert.deepEqual(env.apiCalls.spacesSetProject, [["sp1", null]]);
  } finally {
    await mounted.unmount();
  }
});
