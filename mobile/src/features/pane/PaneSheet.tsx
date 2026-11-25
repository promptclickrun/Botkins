// The side pane a bot opened beside a chat, as a sheet over the chat: one tab for each panel. A
// panel is a custom view, a table, a website or the computer's screen ("side-pane-v1"; the
// contract is the desktop app's docs/SIDE_PANE.md).
import { pullRequestUrl } from "../../../link-host/pr-url.mjs";
import { PullRequestSheet } from "./PullRequestSheet";
import { MenuView } from "@react-native-menu/menu";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Ellipsis, Globe } from "lucide-react-native";
import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import type { PanePanel } from "@/link/types";
import { useBots, usePart, useWatchedChat } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Blocks, Button, Chip, Dot, EmptyState, HtmlFrame, Sheet, space, T, useTheme } from "@/ui";
import { handToChat } from "./inbox";
import { paneFront, paneUrl } from "./pane";
import { PaneScreen } from "./PaneScreen";
import { paneClosed, paneOpened } from "./usePane";

function Body({ panel, chatId }: { panel: PanePanel; chatId: string }) {
  const { colors } = useTheme();
  if (panel.kind === "rich_ui" && panel.frame)
    return (
      <HtmlFrame
        frame={panel.frame}
        height={480}
        title={panel.title}
        fill
        // The text goes to this chat's message box, for the person to read and send.
        onAnswer={(text) => {
          handToChat(chatId, text);
          router.back();
        }}
      />
    );
  if (panel.kind === "table" && panel.columns?.length)
    return (
      <ScrollView contentContainerStyle={{ padding: space.lg }}>
        <Blocks blocks={[{ type: "table", columns: panel.columns, rows: panel.rows ?? [] }]} />
      </ScrollView>
    );
  if (panel.kind === "web") {
    const url = paneUrl(panel.url);
    if (!url) return <EmptyState icon={Globe} title="This address can't be opened" />;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Shown as it came.
    }
    return (
      <View style={{ padding: space.xl, gap: space.lg, alignItems: "center" }}>
        <Globe size={28} color={colors.muted} strokeWidth={2} />
        <T variant="callout" center selectable numberOfLines={3}>
          {host}
        </T>
        <Button title="Open" onPress={() => void WebBrowser.openBrowserAsync(url).catch(() => {})} />
      </View>
    );
  }
  if (panel.kind === "screen") return <PaneScreen />;
  return <EmptyState title="Nothing to show" />;
}

export default function PaneSheet() {
  const { pull } = useLocalSearchParams<{ pull?: string }>();
  const meta = usePart("meta");
  const target = pullRequestUrl(pull);
  if (target && meta?.capabilities.includes("pr-panel-v1") && meta.you?.kind !== "member")
    return <PullRequestSheet key={target.url} url={target.url} />;
  return <BotPaneSheet />;
}

function BotPaneSheet() {
  const { chatId, panel: wanted } = useLocalSearchParams<{ chatId: string; panel?: string }>();
  const { colors } = useTheme();
  const pane = useWatchedChat(chatId)?.pane;
  const bots = useBots();
  const panels = pane?.panels ?? [];
  const panel = panels.find((item) => item.id === wanted) ?? paneFront(pane);

  useEffect(() => {
    paneOpened(chatId);
    // Closed by the person: for the rest of the running turn no bot opens it again. (Closed
    // because a bot asked: nothing to tell.)
    return () => {
      if (!paneClosed()) void api.sidePane(chatId, "closed").catch(() => {});
    };
  }, [chatId]);

  // The tab on screen is the one in front, for every screen that shows this chat.
  const id = panel?.id;
  const front = pane?.active;
  useEffect(() => {
    if (id && id !== front) void api.sidePane(chatId, "select", id).catch(() => {});
  }, [chatId, id, front]);

  if (!panel)
    return (
      <Sheet title="Side pane">
        <EmptyState title="Nothing here now" />
      </Sheet>
    );
  const bot = bots.find((item) => item.id === panel.botId);
  return (
    <Sheet title={panel.title || "Side pane"} scroll={false} contentStyle={{ paddingHorizontal: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: space.sm, alignItems: "center" }}>
          {panels.map((item) => (
            <Chip key={item.id} label={item.title || "Untitled"} selected={item.id === panel.id} leading={item.unseen && item.id !== panel.id ? <Dot /> : undefined} onPress={() => router.setParams({ panel: item.id })} />
          ))}
        </ScrollView>
        <MenuView
          actions={[
            { id: panel.pinned ? "unpin" : "pin", title: panel.pinned ? "Unpin" : "Pin", image: panel.pinned ? "pin.slash" : "pin" },
            { id: "remove", title: "Remove", image: "trash", attributes: { destructive: true } },
          ]}
          onPressAction={({ nativeEvent }) => {
            const action = nativeEvent.event as "pin" | "unpin" | "remove";
            void attempt(api.sidePane(chatId, action, panel.id));
            if (action === "remove" && panels.length === 1) router.back();
          }}
        >
          <View accessible accessibilityRole="button" accessibilityLabel={"More for " + (panel.title || "this panel")} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Ellipsis size={20} color={colors.ink2} strokeWidth={2.2} />
          </View>
        </MenuView>
      </View>
      {!!bot && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          {"From " + bot.name}
        </T>
      )}
      <View style={{ flex: 1 }}>
        <Body key={panel.kind === "screen" ? panel.id : panel.id + ":" + panel.updatedAt} panel={panel} chatId={chatId} />
      </View>
    </Sheet>
  );
}
