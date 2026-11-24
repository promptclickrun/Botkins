// The computer's screen where a bot showed it: a still in a chat's ScreenCard and live in the side
// pane's screen tab, the picture they draw, and what covers it while a gate is closed. The rules are
// in screenLive.ts; the picture loop is Settings › Screen's own (src/features/remote/useFeed.ts).
//
// Pictures are asked for only while they can be seen, the app is in front and the computer can be
// reached. Neither place keeps the phone awake or sends any input: using the pointer and keyboard is
// Settings › Screen's, behind its own check.
import { Image } from "expo-image";
import { Monitor } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { create } from "zustand";
import { checkOwner, type OwnerCheck, useOwnerCheck } from "@/features/credentials/shared";
import { PictureSlots } from "@/features/remote/Picture";
import { useFeed } from "@/features/remote/useFeed";
import type { ScreenInfo, ScreenMode } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { onComputerChange, useApp } from "@/state/store";
import { Button, radius, space, T, useTheme } from "@/ui";
import { DEFAULT_RATIO, feedPlan, type Gate, type Look, type Owner, type Place, type Role, screenGate, screenLook, WORDS } from "./screenLive";
import { useAppActive } from "@/state/useAppActive";
import { useIsFocused } from "expo-router";

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
type Still = { uri: string; width: number; height: number };
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
let infoKept: { mode: ScreenMode; at: number; info: ScreenInfo } | null = null;
const INFO_MS = 30_000;
const keptInfo = (mode: ScreenMode) => (infoKept && infoKept.mode === mode && Date.now() - infoKept.at < INFO_MS ? infoKept.info : null);

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
export function useLiveScreen(place: Place, { role, visible }: { role: Role; visible: boolean }) {
  const meta = usePart("meta");
  const host = usePart("host");
  const owner = OWNER[useOwnerCheck()];
  const online = useOnline();
  const route = useApp((state) => state.route);
  const focused = useIsFocused();
  const front = useAppActive(focused && visible);
  const paneShows = usePaneScreen((state) => state.shown > 0);

  const gate: Gate = screenGate({ capabilities: meta?.capabilities, host, owner });
  const mode = host?.screen ?? "off";
  const wants = gate.kind === "open" && role === "live" && visible && front && !(place === "card" && paneShows);
  const asking = wants && online;
  const plan = feedPlan(place, route);

  // What the computer offers: whether it can show the screen now, and why not.
  const [info, setInfo] = useState<ScreenInfo | null>(() => keptInfo(mode));
  const [infoRun, setInfoRun] = useState(0);
  useEffect(() => {
    if (!asking) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      if (place === "pane") timer = setTimeout(() => setInfoRun((n) => n + 1), ms);
    };
    const kept = keptInfo(mode);
    if (kept) setInfo(kept);
    else
      api["link.screen.info"]()
        .then((next) => {
          if (!alive) return;
          setInfo(next);
          if (next.canView) infoKept = { mode, at: Date.now(), info: next };
          else again(PROBLEM_RETRY_MS);
        })
        .catch(() => {
          if (!alive) return;
          setInfo({ mode, displays: [], canView: false, canControl: false, problem: WORDS.away });
          again(INFO_RETRY_MS);
        });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [asking, mode, infoRun, place]);

  const canView = info?.canView === true;
  const following = asking && canView;
  const feed = useFeed({ enabled: following, display: undefined, maxWidth: plan.maxWidth, quality: plan.quality, gapMs: plan.gapMs, once: place === "card" });

  // The pane's tab over the chat: the card under it waits.
  useEffect(() => {
    if (place !== "pane" || !wants) return;
    usePaneScreen.setState((held) => ({ shown: held.shown + 1 }));
    return () => usePaneScreen.setState((held) => ({ shown: Math.max(0, held.shown - 1) }));
  }, [place, wants]);

  // A lost picture comes back by itself (coming back online restarts the loop anyway).
  const { retry } = feed;
  useEffect(() => {
    if (place === "card" || !following || feed.state !== "failed") return;
    const timer = setTimeout(retry, LOST_RETRY_MS);
    return () => clearTimeout(timer);
  }, [place, following, feed.state, retry]);

  // The newest picture, for the other places. Forgotten when the screen is turned off.
  const picture = feed.pictures[feed.pictures.front];
  const size = feed.size;
  useEffect(() => {
    if (picture && size) keepStill({ uri: picture.uri, width: size.width, height: size.height });
  }, [picture, size]);
  const off = gate.kind === "off";
  useEffect(() => {
    if (off) { keepStill(null); infoKept = null; }
  }, [off]);

  // Only the live place borrows the newest picture; an older card keeps only its own.
  const still = useLastScreen(state => wants && !feed.hasPicture ? state.still : null);
  const look: Look = screenLook({
    place,
    gate,
    role,
    wants,
    online,
    problem: info && !info.canView ? (info.problem ?? "") : undefined,
    feed: feed.state,
    hasPicture: feed.hasPicture || !!still,
  });
  const primary = info?.displays.find((item) => item.primary) ?? info?.displays[0];
  const shape = size ?? still ?? (primary && primary.height > 0 ? primary : null);
  const ratio = shape && shape.height > 0 ? shape.width / shape.height : DEFAULT_RATIO;
  return { gate, look, feed, still, ratio, info, mode };
}

// ── What is drawn ─────────────────────────────────────────────────────────────────────────────

/** The live picture, filling the view it is in, with the line or spinner over it. For looking only. */
export function ScreenPicture({ screen }: { screen: LiveScreen }) {
  const { colors } = useTheme();
  const { feed, still, look } = screen;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, look.dim && styles.dim]}>
        {!!still && <Image source={{ uri: still.uri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="none" transition={null} accessible={false} />}
        <PictureSlots pictures={feed.pictures} drawn={feed.drawn} />
      </View>
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
  const line = gate.kind === "update" ? WORDS.update : gate.kind === "off" ? WORDS.off(gate.headless) : gate.kind === "covered" ? WORDS.covered : null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, { padding: space.lg, gap: space.sm }]}>
      {gate.kind === "covered" && <Monitor size={22} color={colors.muted} strokeWidth={2} />}
      {!!line && (
        <T variant="subhead" color={gate.kind === "covered" ? "ink2" : "muted"} center numberOfLines={3}>
          {line}
        </T>
      )}
      {gate.kind === "covered" && <Button title={WORDS.show} variant="secondary" size="sm" loading={gate.checking} onPress={showScreen} />}
    </View>
  );
}

/** What VoiceOver reads for a closed gate. */
export function gateLabel(gate: Gate): string {
  if (gate.kind === "update") return WORDS.title + ". " + WORDS.update;
  if (gate.kind === "off") return WORDS.title + ". " + WORDS.off(gate.headless);
  return WORDS.title;
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  dim: { opacity: 0.35 },
});
