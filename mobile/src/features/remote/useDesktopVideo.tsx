import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { holdScreen } from "@/features/pane/watching";
import { desktopVideoLink } from "@/state/link";
import { useAppActive } from "@/state/useAppActive";
import { QUALITY, type QualityId } from "./chrome";
import { claimScreenFeed, type ScreenFeedOwner, whenScreenFeedFree } from "./feedRegistry";
import { VIDEO_SOURCE } from "./videoPage";

type Stats = { width: number; height: number; fps: number };
type Report = { status: "starting" | "live" | "fallback"; stats: Stats | null; error?: string };
type Options = { enabled: boolean; computer?: string; display?: string; quality: QualityId; owner?: ScreenFeedOwner };
type Player = { computer: string; display: string; quality: QualityId; owner: ScreenFeedOwner; report: (update: Report) => void };
const first: Report = { status: "starting", stats: null };

export function useDesktopVideo({ enabled, computer, display, quality, owner = "Remote" }: Options) {
  const active = useAppActive(enabled);
  const key = active && computer && display ? JSON.stringify([computer, display, quality, owner]) : "";
  const [state, setState] = useState({ key: "", ...first });
  const report = useCallback((update: Report) => setState({ key, ...update }), [key]);
  useEffect(() => { if (!key) setState({ key: "", ...first }); }, [key]);
  const current = state.key === key ? state : first;
  const surface = key && computer && display && current.status !== "fallback"
    ? <DesktopPlayer key={key} computer={computer} display={display} quality={quality} owner={owner} report={report} />
    : null;
  return { ...current, surface };
}

function DesktopPlayer({ computer, display, quality, owner, report }: Player) {
  const web = useRef<WebView<object>>(null);
  const receive = useRef<(message: string) => void>(() => {});
  const failed = useRef<() => void>(() => {});
  const [attempt, setAttempt] = useState(0);
  const [hasSlot, setHasSlot] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let link: ReturnType<typeof desktopVideoLink> | undefined;
    let opened = false, reading = false, seq = 0;
    let startup: ReturnType<typeof setTimeout>;
    let releaseFeed: (() => void) | null = null;
    let release: ReturnType<typeof holdScreen> | undefined;
    let cancelWait: (() => void) | undefined;
    const stop = () => {
      if (signal.aborted) return;
      controller.abort();
      clearTimeout(startup);
      link?.close();
      releaseFeed?.();
      release?.(AppState.currentState !== "active");
    };
    const fail = (error?: unknown) => {
      if (signal.aborted) return;
      stop();
      report({ status: "fallback", stats: null, error: error instanceof Error ? error.message : "Live video is unavailable." });
    };
    failed.current = fail;
    const waitForSlot = () => {
      stop();
      setHasSlot(false);
      report(first);
      cancelWait = whenScreenFeedFree(computer, () => setAttempt(value => value + 1));
    };
    const leave = () => { cancelWait?.(); stop(); };
    releaseFeed = claimScreenFeed(computer, display, owner, waitForSlot);
    if (!releaseFeed) { waitForSlot(); return leave; }
    release = holdScreen(computer);
    setHasSlot(true);
    startup = setTimeout(() => fail(new Error("The computer did not start video playback.")), 15_000);
    const post = (type: string, value: string) => {
      if (!signal.aborted) web.current?.postMessage(JSON.stringify({ type, value }));
    };
    const handle = async (raw: string) => {
      if (signal.aborted || raw.length > 1024) return;
      const { type, value } = JSON.parse(raw);
      if (type === "formats" && !link) {
        if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === "string")) return fail();
        link = desktopVideoLink(computer, randomUUID(), signal);
        const { mimeType } = await link.open({ display, maxWidth: QUALITY[quality].maxWidth, fps: QUALITY[quality].fps, mimeTypes: value });
        if (!value.includes(mimeType)) return fail();
        opened = true;
        post("open", mimeType);
      } else if (type === "pull" && link && opened && !reading) {
        reading = true;
        const bytes = await link.read(seq++);
        reading = false;
        if (typeof bytes !== "string" || !bytes.length || bytes.length > 349528) return fail();
        post("bytes", bytes);
      } else if (type === "playing" && opened && value?.width > 0 && value?.height > 0) {
        clearTimeout(startup);
        report({ status: "live", stats: { width: value.width, height: value.height, fps: value.fps } });
      } else if (type === "error") fail(new Error(typeof value === "string" && value.length <= 160 ? value : "The desktop video decoder stopped."));
    };
    receive.current = raw => { void handle(raw).catch(fail); };
    return leave;
  }, [computer, display, quality, owner, report, attempt]);

  return hasSlot ? (
    <WebView<object>
      key={attempt} ref={web} source={VIDEO_SOURCE} style={StyleSheet.absoluteFill} pointerEvents="none"
      originWhitelist={["*"]} onShouldStartLoadWithRequest={request => request.url === "about:blank"}
      onMessage={event => receive.current(event.nativeEvent.data)} onError={() => failed.current()}
      onContentProcessDidTerminate={() => failed.current()} onRenderProcessGone={() => failed.current()}
      allowsInlineMediaPlayback allowsAirPlayForMediaPlayback={false} mediaPlaybackRequiresUserAction={false}
      javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false} allowFileAccess={false}
      incognito cacheEnabled={false} domStorageEnabled={false} scrollEnabled={false} bounces={false}
      automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
    />
  ) : null;
}
