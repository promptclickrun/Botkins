// View and control the paired computer. The owner check, picture and input queue are scoped to it.
import * as Clipboard from "expo-clipboard";
import { useKeepAwake } from "expo-keep-awake";
import * as LocalAuthentication from "expo-local-authentication";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { MonitorOff } from "lucide-react-native";
import { type ComponentRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, StyleSheet, type TextInput, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScreenKey } from "@/features/pane/watching";
import type { LinkRoute } from "@/link/client";
import type { Meta, ScreenInfo, ScreenInput } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { trackResource } from "@/state/ledger";
import { api, screenInputSender, wake } from "@/state/link";
import { useApp } from "@/state/store";
import { useAppActive } from "@/state/useAppActive";
import { Button, haptic, space, T, useShape } from "@/ui";
import { chrome, QUALITY, type QualityId } from "./chrome";
import { ControlBar, type Panel, ProblemLine, ViewerHeader, ViewerPanel } from "./Controls";
import { type PointerMode, ScreenGestures } from "./gestures";
import { InputSender } from "./input";
import { HiddenInput, KEY_BAR_HEIGHT, KeyBar, type Modifier } from "./KeyBar";
import { Stage } from "./Stage";
import { useDesktopVideo } from "./useDesktopVideo";
import { useFeed } from "./useFeed";

const remembered: { quality: QualityId; mode: PointerMode } = { quality: "balanced", mode: "trackpad" };
const errorText = (error: unknown) => error instanceof Error && error.message ? error.message : "Couldn't reach your computer.";
const leave = () => router.canGoBack() ? router.back() : router.replace("/");

export default function Remote() {
  const host = useScreenKey();
  const paired = useApp(state => state.pairing?.serverId);
  const target = useLocalSearchParams<{ computer?: string; display?: string }>();
  if (target.computer && target.computer !== paired) {
    return <Standby name="Control computer" route={null} notice={{ title: "The selected computer changed", text: "Open the screen from the computer you want to use." }} />;
  }
  return <RemoteScreen key={host} initialDisplay={target.display} />;
}

type Owner = "checking" | "ok" | "failed" | "paused";
type Notice = { title: string; text?: string; action?: string; onAction?: () => void; busy?: boolean };

function RemoteScreen({ initialDisplay }: { initialDisplay?: string }) {
  const focused = useIsFocused();
  const active = useAppActive(focused);
  const online = useOnline();
  const pairing = useApp(state => state.pairing);
  const route = useApp(state => state.route);
  const meta = usePart("meta");
  const host = usePart("host");
  const name = pairing?.name || meta?.name || "Control computer";
  const mode = host?.screen ?? "off";
  const supported = !!meta?.capabilities.includes("screen-v1");
  const member = meta?.you?.kind === "member";
  const needsCheck = supported && mode !== "off" && !member;
  const [owner, setOwner] = useState<Owner>("checking");
  const asking = useRef(false);
  const inView = useRef(false);
  useLayoutEffect(() => {
    inView.current = focused;
    return () => { inView.current = false; };
  }, [focused]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      // Brief system dialogs can make the app inactive. Leaving the app ends this viewing session.
      if (state === "background") setOwner(held => held === "ok" ? "paused" : held);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active || !online || !needsCheck || owner !== "checking" || asking.current) return;
    asking.current = true;
    const allow = () => setOwner(AppState.currentState === "background" ? "paused" : "ok");
    void (async () => {
      try {
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        if (!inView.current) return;
        if (level === LocalAuthentication.SecurityLevel.NONE) return allow();
        const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock to see your computer's screen", cancelLabel: "Cancel" });
        if (!inView.current) return;
        if (result.success || result.error === "not_enrolled" || result.error === "passcode_not_set") allow();
        else if (result.error === "user_cancel") leave();
        else setOwner("failed");
      } catch {
        if (inView.current) setOwner("failed");
      } finally {
        asking.current = false;
      }
    })();
  }, [active, online, needsCheck, owner]);

  if (!focused) return null;
  let gate: Notice;
  if (!online) gate = { title: "Can't reach your computer", action: "Reconnect", onAction: wake };
  else if (!meta) gate = { title: "Connecting to your computer…", busy: true };
  else if (member) gate = { title: "Only the computer's owner can open its screen." };
  else if (!supported) gate = { title: "Update Botkins on your computer to share its screen." };
  else if (mode === "off") gate = host?.headless
    ? { title: "Screen sharing is off", text: "Choose a level under Screen on this computer's settings page.", action: "Open computer settings", onAction: () => router.navigate("/settings/desktop") }
    : { title: "Screen sharing is off", text: "On your computer, open Botkins settings and choose a screen access level under Phone." };
  else if (owner === "paused") gate = { title: "Screen sharing paused", text: "You left Botkins. Reconnect to see the computer again.", action: "Reconnect", onAction: () => setOwner("checking") };
  else if (owner === "failed") gate = { title: "Couldn't check it's you", action: "Try again", onAction: () => setOwner("checking") };
  else if (owner === "checking") gate = { title: "Checking it's you…", busy: true };
  else return <Viewer active={active} name={name} computer={pairing?.serverId} route={route} mode={mode} meta={meta} initialDisplay={initialDisplay} />;
  return <Standby name={name} route={online ? route : null} notice={gate} />;
}

function Standby({ name, route, notice }: { name: string; route: LinkRoute | null; notice: Notice }) {
  const insets = useSafeAreaInsets();
  const [panel, setPanel] = useState<Panel>();
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: insets.bottom }]}>
      <Stack.Screen options={{ statusBarStyle: "light" }} />
      <ViewerHeader name={name} route={route} back={leave} help={() => setPanel("help")} stats={() => setPanel("stats")} />
      <ViewerNotice {...notice} />
      {panel && <ViewerPanel panel={panel} close={() => setPanel(undefined)} details={{ route, state: notice.title }} />}
    </View>
  );
}

function ViewerNotice({ title, text, action, onAction, busy }: Notice) {
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      {busy ? <ActivityIndicator color={chrome.ink} /> : <MonitorOff size={30} color={chrome.muted} />}
      <T variant="headline" color={chrome.ink} center>{title}</T>
      {!!text && <T variant="subhead" color={chrome.muted} center>{text}</T>}
      {!!action && <Button title={action} onPress={onAction} style={{ alignSelf: "center" }} />}
    </View>
  );
}

function KeepScreenAwake() {
  useKeepAwake(undefined, { suppressDeactivateWarnings: true });
  useEffect(() => {
    const handle = trackResource("keep-awake", "Remote", "healthy-screen-feed");
    return () => handle.release();
  }, []);
  return null;
}

function Viewer({ active, name, computer, route, mode, meta, initialDisplay }: {
  active: boolean; name: string; computer?: string; route: LinkRoute | null; mode: "view" | "control"; meta: Meta; initialDisplay?: string;
}) {
  const insets = useSafeAreaInsets();
  const shape = useShape();
  const { height: windowHeight } = useWindowDimensions();
  const fold = shape.pose === "laptop" ? shape.fold : null;
  const keyboardShown = useKeyboardState(state => state.isVisible);
  const keyboardHeight = useKeyboardState(state => state.height);
  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [infoError, setInfoError] = useState<string>();
  const [infoRun, setInfoRun] = useState(0);
  const [displayId, setDisplayId] = useState(initialDisplay);
  const [quality, setQuality] = useState<QualityId>(remembered.quality);
  const [pointerMode, setPointerMode] = useState<PointerMode>(remembered.mode);
  const [panel, setPanel] = useState<Panel>();
  const [typing, setTyping] = useState(false);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [note, setNote] = useState<string>();
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pointerX = useSharedValue(0.5);
  const pointerY = useSharedValue(0.5);
  const sender = useRef<InputSender | null>(null);
  const out = { send: (event: ScreenInput) => sender.current?.push(event), clicked: () => haptic.tap(), grabbed: () => haptic.select() };
  const [gestures] = useState(() => new ScreenGestures({ scale, x, y, pointerX, pointerY }, out));

  useEffect(() => {
    let current = true;
    setInfoError(undefined);
    api["link.screen.info"]({ pointer: true }).then(
      next => { if (current) setInfo(next); },
      error => { if (current) setInfoError(errorText(error)); },
    );
    return () => { current = false; };
  }, [mode, infoRun]);

  const displays = info?.displays ?? [];
  const display = displays.find(item => item.id === displayId) ?? displays.find(item => item.primary) ?? displays[0];
  const canView = info?.canView === true;
  const canControl = mode === "control" && info?.canControl === true;
  const supportsVideo = canView && info?.video === true && !!display && display.width > 0 && display.height > 0;
  const video = useDesktopVideo({ enabled: supportsVideo, computer, display: display?.id, quality });
  const showingVideo = supportsVideo && video.status !== "fallback";
  const preset = QUALITY[quality];
  const feed = useFeed({ enabled: canView && !showingVideo, display: display?.id, maxWidth: preset.maxWidth, quality: preset.quality });
  const frame = feed.pictures[feed.pictures.front];
  const target = display?.id ?? frame?.display ?? "";
  const ready = canView && !!target && (showingVideo ? video.status === "live" : feed.state === "live" && frame?.display === target);
  const control = ready && canControl && !panel && active;
  const keyboardUp = control && typing;
  const keyboardBottom = keyboardUp && keyboardShown ? keyboardHeight : insets.bottom;

  function say(text: string) {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(undefined), 3000);
  }
  function keyboardClosed() {
    setTyping(false);
    setModifiers([]);
  }
  function closeKeyboard() {
    input.current?.blur();
    keyboardClosed();
  }
  function openPanel(next: Panel) {
    closeKeyboard();
    gestures.cancel();
    setPanel(next);
  }
  async function paste() {
    if (!control) return;
    setModifiers([]);
    const message = await sender.current?.paste(() => Clipboard.getStringAsync());
    if (message) say(message);
  }

  useLayoutEffect(() => {
    const lane = new InputSender(screenInputSender(), error => say(errorText(error)));
    sender.current = lane;
    return () => {
      gestures.dispose();
      lane.close();
      sender.current = null;
      clearTimeout(noteTimer.current);
    };
  }, [gestures]);
  useLayoutEffect(() => {
    if (target) gestures.selectDisplay(target, info?.pointer?.display === target ? info.pointer : undefined);
    sender.current?.setDisplay(control ? target : "");
    gestures.configure({ mode: pointerMode, control, out });
  }, [gestures, control, target, pointerMode, info?.pointer]);
  useEffect(() => {
    if (!control) closeKeyboard();
  }, [control]);
  const previouslyVisible = useRef(false);
  useEffect(() => {
    if (previouslyVisible.current && !keyboardShown) closeKeyboard();
    previouslyVisible.current = keyboardShown;
  }, [keyboardShown]);
  useEffect(() => {
    let showing = true;
    let previous: ScreenOrientation.OrientationLock | undefined;
    const unlock = ScreenOrientation.getOrientationLockAsync().then(lock => {
      previous = lock;
      if (showing) return ScreenOrientation.unlockAsync();
    }).catch(() => {});
    return () => {
      showing = false;
      void unlock.then(() => ScreenOrientation.lockAsync(Platform.OS === "ios" && Platform.isPad && previous !== undefined ? previous : ScreenOrientation.OrientationLock.PORTRAIT_UP)).catch(() => {});
    };
  }, []);

  const retryInfo = () => setInfoRun(n => n + 1);
  let blocked: Notice | undefined;
  if (infoError) blocked = { title: "Couldn't reach your computer", text: infoError, action: "Retry", onAction: retryInfo };
  else if (info && !canView) blocked = { title: "Can't see the screen", text: info.problem, action: "Retry", onAction: retryInfo };
  else if (!showingVideo && feed.state === "failed") blocked = { title: "Lost the picture", text: feed.error ?? undefined, action: "Retry", onAction: feed.retry };
  const waiting = !showingVideo && feed.state === "retrying" ? "Reconnecting…" : "Connecting to the screen…";
  const state = blocked?.title ?? (ready ? "Connected" : waiting);
  const showBar = canView && canControl;
  const barHeight = keyboardUp ? KEY_BAR_HEIGHT : showBar ? 60 : 0;
  const bottom = fold ? Math.max(0, windowHeight - fold.y) : keyboardBottom + barHeight;
  const details = {
    state, route, display, quality, live: ready,
    source: canView ? showingVideo ? "video" as const : "jpeg" as const : undefined,
    video: showingVideo ? video.stats : null, frame: showingVideo ? null : frame,
    fallbackReason: supportsVideo && video.status === "fallback" ? video.error : undefined,
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      {active && ready && <KeepScreenAwake />}
      <Stack.Screen options={{ statusBarStyle: "light" }} />
      <ViewerHeader name={name} route={route} viewOnly={!!info && !canControl} back={leave} help={() => openPanel("help")} stats={() => openPanel("stats")}
        options={info && canView ? {
          mode: pointerMode, control: canControl, quality, displays, display: display?.id, video: showingVideo,
          onMode: () => {
            gestures.cancel();
            remembered.mode = pointerMode === "trackpad" ? "touch" : "trackpad";
            setPointerMode(remembered.mode);
            say(remembered.mode === "trackpad" ? "Trackpad mode" : "Direct touch");
          },
          onFit: () => gestures.resetZoom(),
          onQuality: id => { remembered.quality = id; setQuality(id); },
          onDisplay: id => { gestures.cancel(); closeKeyboard(); setDisplayId(id); },
        } : undefined}
      />
      <View style={[styles.picture, { marginBottom: bottom }]}>
        {!!info?.problem && canView && <ProblemLine text={info.problem} />}
        {blocked ? <ViewerNotice {...blocked} /> : <>
          <Stage
            pictures={showingVideo ? undefined : feed.pictures} video={showingVideo ? video.surface : null} size={showingVideo ? display ?? null : feed.size}
            display={display ?? null} gestures={gestures} values={{ scale, x, y, pointerX, pointerY }}
            control={control} mode={pointerMode} name={name} drawn={feed.drawn}
          />
          {!ready && <View pointerEvents="none" style={styles.waiting}><ViewerNotice title={waiting} busy /></View>}
        </>}
        {!!note && !panel && <View style={styles.note} pointerEvents="none" accessibilityLiveRegion="polite">
          <T variant="footnote" color={chrome.ink} center>{note}</T>
        </View>}
      </View>

      {control && <HiddenInput inputRef={input} send={out.send} modifiers={modifiers} release={() => setModifiers([])} onFocus={() => setTyping(true)} onBlur={keyboardClosed} />}
      {keyboardUp ? (
        <KeyBar platform={meta.platform} superKey={info?.superKey === true} modifiers={modifiers}
          toggle={modifier => setModifiers(held => held.includes(modifier) ? held.filter(key => key !== modifier) : [...held, modifier])}
          send={out.send} release={() => setModifiers([])} paste={() => void paste()} hide={closeKeyboard} bottom={keyboardBottom}
        />
      ) : showBar ? (
        <View style={[styles.bottom, { bottom: fold ? Math.max(insets.bottom + space.xs, (bottom - fold.height - 52) / 2) : insets.bottom + space.xs }]}>
          <ControlBar enabled={control} paste={() => void paste()} keyboard={() => input.current?.focus()} />
        </View>
      ) : null}
      {panel && active && <ViewerPanel panel={panel} close={() => setPanel(undefined)} details={details} />}
      {!active && <View style={[StyleSheet.absoluteFill, { backgroundColor: chrome.stage }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: chrome.stage },
  picture: { flex: 1 },
  notice: { flex: 1, paddingHorizontal: space.huge, alignItems: "center", justifyContent: "center", gap: space.md },
  waiting: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.55)" },
  note: { position: "absolute", bottom: space.sm, alignSelf: "center", maxWidth: "90%", borderRadius: 20, backgroundColor: chrome.glass, paddingHorizontal: space.lg, paddingVertical: space.sm },
  bottom: { position: "absolute", left: 0, right: 0 },
});
