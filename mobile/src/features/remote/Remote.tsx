// Screen: see the computer's screen from the phone and, when the computer allows it, use its
// pointer and keyboard. Full screen, on black whatever the theme.
import * as LocalAuthentication from "expo-local-authentication";
import { useKeepAwake } from "expo-keep-awake";
import { router, Stack, useIsFocused } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { Monitor, MonitorOff, RefreshCw, X } from "lucide-react-native";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, type TextInput, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppActive } from "@/state/useAppActive";
import type { Meta, ScreenInfo, ScreenInput } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api, screenInputSender } from "@/state/link";
import { useScreenKey } from "@/features/pane/watching";
import { Button, EmptyState, haptic, IconButton, space, T, useShape, useTheme } from "@/ui";
import { BAR_HIDE_MS, chrome, QUALITY, type QualityId } from "./chrome";
import { ControlBar, ProblemLine, StatusLine } from "./Controls";
import { type GestureOutput, type PointerMode, ScreenGestures } from "./gestures";
import { InputSender } from "./input";
import { HiddenInput, KEY_BAR_HEIGHT, KeyBar } from "./KeyBar";
import { Stage } from "./Stage";
import { useFeed } from "./useFeed";

type Modifier = "cmd" | "ctrl" | "alt" | "shift";

/** Choices kept while the app runs, so the Screen opens the way it was left. */
const remembered: { quality: QualityId; mode: PointerMode } = { quality: "balanced", mode: "trackpad" };

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export default function Remote() {
  const host = useScreenKey();
  return <RemoteScreen key={host} />;
}

function RemoteScreen() {
  const focused = useIsFocused();
  const active = useAppActive(focused);
  const online = useOnline();
  const [displayId, setDisplayId] = useState<string>();
  const meta = usePart("meta");
  const mode = usePart("host")?.screen ?? "off";
  const headless = usePart("host")?.headless === true;
  const supported = !!meta?.capabilities.includes("screen-v1");
  const needsCheck = supported && mode !== "off";
  const [owner, setOwner] = useState<"checking" | "ok" | "failed">("checking");
  const asking = useRef(false);
  const mounted = useRef(true);
  const inView = useRef(focused);
  inView.current = focused;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // It has to be the phone's owner: Face ID, Touch ID or the passcode, every time the Screen opens.
  useEffect(() => {
    if (!active || !online || !needsCheck || owner !== "checking" || asking.current) return;
    asking.current = true;
    void (async () => {
      try {
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        if (!mounted.current || !inView.current) return;
        if (level === LocalAuthentication.SecurityLevel.NONE) return setOwner("ok");
        const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Show your computer's screen", cancelLabel: "Cancel" });
        if (!mounted.current || !inView.current) return;
        if (result.success) setOwner("ok");
        else if (result.error === "user_cancel") {
          // Only the person's own Cancel closes the Screen; an interrupted check offers another try.
          router.back();
        } else if (result.error === "not_enrolled" || result.error === "passcode_not_set") setOwner("ok");
        else setOwner("failed");
      } catch {
        if (mounted.current && inView.current) setOwner("failed");
      } finally {
        asking.current = false;
      }
    })();
  }, [active, online, needsCheck, owner]);

  if (!active) return null;
  if (!online) return <Gate title="Can't reach your computer" />;
  if (!meta) return <Waiting />;
  if (!supported) return <Gate title="Update the app on your computer to use Screen." />;
  // A headless host has no window to turn it on in: there the phone does it, on the computer's page.
  if (mode === "off") return <Gate title="Screen is off for phones" text={headless ? "Turn it on in Settings, on this computer's page, under Screen." : "Turn it on in the app on your computer, under Phone."} icon />;
  if (owner === "failed") return <Gate title="Couldn't check it's you" action="Try again" onAction={() => setOwner("checking")} />;
  if (owner === "checking") return <Waiting />;
  return <Viewer mode={mode} meta={meta} displayId={displayId} setDisplayId={setDisplayId} />;
}

function Waiting() {
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: chrome.stage }]}>
      <Stack.Screen options={{ statusBarStyle: "light" }} />
      <ActivityIndicator color={chrome.ink} />
      <CloseCorner />
    </View>
  );
}

/** A screen with nothing to show: one line, at most one action, and Close. */
function Gate({ title, text, icon, action, onAction }: { title: string; text?: string; icon?: boolean; action?: string; onAction?: () => void }) {
  const { colors, dark } = useTheme();
  return (
    <View style={[styles.fill, styles.center, { backgroundColor: colors.canvas }]}>
      <Stack.Screen options={{ statusBarStyle: dark ? "light" : "dark" }} />
      <EmptyState icon={icon ? MonitorOff : Monitor} title={title} text={text} action={action} onAction={onAction} />
      <CloseCorner themed />
    </View>
  );
}

function CloseCorner({ themed }: { themed?: boolean }) {
  const insets = useSafeAreaInsets();
  const position = { position: "absolute" as const, top: insets.top + space.sm, left: insets.left + space.lg };
  if (themed) return <IconButton icon={X} label="Close" variant="soft" size={44} onPress={() => router.back()} style={position} />;
  return <IconButton icon={X} label="Close" size={44} color={chrome.ink} onPress={() => router.back()} style={[position, { backgroundColor: chrome.glass }]} />;
}

function KeepScreenAwake() {
  useKeepAwake(undefined, { suppressDeactivateWarnings: true });
  return null;
}

function Viewer({ mode, meta, displayId, setDisplayId }: { mode: "view" | "control"; meta: Meta; displayId?: string; setDisplayId: (id: string) => void }) {
  const insets = useSafeAreaInsets();
  // Half open and flat on a table (iPhone Duo's laptop pose): the picture keeps to the upright half,
  // above the fold, and the controls stay on the half that lies on the table.
  const shape = useShape();
  const { height: windowHeight } = useWindowDimensions();
  const laptop = shape.pose === "laptop" && shape.fold ? shape.fold : null;
  const below = laptop ? Math.max(0, windowHeight - laptop.y) : 0;
  const keyboardShown = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);

  const [info, setInfo] = useState<ScreenInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [infoRun, setInfoRun] = useState(0);
  const [quality, setQuality] = useState<QualityId>(remembered.quality);
  const [pointerMode, setPointerMode] = useState<PointerMode>(remembered.mode);
  const [barVisible, setBarVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const pointerX = useSharedValue(0.5);
  const pointerY = useSharedValue(0.5);
  const [gestures] = useState(() => new ScreenGestures({ scale, x, y, pointerX, pointerY }, { send: () => {}, clicked: () => {}, grabbed: () => {}, showBar: () => {}, touched: () => {} }));
  const failedRef = useRef<(error: unknown) => void>(() => {});
  const [sender] = useState(() => new InputSender(screenInputSender(), (error) => failedRef.current(error)));
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdBar = useRef(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // What the computer offers: its displays, whether it can be watched or used, and any problem.
  useEffect(() => {
    let alive = true;
    api["link.screen.info"]()
      .then((next) => {
        if (!alive) return;
        setInfo(next);
        setInfoError(null);
      })
      .catch((error: unknown) => alive && setInfoError(messageOf(error, "Couldn't reach your computer.")));
    return () => {
      alive = false;
    };
  }, [mode, infoRun]);

  const displays = info?.displays ?? [];
  const display = displays.find((item) => item.id === displayId) ?? displays.find((item) => item.primary) ?? displays[0];
  const canView = info?.canView === true;
  const preset = QUALITY[quality];
  const feed = useFeed({ enabled: canView, display: display?.id, maxWidth: preset.maxWidth, quality: preset.quality });
  const target = display?.id ?? feed.size?.display ?? "";

  const ready = feed.state === "live" && !!target && feed.pictures[feed.pictures.front]?.display === target;
  const canControl = mode === "control" && info?.canControl === true;
  const control = ready && canControl;

  // Leaving the Screen: let go of everything and tell the computer.
  useEffect(
    () => () => {
      gestures.dispose();
      sender.close();
      clearTimeout(hideTimer.current);
      clearTimeout(noteTimer.current);
    },
    [gestures, sender],
  );

  // The Screen turns with the phone while it is open.
  useEffect(() => {
    let previous: ScreenOrientation.OrientationLock | undefined;
    void ScreenOrientation.getOrientationLockAsync()
      .then((lock) => {
        previous = lock;
      })
      .catch(() => {});
    void ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      const pad = Platform.OS === "ios" && Platform.isPad;
      void ScreenOrientation.lockAsync(pad && previous !== undefined ? previous : ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    };
  }, []);

  function say(text: string) {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3000);
  }

  function poke() {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!holdBar.current) setBarVisible(false);
    }, BAR_HIDE_MS);
  }
  function showBar() {
    setBarVisible(true);
    poke();
  }
  // The bar stays while its menu is open or the keyboard is up; otherwise it hides 3 s after the last touch.
  useEffect(() => {
    holdBar.current = menuOpen || typing;
    if (!holdBar.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setBarVisible(false), BAR_HIDE_MS);
    }
  }, [menuOpen, typing]);

  useEffect(() => {
    failedRef.current = (error) => say(messageOf(error, "Couldn't reach your computer."));
  });

  useEffect(() => {
    sender.setDisplay(control ? target : "");
  }, [sender, target, control]);

  useEffect(() => {
    const out: GestureOutput = { send: (event) => sender.push(event), clicked: () => haptic.tap(), grabbed: () => haptic.select(), showBar, touched: poke };
    gestures.configure({ mode: pointerMode, control, barHidden: !barVisible, out });
  });

  const send = (event: ScreenInput) => sender.push(event);
  const keyboardUp = typing && keyboardShown;

  function toggleKeyboard() {
    if (typing) inputRef.current?.blur();
    else inputRef.current?.focus();
  }
  function switchMode() {
    const next: PointerMode = pointerMode === "trackpad" ? "touch" : "trackpad";
    remembered.mode = next;
    setPointerMode(next);
    say(next === "trackpad" ? "Trackpad" : "Touch");
    poke();
  }
  function chooseQuality(id: QualityId) {
    remembered.quality = id;
    setQuality(id);
  }
  function chooseDisplay(id: string) {
    gestures.cancel();
    gestures.resetZoom();
    setDisplayId(id);
  }

  const retrying = feed.state === "retrying";
  let blocked: { title: string; text?: string; action: string; onAction: () => void } | null = null;
  if (infoError && !info) blocked = { title: "Couldn't reach your computer", text: infoError, action: "Retry", onAction: () => setInfoRun((n) => n + 1) };
  else if (info && !canView) blocked = { title: "Can't see the screen", text: info.problem, action: "Retry", onAction: () => setInfoRun((n) => n + 1) };
  else if (feed.state === "failed") blocked = { title: "Lost the picture", text: feed.error ?? undefined, action: "Retry", onAction: feed.retry };

  return (
    <View style={[styles.fill, { backgroundColor: chrome.stage }]}>
      {ready && <KeepScreenAwake />}
      <Stack.Screen options={{ statusBarStyle: "light" }} />
      <View style={[styles.fill, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, paddingBottom: laptop ? below : keyboardUp ? keyboardHeight + KEY_BAR_HEIGHT : insets.bottom }]}>
        {!!info?.problem && canView && <ProblemLine text={info.problem} />}
        {blocked ? (
          <Blocked {...blocked} />
        ) : (
          <Stage
            pictures={feed.pictures}
            size={feed.size}
            display={display ? { width: display.width, height: display.height } : null}
            gestures={gestures}
            values={{ scale, x, y, pointerX, pointerY }}
            showPointer={control && pointerMode === "trackpad" && feed.hasPicture}
            drawn={feed.drawn}
          >
            <StatusLine visible={barVisible || !!note} top={space.sm} name={meta.name} viewOnly={!canControl} waiting={!feed.hasPicture} reconnecting={retrying} note={note} />
          </Stage>
        )}
      </View>

      {control && (
        <HiddenInput
          inputRef={inputRef}
          send={send}
          modifiers={modifiers}
          release={() => setModifiers([])}
          onFocus={() => setTyping(true)}
          onBlur={() => {
            setTyping(false);
            setModifiers([]);
            showBar();
          }}
        />
      )}
      {control && keyboardUp && (
        <KeyBar
          platform={meta.platform}
          modifiers={modifiers}
          toggle={(modifier) => setModifiers((held) => (held.includes(modifier) ? held.filter((item) => item !== modifier) : [...held, modifier]))}
          send={send}
          release={() => setModifiers([])}
          hide={() => inputRef.current?.blur()}
          bottom={keyboardHeight}
        />
      )}
      <ControlBar
        visible={(barVisible || !!laptop || !!blocked) && !keyboardUp}
        bottom={laptop ? Math.max(insets.bottom + space.md, (below - laptop.height) / 2) : insets.bottom + space.md}
        control={control && !blocked}
        mode={pointerMode}
        displays={displays}
        display={display?.id}
        quality={quality}
        onClose={() => router.back()}
        onKeyboard={toggleKeyboard}
        onMode={switchMode}
        onDisplay={chooseDisplay}
        onQuality={chooseQuality}
        onFit={() => gestures.resetZoom()}
        onMenu={setMenuOpen}
      />
    </View>
  );
}

function Blocked({ title, text, action, onAction }: { title: string; text?: string; action: string; onAction: () => void }) {
  return (
    <View style={[styles.fill, styles.center, { paddingHorizontal: space.huge, gap: space.md }]}>
      <MonitorOff size={32} color={chrome.muted} strokeWidth={1.9} />
      <T variant="title3" color={chrome.ink} center>
        {title}
      </T>
      {!!text && (
        <T variant="subhead" color={chrome.muted} center>
          {text}
        </T>
      )}
      <Button title={action} icon={RefreshCw} onPress={onAction} style={{ alignSelf: "center", marginTop: space.sm }} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
});
