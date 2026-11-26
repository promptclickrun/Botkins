// An agent's screen panel uses the same video as Control computer. Chat cards request a still
// until the person chooses Watch live on the newest visible card.
//
// Pictures are asked for only while they can be seen, the app is in front and the computer can be
// reached. The full viewer handles keyboard and pointer input after its own owner check.
import { Image } from "expo-image";
import { router, useIsFocused } from "expo-router";
import { Monitor } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { create } from "zustand";
import { checkOwner, type OwnerCheck, useOwnerCheck } from "@/features/credentials/shared";
import { PictureSlots } from "@/features/remote/Picture";
import { useDesktopVideo } from "@/features/remote/useDesktopVideo";
import { useFeed } from "@/features/remote/useFeed";
import type { ScreenInfo, ScreenMode } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { onComputerChange, useApp } from "@/state/store";
import { Button, radius, space, T, useTheme } from "@/ui";
import { DEFAULT_RATIO, feedPlan, type Gate, type Look, type Owner, type Place, type Role, screenGate, screenLook, WORDS } from "./screenLive";
import { useAppActive } from "@/state/useAppActive";

// ── The owner check ───────────────────────────────────────────────────────────────────────────
// A bot showing the screen must never make Face ID appear by itself: the check starts only from a
// tap on "Show screen", and it is the app's one owner check (credentials/shared.tsx, once per app
// session). Its state is read here without starting it, so a person who already confirmed in this
// session (in Credentials, or on another card) sees the screen at once.

/** A tap on "Show screen". */
export function showScreen() {
  void checkOwner("Show your computer's screen");
}

const OWNER: Record<OwnerCheck, Owner> = { unknown: "unasked", checking: "checking", open: "open", locked: "locked" };

// ── What is kept between the places ───────────────────────────────────────────────────────────

/** The newest picture any place drew, so the pane opens on a picture and a card that comes back shows one at once. */
type Still = { uri: string; computer: string; display: string; width: number; height: number };
const useLastScreen = create<{ still: Still | null }>(() => ({ still: null }));
/** A picture older than this is not shown in place of a live one. */
const STILL_MS = 60_000;
let stillTimer: ReturnType<typeof setTimeout> | undefined;
function keepStill(still: Still | null) {
  clearTimeout(stillTimer);
  useLastScreen.setState({ still });
  if (still) stillTimer = setTimeout(() => useLastScreen.setState({ still: null }), STILL_MS);
}

/** How many pane tabs show the screen now. Meanwhile the card under the sheet asks for nothing. */
const usePaneScreen = create<{ shown: number }>(() => ({ shown: 0 }));

/** What the computer said it can show, for its screen level then. Only a yes is kept; a no is asked again. */
type ScreenAnswer = { computer: string; mode: ScreenMode; at: number; info: ScreenInfo };
let infoKept: ScreenAnswer | null = null;
const INFO_MS = 30_000;
const keptInfo = (computer: string | undefined, mode: ScreenMode) => infoKept && infoKept.computer === computer && infoKept.mode === mode && Date.now() - infoKept.at < INFO_MS ? infoKept : null;

onComputerChange(() => {
  keepStill(null);
  infoKept = null;
});

/** Asking again after the computer said it can't show the screen, after it couldn't be asked, and after the picture was lost. */
const PROBLEM_RETRY_MS = 10_000;
const INFO_RETRY_MS = 5_000;
const LOST_RETRY_MS = 10_000;

export type LiveScreen = ReturnType<typeof useLiveScreen>;

/**
 * The screen for one place. `role` is the card's (the pane's tab is always "live"); `visible` says
 * its screen is on show and, for a card, that it is in the chat's view.
 */
export function useLiveScreen(place: Place, { role, visible, playing = false }: { role: Role; visible: boolean; playing?: boolean }) {
  const meta = usePart("meta");
  const host = usePart("host");
  const owner = OWNER[useOwnerCheck()];
  const online = useOnline();
  const route = useApp((state) => state.route);
  const computer = useApp(state => state.pairing?.serverId);
  const focused = useIsFocused();
  const front = useAppActive(focused && visible);
  const paneShows = usePaneScreen((state) => state.shown > 0);

  const gate: Gate = screenGate({ capabilities: meta?.capabilities, host, owner, member: meta?.you?.kind === "member" });
  const mode = host?.screen ?? "off";
  const wants = gate.kind === "open" && role === "live" && visible && front && !(place === "card" && paneShows);
  const asking = wants && online;
  const continuous = place === "pane" || playing;
  const plan = feedPlan(continuous ? "pane" : "card", route);

  // What the computer offers: whether it can show the screen now, and why not.
  const [answer, setAnswer] = useState<ScreenAnswer | null>(() => keptInfo(computer, mode));
  const info = answer?.computer === computer && answer?.mode === mode ? answer.info : null;
  const [infoRun, setInfoRun] = useState(0);
  useEffect(() => {
    if (!asking || !computer) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      if (continuous) timer = setTimeout(() => setInfoRun((n) => n + 1), ms);
    };
    const kept = keptInfo(computer, mode);
    if (kept) setAnswer(kept);
    else
      api["link.screen.info"]()
        .then((next) => {
          if (!alive || useApp.getState().pairing?.serverId !== computer) return;
          const result = { computer, mode, at: Date.now(), info: next };
          setAnswer(result);
          if (next.canView) infoKept = result;
          else again(PROBLEM_RETRY_MS);
        })
        .catch(() => {
          if (!alive || useApp.getState().pairing?.serverId !== computer) return;
          setAnswer({ computer, mode, at: Date.now(), info: { mode, displays: [], canView: false, canControl: false, problem: WORDS.away } });
          again(INFO_RETRY_MS);
        });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [asking, computer, mode, infoRun, continuous]);

  const canView = info?.canView === true;
  const following = asking && canView;
  const primary = info?.displays.find(item => item.primary) ?? info?.displays[0];
  const feedOwner = place === "pane" ? "PaneScreen" : "ScreenCard";
  const wantsVideo = following && continuous && info?.video === true && !!primary?.id && primary.width > 0 && primary.height > 0;
  const video = useDesktopVideo({ enabled: wantsVideo, computer, display: primary?.id, quality: route === "relay" ? "saver" : "balanced", owner: feedOwner });
  const showingVideo = wantsVideo && video.status !== "fallback";
  const feed = useFeed({ enabled: following && !showingVideo, display: primary?.id, maxWidth: plan.maxWidth, quality: plan.quality, gapMs: plan.gapMs, once: !continuous, owner: feedOwner });

  // The pane's tab over the chat: the card under it waits.
  useEffect(() => {
    if (place !== "pane" || !wants) return;
    usePaneScreen.setState((held) => ({ shown: held.shown + 1 }));
    return () => usePaneScreen.setState((held) => ({ shown: Math.max(0, held.shown - 1) }));
  }, [place, wants]);

  // A lost picture comes back by itself (coming back online restarts the loop anyway).
  const { retry } = feed;
  useEffect(() => {
    if (!continuous || !following || showingVideo || feed.state !== "failed") return;
    const timer = setTimeout(retry, LOST_RETRY_MS);
    return () => clearTimeout(timer);
  }, [continuous, following, showingVideo, feed.state, retry]);

  // The newest picture, for the other places. Forgotten when the screen is turned off.
  const picture = feed.pictures[feed.pictures.front];
  const size = feed.size;
  useEffect(() => {
    if (following && !showingVideo && picture && computer) keepStill({ uri: picture.uri, computer, display: picture.display, width: picture.width, height: picture.height });
  }, [following, showingVideo, picture, computer]);
  const off = gate.kind === "off";
  useEffect(() => {
    if (off) { keepStill(null); infoKept = null; }
  }, [off]);

  // Only the live place borrows the newest picture; an older card keeps only its own.
  const still = useLastScreen(state => wants && !showingVideo && !feed.hasPicture && state.still?.computer === computer && (!primary || state.still?.display === primary.id) ? state.still : null);
  const look: Look = screenLook({
    place: continuous ? "pane" : "card",
    gate,
    role,
    wants,
    online,
    problem: info && !info.canView ? (info.problem ?? "") : undefined,
    feed: showingVideo ? (video.status === "live" ? "live" : "starting") : feed.state,
    hasPicture: showingVideo ? video.status === "live" : feed.hasPicture || !!still,
  });
  const shape = showingVideo ? primary : size ?? still ?? primary;
  const ratio = shape && shape.height > 0 ? shape.width / shape.height : DEFAULT_RATIO;
  // This shortcut goes directly to the full viewer's fresh owner check, including when the
  // preview is still covered. It never unlocks a preview or changes the host's permission.
  const viewerLabel = computer && online && front && role === "live" && (gate.kind === "open" || gate.kind === "covered") && info?.canView !== false
    ? mode === "control" && info?.canControl !== false ? WORDS.control : WORDS.watch
    : undefined;
  function openViewer() {
    const current = useApp.getState();
    if (!viewerLabel || !computer || current.pairing?.serverId !== computer || current.link !== "online" || current.parts.meta?.you?.kind === "member" || !current.parts.host || current.parts.host.screen === "off") return;
    const display = primary?.id ?? picture?.display;
    router.push({ pathname: "/remote", params: { computer, ...(display && { display }) } });
  }
  return { gate, look, feed, still, ratio, front, canPlay: following, viewerLabel, openViewer, video: showingVideo ? video.surface : null, showingVideo };
}

// ── What is drawn ─────────────────────────────────────────────────────────────────────────────

/** The live picture, filling the view it is in, with the line or spinner over it. For looking only. */
export function ScreenPicture({ screen }: { screen: LiveScreen }) {
  const { colors } = useTheme();
  const { feed, still, look } = screen;
  const activity = feed.activity;
  if (!screen.front) return null;
  const activityLine = activity
    ? [activity.botName || "Bot", activity.action, activity.app].filter(Boolean).join(" · ")
    : "";
  const activityMeta = activity?.deliveryMode === "background" && activity.pointerUntouched
    ? "Background · pointer untouched"
    : activity?.deliveryMode === "foreground"
      ? "Foreground"
      : null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, look.dim && styles.dim]}>
        {!!still && <Image source={{ uri: still.uri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="none" transition={null} accessible={false} />}
        {screen.showingVideo ? screen.video : <PictureSlots pictures={feed.pictures} drawn={feed.drawn} />}
      </View>
      {!!activityLine && !look.dim && (
        <View style={[styles.activityPill, { backgroundColor: colors.surface, borderColor: colors.line }]}>
          <T variant="caption" weight="600" numberOfLines={1}>{activityLine}</T>
          {!!activityMeta && <T variant="caption" color="muted" numberOfLines={1}>{activityMeta}</T>}
        </View>
      )}
      {(look.busy || !!look.line) && (
        <View style={[StyleSheet.absoluteFill, styles.center, { padding: space.lg }]}>
          {look.busy ? (
            <ActivityIndicator color={colors.muted} />
          ) : (
            <View style={look.dim ? { backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm } : undefined}>
              <T variant="subhead" color={look.dim ? "ink" : "muted"} center numberOfLines={3}>
                {look.line}
              </T>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** What covers the picture while a gate is closed: one line, and "Show screen" before the owner check. */
export function GateCover({ gate }: { gate: Gate }) {
  const { colors } = useTheme();
  const line = gate.kind === "member" ? WORDS.member : gate.kind === "update" ? WORDS.update : gate.kind === "off" ? WORDS.off(gate.headless) : gate.kind === "covered" ? WORDS.covered : null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, { padding: space.lg, gap: space.sm }]}>
      {gate.kind === "covered" && <Monitor size={22} color={colors.muted} strokeWidth={2} />}
      {!!line && (
        <T variant="subhead" color={gate.kind === "covered" ? "ink2" : "muted"} center numberOfLines={3}>
          {line}
        </T>
      )}
      {gate.kind === "covered" && <Button title={WORDS.show} variant="secondary" size="sm" loading={gate.checking} onPress={showScreen} />}
      {gate.kind === "off" && gate.headless && <Button title="Open computer settings" variant="secondary" size="sm" onPress={() => router.navigate("/settings/desktop")} />}
    </View>
  );
}

/** What VoiceOver reads for a closed gate. */
export function gateLabel(gate: Gate): string {
  if (gate.kind === "member") return WORDS.member;
  if (gate.kind === "update") return WORDS.title + ". " + WORDS.update;
  if (gate.kind === "off") return WORDS.title + ". " + WORDS.off(gate.headless);
  return WORDS.title;
}

/** A cover with a button exposes that button to the screen reader independently. */
export function gateHasAction(gate: Gate) {
  return gate.kind === "covered" || (gate.kind === "off" && gate.headless);
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  dim: { opacity: 0.35 },
  activityPill: {
    position: "absolute",
    top: space.sm,
    left: space.sm,
    right: space.sm,
    alignSelf: "flex-start",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    opacity: 0.94,
  },
});
