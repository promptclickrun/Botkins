// The crew card in the chat (src/features/chat/CrewCard.tsx) starts folded and costs nothing there:
// it reads no run, ticks no clock and shimmers nothing until a tap opens it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import { create } from "zustand";
import { mount, phoneModule } from "./render-phone";

test("a folded crew card reads no run and ticks no clock; open, it lists each member", async (t) => {
  let reads = 0;
  let draws = 0;
  const clocks: boolean[] = [];
  const shimmers: boolean[] = [];
  const run = {
    id: "r1", time: 0, status: "Working",
    steps: [{ id: "dev", name: "bash", label: "npm run dev", status: "Running", started: 2, background: true, stoppable: true, input: JSON.stringify({ command: "npm run dev" }) }],
    agents: [{ id: "h1", name: "Code searcher", status: "Running", started: 1, intent: "Reading cart.ts", stoppable: true }],
  };
  const useRuns = create(() => ({ running: { c1: run }, chats: {} }));
  const T = (props: { children?: unknown }) => {
    draws++;
    return el("T", props);
  };
  const { CrewCard } = phoneModule("../src/features/chat/CrewCard", {
    "expo-router": { router: { push() {} } },
    "lucide-react-native": { ChevronDown: "Down", ChevronRight: "Right", Users: "Users" },
    "react-native": { Alert: { alert() {} }, StyleSheet: { hairlineWidth: 0.5 }, View: "View" },
    "@/state/hooks": { useCapability: () => true },
    "@/state/link": { api: {} },
    "@/state/store": {
      showToast() {},
      useApp: (select: (state: unknown) => unknown) => {
        reads++;
        return useRuns(select as never);
      },
    },
    "@/ui": { Button: "Button", T, Tap: "Tap", useOnShow: () => true, useTheme: () => ({ colors: {}, dark: true }) },
    "@/ui/Shimmer": { Shimmer: (props: { on: boolean; children: unknown }) => (shimmers.push(props.on), el("Shimmer", null, props.children)) },
    "./bits": { StepMark: "Mark", workWidth: {} },
    "./HelperRail": { commandSheet: () => "", helperSheet: () => "" },
    "./useElapsedClock": { useElapsedClock: (on: boolean) => (clocks.push(on), 10_000) },
  });
  const item = { kind: "crew", key: "c:r1", runId: "r1", line: "1 helper · 1 command · 2 working", marks: ["Running", "Running"], live: true, at: 1 };
  const screen = await mount(el(CrewCard, { chatId: "c1", item }));
  t.after(screen.unmount);
  const tree = screen.root.root;
  assert.equal(reads, 0, "folded, it reads no run");
  assert.deepEqual(clocks, [], "and has no clock");
  assert.equal(tree.findAllByType("Mark" as never).length, 2, "one still mark per member");

  // The turn moves on: the chat hands the same item again, and the folded row isn't drawn again.
  draws = 0;
  await act(async () => screen.root.update(el(CrewCard, { chatId: "c1", item })));
  await act(async () => useRuns.setState({ running: { c1: { ...run, steps: [...run.steps] } } }));
  assert.equal(draws, 0);
  assert.equal(reads, 0);

  const head = tree.findAll((node) => node.type === ("Tap" as never) && node.props.accessibilityLabel === "Crew, " + item.line)[0];
  await act(async () => head.props.onPress());
  assert.ok(reads > 0, "open, it reads the run");
  const rows = tree.findAll((node) => node.type === ("Tap" as never) && /show (helper|output)$/.test(node.props.accessibilityLabel ?? ""));
  assert.deepEqual(rows.map((row) => row.props.accessibilityLabel), ["Code searcher, Running, Reading cart.ts, show helper", "npm run dev, Running, show output"]);
  assert.ok(clocks.includes(true), "a running member's time ticks while open");
  assert.ok(shimmers.includes(true), "and its line shimmers");
  assert.equal(tree.findAllByType("Button" as never).length, 0, "no Stop while the turn runs");

  // Folded again: nothing ticks.
  clocks.length = 0;
  await act(async () => head.props.onPress());
  await act(async () => useRuns.setState({ running: { c1: { ...run } } }));
  assert.deepEqual(clocks, []);
});

test("after the turn ended, a background command still running keeps Stop on its row", async (t) => {
  const run = {
    id: "r2", time: 0, status: "Completed", finished: 50,
    steps: [{ id: "dev", name: "bash", label: "npm run dev", status: "Running", started: 2, background: true, stoppable: true, progress: "ready", input: JSON.stringify({ command: "npm run dev" }) }],
    agents: [{ id: "h1", name: "Docs reader", status: "Done", started: 1, finished: 9, result: "Once per invoice." }],
  };
  const { CrewCard } = phoneModule("../src/features/chat/CrewCard", {
    "expo-router": { router: { push() {} } },
    "lucide-react-native": { ChevronDown: "Down", ChevronRight: "Right", Users: "Users" },
    "react-native": { Alert: { alert() {} }, StyleSheet: { hairlineWidth: 0.5 }, View: "View" },
    "@/state/hooks": { useCapability: () => true },
    "@/state/link": { api: {} },
    "@/state/store": { showToast() {}, useApp: (select: (state: unknown) => unknown) => select({ running: {}, chats: { c2: { runs: { r2: run } } } }) },
    "@/ui": { Button: "Button", T: "T", Tap: "Tap", useOnShow: () => true, useTheme: () => ({ colors: {}, dark: false }) },
    "@/ui/Shimmer": { Shimmer: "Shimmer" },
    "./bits": { StepMark: "Mark", workWidth: {} },
    "./HelperRail": { commandSheet: () => "", helperSheet: () => "" },
    "./useElapsedClock": { useElapsedClock: () => 60 },
  });
  const item = { kind: "crew", key: "c:r2", runId: "r2", line: "1 helper · 1 command · 1 working", marks: ["Done", "Running"], live: false, at: 1 };
  const screen = await mount(el(CrewCard, { chatId: "c2", item }));
  t.after(screen.unmount);
  const head = screen.root.root.findAll((node) => node.type === ("Tap" as never) && node.props.accessibilityLabel === "Crew, " + item.line)[0];
  await act(async () => head.props.onPress());
  const stops = screen.root.root.findAllByType("Button" as never);
  assert.deepEqual(stops.map((button) => button.props.accessibilityLabel), ["Stop npm run dev"]);
});
