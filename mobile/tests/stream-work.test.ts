import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createContext, createElement as el, Fragment, Profiler } from "react";
import { Marked } from "marked";
import { useApp } from "../src/state/store";
import { mount, phoneModule } from "./render-phone";
import { setup } from "./smooth-link";
import { WorkingChat } from "./working-chat";

const native = { Text: "Text", View: "View", StyleSheet: {}, Platform: { OS: "ios" } };
const prefs = phoneModule("../src/state/chatPrefs", { "react-native": native, "@/state/keep": { readKept: async () => null } });
let lexed = 0;
class CountedMarked extends Marked {
  lexer(text: string, options?: Parameters<Marked["lexer"]>[1]) {
    lexed += text.length;
    return super.lexer(text, options);
  }
}
const theme = { colors: { ink: "ink" }, type: { callout: {}, footnote: {}, small: {} } };
const openLink = () => {};
const { Markdown } = phoneModule("../src/ui/Markdown", {
  "expo-clipboard": {}, "lucide-react-native": {}, "react-native": native, marked: { Marked: CountedMarked },
  "@/state/chatPrefs": prefs, "./haptics": {}, "./Tap": {}, "./theme": { useTheme: () => theme },
  "./LinkHold": { LinkHold: createContext(null), MessageLink: createContext(openLink), openLink },
  "./inlineTags": { InlineTagsContext: createContext(null), withTags: (text, _tags, _color, key, render) => render(text, key) },
});
let selections = 0;
const countedStore = {
  useApp(select) {
    return useApp((state) => select(new Proxy(state, { get(target, key) {
      if (key === "texts") selections++;
      return Reflect.get(target, key);
    } })));
  },
};
const { LiveTurn } = phoneModule("../src/features/chat/LiveTurn", {
  "@/state/store": countedStore, "react-native": native, "@/ui": { Markdown, T: "T", space: { sm: 8 } }, "@/state/chatPrefs": prefs,
  "@/state/hooks": { useChatActivity: () => "talking", activityLabel: () => "Replying" }, "./bits": {}, "./Aside": { Aside: "Aside" }, "./WorkRows": {},
});

for (const [on, otherWork] of [[true, false], [true, true], [false, false]]) {
  test(`ten seconds of reply tokens with streaming ${on ? "on" : "off"} and ${otherWork ? "busy" : "quiet"} other chats`, async (t) => {
    const { backend, mine, wire, timers, additions, start, client, advance, step } = await setup(t, false, {
      textStreaming: (route) => prefs.textMode(on, route, useApp.getState().parts.meta?.capabilities),
    });
    backend.state.streams[mine.id] = "Ready ";
    backend.changed();
    client.watch([mine.id]);
    await start();
    const item = { kind: "live", bodyMode: "raw", key: "reply", text: "", thinking: "", steps: [] } as const;
    const bots = new Map();
    let historyRenders = 0;
    function History() {
      useApp((state) => state.chats[mine.id]?.messages);
      historyRenders++;
      return null;
    }
    const island = { kind: "fold", live: true, run: { id: "turn", time: Date.now(), status: "Working", steps: [] } };
    let clockRenders = 0;
    let draws = 0;
    const screen = await mount(el(Fragment, null, el(History),
      el(Profiler, { id: "working", onRender: () => { clockRenders++; } }, el(WorkingChat, { chatId: mine.id, item: island })),
      el(Profiler, { id: "reply", onRender: () => { draws++; } }, el(LiveTurn, { chatId: mine.id, bots, group: false, item }))));
    t.after(screen.unmount);
    await act(async () => {
      for (const view of screen.root.root.findAll((node) => node.type === "View" && typeof node.props.onLayout === "function")) {
        view.props.onLayout({ nativeEvent: { layout: { width: 120 } } });
      }
    });
    const before = { ...wire };
    timers.reset();
    let updates = 0;
    const stop = useApp.subscribe(() => updates++);
    t.after(stop);
    draws = selections = historyRenders = lexed = clockRenders = 0;
    additions.length = 0;
    const perSecond: number[] = [];
    let previous = 0;
    for (let i = 0; i < 500; i++) {
      backend.state.streams[mine.id] += "word ";
      if (otherWork && i % 5 === 0) step();
      else backend.changed();
      await act(() => advance(20));
      if (i % 50 === 49) {
        perSecond.push(additions.length - previous);
        previous = additions.length;
      }
    }
    const received = additions.length;
    t.diagnostic(JSON.stringify({ syncs: wire.syncs - before.syncs, received, updates, replyRenders: draws, historyRenders, bodySelectorCalls: selections, lexerInput: lexed, clockRenders, sentBytes: wire.sentBytes - before.sentBytes, receivedBytes: wire.receivedBytes - before.receivedBytes, perSecond, timers: timers.snapshot() }));
    assert.equal(historyRenders, 0);
    assert.equal(clockRenders, 10);
    assert.equal(timers.snapshot().fired["features/chat/useElapsedClock.ts"], 10);
    assert.ok(perSecond.every((count) => on ? count >= 1 && count <= 2 : count === 0));
    if (on) {
      assert.ok(received > 0 && received <= 20, "the person sees words regularly without drawing every token");
      assert.ok(wire.syncs - before.syncs <= 20 && updates <= 20 && selections <= 90);
      assert.ok(draws > 0 && draws <= 20);
      assert.ok(lexed > 0 && lexed < 27_000, "the growing paragraph is formatted at word-chunk cadence");
    } else {
      assert.equal(received, 0);
      assert.equal(draws, 0);
      assert.equal(updates, 0);
    }
    await act(() => advance(1000));
    await act(() => advance(100));
    if (on) {
      assert.equal(additions.map((part) => part.add).join(""), "word ".repeat(500), "each byte crossed the link once");
      assert.equal(useApp.getState().texts[mine.id]?.stream, backend.state.streams[mine.id]);
    }
    const reply = backend.state.streams[mine.id];
    delete backend.state.streams[mine.id];
    mine.messages.push({ role: "assistant", text: reply });
    backend.changed();
    await act(() => advance(100));
    assert.equal(useApp.getState().chats[mine.id]?.messages.at(-1)?.text, reply);
    const quiet = wire.syncs;
    await act(() => advance(10_000));
    assert.equal(wire.syncs, quiet, "the finished turn leaves one quiet long poll");
  });
}


test("scrolling the island out of view stops its shimmer and clock while the chat stays focused", async (t) => {
  const { mine, start, advance, timers } = await setup(t);
  await start();
  const item = { kind: "fold", live: true, run: { id: "island", time: Date.now(), steps: [], status: "Working" } };
  const card = (inView: boolean) => el(WorkingChat, { chatId: mine.id, item, inView });
  const screen = await mount(card(true));
  t.after(screen.unmount);
  await act(async () => {
    for (const view of screen.root.root.findAll((node) => node.type === "View" && typeof node.props.onLayout === "function")) {
      view.props.onLayout({ nativeEvent: { layout: { width: 120 } } });
    }
  });
  assert.ok(timers.snapshot().active.includes("ui/shimmerSteps.ts"));
  await act(async () => screen.root.update(card(false)));
  timers.reset();
  for (let n = 0; n < 500; n++) await act(() => advance(20));
  const { fired, active } = timers.snapshot();
  t.diagnostic(JSON.stringify({ hiddenShimmerTicks: fired["ui/shimmerSteps.ts"] ?? 0, hiddenClockTicks: fired["features/chat/useElapsedClock.ts"] ?? 0 }));
  assert.equal(fired["ui/shimmerSteps.ts"] ?? 0, 0);
  assert.equal(fired["features/chat/useElapsedClock.ts"] ?? 0, 0);
  assert.deepEqual(active, ["link/client.ts", "ui/avatarRest.ts"]);
});

test("a phone with an older computer streams supported direct appends or asks for the whole reply", () => {
  const appends = ["stream-appends-v1"];
  assert.equal(prefs.textMode(true, "direct", appends), "live");
  assert.equal(prefs.textMode(true, "relay", appends), "whole");
  assert.equal(prefs.textMode(true, "direct", []), "whole");
  assert.equal(prefs.textMode(true, "direct"), "whole");
  assert.equal(prefs.textMode(false, "direct", appends), "whole");
});
