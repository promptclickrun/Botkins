// A space: its name, who can open it, its panels and cards. The bar pins it, shares it (its maker
// only) and has its menu; the glass bar at the foot asks a bot about the whole page, and the plus
// adds a panel.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router, Stack, useLocalSearchParams } from "expo-router";
import { Ellipsis, Pin, PinOff, Plus, Share } from "lucide-react-native";
import { useEffect } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SpaceSummary } from "@/link/types";
import { useBots, useCan, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { BotAvatar, EmptyState, Glass, IconButton, Loading, Page, space as gap, T, Tap, useOnShow, useTheme } from "@/ui";
import { lookingAt, openNewPanel, openShare, setPinned, useSpaces, useSpacesOn } from "./data";
import { holds, NOTIFY, spaceTitle, whoCanOpen } from "./logic";
import { SpaceView } from "./SpaceView";

const openAsk = (spaceId: string) => router.push(("/space/ask?spaceId=" + encodeURIComponent(spaceId)) as unknown as Href);

function rename(space: SpaceSummary) {
  Alert.prompt(
    "Rename space",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Rename",
        onPress: (value?: string) => {
          const name = value?.trim().slice(0, 40);
          if (name && name !== space.name) void attempt(api["spaces.rename"](space.id, name));
        },
      },
    ],
    "plain-text",
    space.name,
  );
}

function remove(space: SpaceSummary) {
  Alert.alert("Delete " + space.name + " and its " + holds(space) + "?", undefined, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: () =>
        void attempt(api["spaces.remove"](space.id).then(() => true)).then((done) => {
          if (done && router.canGoBack()) router.back();
        }),
    },
  ]);
}

/** Pin, Share and the menu, for the bar. Also used over a space shown from the list. */
function BarButtons({ space, spaces }: { space: SpaceSummary; spaces: SpaceSummary[] }) {
  const { colors } = useTheme();
  const canCreate = useCan("today", "create");
  const own = space.can === "own";
  const mayAdd = canCreate && (own || space.can === "edit");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: gap.xs }}>
      <IconButton icon={space.pinned ? PinOff : Pin} label={space.pinned ? "Unpin" : "Pin"} onPress={() => setPinned(spaces, space.id, !space.pinned)} />
      {own && <IconButton icon={Share} label="Share" onPress={() => openShare(space.id)} />}
      <MenuView
        title={spaceTitle(space)}
        actions={[
          ...(mayAdd ? [{ id: "panel", title: "New panel…", image: "plus.rectangle" }] : []),
          { id: "notify", title: "Notify me", image: "bell", subactions: NOTIFY.map((choice) => ({ id: "notify:" + choice.value, title: choice.label, state: space.notify === choice.value ? ("on" as const) : ("off" as const) })) },
          ...(own ? [{ id: "rename", title: "Rename", image: "pencil", attributes: { disabled: !!space.builtin } }] : []),
          ...(own && !space.builtin ? [{ id: "delete", title: "Delete space", image: "trash", attributes: { destructive: true } }] : []),
        ]}
        onPressAction={({ nativeEvent }) => {
          const action = nativeEvent.event;
          if (action === "panel") openNewPanel(space.id);
          else if (action === "rename") rename(space);
          else if (action === "delete") remove(space);
          else if (action.startsWith("notify:")) void attempt(api["link.spaces.notify"](space.id, action.slice(7) as SpaceSummary["notify"]));
        }}
      >
        <View accessible accessibilityRole="button" accessibilityLabel={"Options for " + spaceTitle(space)} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Ellipsis size={20} color={colors.ink} strokeWidth={2.2} />
        </View>
      </MenuView>
    </View>
  );
}

/** The glass bar at the foot: ask a bot about this space, and add a panel. */
function AskBar({ space }: { space: SpaceSummary }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const bots = useBots();
  const canChat = useCan("agents", "chat");
  const canCreate = useCan("today", "create");
  const mayAdd = canCreate && (space.can === "own" || space.can === "edit");
  if (!canChat && !mayAdd) return null;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: gap.lg, right: gap.lg, bottom: insets.bottom + gap.sm, flexDirection: "row", alignItems: "center", gap: gap.sm }}>
      {canChat && (
        <Tap onPress={() => openAsk(space.id)} feel="select" sink={0.99} accessibilityLabel="Ask about this space" style={{ flex: 1 }}>
          <Glass interactive style={{ height: 50, borderRadius: 25, flexDirection: "row", alignItems: "center", gap: gap.sm, paddingHorizontal: gap.md, overflow: "hidden" }}>
            <BotAvatar bot={bots[0]} size={28} badge={false} />
            <T variant="callout" color="muted" numberOfLines={1} style={{ flex: 1 }}>
              Ask about this space
            </T>
          </Glass>
        </Tap>
      )}
      {!canChat && <View style={{ flex: 1 }} />}
      {mayAdd && <IconButton icon={Plus} label="Add panel" variant="accent" size={50} onPress={() => openNewPanel(space.id)} />}
    </View>
  );
}

export default function SpacePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const on = useSpacesOn();
  const synced = useApp((state) => state.synced);
  const spaces = useSpaces();
  const space = spaces.find((one) => one.id === id);
  const projects = usePart("projects");
  const shown = useOnShow();
  // The computer is told who is looking, so others see it and no alert is sent about what is on screen.
  // It forgets after a while, so the page says it again.
  useEffect(() => {
    if (!on || !space?.id || !shown) return;
    lookingAt(space.id);
    const again = setInterval(() => lookingAt(space.id), 60_000);
    return () => {
      clearInterval(again);
      lookingAt(null);
    };
  }, [on, space?.id, shown]);

  if (!on)
    return (
      <Page title="Spaces">
        <EmptyState title="Update the app on your computer" />
      </Page>
    );
  if (!space) return <Page title="Space">{synced ? <EmptyState title="This space no longer exists." /> : <Loading />}</Page>;
  const project = space.projectId ? projects?.find((one) => one.id === space.projectId)?.name : undefined;
  return (
    <View style={{ flex: 1 }}>
      <Page title={spaceTitle(space)} caption={[whoCanOpen(space), project].filter(Boolean).join(" · ")} contentStyle={{ paddingBottom: 120 }}>
        <Stack.Screen options={{ headerRight: () => <BarButtons space={space} spaces={spaces} /> }} />
        <SpaceView space={space} visit />
      </Page>
      <AskBar space={space} />
    </View>
  );
}
