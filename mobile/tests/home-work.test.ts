import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el, Profiler, useRef } from "react";
import * as activity from "../src/state/sessionActivity";
import { useApp } from "../src/state/store";
import { mount, phoneModule } from "./render-phone";
import { setup } from "./smooth-link";
import { BotAvatar } from "./working-chat";

let scans = 0;
const hooks = phoneModule("../src/state/hooks", {
  "@/ui/useOnShow": {}, "./useAppActive": {}, "./link": {},
  "./sessionActivity": { ...activity, botActivity: (...args) => { scans++; return activity.botActivity(...args); } },
});
const size = { height: 800, width: 390 };
const insets = { top: 0, bottom: 0, right: 0, left: 0, tabRoom: 0 };
const theme = { colors: {} };
// Any other part of the kit a screen draws stands in as its own name, so every state of Home can be mounted.
const ui = new Proxy({ useTheme: () => theme, useShape: () => insets, space: {}, badgeColors: () => ({}), slopFor: () => 0,
  useFrozenWhenHidden: <T,>(v: T) => v, Loading: "Loading",
  BackdropLayer: "Backdrop", BotAvatar, Button: "Button", Chip: "Chip", Dot: "Dot", Group: "Group", HoldMenu: "Menu", Label: "Label",
  IconButton: "IconButton", IconTile: "IconTile", LinkBanner: "Banner", Row: "Row", T: "T", Tap: "Tap" },
  { get: (kit, name) => (name in kit ? kit[name] : typeof name === "string" && /^[A-Z]/.test(name) ? name : undefined) });
const animated = { __esModule: true, default: { ScrollView: "ScrollView", View: "View" }, FadeIn: { duration: () => 0 }, FadeOut: { duration: () => 0 },
  useAnimatedRef: () => useRef(null), useSharedValue: (value) => useRef({ value }).current, useAnimatedScrollHandler: () => undefined };
const native = { ActivityIndicator: "ActivityIndicator", ScrollView: "ScrollView", View: "View", useWindowDimensions: () => size };
// The link's own line draws icons when the link is not up: each stands in as its own name.
const icons = new Proxy({}, { get: (_, name) => (typeof name === "string" && /^[A-Z]/.test(name) ? name : undefined) });
const { ServerLinkStatus } = phoneModule("../src/features/home/ServerLinkStatus", {
  "lucide-react-native": icons, "react-native": native, "react-native-reanimated": animated, "@/state/link": {}, "@/ui": ui,
});
const pushed: unknown[] = [];
const openedChats: string[] = [];
// A drop's held order (useHeldOrder), with the same link the test gives Home.
const heldOrder = phoneModule("../src/features/home/useHeldOrder", { "@/state/link": {} });
const Home = phoneModule("../src/features/home/Home", {
  "./useHeldOrder": heldOrder,
  "expo-router": { useScrollToTop() {}, router: { push: (target: unknown) => pushed.push(target) } },
  "lucide-react-native": {}, "react-native": native, "react-native-reanimated": animated,
  "react-native-safe-area-context": { useSafeAreaInsets: () => insets }, "react-native-worklets": {},
  "@react-native-menu/menu": { MenuView: "MenuView" }, "@/features/chat/request/logic": { looksDangerous: () => false },
  "@/features/chat/navigate": { openChat: (id: string) => openedChats.push(id) }, "@/features/chat/open": {},
  "@/features/spaces/data": { useSpacesOn: () => true }, "@/features/spaces/HomePins": { HomePins: "Pins" },
  "@/features/today/Today": { makeSeenSignal: () => ({}) }, "@/state/link": {}, "@/state/hooks": hooks,
  "@/state/prefs": { usePrefs: (select) => select({ backdrop: "clean", computerOrder: [] }) },
  "@/state/profile": { useProfileHosts: () => [] }, "@/features/bots/agents": {}, "@/ui": ui,
  "./BotBoard": { BotBoard: "Board", BotMenu: "Menu" }, "./computers": {}, "./ServerLinkStatus": { ServerLinkStatus },
}).default;

test("Home opens a pending chat through openChat and a node job through the approval sheet", async (t) => {
  const previous = useApp.getState();
  useApp.setState({
    link: "online",
    synced: false,
    parts: {
      live: { requests: [
        { id: "chat-request", chatId: "chat-1", botId: "bot", kind: "permission", title: "Chat approval" },
        { id: "node-request", chatId: "node-job-1", botId: "bot", kind: "permission", title: "Node approval", nodeJob: true,
          sourceBotName: "Alfie", sourceHostName: "Studio" },
      ] },
    },
  });
  const screen = await mount(el(Home));
  t.after(async () => {
    await screen.unmount();
    useApp.setState(previous);
  });
  const [chat, node] = screen.root.root.findAllByType("Row");
  assert.equal(node.props.subtitle, "Alfie on Studio needs approval");
  chat.props.onPress();
  node.props.onPress();
  assert.deepEqual(openedChats, ["chat-1"]);
  assert.deepEqual(pushed, [{ pathname: "/node-approval", params: { request: "node-request", chat: "node-job-1" } }]);
});

// The app closed when "Operate all bots in one view" was switched while Home was mounted: Home read
// the computer's name with a hook only when unified mode was off, so the number of hooks changed with
// the mode and React threw while drawing. Every hook now runs on every render.
test("Home stays up when unified mode goes off and on under it", async (t) => {
  const previous = useApp.getState();
  const pairing = { serverId: "h1", name: "Studio" };
  const hosts = [{ id: "h1", included: true, state: "online" }, { id: "h2", included: true, state: "online" }];
  const bots = [{ id: "bot", name: "Pip" }];
  useApp.setState({ link: "online", synced: true, pairing, pairings: [pairing, { serverId: "h2", name: "Mini" }], unified: true, unifiedHosts: hosts, parts: { bots, chats: [] } } as never);
  const screen = await mount(el(Home));
  t.after(async () => {
    await screen.unmount();
    useApp.setState(previous);
  });
  const pill = () => screen.root.root.findAllByType("Tap").map((tap) => tap.props.accessibilityLabel).find((label) => / connected/.test(label ?? ""));
  assert.match(pill()!, /^All computers, connected/);
  // Switched off: the link starts over on one computer, as startOver does (src/state/link.ts).
  await act(async () => useApp.setState({ unified: false, unifiedHosts: [], link: "connecting", route: null, synced: false, parts: {}, texts: {}, chats: {}, running: {} } as never));
  assert.match(pill()!, /^Studio, not connected/);
  // That computer answers.
  await act(async () => useApp.setState({ link: "online", synced: true, parts: { bots, chats: [] } } as never));
  assert.match(pill()!, /^Studio, connected/);
  // And on again.
  await act(async () => useApp.setState({ unified: true, unifiedHosts: hosts } as never));
  assert.match(pill()!, /^All computers, connected/);
});

for (const busy of [false, true]) {
  test("Home with three pinned bots " + (busy ? "working in other chats" : "at rest"), async (t) => {
    const { backend, wire, timers, start, advance, step } = await setup(t);
    backend.state.bots = backend.state.bots.slice(0, 3).map((bot) => ({ ...bot, pinned: true }));
    if (!busy) {
      backend.state.streams = {};
      backend.state.runs = backend.state.runs.filter((run) => run.status !== "Working");
    }
    backend.changed();
    await start();
    useApp.setState({ link: "online" });
    let renders = 0;
    const screen = await mount(el(Profiler, { id: "home", onRender: () => { renders++; } }, el(Home)));
    t.after(screen.unmount);
    const before = wire.syncs;
    let stores = 0;
    t.after(useApp.subscribe(() => stores++));
    renders = scans = 0;
    timers.reset();
    for (let n = 0; n < 100; n++) {
      if (busy) step();
      await act(() => advance(busy ? 100 : 1000));
    }
    const stats = timers.snapshot();
    t.diagnostic(JSON.stringify({ seconds: busy ? 10 : 100, syncs: wire.syncs - before, stores, renders, scans, timers: stats }));
    assert.equal(renders, 0);
    assert.equal(stores, busy ? 10 : 0);
    assert.equal(wire.syncs - before, busy ? 10 : 4);
    assert.equal(scans, 0, "the pinned rows skip the activity scan when only step counts changed");
    assert.deepEqual(stats.active, ["link/client.ts"]);
    assert.deepEqual(stats.fired, {});
  });
}

test("one hundred unrelated store changes leave the tab badges' chat and task counts alone", async (t) => {
  let chatChecks = 0;
  let taskCounts = 0;
  const tabs = Object.assign((props) => el("Tabs", props), { Trigger: Object.assign((props) => el("Trigger", props),
    { Badge: "Badge", Label: "Label", Icon: "Icon" }) });
  const { default: Layout } = phoneModule("../src/app/(tabs)/_layout", {
    "expo-router": { router: { navigate() {} }, useSegments: () => ["(tabs)"] },
    "expo-router/native-tabs": { NativeTabs: tabs }, "@/state/hooks": hooks, "@/ui": ui,
    "@/state/prefs": { usePrefs: (select) => select({ bar: ["chats", "work"], homeBot: null, backdrop: "clean" }) },
    "@/features/spaces/data": { useSpacesOn: () => true },
    "@/state/sessionActivity": { ...activity, needsYou: (parts) => { taskCounts++; return activity.needsYou(parts); } },
    "@/features/chat/unread": { isChatsPageUnread: (chat) => { chatChecks++; return !chat.archived && chat.unread; } },
  });
  const chats = Array.from({ length: 300 }, (_, i) => ({ id: String(i), unread: i === 0 }));
  useApp.setState({ parts: { chats, tasks: [{ status: "review" }] } });
  const screen = await mount(el(Layout));
  t.after(screen.unmount);
  chatChecks = taskCounts = 0;
  for (let i = 0; i < 100; i++) await act(async () => useApp.setState({ texts: { c: { stream: String(i) } } }));
  t.diagnostic(JSON.stringify({ chatChecks, taskCounts }));
  assert.deepEqual([chatChecks, taskCounts], [0, 0]);
  const badges = () => screen.root.root.findAllByType("Badge").map((node) => node.props.children);
  assert.deepEqual(badges(), ["1", "1"]);
  await act(async () => useApp.setState({ parts: { chats: [], tasks: [], live: { requests: [{}, {}] } } }));
  assert.deepEqual(badges(), ["2"]);
});
