import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import { create } from "zustand";
import { mount, phoneModule } from "./render-phone";
import { screenGate } from "../src/features/pane/screenLive";
import { MockBackend } from "../link-host/mock-backend.mjs";

test("a team member cannot unlock an agent's screen preview", () => {
  assert.deepEqual(screenGate({ capabilities: ["screen-v1"], host: { screen: "control" }, owner: "open", member: true }), { kind: "member" });
});

test("a visible screen pane gives its decoder to the full viewer and resumes after it closes", async t => {
  const opened = [], closed = [], holds = [];
  let next = 0;
  const { useDesktopVideo } = phoneModule("../src/features/remote/useDesktopVideo", {
    "react-native": { AppState: { currentState: "active" }, StyleSheet: {} },
    "react-native-webview": { WebView: "WebView" }, "expo-crypto": { randomUUID: () => String(++next) },
    "@/state/link": { desktopVideoLink: (_host, id) => ({
      open: async opts => { opened.push([id, opts.display]); return { mimeType: "video/mp4" }; }, close: () => closed.push(id),
    }) },
    "@/state/useAppActive": { useAppActive: enabled => enabled },
    "@/features/pane/watching": { holdScreen: () => { holds.push(1); return () => { holds.pop(); }; } },
  });
  function Screen({ owner, display }) {
    const video = useDesktopVideo({ owner, enabled: true, computer: "video-handoff", display, quality: "balanced" });
    return el("Screen", { owner }, video.surface);
  }
  const tree = (viewer: boolean, pane: boolean) => el("Tree", {}, [
    ...(viewer ? [el(Screen, { key: "viewer", owner: "Remote", display: "full" })] : []),
    ...(pane ? [el(Screen, { key: "pane", owner: "PaneScreen", display: "pane" })] : []),
  ]);
  const screens = await mount(tree(false, true));
  t.after(screens.unmount);
  const single = async owner => {
    const players = screens.root.root.findAllByType("WebView");
    assert.equal(players.length, 1, "exactly one decoder may be mounted");
    const active = screens.root.root.findAllByType("Screen").find(node => node.props.owner === owner);
    assert.equal(active.findAllByType("WebView").length, 1);
    await act(async () => players[0].props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "formats", value: ["video/mp4"] }) } }));
  };
  await single("PaneScreen");
  await act(async () => screens.root.update(tree(true, true)));
  await single("Remote");
  await act(async () => screens.root.update(tree(false, true)));
  await single("PaneScreen");
  assert.deepEqual(opened.map(row => row[1]), ["pane", "full", "pane"]);
  assert.deepEqual(closed, ["1", "2"]);
  assert.equal(holds.length, 1);
  await act(async () => screens.root.update(tree(false, false)));
  assert.equal(holds.length, 0);
});

function screenFixture() {
  const host = { screen: "control" };
  const meta = { capabilities: ["screen-v1"], you: { kind: "owner" } };
  const primary = { id: "primary", label: "Studio", width: 1920, height: 1080, primary: true };
  const other = { ...primary, id: "other", primary: false };
  const info = { canView: true, canControl: true, video: true, displays: [other, primary] };
  const state = create(() => ({ pairing: { serverId: "my-computer" }, chats: {}, parts: { meta, host }, route: "direct", link: "online", active: true, owner: "unknown", video: "live" }));
  const videoAsks = [], jpegAsks = [], routes = [];
  const ui = { radius: {}, space: {}, T: "T", Button: "Button", Tap: "Tap", HoldMenu: "Menu", useTheme: () => ({ colors: {} }) };
  const native = { StyleSheet: { create: styles => styles }, View: "View", ActivityIndicator: "Spinner", useWindowDimensions: () => ({ width: 390, height: 844 }) };
  const live = phoneModule("../src/features/pane/LiveScreen", {
    "expo-image": { Image: "Image" }, "lucide-react-native": { Monitor: "Monitor" }, "expo-router": { useIsFocused: () => true, router: { push: route => routes.push(route), navigate: route => routes.push(route) } },
    "react-native": native,
    "@/features/credentials/shared": { useOwnerCheck: () => state(s => s.owner), checkOwner: async () => { state.setState({ owner: "open" }); return true; } },
    "@/features/remote/Picture": { PictureSlots: "JPEG" }, "@/state/hooks": { usePart: key => state(s => s.parts[key]), useOnline: () => true },
    "@/state/link": { api: { "link.screen.info": async () => info } },
    "@/state/store": { useApp: state, onComputerChange() {} },
    "@/state/useAppActive": { useAppActive: enabled => state(s => !!enabled && s.active) },
    "@/ui": ui,
    "@/features/remote/useDesktopVideo": { useDesktopVideo: opts => { videoAsks.push(opts); return { surface: opts.enabled ? el("Video") : null, status: state(s => s.video), stats: null }; } },
    "@/features/remote/useFeed": { useFeed: opts => {
      jpegAsks.push(opts);
      return { pictures: { a: null, b: null, front: "a" }, state: "starting", hasPicture: false, size: null, retry() {} };
    } },
  });
  return { live, state, native, ui, routes, jpegAsks, videoAsks };
}

test("the agent pane plays the main display and only an explicitly played chat card streams", async t => {
  const { live, state, routes, jpegAsks, videoAsks } = screenFixture();
  function Preview(props) {
    const screen = live.useLiveScreen(props.place, { role: props.role, visible: props.visible, playing: props.playing });
    return el("Preview", { screen });
  }
  const render = (place: string, playing = false, role = "live", visible = true) => el(Preview, { place, playing, role, visible });
  const preview = await mount(render("pane"));
  t.after(preview.unmount);
  const latest = () => preview.root.root.findByType("Preview").props.screen;
  assert.ok(!jpegAsks.at(-1)?.enabled);
  assert.equal(latest().gate.kind, "covered");
  await act(async () => state.setState({ owner: "open" }));
  assert.equal(videoAsks.at(-1)?.enabled, true);
  assert.equal(videoAsks.at(-1).display, "primary");
  assert.equal(videoAsks.at(-1).owner, "PaneScreen");
  assert.equal(jpegAsks.at(-1).enabled, false);
  await act(async () => state.setState({ video: "fallback" }));
  assert.equal(jpegAsks.at(-1).enabled, true);
  assert.equal(jpegAsks.at(-1).once, false);
  await act(async () => { state.setState({ video: "live", route: "relay" }); preview.root.update(render("card")); });
  assert.equal(videoAsks.at(-1).enabled, false);
  assert.equal(jpegAsks.at(-1).once, true);
  await act(async () => preview.root.update(render("card", true)));
  assert.equal(videoAsks.at(-1).owner, "ScreenCard");
  assert.equal(videoAsks.at(-1).quality, "saver");
  assert.equal(videoAsks.at(-1).enabled, true);
  latest().openViewer();
  assert.deepEqual(routes, [{ pathname: "/remote", params: { computer: "my-computer", display: "primary" } }]);
  await act(async () => preview.root.update(render("card", true, "older")));
  assert.equal(videoAsks.at(-1).enabled, false);
  assert.equal(jpegAsks.at(-1).enabled, false);
  assert.equal(latest().viewerLabel, undefined);
  await act(async () => { state.setState({ active: false }); preview.root.update(render("pane")); });
  assert.equal(videoAsks.at(-1).enabled, false);
  assert.equal(jpegAsks.at(-1).enabled, false);
});

test("the demo agent's screen card opens the same controller and plays in the chat only on demand", { timeout: 8000 }, async t => {
  const backend = new MockBackend({ speed: 0.005 });
  const chatId = await backend.call("createChat", [backend.state.bots[0].id]);
  const receipt = Promise.withResolvers();
  const unsubscribe = backend.subscribe(() => {
    const pane = backend.chat(chatId).pane;
    if (pane?.panels?.some(panel => panel.kind === "screen")) receipt.resolve(pane);
  });
  t.after(unsubscribe);
  await backend.call("send", [chatId, "show me the screen"]);
  const pane = await receipt.promise;
  const panel = pane.panels.find(item => item.kind === "screen");
  const { live, state, native, ui, routes } = screenFixture();
  state.setState({ chats: { [chatId]: { pane } } });
  const { ScreenCard } = phoneModule("../src/features/pane/ScreenCard", {
    "react-native": native, "lucide-react-native": { Monitor: "Monitor", Play: "Play", Pause: "Pause" }, "@/ui": ui,
    "@/state/store": { useApp: state }, "@/features/pane/watching": { useScreenKey: () => "my-computer" },
    "@/state/link": {}, "./LiveScreen": live,
  });
  let opened = false;
  const card = (inView = true) => el(ScreenCard, { chatId, panel, inView, onOpen: () => { opened = true; } });
  const screen = await mount(card());
  t.after(screen.unmount);
  const action = title => screen.root.root.findAllByType("Button").find(node => node.props.title === title);
  assert.ok(action("Control computer"));
  assert.equal(screen.root.root.findAllByType("Video").length, 0);
  await act(async () => action("Show screen").props.onPress());
  await act(async () => action("Watch live").props.onPress());
  assert.equal(screen.root.root.findAllByType("Video").length, 1);
  await act(async () => action("Control computer").props.onPress());
  assert.deepEqual(routes, [{ pathname: "/remote", params: { computer: "my-computer", display: "primary" } }]);
  await act(async () => screen.root.root.findByType("Tap").props.onPress());
  assert.equal(opened, true, "the picture still opens its agent panel");
  await act(async () => screen.root.update(card(false)));
  assert.equal(screen.root.root.findAllByType("Video").length, 0);
  await act(async () => screen.root.update(card()));
  assert.ok(action("Watch live"));
  assert.equal(screen.root.root.findAllByType("Video").length, 0);
  await act(async () => state.setState(s => ({ parts: { ...s.parts, host: { screen: "off", headless: true } } })));
  assert.equal(action("Control computer"), undefined);
  await act(async () => action("Open computer settings").props.onPress());
  assert.equal(routes.at(-1), "/settings/desktop");
});

test("an agent closing its screen panel leaves the active full-screen controller in front", async t => {
  const nav = create(() => ({ path: "/chat/pane", pane: { panels: [], active: null } }));
  const back = [];
  const { usePane, paneOpened, paneClosed } = phoneModule("../src/features/pane/usePane", {
    "expo-router": { usePathname: () => nav(s => s.path), router: { canGoBack: () => true, back: () => back.push(nav.getState().path) } },
    "@/state/hooks": { usePart: key => key === "meta" ? { capabilities: ["side-pane-v1"] } : {}, useWatchedChat: () => ({ pane: nav(s => s.pane) }) },
    "@/state/link": {}, "@/state/store": {}, "./inbox": { usePaneInbox: () => ({ seq: 0 }) },
  });
  function Chat() { usePane("chat", () => {}); return null; }
  const chat = await mount(el(Chat));
  t.after(chat.unmount);
  paneOpened("chat");
  await act(async () => nav.setState({ path: "/remote", pane: { panels: [], active: null, ask: { seq: 1, close: true } } }));
  assert.deepEqual(back, []);
  await act(async () => nav.setState({ path: "/chat/pane" }));
  assert.deepEqual(back, ["/chat/pane"]);
  assert.equal(paneClosed(), true);
});
