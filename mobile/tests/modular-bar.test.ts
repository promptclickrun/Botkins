// The bar a person arranges: the tab layout, All's tiles with a drag run by hand (the gesture's own
// functions, called as the phone calls them, with the UI thread's values as plain objects), a
// tile's menu, and the first tab's bot. Native views and the gesture library are stand-ins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el, useRef } from "react";
import { create } from "zustand";
import { type GridMetrics, layoutOf, moved } from "../src/features/all/grid";
import { allItems, CAPS, placesFor } from "../src/features/all/places";
import { homeBots, homeChat, pickHomeBot } from "../src/features/home/homeBot";
import { STRIP } from "../src/features/home/strip";
import * as activity from "../src/state/sessionActivity";
import { useApp } from "../src/state/store";
import { USUAL_BAR } from "../src/state/tabs";
import { mount, phoneModule } from "./render-phone";

const START = { bar: USUAL_BAR, allOrder: [] as string[], allHidden: [] as string[], homeBot: null as string | null, nameTag: true, backdrop: "clean" };
const usePrefs = create(() => ({ ...START }));
const prefs = { usePrefs, setPrefs: (patch: object) => usePrefs.setState(patch) };
const hooks = phoneModule("../src/state/hooks", { "@/ui/useOnShow": {}, "./useAppActive": {}, "./link": {}, "./sessionActivity": activity });
const insets = { top: 0, bottom: 0, right: 0, left: 0, tabRoom: 0 };
const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 };
const ui = {
  useTheme: () => ({ colors: {}, dark: false }), useShape: () => insets, space, radius: { lg: 20 }, tint: () => "", badgeColors: () => ({}), haptic: { tap() {}, select() {} },
  BackdropLayer: "Backdrop", BotAvatar: "Avatar", Dot: "Dot", EmptyState: "Empty", Glass: "Glass", HoldMenu: "Menu", IconButton: "IconButton", IconTile: "IconTile",
  Label: "Label", LinkBanner: "Banner", Loading: "Loading", T: "T", Tap: "Tap",
};
// The UI thread's values as plain objects, an animation that is over at once, and a call back to React that is made at once.
const animated = {
  __esModule: true, default: { ScrollView: "ScrollView", View: "View" },
  useAnimatedRef: () => useRef(null), useSharedValue: (value: unknown) => useRef({ value }).current, useAnimatedScrollHandler: () => undefined,
  useAnimatedStyle: () => ({}), useAnimatedReaction: () => {}, useFrameCallback: () => ({ setActive() {} }), scrollTo() {}, useDerivedValue: () => ({ value: 0 }),
  withTiming: (value: unknown, _config?: unknown, done?: () => void) => { done?.(); return value; },
  // A wait that is not over yet, told apart from a value: { after, then }.
  withDelay: (after: number, then: unknown) => ({ after, then }),
};
const native = { ScrollView: "ScrollView", View: "View", useWindowDimensions: () => ({ height: 800, width: 390 }) };
const gestures = { GestureDetector: "Detector", GestureStateManager: {}, usePanGesture: (config: unknown) => config };
const safeArea = { useSafeAreaInsets: () => insets };

const M: GridMetrics = { columns: 2, gap: space.md, tile: 108, head: 26, section: space.lg };
const WIDTH = 350;
const OWNER = placesFor({ member: false, spaces: true, today: true, models: true, tools: true, skills: true });

test("the bar shows the bot, the person's tabs and All; what waits off the bar is counted on All", async (t) => {
  const left: string[] = [];
  let segments = ["(tabs)", "all"];
  const tabs = Object.assign((props: object) => el("Tabs", props), { Trigger: Object.assign((props: object) => el("Trigger", props), { Badge: "Badge", Label: "Label", Icon: "Icon" }) });
  const { default: Layout } = phoneModule("../src/app/(tabs)/_layout", {
    "expo-router": { router: { navigate: (to: string) => void left.push(to) }, useSegments: () => segments },
    "expo-router/native-tabs": { NativeTabs: tabs }, "@/state/hooks": hooks, "@/ui": ui, "@/state/prefs": prefs,
    "@/features/spaces/data": { useSpacesOn: () => true },
    "@/features/chat/unread": { isChatsPageUnread: (chat: { unread?: boolean }) => !!chat.unread },
  });
  usePrefs.setState({ ...START });
  useApp.setState({ parts: { bots: [{ id: "a", name: "Chief of Staff" }, { id: "b", name: "Glory" }], chats: [{ id: "1", unread: true }, { id: "2", unread: true }], tasks: [{ status: "review" }] } } as never);
  const screen = await mount(el(Layout));
  t.after(screen.unmount);
  const triggers = () => screen.root.root.findAllByType("Trigger").map((node) => ({
    name: node.props.name as string, hidden: !!node.props.hidden,
    label: node.findByType("Label").props.children as string, badge: node.findAllByType("Badge")[0]?.props.children as string | undefined,
  }));
  assert.deepEqual(triggers().filter((tab) => !tab.hidden).map((tab) => tab.name), ["index", "home", "work", "all"]);
  assert.deepEqual(triggers().filter((tab) => tab.hidden).map((tab) => tab.name).sort(), ["chats", "market", "spaces"]);
  assert.equal(triggers()[0].label, "Chief", "the first tab is named for the primary bot");
  assert.equal(triggers().find((tab) => tab.name === "work")!.badge, "1");
  assert.equal(triggers().find((tab) => tab.name === "all")!.badge, "2", "unread chats, while Chats is off the bar");
  await act(async () => usePrefs.setState({ bar: ["chats"], homeBot: "b" }));
  assert.deepEqual(triggers().filter((tab) => !tab.hidden).map((tab) => tab.name), ["index", "chats", "all"]);
  assert.equal(triggers()[0].label, "Glory", "and for the bot the person chose there");
  assert.equal(triggers().find((tab) => tab.name === "chats")!.badge, "2");
  assert.equal(triggers().find((tab) => tab.name === "all")!.badge, "1", "now what waits in Work");
  await act(async () => usePrefs.setState({ bar: ["chats", "work"] }));
  assert.equal(triggers().find((tab) => tab.name === "all")!.badge, undefined);
  assert.deepEqual(left, [], "the tab on show is still on the bar");
  segments = ["settings", "tabs"];
  await act(async () => usePrefs.setState({ bar: ["chats"] }));
  assert.deepEqual(left, [], "a page is over the tabs");
  segments = ["(tabs)", "chats"];
  await act(async () => usePrefs.setState({ bar: [] }));
  assert.deepEqual(left, ["/"], "the tab on show was taken off the bar: the person lands on their bot");
});

const opened: string[] = [];
const went: string[] = [];
const { TileGrid } = phoneModule("../src/features/all/TileGrid", {
  "react-native": native, "react-native-gesture-handler": gestures, "react-native-reanimated": animated,
  "react-native-worklets": { scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args) }, "@/ui": ui,
});
const All = phoneModule("../src/features/all/All", {
  "expo-router": { useScrollToTop() {}, router: { navigate: (to: string) => void went.push(to) } }, "lucide-react-native": {}, "react-native": native, "react-native-reanimated": animated,
  "react-native-safe-area-context": safeArea, "@/features/home/Home": { SettingsButton: "SettingsButton" },
  "@/features/spaces/data": { useSpaces: () => [], useSpacesOn: () => true }, "@/state/hooks": hooks, "@/state/prefs": prefs, "@/ui": ui,
  "./open": { openPlace: (id: string) => opened.push(id) }, "./TileGrid": { TileGrid },
}).default;

async function showAll(t: { after: (fn: () => unknown) => void }) {
  usePrefs.setState({ ...START });
  useApp.setState({ parts: { bots: [{ id: "a", name: "Pip" }], chats: [{ id: "1", unread: true }], tasks: [], live: { requests: [{}, {}] } } } as never);
  const screen = await mount(el(All));
  t.after(screen.unmount);
  // The grid learns its width as it is laid out.
  const frame = screen.root.root.findAll((node) => node.type === "View" && typeof node.props.onLayout === "function" && !node.props.scrollEnabled)[0];
  await act(async () => frame.props.onLayout({ nativeEvent: { layout: { width: WIDTH } } }));
  const menus = () => screen.root.root.findAllByType("Menu");
  const menu = (title: string) => menus().find((node) => node.props.title === title)!;
  const gesture = (title: string) => screen.root.root.findAllByType("Detector").find((node) => node.findByType("Menu").props.title === title)!.props.gesture;
  const state = () => ({ bar: usePrefs.getState().bar, order: usePrefs.getState().allOrder, hidden: usePrefs.getState().allHidden });
  /** Hold `title`'s tile, move its middle to the middle of place `index` of `zone`, and let go. */
  const drag = async (title: string, zone: string, index: number) => {
    const key = title.toLowerCase();
    const items = allItems(state(), OWNER, true);
    const from = layoutOf(allItems(state(), OWNER), WIDTH, M);
    const to = layoutOf(moved(items, key, zone, index, CAPS), WIDTH, M);
    const [a, b] = [from.keys.indexOf(key), to.keys.indexOf(key)];
    await act(async () => gesture(title).onActivate({ absoluteX: 200, absoluteY: 400 }));
    await act(async () => gesture(title).onUpdate({ absoluteX: 200 + to.xs[b] - from.xs[a], absoluteY: 400 + to.ys[b] - from.ys[a] }));
    await act(async () => gesture(title).onFinalize());
  };
  return { screen, menu, menus, drag, gesture, state };
}

test("All shows every place as a tile with its line, and a tap opens it", async (t) => {
  const { menus, menu } = await showAll(t);
  assert.deepEqual(menus().map((node) => node.props.title).slice(0, 5), ["Home", "Work", "Chats", "Spaces", "Market"]);
  assert.equal(menus().length, OWNER.length);
  const home = menu("Home").findByType("Tap");
  assert.equal(home.props.accessibilityLabel, "Home, 2 need you, on your bar");
  assert.equal(menu("Chats").findByType("Tap").props.accessibilityLabel, "Chats, 1 unread");
  home.props.onPress();
  menu("Wiki").findByType("Tap").props.onPress();
  assert.deepEqual(opened.splice(0), ["home", "wiki"]);
});

test("a tile dragged onto the bar is pinned there, and a full bar gives up its last tab", async (t) => {
  const { drag, state, menu } = await showAll(t);
  went.length = 0;
  await drag("Chats", "bar", 0);
  assert.deepEqual(state().bar, ["chats", "home", "work"]);
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(went, ["/all"], "the bar is built again: the person stays on All");
  assert.match(menu("Chats").findByType("Tap").props.accessibilityLabel, /on your bar$/);
  await drag("Market", "bar", 1);
  assert.deepEqual(state().bar, ["chats", "market", "home"]);
  assert.equal(state().order[0], "work", "the tab that came off is first in More");
  await drag("Home", "bar", 0);
  assert.deepEqual(state().bar, ["home", "chats", "market"], "and the bar's own tabs are put in order the same way");
});

test("a tile is dragged off the bar, among the others, and into Hidden; one that is no tab never lands on the bar", async (t) => {
  const { drag, state, menus, gesture } = await showAll(t);
  await drag("Home", "more", 2);
  assert.deepEqual(state().bar, ["work"]);
  assert.deepEqual(state().order.slice(0, 3), ["chats", "spaces", "home"]);
  went.length = 0;
  await drag("Usage", "more", 0);
  assert.equal(state().order[0], "usage");
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(went, [], "a move that leaves the bar as it is rebuilds nothing");
  await drag("Wiki", "hidden", 0);
  assert.deepEqual(state().hidden, ["wiki"]);
  assert.equal(menus().find((node) => node.props.title === "Wiki")!.findByType("Tap").props.accessibilityLabel, "Wiki, Pages your bots keep, hidden");
  // Held over the bar's first place, a tile that is no tab lands on the nearest place it may go to.
  const before = state().bar;
  const key = "skills";
  const from = layoutOf(allItems(state(), OWNER), WIDTH, M);
  const at = from.keys.indexOf(key);
  await act(async () => gesture("Skills").onActivate({ absoluteX: 200, absoluteY: 400 }));
  await act(async () => gesture("Skills").onUpdate({ absoluteX: 200 - from.xs[at], absoluteY: 400 + (M.head + M.tile / 2) - (from.ys[at] + M.tile / 2) }));
  await act(async () => gesture("Skills").onFinalize());
  assert.deepEqual(state().bar, before);
  assert.equal(state().order[0], "skills", "the top of More");
});

test("a tile's menu makes the same moves, and offers only the ones that can be made", async (t) => {
  const { menu, state } = await showAll(t);
  const ids = (title: string) => menu(title).props.actions.map((action: { id: string }) => action.id);
  const pick = (title: string, id: string) => act(async () => menu(title).props.onPressAction({ nativeEvent: { event: id } }));
  assert.deepEqual(ids("Home"), ["unpin", "later", "hide"]);
  assert.deepEqual(ids("Chats"), ["pin", "later", "hide"]);
  assert.deepEqual(ids("Wiki"), ["earlier", "later", "hide"], "no pin for a place that is no tab");
  assert.deepEqual(menu("Wiki").findByType("Tap").props.accessibilityActions.map((action: { name: string }) => action.name), ids("Wiki"));
  await pick("Chats", "pin");
  assert.deepEqual(state().bar, ["home", "work", "chats"]);
  await pick("Chats", "earlier");
  assert.deepEqual(state().bar, ["home", "chats", "work"]);
  await pick("Home", "unpin");
  assert.deepEqual(state().bar, ["chats", "work"]);
  assert.equal(state().order[0], "home");
  await pick("Settings", "hide");
  assert.deepEqual(state().hidden, ["settings"]);
  assert.deepEqual(ids("Settings"), ["show"]);
  await pick("Settings", "show");
  assert.deepEqual(state().hidden, []);
  assert.equal(state().order[0], "settings");
});

test("the first tab offers the primary bot first and keeps the bot a person chose", () => {
  const bots = [{ id: "a", hidden: true }, { id: "b" }, { id: "c" }, { id: "d", pinned: true }];
  assert.deepEqual(homeBots(bots).map((bot) => bot.id), ["b", "d", "c"], "a hidden primary hands over to the next bot; pinned bots follow");
  assert.equal(pickHomeBot(homeBots(bots), null)?.id, "b");
  assert.equal(pickHomeBot(homeBots(bots), "c")?.id, "c");
  assert.equal(pickHomeBot(homeBots(bots), "a")?.id, "b", "a bot that is hidden now");
  assert.equal(pickHomeBot(homeBots([]), "a"), undefined);
  const chats = [{ id: "main", botId: "b", main: true, time: 1, count: 0 }, { id: "new", botId: "b", time: 9, count: 3 }, { id: "old", botId: "b", time: 2, count: 1, archived: true }];
  assert.deepEqual(homeChat(chats as never, "b", true), { id: "main" });
  assert.deepEqual(homeChat(chats as never, "b", false), { id: "new" }, "a computer without Main chats: the latest one");
  assert.deepEqual(homeChat(chats as never, "c", true), { make: "main" });
  assert.deepEqual(homeChat(chats as never, "c", false), { make: "ask" }, "an ordinary chat is made on a tap, never by itself");
  assert.deepEqual(homeChat(chats as never, "b", true, "member-1"), { make: "main" }, "Main chat is each person's own");
});

test("the first tab shows the bot's chat under the row of bots, and Home while there is no bot", async (t) => {
  const asked: string[] = [];
  const pages: unknown[] = [];
  const carried: unknown[] = [];
  const BotHome = phoneModule("../src/features/home/BotHome", {
    "lucide-react-native": {}, "react-native": native, "react-native-safe-area-context": safeArea, "react-native-reanimated": animated,
    "react-native-gesture-handler": gestures,
    "react-native-worklets": { scheduleOnRN: (run: (...args: unknown[]) => void, ...args: unknown[]) => run(...args), scheduleOnUI() {} },
    // The computer's order as it is: what a move asks of the computer is kept for the test to read.
    "./useHeldOrder": { useHeldOrder: (list: unknown[]) => ({ shown: list, carry: (id: string, plan: unknown) => void carried.push([id, plan]) }) },
    "expo-router": { router: { push: (to: unknown) => pages.push(to) } },
    "@/features/all/open": { openPlace: (id: string) => opened.push(id) }, "@/features/chat/ChatScreen": { ChatPane: "ChatPane" },
    "@/features/chat/navigate": { openChat() {} }, "@/state/hooks": hooks, "@/state/prefs": prefs, "@/ui": ui,
    "@/state/link": { api: { mainChat: async (id: string) => void asked.push(id), createChat: async () => "x" }, attempt: (call: Promise<unknown>) => call },
    "./Home": { __esModule: true, default: "HomeBoard" },
  }).default;
  usePrefs.setState({ ...START });
  const meta = { capabilities: ["main-chat-v1"] };
  useApp.setState({ synced: true, link: "online", parts: { meta, bots: [] } } as never);
  const screen = await mount(el(BotHome));
  t.after(screen.unmount);
  const has = (type: string) => screen.root.root.findAllByType(type).length;
  assert.equal(has("HomeBoard"), 1, "no bots yet: Home, with its first steps");
  const bots = [{ id: "a", name: "Pip", role: "Chief of staff" }, { id: "b", name: "Patch", role: "" }];
  await act(async () => useApp.setState({ parts: { meta, bots, chats: [{ id: "main-a", botId: "a", main: true, time: 1, count: 0 }] } } as never));
  assert.equal(screen.root.root.findByType("ChatPane").props.id, "main-a");
  assert.deepEqual(asked, [], "a Main chat that is there is not asked for");

  // The chat's bar is the tab's to draw: the row of bots, with the chat's menu at its end.
  const bar = async () => {
    const drawn = await mount(el("View", null, screen.root.root.findByType("ChatPane").props.bar({ menu: el("ChatMenu") })));
    t.after(drawn.unmount);
    return drawn.root.root;
  };
  let row = await bar();
  assert.equal(row.findAllByType("ScrollView").length, 0, "the row waits for its width, so no bot is drawn out of place");
  // The row's width is the tab's to keep: the next chat's bar has it at once.
  const box = row.findAll((node) => typeof node.props.onLayout === "function")[0];
  await act(async () => box.props.onLayout({ nativeEvent: { layout: { width: 312 } } }));
  row = await bar();
  const scroller = row.findByType("ScrollView");
  assert.equal(scroller.props.snapToInterval, STRIP.slot, "the row rests on a bot");
  assert.deepEqual(scroller.props.contentOffset, { x: 0, y: 0 }, "the bot on show starts in the middle");
  assert.equal(scroller.props.contentContainerStyle.width, 312 - STRIP.slot + 2 * STRIP.slot, "room at both ends, so the first and last bot can reach the middle too");
  assert.equal(scroller.props.scrollEnabled, true);
  assert.equal(row.findAllByType("ChatMenu").length, 1);
  const faces = () => row.findAllByType("Tap").filter((tap) => tap.props.accessibilityState);
  assert.deepEqual(faces().map((face) => [face.props.accessibilityLabel, face.props.accessibilityState.selected]), [["Pip", true], ["Patch", false]]);
  // Only the bot on show is drawn as the moving face; every face is the large size, scaled where it stands.
  assert.deepEqual(row.findAllByType("Avatar").map((face) => [face.props.size, face.props.animated]), [[STRIP.face, true], [STRIP.face, false]]);
  row.findByType("IconButton").props.onPress();
  assert.deepEqual(opened.splice(0), ["home"], "the row's first button opens every bot");

  // The name tag: the bot's name and what it is for, a way to its page.
  const tag = () => row.findAllByType("Tap").find((tap) => /bot page$/.test(tap.props.accessibilityLabel ?? ""))!;
  assert.equal(tag().props.accessibilityLabel, "Pip, Chief of staff, bot page");
  tag().props.onPress();
  assert.deepEqual(pages.splice(0), [{ pathname: "/bot/[id]", params: { id: "a" } }]);
  // So is a hold on any face in the row, the bot on show or another: the name tag can be switched off.
  faces()[0].props.onLongPress();
  faces()[1].props.onLongPress();
  assert.deepEqual(pages.splice(0), [{ pathname: "/bot/[id]", params: { id: "a" } }, { pathname: "/bot/[id]", params: { id: "b" } }]);
  // A tap on the bot already on show changes nothing.
  await act(async () => faces()[0].props.onPress());
  assert.deepEqual(pages, []);
  assert.equal(usePrefs.getState().homeBot, null, "and a hold opens a page without changing the bot on show");
  // Two bots: the primary stays first, so there is nowhere to move the other, and no face can be carried.
  assert.equal(row.findAllByType("Detector").length, 0);

  // A swipe that comes to rest on Patch: its name shows at once, and its chat opens.
  scroller.props.onScrollBeginDrag();
  await act(async () => scroller.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: STRIP.slot } } }));
  assert.equal(usePrefs.getState().homeBot, "b");
  assert.equal(has("ChatPane"), 0, "Patch has no Main chat yet");
  assert.equal(has("Loading"), 1);
  assert.deepEqual(asked, ["b"], "so the computer is asked for it, once");
  await act(async () => useApp.setState({ parts: { meta, bots, chats: [{ id: "main-a", botId: "a", main: true, time: 1, count: 0 }, { id: "main-b", botId: "b", main: true, time: 2, count: 0 }] } } as never));
  assert.equal(screen.root.root.findByType("ChatPane").props.id, "main-b");
  assert.deepEqual(asked, ["b"]);
  row = await bar();
  assert.deepEqual(row.findByType("ScrollView").props.contentOffset, { x: STRIP.slot, y: 0 }, "Patch's bar starts with Patch in the middle");
  assert.equal(tag().props.accessibilityLabel, "Patch, bot page", "a bot with nothing said about it has its name alone");

  // A tap on the other bot: it takes the middle, and its chat opens when the row has stopped there.
  await act(async () => faces()[0].props.onPress());
  assert.equal(usePrefs.getState().homeBot, "b", "not before the row stops");
  await act(async () => row.findByType("ScrollView").props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0 } } }));
  assert.equal(usePrefs.getState().homeBot, "a");
  assert.equal(screen.root.root.findByType("ChatPane").props.id, "main-a");

  // The name tag switched off (Settings › Appearance): it is no button, and it fades a moment after a bot is on show.
  const tagBox = () => row.findAll((node) => node.props.pointerEvents === "auto" || node.props.pointerEvents === "none").find((node) => node.findAllByType("Glass").length > 0)!;
  row = await bar();
  assert.equal(tagBox().props.pointerEvents, "auto");
  await act(async () => usePrefs.setState({ nameTag: false }));
  row = await bar();
  assert.equal(tagBox().props.pointerEvents, "none");
  assert.equal(STRIP.tagStaysMs, 2500);

  // Three bots or more: every face but the primary bot's can be carried to a new place (hold, then slide),
  // and VoiceOver has the same moves as actions. The computer is asked for the new order.
  const trio = [...bots, { id: "c", name: "Dot", role: "" }];
  await act(async () => useApp.setState({ parts: { meta, bots: trio, chats: [{ id: "main-a", botId: "a", main: true, time: 1, count: 0 }] } } as never));
  row = await bar();
  assert.deepEqual(faces().map((face) => face.props.accessibilityActions.map((action: { name: string }) => action.name)), [["longpress"], ["longpress", "left", "right"], ["longpress", "left", "right"]]);
  assert.equal(row.findAllByType("Detector").length, 2, "the primary bot's face is not one to carry");
  await act(async () => faces()[1].props.onAccessibilityAction({ nativeEvent: { actionName: "right" } }));
  assert.deepEqual(carried.splice(0), [["b", { order: ["a", "c", "b"] }]]);
  await act(async () => faces()[2].props.onAccessibilityAction({ nativeEvent: { actionName: "right" } }));
  await act(async () => faces()[1].props.onAccessibilityAction({ nativeEvent: { actionName: "left" } }));
  assert.deepEqual(carried, [], "nothing past the end, and nothing before the primary bot");
  // A role that may not arrange the bots, or no link to the computer: nothing to carry.
  await act(async () => useApp.setState({ link: "offline" } as never));
  row = await bar();
  assert.equal(row.findAllByType("Detector").length, 0);
  await act(async () => useApp.setState({ link: "online" } as never));

  await act(async () => useApp.setState({ parts: { meta: { capabilities: [] }, bots, chats: [] } } as never));
  assert.equal(screen.root.root.findByType("Empty").props.action, "Start a chat", "without Main chats, a first chat waits for a tap");
});
