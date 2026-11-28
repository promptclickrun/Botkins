// Instant press feedback & LoadingGrid tests:
// 1. Profiler benchmark with 300 chats: pressing a filter chip commits the chip's selected state
//    in an urgent render without rendering the full chat list; the deferred list commits in a
//    subsequent render.
// 2. LoadingGrid delay test: hidden below 120ms, visible after 120ms, accessible region "Loading"
//    with inner animation hidden from accessibility.
// 3. Tab isolation: background store updates do not re-render a hidden tab's body.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el, Profiler } from "react";
import { create } from "zustand";
import { applyParts, useApp } from "../src/state/store";
import * as sectionsMod from "../src/features/chat/sections";
import * as unreadMod from "../src/features/chat/unread";
import * as workOverview from "../src/features/work/overview";
import { mount, phoneModule } from "./render-phone";

test("LoadingGrid stays hidden below 120ms and renders after 120ms with accessible Loading region", async (t) => {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms = 0) => {
    const id = nextId++;
    scheduled.set(id, { fn, ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    scheduled.delete(id as unknown as number);
  }) as typeof clearTimeout;
  t.after(() => {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  });

  let animatedStarted = 0;
  let animatedCancelled = 0;
  const { LoadingGrid, LOADING_GRID_DELAY_MS } = phoneModule("../src/ui/LoadingGrid", {
    "react-native": {
      AccessibilityInfo: {
        addEventListener: () => ({ remove() {} }),
        isReduceMotionEnabled: () => Promise.resolve(false),
      },
      View: "View",
    },
    "react-native-reanimated": {
      __esModule: true,
      default: { View: "AnimatedView" },
      Easing: { linear: "linear" },
      cancelAnimation: () => { animatedCancelled++; },
      useAnimatedStyle: (fn: () => unknown) => fn(),
      useSharedValue: (v: unknown) => ({ value: v }),
      withRepeat: (v: unknown) => { animatedStarted++; return v; },
      withTiming: (v: unknown) => v,
    },
    "@/state/prefs": { usePrefs: (sel: (p: { backdrop: string }) => unknown) => sel({ backdrop: "clean" }) },
    "./theme": {
      tint: (color: string) => color,
      useTheme: () => ({ colors: { ink: "#111", accent: "#923F26" }, dark: false }),
    },
  });

  assert.equal(LOADING_GRID_DELAY_MS, 120);
  const screen = await mount(el(LoadingGrid, null));
  t.after(screen.unmount);

  // Before 120ms: nothing is rendered, and the timer is scheduled for 120ms.
  assert.equal(screen.root.toJSON(), null, "LoadingGrid must not flash before 120ms");
  assert.equal(scheduled.size, 1);
  const [[timerId, entry]] = [...scheduled.entries()];
  assert.equal(entry.ms, 120);

  // Fire the 120ms timer.
  await act(async () => {
    scheduled.delete(timerId);
    entry.fn();
  });

  const regions = screen.root.root.findAll(
    (node) => node.type === ("View" as never) && node.props.accessibilityLabel === "Loading",
  );
  assert.equal(regions.length, 1, "outer region is labeled Loading");
  assert.equal(regions[0]!.props.accessible, true);
  assert.equal(regions[0]!.props.accessibilityRole, "progressbar");

  const hiddenWrappers = screen.root.root.findAll(
    (node) => node.type === ("View" as never) && node.props.accessibilityElementsHidden === true,
  );
  assert.equal(hiddenWrappers.length, 1, "inner grid animation is hidden from accessibility");
  assert.equal(hiddenWrappers[0]!.props.importantForAccessibility, "no-hide-descendants");

  const cells = screen.root.root.findAllByType("AnimatedView" as never);
  // Each of the 9 bot tiles renders 4 AnimatedViews: tile + eyes wrapper + left eye + right eye.
  assert.equal(cells.length, 36, "3×3 Brady Bunch grid renders 9 bot tiles with eyes");
  assert.ok(animatedStarted >= 1, "Reanimated loop started");

  await screen.unmount();
  assert.ok(animatedCancelled >= 1, "Reanimated animation cancelled on unmount");
});

test("ChatList chip press with 300 chats commits chip selection before deferred list render", async (t) => {
  const useChatSplit = create(() => ({ active: false, id: null as string | null, taps: 0, pushed: null as string | null }));
  const now = Date.now();
  const bots = Array.from({ length: 12 }, (_, i) => ({ id: "b" + i, name: "Bot " + i, role: "Helper" }));
  const sections = [{ id: "s1", name: "Work" }, { id: "s2", name: "Personal" }];
  const chats = Array.from({ length: 300 }, (_, i) => ({
    id: "c" + i,
    botId: "b" + (i % 12),
    title: "Conversation " + i,
    time: now - i * 60_000,
    count: 5,
    unread: i % 5 === 0,
    sectionId: i % 3 === 0 ? "s1" : i % 3 === 1 ? "s2" : undefined,
    last: { role: "assistant", text: "Message preview text for chat " + i },
  }));

  applyParts({
    bots,
    chats,
    chatSections: sections,
    meta: { capabilities: ["chat-sections-v1"], you: { kind: "owner" } },
    live: { active: ["c0", "c1"], streams: {}, thinking: {}, requests: [], queued: {} },
    settings: {},
  });

  const reanimated = {
    __esModule: true,
    default: { View: "AnimatedView", ScrollView: "AnimatedScrollView" },
    FadeIn: { duration: () => ({}) },
    useAnimatedRef: () => ({ current: null }),
    useAnimatedScrollHandler: () => () => {},
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useFrameCallback: () => ({ setActive() {} }),
    withTiming: (v: unknown) => v,
    scrollTo: () => {},
  };

  let chipRenderPicked: string | null = null;
  let boardRenders = 0;
  let boardRowCount = 0;

  const ui = {
    BackdropLayer: "BackdropLayer",
    Badge: "Badge",
    BotAvatar: "BotAvatar",
    Chip: (p: Record<string, unknown>) => el("Chip", p),
    Dot: "Dot",
    EmptyState: "EmptyState",
    Glass: "Glass",
    Group: "Group",
    HoldMenu: (p: { children?: unknown }) => el("HoldMenu", null, p.children as never),
    IconButton: "IconButton",
    IconTile: "IconTile",
    LinkBanner: "LinkBanner",
    Loading: "Loading",
    LoadingGrid: (p: Record<string, unknown>) => el("LoadingGrid", p),
    Mascot: "Mascot",
    Row: "Row",
    T: "T",
    Tap: (p: Record<string, unknown>) => el("Tap", p),
    foldGap: () => 0,
    haptic: { tap() {}, select() {} },
    listWidth: () => 320,
    radius: { md: 12, lg: 16, pill: 999 },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, huge: 40 },
    tint: () => "transparent",
    useFrozenWhenHidden: <T,>(v: T) => v,
    useShape: () => ({ wide: false, pose: "flat", left: 0, right: 0, tabRoom: 64 }),
    useTabReady: () => true,
    useTextPrompt: () => ({ ask() {}, node: null }),
    useTheme: () => ({
      colors: {
        canvas: "#fff", surface: "#f5f5f5", sunken: "#eee", raised: "#fff",
        ink: "#000", ink2: "#222", muted: "#666", faint: "#999", line: "#ddd",
        accent: "#000", shadow: "#000",
      },
      dark: false,
      type: { callout: {} },
      control: { field: 40 },
    }),
  };

  const iconProxy = new Proxy({}, { get: (_, k) => String(k) });
  const rn = {
    Alert: { alert() {} },
    ScrollView: "ScrollView",
    StyleSheet: { hairlineWidth: 0.5 },
    TextInput: "TextInput",
    View: "View",
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
  const gesture = {
    GestureDetector: (p: { children?: unknown }) => el("GestureDetector", null, p.children as never),
    GestureStateManager: {},
    usePanGesture: () => ({}),
  };

  const ChatBoardMod = phoneModule("../src/features/chat/ChatBoard", {
    "@react-native-menu/menu": { MenuView: (p: { children?: unknown }) => el("MenuView", null, p.children as never) },
    "expo-router": { router: { push() {} } },
    "lucide-react-native": iconProxy,
    "react-native": rn,
    "react-native-gesture-handler": gesture,
    "react-native-reanimated": reanimated,
    "react-native-worklets": { scheduleOnRN: () => {} },
    "@/features/home/drag": { DRAG: { HOLD_MS: 350, SWIPE_SLOP: 8, START_PT: 6, SETTLE_MS: 180, LIFT_SCALE: 1.02, HOLD_ORDER_MS: 2000, EDGE: 60, SCROLL_MAX: 10 } },
    "@/state/hooks": {
      activityLabel: () => "",
      useCan: () => true,
      useCapability: () => false,
      useChatActivity: () => "idle",
      usePart: (k: string) => useApp((s) => s.parts[k as keyof typeof s.parts]),
    },
    "@/state/link": { api: {}, attempt: async () => {} },
    "@/state/store": { useApp },
    "@/state/time": { ago: () => "1m" },
    "./split": { openFromList: () => {}, useChatSplit },
    "@/ui": ui,
    "./bits": { GroupFace: "GroupFace", plainPreview: (text: string) => text },
    "./people": { myPlace: () => "manages", myself: () => ({ kind: "owner" }) },
    "./sectionMenus": { moveToSection: () => ({ id: "s", title: "Move" }), runSectionAction: () => {}, runSectionChoice: () => false, sectionActions: () => [] },
    "./sections": sectionsMod,
    "./titleActions": { regenerateTitle: () => {}, regenerateTitleAction: { id: "regen", title: "Regen" } },
  });

  const origBoard = ChatBoardMod.ChatBoard;
  const ChatChipsStub = ({ chips, picked, onPick }: { chips: { value: string; label: string }[]; picked: string; onPick: (v: string) => void }) => {
    chipRenderPicked = picked;
    return el(
      "ChatChips",
      { picked },
      chips.map((c) => el("Chip", { key: c.value, label: c.label, selected: picked === c.value, onPress: () => onPick(c.value) })),
    );
  };

  const ChatListMod = phoneModule("../src/features/chat/ChatList", {
    "@react-native-menu/menu": { MenuView: (p: { children?: unknown }) => el("MenuView", null, p.children as never) },
    "expo-router": { router: { push() {} }, useIsFocused: () => true, useScrollToTop: () => {} },
    "lucide-react-native": iconProxy,
    "react-native": rn,
    "react-native-reanimated": reanimated,
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }) },
    "@/state/hooks": {
      activityLabel: () => "",
      isConversation: () => true,
      useBots: () => useApp((s) => s.parts.bots ?? []),
      useCan: () => true,
      useCapability: () => true,
      useChatActivity: () => "idle",
      useChats: () => useApp((s) => s.parts.chats ?? []),
      useOnline: () => true,
      usePart: (k: string) => useApp((s) => s.parts[k as keyof typeof s.parts]),
      useSettings: () => ({}),
    },
    "@/state/link": { api: {}, attempt: async () => {} },
    "@/state/prefs": { usePrefs: (sel: (p: { backdrop: string; chatChipOrder: string[] }) => unknown) => sel({ backdrop: "clean", chatChipOrder: [] }) },
    "@/state/store": { useApp },
    "@/ui": ui,
    "./bits": { GroupFace: "GroupFace" },
    "./ChatBoard": {
      ChatBoard: (p: { chats: unknown[] }) => {
        boardRenders++;
        boardRowCount = p.chats.length;
        return el(origBoard, p as never);
      },
    },
    "./ChatScreen": { ChatPane: "ChatPane" },
    "./navigate": { openChat: () => {} },
    "./open": { markChatsPageRead: async () => {} },
    "./split": { openFromList: () => {}, useChatSplit },
    "./sectionMenus": { newSection: () => {} },
    "./ChatChips": { ChatChips: ChatChipsStub },
    "./sections": sectionsMod,
    "./unread": unreadMod,
  });

  type Commit = {
    phase: string;
    actualDuration: number;
    picked: string | null;
    boardRenders: number;
    boardRowCount: number;
  };
  const commits: Commit[] = [];
  const onRender = (_id: string, phase: string, actualDuration: number) => {
    commits.push({
      phase,
      actualDuration,
      picked: chipRenderPicked,
      boardRenders,
      boardRowCount,
    });
  };

  const screen = await mount(el(Profiler, { id: "ChatList", onRender }, el(ChatListMod.default)));
  t.after(screen.unmount);

  // Switch Unread -> All -> Unread -> All and assert each press splits into an urgent chip commit
  // (0 board renders!) followed by a deferred list commit.
  const firstCommitTimes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const label = i % 2 === 0 ? "Unread" : "All";
    const expectedValue = i % 2 === 0 ? "unread" : "all";
    commits.length = 0;
    boardRenders = 0;
    boardRowCount = 0;
    const chip = screen.root.root.findAll((node) => node.type === ("Chip" as never) && node.props.label === label)[0];
    assert.ok(chip, "chip " + label + " exists");
    await act(async () => {
      chip.props.onPress();
    });
    assert.ok(commits.length >= 2, `expected urgent + deferred commits for ${label}, got ${commits.length}`);
    const urgent = commits[0]!;
    const deferred = commits[1]!;
    assert.equal(urgent.picked, expectedValue, "chip selected state updates in the urgent first commit");
    assert.equal(urgent.boardRenders, 0, "urgent first commit must NOT render ChatBoard");
    assert.ok(deferred.boardRenders >= 1, "deferred commit renders ChatBoard for the new filter");
    if (i > 0) firstCommitTimes.push(urgent.actualDuration);
  }
  const avg = firstCommitTimes.reduce((a, b) => a + b, 0) / firstCommitTimes.length;
  t.diagnostic(`AFTER 300-chat chip press urgent commit avg=${avg.toFixed(2)}ms (${firstCommitTimes.map((v) => v.toFixed(2)).join(", ")})`);
});

test("hidden Work tab does not re-render its body when chats change on another tab", async (t) => {
  const useVisible = create(() => true);
  const now = Date.now();
  const bots = Array.from({ length: 4 }, (_, i) => ({ id: "b" + i, name: "Bot " + i, role: "Helper" }));
  const chats = Array.from({ length: 20 }, (_, i) => ({
    id: "c" + i, botId: "b" + (i % 4), title: "Chat " + i, time: now - i * 1000, count: 1,
    last: { role: "assistant", text: "Hi " + i },
  }));
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: "t" + i, title: "Task " + i, status: "working", botId: "b0", createdAt: now, updatedAt: now,
  }));
  applyParts({
    bots, chats, tasks, projects: [],
    meta: { capabilities: [], you: { kind: "owner" } },
    live: { active: [], streams: {}, thinking: {}, requests: [], queued: {} },
    settings: {},
  });

  const { useFrozenWhenHidden } = phoneModule("../src/ui/useTabReady", {
    "./useOnShow": { useOnShow: () => useVisible((v) => v) },
  });

  let taskRowDraws = 0;
  const iconProxy = new Proxy({}, { get: (_, k) => String(k) });
  const WorkMod = phoneModule("../src/features/work/Work", {
    "expo-router": { router: { push() {} } },
    "@react-native-menu/menu": { MenuView: (p: { children?: unknown }) => el("MenuView", null, p.children as never) },
    "lucide-react-native": iconProxy,
    "react-native": { Alert: { alert() {} }, ScrollView: "ScrollView", Switch: "Switch", View: "View" },
    "@/features/chat/navigate": { openChat: () => {} },
    "@/features/projects/colors": { projectColor: () => "#888" },
    "@/state/hooks": {
      useBots: () => useApp((s) => s.parts.bots ?? []),
      useCan: () => true,
      useChats: () => useApp((s) => s.parts.chats ?? []),
      useMember: () => false,
      usePart: (k: string) => useApp((s) => s.parts[k as keyof typeof s.parts]),
      useRoutines: () => [],
      useWorkflowRuns: () => [],
      useWorkflows: () => [],
    },
    "@/state/link": { api: {}, attempt: async () => {} },
    "@/state/prefs": { usePrefs: (sel: (p: { backdrop: string }) => unknown) => sel({ backdrop: "clean" }) },
    "@/state/store": { useApp },
    "@/state/time": { ago: () => "1m", clockTime: () => "9:00", upcoming: () => "soon" },
    "@/ui": {
      BotAvatar: "BotAvatar", Button: "Button", Chip: "Chip", Dot: "Dot", EmptyState: "EmptyState",
      Glass: "Glass", Group: "Group", HoldMenu: (p: { children?: unknown }) => el("HoldMenu", null, p.children as never),
      IconButton: "IconButton", IconTile: "IconTile", Label: "Label", Loading: "Loading",
      LoadingGrid: "LoadingGrid", Mascot: "Mascot", Page: (p: { children?: unknown }) => el("Page", null, p.children as never),
      Row: "Row", T: "T", Tap: "Tap",
      haptic: { select() {} }, radius: { md: 12, lg: 16 },
      space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20 },
      switchColors: () => ({}), tint: () => "transparent",
      useFrozenWhenHidden,
      useTabReady: () => true,
      useTheme: () => ({ colors: { accent: "#000", onAccent: "#fff", faint: "#999", muted: "#666", sunken: "#eee", surface: "#fff", warning: "#a60" }, dark: false }),
    },
    "./bits": {
      isFinished: () => false, routineName: () => "R", routineSubtitle: () => "",
      SplitRow: (p: Record<string, unknown>) => { taskRowDraws++; return el("SplitRow", p); },
      taskSubtitle: () => "sub",
    },
    "./notifyTargets": { buildNotifyTargetView: () => null },
    "./cron": { cronLabel: () => "", scheduleLabel: () => "" },
    "./overview": workOverview,
  });

  const screen = await mount(el(WorkMod.default));
  t.after(screen.unmount);
  assert.ok(taskRowDraws > 0, "Work renders its tasks when visible");

  // Switch away from Work tab.
  await act(async () => useVisible.setState(false, true));
  taskRowDraws = 0;

  // Update a chat on another tab (Chats): Work's body must stay frozen.
  await act(async () => {
    applyParts({ chats: chats.map((c, i) => (i === 0 ? { ...c, unread: true, time: now + 5000 } : c)) });
  });
  assert.equal(taskRowDraws, 0, "hidden Work tab must not re-render when chats update");
});
