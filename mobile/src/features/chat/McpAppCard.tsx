// The view of an MCP App in a chat, with the desktop's words: a tool of an MCP server declared an
// interactive view, and the computer kept the view's page, the tool's input and its result
// ("mcp-apps-v1", the computer's desktop/mcp-apps.mjs). The page is drawn in a web view from a string
// (mcpApp.ts builds it, with the policy its server declared); every navigation is refused. Its calls go
// to the computer, which sends them only to the card's own server and checks the chat's access each
// time. A tool that may change something, and a link, ask the person first. Showing the card again
// never runs the tool again. Without the capability, with rich cards off, or when the view can't be
// shown, the card is its saved summary.
import { AppWindow, TriangleAlert } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { McpAppCard as Card, McpAppView, McpToolResult } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { allowsLoad, NESTED_FRAME_GUARD } from "@/ui/frame";
import { radius, space, T, useTheme } from "@/ui";
import { createMcpHost, deliver, MCP_APP_BRIDGE, mcpAppPage, VIEW_MIN } from "./mcpApp";

/** How long a view may take to say it is ready before the card shows the saved summary instead. */
const PATIENCE = 20_000;
const refused = (text: string): McpToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Asks the person; one question at a time. */
let asking = false;
function ask(title: string, message: string, yes: string): Promise<boolean> {
  if (asking) return Promise.resolve(false);
  asking = true;
  return new Promise((resolve) => {
    const done = (answer: boolean) => {
      asking = false;
      resolve(answer);
    };
    Alert.alert(title, message, [
      { text: "Don't allow", style: "cancel", onPress: () => done(false) },
      { text: yes, onPress: () => done(true) },
    ]);
  });
}

function Summary({ card, failed }: { card: Card; failed?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {failed ? <TriangleAlert size={14} color={colors.faint} strokeWidth={2.2} /> : <AppWindow size={14} color={colors.faint} strokeWidth={2.2} />}
      <T variant="footnote" color="muted" style={{ flexShrink: 1 }}>
        {(card.title || card.tool) + (card.summary ? ": " + card.summary : "")}
      </T>
    </View>
  );
}

export function McpAppCard({ chatId, card, rich }: { chatId: string; card: Card; rich: boolean }) {
  const { colors, dark } = useTheme();
  const supported = usePart("meta")?.capabilities.includes("mcp-apps-v1");
  const web = useRef<WebView<object>>(null);
  const [view, setView] = useState<McpAppView | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [height, setHeight] = useState(220);
  const theme = dark ? "dark" : "light";

  useEffect(() => {
    if (!supported || !rich) return;
    let live = true;
    api["mcpApps.view"](chatId, card.id, { html: true }).then(
      (found) => live && (found.html ? setView(found) : setPhase("failed")),
      () => live && setPhase("failed"),
    );
    return () => {
      live = false;
    };
  }, [chatId, card.id, supported, rich]);

  useEffect(() => {
    if (!view || phase !== "loading") return;
    const timer = setTimeout(() => setPhase((now) => (now === "loading" ? "failed" : now)), PATIENCE);
    return () => clearTimeout(timer);
  }, [view, phase]);

  // The host's side of the view, made once for the view it shows.
  const host = useMemo(() => {
    if (!view) return null;
    return createMcpHost(
      view,
      // The theme is set just below, before the view starts, and told to it as it changes.
      { theme: "light", platform: "mobile", displayMode: "inline", availableDisplayModes: ["inline"], deviceCapabilities: { touch: true, hover: false } },
      {
        callTool: async (name, args) => {
          const first = await api["mcpApps.callTool"](chatId, card.id, name, args);
          if ("result" in first) return first.result;
          const { title, server } = first.needsApproval;
          if (!(await ask("Allow " + server + "?", "Run “" + title + "” from this view.", "Allow"))) return refused("The person didn't allow this.");
          const again = await api["mcpApps.callTool"](chatId, card.id, name, args, { approved: true });
          return "result" in again ? again.result : refused("The person didn't allow this.");
        },
        readResource: (uri) => api["mcpApps.readResource"](chatId, card.id, uri),
        openLink: async (url) => {
          let host = "";
          try {
            const parsed = new URL(url);
            if (parsed.protocol === "https:" || parsed.protocol === "http:") host = parsed.host;
          } catch {
            // Not an address: refused below.
          }
          if (!host || !(await ask("Open " + host + "?", url.length > 200 ? url.slice(0, 200) + "…" : url, "Open"))) return false;
          await Linking.openURL(url).catch(() => showToast("Couldn't open that page.", "error"));
          return true;
        },
        size: setHeight,
        ready: () => setPhase("ready"),
      },
      (message) => web.current?.injectJavaScript(deliver(message)),
    );
  }, [view, chatId, card.id]);
  useEffect(() => host?.theme(theme), [host, theme]);
  useEffect(() => () => host?.teardown(), [host]);

  // The page is built once for a view: a change of theme is told to it, and it stays as it is.
  const page = useMemo(() => (view ? mcpAppPage(view, NESTED_FRAME_GUARD) : null), [view]);

  if (!rich || !supported || phase === "failed") return <Summary card={card} failed={phase === "failed"} />;
  const name = card.title || card.tool;
  return (
    <View style={{ backgroundColor: view?.prefersBorder === false ? "transparent" : colors.surface, borderRadius: radius.lg, borderWidth: view?.prefersBorder === false ? 0 : StyleSheet.hairlineWidth, borderColor: colors.line, padding: view?.prefersBorder === false ? 0 : space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <AppWindow size={14} color={colors.muted} strokeWidth={2.2} />
        <T variant="subhead" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
          {name}
        </T>
        <T variant="caption" color="faint" style={{ marginLeft: "auto" }}>
          {card.server}
        </T>
      </View>
      <View style={{ height: Math.max(VIEW_MIN, height), opacity: phase === "ready" ? 1 : 0, backgroundColor: phase === "ready" ? "transparent" : colors.sunken, borderRadius: radius.sm }}>
        {page && (
          <WebView<object>
            ref={web}
            accessibilityLabel={name + " from " + card.server}
            source={{ html: page, baseUrl: "about:blank" }}
            originWhitelist={["*"]}
            onShouldStartLoadWithRequest={(request) => allowsLoad(request.url, request.isTopFrame !== false)}
            injectedJavaScriptBeforeContentLoaded={MCP_APP_BRIDGE}
            onMessage={(event: WebViewMessageEvent) => void host?.receive(event.nativeEvent.data)}
            onError={() => setPhase("failed")}
            style={{ backgroundColor: "transparent" }}
            scrollEnabled={false}
            javaScriptEnabled
            javaScriptCanOpenWindowsAutomatically={false}
            setSupportMultipleWindows={false}
            incognito
            allowFileAccess={false}
            mediaPlaybackRequiresUserAction
          />
        )}
      </View>
    </View>
  );
}
