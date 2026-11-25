import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as el } from "react";
import { create } from "zustand";
import { cleanEvents } from "../link-host/input.mjs";
import { fitPicture, ScreenGestures } from "../src/features/remote/gestures";
import { InputSender } from "../src/features/remote/input";
import { mount, phoneModule } from "./render-phone";

const gestureModule = { fitPicture, ScreenGestures };

function finger(id: number, x: number, y: number) { return { id, x, y }; }
function touches(...points: ReturnType<typeof finger>[]) { return { allTouches: points, changedTouches: points }; }
function trackpad(control = true) {
  const events = [];
  const values = { scale: { value: 1 }, x: { value: 0 }, y: { value: 0 }, pointerX: { value: 0.5 }, pointerY: { value: 0.5 } };
  const out = { send: event => events.push(event), clicked() {}, grabbed() {} };
  const pad = new gestureModule.ScreenGestures(values, out);
  pad.configure({ mode: "trackpad", control, out });
  pad.layout(gestureModule.fitPicture({ width: 300, height: 300 }, { width: 900, height: 900 }), { width: 900, height: 900 });
  return { pad, events, values, out };
}
function pinch(pad) {
  pad.down(touches(finger(1, 100, 150), finger(2, 200, 150)));
  pad.move(touches(finger(1, 80, 150), finger(2, 220, 150)));
  pad.move(touches(finger(1, 40, 150), finger(2, 260, 150)));
  pad.up(touches(finger(1, 40, 150), finger(2, 260, 150)));
}

test("a clipboard permission prompt cannot paste into a display selected while it was open", async () => {
  const sender = new InputSender(async () => assert.fail("stale paste"), assert.fail);
  sender.setDisplay("first");
  const reading = Promise.withResolvers<string>();
  const result = sender.paste(() => reading.promise);
  sender.setDisplay("second");
  sender.setDisplay("first");
  reading.resolve("from the phone");
  assert.equal(await result, undefined);
  assert.match(await sender.paste(async () => ""), /empty/i);
  assert.match(await sender.paste(async () => { throw new Error("permission"); }), /read/i);
  sender.close();
});

test("a multiline paste is delivered in order within the computer's input limits", async t => {
  const callbacks = new Map();
  let id = 0;
  const animation = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { callbacks.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = key => { callbacks.delete(key); };
  t.after(() => { globalThis.requestAnimationFrame = animation; globalThis.cancelAnimationFrame = cancel; });
  const received = [], errors = [];
  const sender = new InputSender(async (_display, actions) => {
    const batch = cleanEvents(actions).events;
    if (batch.length > 256) throw new Error("batch exceeds computer limit");
    received.push(...batch);
  }, error => errors.push(error));
  sender.setDisplay("desk");
  const text = ("a\tb\n").repeat(200);
  await sender.paste(async () => text);
  while (callbacks.size) {
    for (const [key, fn] of callbacks) { callbacks.delete(key); fn(); }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(errors, []);
  assert.equal(received.map(event => event.type === "text" ? event.text : event.key === "tab" ? "\t" : "\n").join(""), text);
  sender.close();
});

test("pinching then scrolling with two fingers sends a wheel event without moving the magnified desktop", () => {
  const { pad, events, values } = trackpad();
  pinch(pad);
  assert.ok(values.scale.value > 1);
  pad.down(touches(finger(1, 100, 150), finger(2, 200, 150)));
  pad.move(touches(finger(1, 100, 120), finger(2, 200, 120)));
  pad.move(touches(finger(1, 100, 80), finger(2, 200, 80)));
  pad.up(touches(finger(1, 100, 80), finger(2, 200, 80)));
  assert.equal(values.y.value, 0);
  assert.ok(events.some(event => event.type === "scroll" && event.dy > 0));
  pad.dispose();
});

test("three fingers pan a magnified view-only desktop without sending input", () => {
  const { pad, events, values } = trackpad(false);
  pinch(pad);
  pad.down(touches(finger(1, 80, 100), finger(2, 160, 100), finger(3, 120, 160)));
  pad.move(touches(finger(1, 105, 100), finger(2, 185, 100), finger(3, 145, 160)));
  pad.up(touches(finger(1, 105, 100), finger(2, 185, 100), finger(3, 145, 160)));
  assert.equal(values.x.value, 25);
  assert.deepEqual(events, []);
  pad.resetZoom();
  assert.equal(values.scale.value, 1);
  assert.equal(values.x.value, 0);
  pad.dispose();
});

test("screen-reader actions move and click the pointer, and only zoom when access is view only", () => {
  const { pad, events, values } = trackpad();
  pad.accessibilityAction("moveRight");
  pad.accessibilityAction("activate");
  assert.equal(events[0].type, "move");
  assert.ok(events[0].x > 0.5);
  assert.deepEqual(events[1], { type: "click", x: events[0].x, y: 0.5 });
  pad.accessibilityAction("increment");
  assert.ok(values.scale.value > 1);
  pad.dispose();
  const viewer = trackpad(false);
  viewer.pad.accessibilityAction("activate");
  viewer.pad.accessibilityAction("moveRight");
  viewer.pad.accessibilityAction("increment");
  assert.deepEqual(viewer.events, []);
  assert.ok(viewer.values.scale.value > 1);
  viewer.pad.dispose();
});

test("trackpad clicks start at the computer's real pointer and keep each display's last position", () => {
  const { pad, events, values } = trackpad();
  pad.selectDisplay("left", { x: 0.1, y: 0.8 });
  pad.accessibilityAction("activate");
  assert.deepEqual(events[0], { type: "click", x: 0.1, y: 0.8 });
  pad.accessibilityAction("moveRight");
  const moved = values.pointerX.value;
  pad.selectDisplay("right");
  assert.equal(values.pointerX.value, 0.5);
  pad.selectDisplay("left", { x: 0.1, y: 0.8 });
  assert.equal(values.pointerX.value, moved);
  assert.equal(events.length, 2);
  pad.dispose();
});

test("direct touch ignores the black margins and trackpad resumes from the directly touched point", () => {
  const { pad, out, events } = trackpad();
  pad.configure({ mode: "touch", control: true, out });
  pad.layout(fitPicture({ width: 300, height: 500 }, { width: 900, height: 300 }), { width: 900, height: 300 });
  pad.down(touches(finger(1, 18, 20)));
  pad.up(touches(finger(1, 18, 20)));
  assert.deepEqual(events, []);
  pad.down(touches(finger(1, 75, 240)));
  pad.up(touches(finger(1, 75, 240)));
  pad.configure({ mode: "trackpad", control: true, out });
  pad.accessibilityAction("activate");
  assert.deepEqual(events, [{ type: "click", x: 0.25, y: 0.4 }, { type: "click", x: 0.25, y: 0.4 }]);
  pad.dispose();
});

test("the keyboard reproduces emoji deletion and edits inside composed text at the remote caret", async t => {
  const keyboard = phoneModule("../src/features/remote/KeyBar", {
    "lucide-react-native": {}, "react-native": { TextInput: "Field", StyleSheet: { create: styles => styles } },
    "@/ui": { space: {} },
  });
  const received = [];
  const screen = await mount(el(keyboard.HiddenInput, { inputRef: { current: null }, modifiers: [], send: action => received.push(action), release() {}, onFocus() {}, onBlur() {} }));
  t.after(screen.unmount);
  const field = () => screen.root.root.findByType("Field").props;
  const seed = field().value;
  await act(async () => field().onChangeText(seed + "🌿"));
  await act(async () => field().onChangeText(seed));
  assert.deepEqual(received, [{ type: "text", text: "🌿" }, { type: "key", key: "backspace" }]);
  let desktop = "";
  received.length = 0;
  await act(async () => field().onChangeText(seed + "teh file"));
  await act(async () => field().onChangeText(seed + "the file"));
  for (const event of received) desktop = event.type === "text" ? desktop + event.text : desktop.slice(0, -1);
  assert.equal(desktop, "the file");
});

test("the viewer uses the video surface at the display aspect ratio and starts JPEGs only on fallback", async t => {
  const display = { id: "wide", label: "Desk", width: 2560, height: 1440, primary: true };
  const info = { displays: [display], video: true, canControl: true, canView: true, mode: "control" };
  const meta = { serverId: "host", name: "Work Mac", platform: "darwin", capabilities: ["screen-v1"] };
  const useState = create(() => ({
    pairing: { serverId: "host", name: "Work Mac" }, link: "online", route: "relay",
    parts: { host: { screen: "control" }, meta }, video: "starting",
  }));
  const jpeg = { display: "wide", id: 1, width: 640, height: 360, uri: "frame" };
  let readingJpeg = false;
  let appChange = (_state: string) => {};
  let unlocks = 0;
  const unlock = Promise.withResolvers<{ success: boolean }>();
  const infoRequests = [];
  const native = {
    View: "View", ActivityIndicator: "Spinner", AppState: { currentState: "active", addEventListener: (_, callback) => { appChange = callback; return { remove() {} }; } },
    useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: "ios" }, StyleSheet: { create: styles => styles },
  };
  const screen = phoneModule("../src/features/remote/Remote", {
    "expo-router": { useIsFocused: () => true, useLocalSearchParams: () => ({ computer: "host", display: "wide" }), Stack: { Screen: "Screen" } },
    "expo-clipboard": {}, "expo-local-authentication": {
      getEnrolledLevelAsync: async () => 1, SecurityLevel: { NONE: 0 },
      authenticateAsync: () => { unlocks++; return unlock.promise; },
    },
    "expo-keep-awake": { useKeepAwake() {} },
    "expo-screen-orientation": { getOrientationLockAsync: async () => 1, unlockAsync: async () => {}, lockAsync: async () => {}, OrientationLock: { PORTRAIT_UP: 1 } },
    "lucide-react-native": { MonitorOff: "MonitorOff", RefreshCw: "Refresh" }, "react-native": native,
    "react-native-keyboard-controller": { useKeyboardState: select => select({ isVisible: false, height: 0 }) },
    "react-native-reanimated": { useSharedValue: value => ({ value }) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ left: 0, right: 0, top: 0, bottom: 0 }) },
    "@/state/useAppActive": { useAppActive: enabled => enabled }, "@/state/ledger": { trackResource: () => ({ release() {} }) },
    "@/state/hooks": { useOnline: () => true, usePart: key => useState(state => state.parts[key]) },
    "@/state/link": { api: { "link.screen.info": async opts => { infoRequests.push(opts); return info; } }, screenInputSender: () => async () => {} },
    "@/state/store": { useApp: useState }, "@/features/pane/watching": { useScreenKey: () => "host" },
    "@/ui": { T: "T", Button: "Button", EmptyState: "Empty", IconButton: "IconButton", haptic: {}, space: {}, useShape: () => ({}), useTheme: () => ({ colors: {} }) },
    "./gestures": gestureModule, "./KeyBar": { HiddenInput: "Input", KeyBar: "Keys" }, "./Stage": { Stage: "Stage" },
    "./Controls": { ControlBar: "ControlBar", ProblemLine: "Problem", StatusLine: "Status", ViewerHeader: "Header", ViewerPanel: "Panel" },
    "./useDesktopVideo": { useDesktopVideo: () => {
      const status = useState(state => state.video);
      return { surface: el("Video"), stats: null, status };
    } },
    "./useFeed": { useFeed: options => {
      readingJpeg = options.enabled;
      return { pictures: { a: jpeg, b: null, front: "a" }, size: jpeg, state: "live", hasPicture: true, drawn() {} };
    } },
  });
  const viewer = await mount(el(screen.default));
  t.after(viewer.unmount);
  assert.deepEqual(infoRequests, []);
  assert.equal(viewer.root.root.findAllByType("Stage").length, 0);
  await act(async () => unlock.resolve({ success: true }));
  assert.deepEqual(infoRequests, [{ pointer: true }]);
  const stage = () => viewer.root.root.findByType("Stage").props;
  assert.equal(readingJpeg, false);
  assert.equal(stage().size.width, 2560);
  assert.equal(stage().video.type, "Video");
  assert.equal(viewer.root.root.findAllByType("Input").length, 0);
  await act(async () => useState.setState({ video: "live" }));
  assert.equal(viewer.root.root.findAllByType("Input").length, 1);
  await act(async () => useState.setState({ video: "fallback" }));
  assert.equal(readingJpeg, true);
  assert.equal(stage().size.width, 640);
  assert.equal(stage().video, null);
  await act(async () => useState.setState({ parts: { meta, host: { screen: "view" } } }));
  assert.equal(viewer.root.root.findAllByType("Input").length, 0);
  assert.equal(viewer.root.root.findByType("Header").props.viewOnly, true);
  await act(async () => appChange("background"));
  assert.equal(viewer.root.root.findAllByType("Stage").length, 0);
  const reconnect = viewer.root.root.findByProps({ title: "Reconnect" });
  assert.equal(unlocks, 1);
  await act(async () => reconnect.props.onPress());
  assert.equal(unlocks, 2);
  await act(async () => useState.setState({ pairing: { serverId: "other", name: "Other computer" } }));
  assert.equal(viewer.root.root.findAllByType("Stage").length, 0, "a chat's controller cannot switch to a second computer");
  assert.equal(unlocks, 2);
});

test("the viewer header follows the actual connection and its menu selects the requested display and quality", async t => {
  const calls: string[] = [];
  const controls = phoneModule("../src/features/remote/Controls", {
    "@react-native-menu/menu": { MenuView: "Menu" }, "expo-clipboard": {},
    "lucide-react-native": { ChevronLeft: "Back", Ellipsis: "Ellipsis", CircleHelp: "Help" },
    "react-native": { Modal: "Modal", View: "View", Platform: { OS: "ios" }, StyleSheet: { create: styles => styles } },
    "@/ui": { T: "T", IconButton: "Button", Glass: "Glass", space: {}, useTheme: () => ({ colors: {} }) },
  });
  const options = {
    mode: "trackpad", control: true, displays: [{ id: "1", label: "Main" }, { id: "usb:2", label: "External" }], display: "1",
    quality: "balanced", video: true, onDisplay: id => calls.push("display " + id), onQuality: id => calls.push("quality " + id),
    onMode: () => calls.push("mode"), onFit: () => calls.push("fit"),
  };
  const props = { name: "Studio", route: "direct", options, back() {}, help() {}, stats: () => calls.push("stats") };
  const header = await mount(el(controls.ViewerHeader, props));
  t.after(header.unmount);
  const button = label => header.root.root.findByProps({ label });
  assert.ok(button("Back"));
  assert.ok(button("Gesture help"));
  assert.match(header.root.root.findByProps({ accessibilityRole: "header" }).props.accessibilityLabel, /Studio, Direct connection/);
  const select = event => header.root.root.findByType("Menu").props.onPressAction({ nativeEvent: { event } });
  for (const id of ["display:usb:2", "quality:saver", "fit", "mode", "stats", "quality:__proto__", "display:removed"]) select(id);
  assert.deepEqual(calls, ["display usb:2", "quality saver", "fit", "mode", "stats"]);
  await act(async () => header.root.update(el(controls.ViewerHeader, { ...props, route: "relay", viewOnly: true, options: { ...options, control: false } })));
  assert.match(header.root.root.findByProps({ accessibilityRole: "header" }).props.accessibilityLabel, /Studio, Relay connection · View only/);
  select("mode");
  assert.equal(calls.length, 5);
});

test("the connection sheet copies measurements from the playing video and its requested quality", async t => {
  let report: string | undefined;
  const controls = phoneModule("../src/features/remote/Controls", {
    "@react-native-menu/menu": {}, "expo-clipboard": { setStringAsync: async text => { report = text; return true; } },
    "lucide-react-native": {}, "react-native": { Modal: "Modal", View: "View", Platform: { OS: "ios" }, StyleSheet: { create: styles => styles } },
    "@/ui": { Sheet: "Sheet", T: "T", Group: "Group", Label: "Label", Row: "Row", space: {} },
  });
  const details = {
    route: "relay", state: "Connected", source: "video", display: { label: "Desk" }, quality: "balanced",
    frame: null, video: { width: 1152, height: 720, fps: 23.4 }, live: true,
  };
  const panel = await mount(el(controls.ViewerPanel, { panel: "stats", close() {}, details }));
  t.after(panel.unmount);
  assert.equal(panel.root.root.findByProps({ title: "Resolution" }).props.value, "1152 × 720");
  assert.equal(panel.root.root.findByProps({ title: "Frame rate" }).props.value, "23.4 fps");
  await act(async () => panel.root.root.findByType("Sheet").props.onAction());
  assert.match(report, /Route: Relay connection/);
  assert.match(report, /Requested quality: Balanced · 30 fps/);
  assert.match(report, /Frame rate: 23.4 fps/);
});
