// A panel, opened: its app gets the whole width and works by touch. The bar has the panel's menu;
// below it sit the notes people wrote, and the field that asks its bot to change it.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { Ellipsis, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { myself } from "@/features/chat/people";
import { cronLabel } from "@/features/work/cron";
import type { PanelView, SpaceSummary } from "@/link/types";
import { useBots, useCan, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago, upcoming } from "@/state/time";
import { Blocks, BotAvatar, Button, EmptyState, Field, Glass, Group, IconButton, Label, Loading, Page, space as gap, T, Tap, useTheme } from "@/ui";
import { panelState, useSpace, useSpaceContent } from "./data";
import { lastLine } from "./logic";

const SIZES: { value: PanelView["size"]; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "wide", label: "Wide" },
  { value: "tall", label: "Tall" },
];

/** The panel's menu: refresh, size, order, hide, its chat, remove. What a person may do follows their role and what they may do in the space. */
function PanelMenu({ panel, space, first, last }: { panel: PanelView; space: SpaceSummary; first: boolean; last: boolean }) {
  const { colors } = useTheme();
  const canUse = useCan("today", "use");
  const canManage = useCan("today", "manage");
  const canDelete = useCan("today", "delete");
  const acts = space.can === "own" || space.can === "edit";
  const off = (disabled: boolean) => (disabled ? { attributes: { disabled: true } } : {});
  const actions = [
    ...(canUse && acts ? [{ id: "refresh", title: "Refresh", image: "arrow.clockwise" }] : []),
    ...(canManage && acts
      ? [
          { id: "size", title: "Panel size", subtitle: SIZES.find((size) => size.value === panel.size)?.label, image: "rectangle.expand.vertical", subactions: SIZES.map((size) => ({ id: "size:" + size.value, title: size.label, state: panel.size === size.value ? ("on" as const) : ("off" as const) })) },
          { id: "earlier", title: "Earlier", image: "arrow.up", ...off(first) },
          { id: "later", title: "Later", image: "arrow.down", ...off(last) },
          { id: "hide", title: panel.hidden ? "Show" : "Hide", image: panel.hidden ? "eye" : "eye.slash" },
        ]
      : []),
    ...(panel.chatId ? [{ id: "chat", title: "Open original chat", image: "bubble.left" }] : []),
    ...(panel.refreshChatId ? [{ id: "history", title: "Open refresh history", image: "clock.arrow.circlepath" }] : []),
    ...(canDelete && acts ? [{ id: "delete", title: "Remove panel", image: "trash", attributes: { destructive: true } }] : []),
  ];
  if (!actions.length) return null;
  const remove = () =>
    Alert.alert("Remove " + panel.title + "?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove panel", style: "destructive", onPress: () => void attempt(api.changePanel(panel.id, "delete").then(() => true), "Panel removed").then((done) => done && router.canGoBack() && router.back()) },
    ]);
  return (
    <MenuView
      title={panel.title}
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "refresh") void attempt(api.refreshPanel(panel.id), "Refreshing");
        else if (action.startsWith("size:")) void attempt(api.changePanel(panel.id, action.slice(5) as PanelView["size"]));
        else if (action === "earlier" || action === "later") void attempt(api.changePanel(panel.id, action));
        else if (action === "hide") void attempt(api.changePanel(panel.id, panel.hidden ? "show" : "hide"), panel.hidden ? "Shown" : "Hidden");
        else if (action === "chat" && panel.chatId) router.push({ pathname: "/chat/[id]", params: { id: panel.chatId } });
        else if (action === "history" && panel.refreshChatId) router.push({ pathname: "/chat/[id]", params: { id: panel.refreshChatId } });
        else if (action === "delete") remove();
      }}
    >
      <View accessible accessibilityRole="button" accessibilityLabel={"Options for " + panel.title} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Ellipsis size={20} color={colors.ink} strokeWidth={2.2} />
      </View>
    </MenuView>
  );
}

/** Short notes people wrote on the panel, and a field to write one. A person removes their own; the maker and the owner remove any. */
function Notes({ panel, space, me }: { panel: PanelView; space: SpaceSummary; me: string }) {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const acts = space.can === "own" || space.can === "edit";
  const notes = panel.notes ?? [];
  if (!acts && !notes.length) return null;
  const add = async () => {
    const note = text.trim();
    if (!note || saving) return;
    setSaving(true);
    const done = await attempt(api["spaces.note"](panel.id, note));
    setSaving(false);
    if (done) setText("");
  };
  return (
    <View>
      <Label>Notes</Label>
      {notes.length > 0 && (
        <Group>
          {notes.map((note) => (
            <View key={note.id} style={{ paddingHorizontal: gap.lg, paddingVertical: gap.md, flexDirection: "row", alignItems: "flex-start", gap: gap.md }}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant="footnote" color="muted">
                  {note.name + " · " + ago(note.at)}
                </T>
                <T variant="callout">{note.text}</T>
              </View>
              {(note.by === me || space.can === "own") && <IconButton icon={Trash2} label={"Remove note by " + note.name} color={colors.muted} onPress={() => void attempt(api["spaces.removeNote"](panel.id, note.id))} />}
            </View>
          ))}
        </Group>
      )}
      {acts && (
        <View style={{ gap: gap.sm, marginTop: notes.length ? gap.md : 0 }}>
          <Field placeholder="Write a note" value={text} onChangeText={setText} area maxLength={2000} />
          {!!text.trim() && <Button title="Add note" variant="secondary" size="sm" onPress={() => void add()} loading={saving} style={{ alignSelf: "flex-start" }} />}
        </View>
      )}
    </View>
  );
}

export default function PanelPage() {
  const { spaceId, id } = useLocalSearchParams<{ spaceId: string; id: string }>();
  const insets = useSafeAreaInsets();
  const space = useSpace(spaceId);
  const { content, loading } = useSpaceContent(spaceId);
  const bots = useBots();
  const canChat = useCan("agents", "chat");
  const canUse = useCan("today", "use");
  const me = myself(usePart("meta"));
  const panels = content?.panels ?? [];
  const panel = panels.find((one) => one.id === id);
  if (!space || !panel) return <Page title="Panel">{loading && space ? <Loading /> : <EmptyState title="This panel no longer exists." />}</Page>;
  const bot = bots.find((one) => one.id === panel.botId);
  const index = panels.indexOf(panel);
  const routine = panel.routine;
  const caption = [bot?.name, "Updated " + ago(panel.updatedAt), routine ? (routine.enabled && routine.nextAt ? "Next " + upcoming(routine.nextAt) : "Routine paused") : undefined].filter(Boolean).join(" · ");
  const last = lastLine(panel.last, ago);
  const mayAsk = canChat && (space.can === "own" || space.can === "edit");
  return (
    <View style={{ flex: 1 }}>
      <Page contentStyle={{ paddingBottom: 120 }} keyboard>
        <Stack.Screen options={{ headerRight: () => <PanelMenu panel={panel} space={space} first={index === 0} last={index === panels.length - 1} /> }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: gap.md }}>
          <BotAvatar bot={bot} size={40} badge={false} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="title2" numberOfLines={3} accessibilityRole="header">
              {panel.title}
            </T>
            <T variant="footnote" color="muted" numberOfLines={2}>
              {caption}
            </T>
          </View>
        </View>
        <Blocks blocks={panel.blocks} title={panel.title} state={panel.blocks.some((block) => block.type === "html") ? panelState(panel, space, canUse) : undefined} />
        {!!last && (
          <T variant="footnote" color="faint">
            {last}
          </T>
        )}
        {!!routine && (
          <T variant="footnote" color="muted">
            {"Refreshes " + cronLabel(routine.cron).toLowerCase() + " · " + routine.timezone}
          </T>
        )}
        <Notes panel={panel} space={space} me={me} />
      </Page>
      {mayAsk && (
        <View pointerEvents="box-none" style={{ position: "absolute", left: gap.lg, right: gap.lg, bottom: insets.bottom + gap.sm }}>
          <Tap onPress={() => router.push(("/space/ask?spaceId=" + encodeURIComponent(space.id) + "&panelId=" + encodeURIComponent(panel.id)) as unknown as Href)} feel="select" sink={0.99} accessibilityLabel={"Ask " + (bot?.name ?? "the bot") + " to change it"}>
            <Glass interactive style={{ height: 50, borderRadius: 25, flexDirection: "row", alignItems: "center", gap: gap.sm, paddingHorizontal: gap.md, overflow: "hidden" }}>
              <BotAvatar bot={bot} size={28} badge={false} />
              <T variant="callout" color="muted" numberOfLines={1} style={{ flex: 1 }}>
                {"Ask " + (bot?.name ?? "the bot") + " to change it"}
              </T>
            </Glass>
          </Tap>
        </View>
      )}
    </View>
  );
}
