// A custom view (an html block): a page a bot wrote, drawn in a web view inside a card or a Today
// panel. The page is not trusted (src/ui/frame.ts has the rules): it loads from a string, never
// from an address, every navigation is refused, and it reaches the app only through the few
// messages read below. The page comes from the computer (`link.frame.page`), which needs "frames-v1".
import { router } from "expo-router";
import { AppWindow, Maximize2, RefreshCw, TriangleAlert } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { AnswerPace, allowsLoad, clampHeight, FRAME_GUARD, frameColors, framePage, frameScript, readFrameMessage } from "./frame";
import { Tap } from "./Tap";
import { T } from "./Text";
import { radius, slopFor, space, useTheme } from "./theme";

type Loaded = { html: string; data: unknown };
/** How long a page may take to say it is ready before the view says it didn't load. */
const PATIENCE = 20_000;
/** A page may hand over text or ask to open a link only just after the person touched it. */
const TOUCH_WINDOW = 10_000;
/** After the person says no to a link, the view can't ask again for a minute. */
const QUIET = 60_000;

// A view's page never changes (a new page gets a new id), so the last few are kept while the app runs.
const pages = new Map<string, Promise<Loaded>>();
function pageOf(frame: string): Promise<Loaded> {
  let page = pages.get(frame);
  if (!page) {
    page = api["link.frame.page"](frame);
    pages.set(frame, page);
    page.catch(() => pages.get(frame) === page && pages.delete(frame));
    if (pages.size > 8) pages.delete(pages.keys().next().value!);
  }
  return page;
}

const pace = new AnswerPace();
const quietUntil = new Map<string, number>();
let asking = false;

/** Opens a web page for a view, when the person says yes. One question at a time. */
function askToOpen(frame: string, url: string): Promise<boolean> {
  if (asking || Date.now() < (quietUntil.get(frame) ?? 0)) return Promise.resolve(false);
  asking = true;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Shown as it came.
  }
  return new Promise((resolve) => {
    const done = (open: boolean) => {
      asking = false;
      if (!open) quietUntil.set(frame, Date.now() + QUIET);
      else void Linking.openURL(url).catch(() => showToast("Couldn't open that page.", "error"));
      resolve(open);
    };
    Alert.alert("Open " + host + "?", url.length > 200 ? url.slice(0, 200) + "…" : url, [
      { text: "Cancel", style: "cancel", onPress: () => done(false) },
      { text: "Open", onPress: () => done(true) },
    ]);
  });
}

/** The chat a view's answer goes to when the view isn't in a chat: the computer knows. */
async function answerInItsChat(frame: string, text: string) {
  const { chatId } = await api["link.frame.chat"](frame);
  if (!chatId) throw new Error("This view's chat no longer exists.");
  router.push({ pathname: "/chat/[id]", params: { id: chatId, draft: text } });
}

export type HtmlFrameProps = {
  frame: string;
  /** The height the bot asked for, until the page says its own. */
  height: number;
  title?: string;
  /** Puts a view's answer in the message box of the chat on screen. Without it the view's own chat opens. */
  onAnswer?: (text: string) => void;
  /** The whole screen: the page scrolls and zooms by itself. */
  fill?: boolean;
};

export function HtmlFrame({ frame, height, title, onAnswer, fill }: HtmlFrameProps) {
  const { colors, dark } = useTheme();
  const supported = usePart("meta")?.capabilities.includes("frames-v1");
  // (The package types its props as `WebViewProps & P` with P undefined by default, which is nothing: P is named here.)
  const web = useRef<WebView<object>>(null);
  const [page, setPage] = useState<Loaded | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState(() => clampHeight(height, 160));
  const touched = useRef(0);
  // The page's own code failed while it was starting (a page written on the computer can fail in a phone's browser engine).
  const [broken, setBroken] = useState(false);
  const name = title || "View from a bot";
  const theme = useMemo(() => ({ mode: dark ? ("dark" as const) : ("light" as const), colors: frameColors(colors) }), [colors, dark]);

  // The page, from the computer.
  useEffect(() => {
    if (!supported) return;
    let current = true;
    setPhase("loading");
    setBroken(false);
    setPage(null);
    pageOf(frame).then(
      (loaded) => current && setPage(loaded),
      (error: unknown) => {
        if (__DEV__) console.warn("A custom view's page could not be read: " + (error instanceof Error ? error.message : String(error)));
        if (current) setPhase("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [frame, attempt, supported]);

  // A page that never says it is ready didn't load.
  useEffect(() => {
    if (phase !== "loading" || !page) return;
    const timer = setTimeout(() => {
      if (__DEV__) console.warn("A custom view's page never said it was ready.");
      setPhase((now) => (now === "loading" ? "failed" : now));
    }, PATIENCE);
    return () => clearTimeout(timer);
  }, [phase, page]);

  // The document is built once for a page: a change of theme is told to the page, which stays as it is.
  const built = useRef<{ page: Loaded; fill: boolean; html: string } | null>(null);
  if (page && (built.current?.page !== page || built.current.fill !== !!fill)) built.current = { page, fill: !!fill, html: framePage(page.html, page.data, theme, { fill }) };
  useEffect(() => {
    if (phase === "ready") web.current?.injectJavaScript(frameScript({ type: "theme", ...theme }));
  }, [theme, phase]);

  if (supported === false)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }}>
        <AppWindow size={18} color={colors.muted} strokeWidth={2} />
        <T variant="footnote" color="muted" style={{ flex: 1 }}>
          Custom view. Update the app on your computer to see it here.
        </T>
      </View>
    );

  if (phase === "failed")
    return (
      <View style={[{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.sunken }, fill && { margin: space.xl }]} accessibilityRole="alert">
        <TriangleAlert size={18} color={colors.muted} strokeWidth={2} />
        <T variant="footnote" color="muted" style={{ flex: 1 }}>
          This view didn't load.
        </T>
        <Tap onPress={() => setAttempt((n) => n + 1)} accessibilityLabel="Try again" hitSlop={slopFor(30)} style={{ flexDirection: "row", alignItems: "center", gap: 5, minHeight: 30 }}>
          <RefreshCw size={14} color={colors.ink} strokeWidth={2.2} />
          <T variant="footnote" weight="600">
            Try again
          </T>
        </Tap>
      </View>
    );

  const reply = (id: number, work: Promise<unknown>) =>
    work.then(
      (value) => web.current?.injectJavaScript(frameScript({ type: "result", id, value: value ?? null })),
      (error: unknown) => web.current?.injectJavaScript(frameScript({ type: "result", id, error: error instanceof Error && error.message ? error.message : "That didn't work." })),
    );

  const onMessage = (event: WebViewMessageEvent) => {
    const message = readFrameMessage(event.nativeEvent.data);
    if (__DEV__ && !message) console.warn("A custom view said something the app doesn't read: " + String(event.nativeEvent.data).slice(0, 120));
    if (!message) return;
    if (message.type === "ready") {
      setPhase("ready");
      return;
    }
    if (message.type === "error") {
      setBroken(true);
      if (__DEV__) console.warn("A custom view's page failed: " + message.message);
      return;
    }
    if (message.type === "refused") {
      void reply(message.id, Promise.reject(new Error("That can't be done from a view.")));
      return;
    }
    if (message.type === "size") {
      if (!fill) setSize((now) => clampHeight(message.height, now));
      return;
    }
    // Only a view the person is working in may hand over text or ask to open a page.
    if (Date.now() - touched.current > TOUCH_WINDOW) {
      void reply(message.id, Promise.reject(new Error("Tap inside this view first.")));
      return;
    }
    if (message.type === "open") {
      void reply(message.id, askToOpen(frame, message.url));
      return;
    }
    // An answer becomes ordinary message text for the person to read and send: never a command.
    const text = message.text;
    if (/^\s*\//.test(text)) void reply(message.id, Promise.reject(new Error("An answer can't start with a slash command.")));
    else if (!pace.allow(frame)) void reply(message.id, Promise.reject(new Error("Wait a moment before sending another answer.")));
    else void reply(message.id, onAnswer ? Promise.resolve(onAnswer(text)) : answerInItsChat(frame, text));
  };

  const view = (
    <View
      // Full size: the app's own side margin, whatever padding the page gives itself.
      style={fill ? { flex: 1, paddingHorizontal: space.lg } : { height: size, borderRadius: radius.md, overflow: "hidden" }}
      // Seen before the web view takes the touch: this is how the app knows the person is working in the view.
      onTouchStart={() => {
        touched.current = Date.now();
      }}
      accessibilityLabel={name}
    >
      {built.current && (
        <WebView<object>
          key={frame + ":" + attempt}
          ref={web}
          source={{ html: built.current.html, baseUrl: "about:blank" }}
          // Every address "passes" the library's own list, so the decision below is the only one.
          // (An address that fails that list is handed to the phone's browser, which a view must never do.)
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={(request) => allowsLoad(request.url, request.isTopFrame !== false)}
          onOpenWindow={() => {}}
          // In every frame, not only the page's own: see FRAME_GUARD.
          injectedJavaScriptBeforeContentLoaded={FRAME_GUARD}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
          onMessage={onMessage}
          onError={(event) => {
            if (__DEV__) console.warn("A custom view's web view failed: " + event.nativeEvent.description);
            setPhase("failed");
          }}
          onHttpError={() => setPhase("failed")}
          onContentProcessDidTerminate={() => setAttempt((n) => n + 1)}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows={false}
          incognito
          cacheEnabled={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          domStorageEnabled={false}
          allowFileAccess={false}
          geolocationEnabled={false}
          allowsLinkPreview={false}
          allowsBackForwardNavigationGestures={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction
          dataDetectorTypes="none"
          scrollEnabled={!!fill}
          bounces={!!fill}
          showsVerticalScrollIndicator={!!fill}
          showsHorizontalScrollIndicator={!!fill}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          webviewDebuggingEnabled={__DEV__}
          style={{ flex: 1, backgroundColor: "transparent", opacity: phase === "ready" ? 1 : 0 }}
          containerStyle={{ backgroundColor: "transparent" }}
        />
      )}
      {phase === "loading" && (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.sunken }} accessibilityLabel={"Loading " + name}>
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
      {!fill && phase === "ready" && (
        <Tap
          onPress={() => router.push({ pathname: "/frame", params: { frame, title: title ?? "" } })}
          accessibilityLabel={"Open " + name + " full screen"}
          hitSlop={slopFor(28)}
          style={{ position: "absolute", top: 4, right: 4, width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, opacity: 0.9 }}
        >
          <Maximize2 size={14} color={colors.muted} strokeWidth={2.2} />
        </Tap>
      )}
    </View>
  );
  if (!broken) return view;
  return (
    <View style={fill ? { flex: 1 } : { gap: space.sm }}>
      {view}
      <View style={[{ flexDirection: "row", alignItems: "center", gap: 6 }, fill && { padding: space.lg }]}>
        <TriangleAlert size={13} color={colors.muted} strokeWidth={2.2} />
        <T variant="footnote" color="muted" style={{ flex: 1 }}>
          Part of this view didn't run on this phone.
        </T>
      </View>
    </View>
  );
}
