import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import { create } from "zustand";
import { applyParts, useApp } from "../src/state/store";
import * as model from "../src/features/chat/islandModel";
import { mount, phoneModule } from "./render-phone";

const theme = { colors: {}, control: { row: 44 }, type: { footnote: { lineHeight: 16 } }, dark: true };
const ui = { useTheme: () => theme, space: {}, T: "T", Group: "Group", Tap: "Tap", BotAvatar: "Avatar", tint: () => "" };

test("one run changing draws one Activity row and hidden working rows stop pulsing", async (t) => {
  const useVisibility = create(() => ({ shown: true, active: true }));
  let draws = 0;
  const { ActivityList } = phoneModule("../src/features/work/Activity", {
    "expo-router": {}, "react-native": { View: "View" }, "./bits": { RunIcon: "RunIcon" },
    "@/features/chat/ActivityWidgets": { ShimmerLabel: "Pulse", IconStack: "Icons" },
    "@/state/hooks": {
      useBots: () => [], useChats: () => [], useSettings: () => undefined,
      usePart: (name) => useApp((state) => state.parts[name]),
    },
    "@/state/useAppActive": { useAppActive: (shown) => useVisibility((state) => shown && state.active) },
    "@/ui": { ...ui, Tap: (props) => { draws++; return el("Tap", props); }, useOnShow: () => useVisibility((state) => state.shown) },
  });
  const runs = Array.from({ length: 40 }, (_, i) => ({
    id: String(i), chatId: "chat", time: Date.now(), title: "Run " + i, status: i < 3 ? "Working" : "Completed", stepCount: 1, summary: "1 step",
  }));
  applyParts({ runs });
  const screen = await mount(el(ActivityList));
  t.after(screen.unmount);
  const active = () => screen.root.root.findAllByType("Pulse").filter((node) => node.props.active).length;
  assert.equal(draws, 40);
  assert.equal(active(), 3);
  draws = 0;
  await act(async () => applyParts({ runs: runs.map((row, i) => i === 0 ? { ...row, summary: "2 steps", stepCount: 2 } : row) }));
  t.diagnostic(draws + " Activity rows drawn for one changed run");
  assert.equal(draws, 1);
  await act(async () => useVisibility.setState({ shown: false }));
  assert.equal(active(), 0);
  await act(async () => useVisibility.setState({ shown: true, active: false }));
  assert.equal(active(), 0);
  await act(async () => useVisibility.setState({ active: true }));
  assert.equal(active(), 3);
});

test("ten island clock ticks update ten time labels without rereading the turn or its collapsed list", async (t) => {
  const motion = { duration() { return this; }, reduceMotion() { return this; } };
  const useTime = create(() => 10_000);
  let headings = 0;
  let lists = 0;
  let timeLabels = 0;
  const { Island } = phoneModule("../src/features/chat/Island", {
    "react-native": { View: "View", StyleSheet: {}, useWindowDimensions: () => ({ fontScale: 1, height: 800 }) },
    "react-native-svg": {}, "lucide-react-native": { ChevronRight: "Chevron", Brain: "Brain" }, "expo-router": {},
    "react-native-reanimated": { __esModule: true, default: { View: "Animated" }, FadeInDown: motion, LinearTransition: motion, ReduceMotion: {}, LayoutAnimationConfig: "Layout" },
    "@/state/chatPrefs": { useChatPrefs: (select) => select({ steps: "show", thinking: "show" }) },
    "@/ui": ui, "@/ui/Shimmer": { Shimmer: "Shimmer" }, "./WorkRows": { stepIcon: () => "Icon" },
    "./useElapsedClock": { useElapsedClock: (on) => useTime((now) => on ? now : 0) },
    "./islandModel": {
      ...model,
      islandFacts: (...args) => { timeLabels++; return model.islandFacts(...args); },
      thinkingHeading: (run) => { headings++; return model.thinkingHeading(run); },
      islandLines: (...args) => { lists++; return model.islandLines(...args); },
    },
  });
  const steps = Array.from({ length: 3 }, (_, i) => ({ id: "s" + i, name: "read", started: i, status: "Done" }));
  const run = { id: "r", time: 1000, status: "Working", steps, reasoning: [{ id: "a", started: 4, text: "**Reading** Some reasoning" }] };
  const item = { kind: "fold", live: true, run };
  const screen = await mount(el(Island, { chatId: "c", group: false, item, inView: true }));
  t.after(screen.unmount);
  const mountLists = lists;
  headings = lists = timeLabels = 0;
  for (let i = 1; i <= 10; i++) await act(async () => useTime.setState(10_000 + i * 1000, true));
  t.diagnostic(JSON.stringify({ timeLabels, headings, lists, mountLists }));
  assert.deepEqual({ timeLabels, headings, lists, mountLists }, { timeLabels: 10, headings: 0, lists: 0, mountLists: 1 });
});

test("a collapsed receipt does not format every thought when it scrolls into view", async (t) => {
  let formatted = 0;
  const motion = { duration() { return this; }, reduceMotion() { return this; } };
  const { Island } = phoneModule("../src/features/chat/Island", {
    "react-native": { View: "View" }, "react-native-svg": {}, "lucide-react-native": { Check: "Check", ChevronRight: "Chevron" }, "expo-router": {},
    "react-native-reanimated": { FadeInDown: motion, LinearTransition: motion, ReduceMotion: {} },
    "@/ui": ui, "@/ui/Shimmer": {}, "./WorkRows": {}, "./useElapsedClock": {}, "@/state/chatPrefs": {},
    "./islandModel": { ...model, thoughtParts: (text) => { formatted++; return model.thoughtParts(text); } },
  });
  const entries = Array.from({ length: 100 }, (_, i) => ({ kind: "thought", key: String(i), text: "**Thinking** About " + i }));
  const screen = await mount(el(Island, { chatId: "c", group: false, inView: true, item: { kind: "fold", run: { id: "r" }, line: "Worked 48s", entries } }));
  t.after(screen.unmount);
  assert.equal(formatted, 0);
});

test("a covered conversation releases its reasoning and the focused sheet can read its own", async (t) => {
  const focus = create(() => true);
  const active = create(() => true);
  const calls: string[] = [];
  const { useWatchedReasoning } = phoneModule("../src/features/chat/useWatchedReasoning", {
    "expo-router": { useIsFocused: () => focus((shown) => shown) },
    "@/state/useAppActive": { useAppActive: (enabled) => active((front) => enabled && front) },
    "@/state/link": { watchReasoning(id) { calls.push("open " + id); return () => calls.push("close " + id); } },
  });
  function Reader({ chat }) { useWatchedReasoning(chat, true); return null; }
  const screen = await mount(el(Reader, { chat: "conversation" }));
  t.after(screen.unmount);
  await act(async () => focus.setState(false, true));
  await act(async () => screen.root.update(el(Reader, { chat: "sheet" })));
  assert.deepEqual(calls, ["open conversation", "close conversation"]);
  await act(async () => focus.setState(true, true));
  await act(async () => active.setState(false, true));
  assert.deepEqual(calls, ["open conversation", "close conversation", "open sheet", "close sheet"]);
});
