// All: the last tab, where every place in the app is a tile with one line of what is going on
// there. "On your bar" holds the tabs a person keeps between their bot and All; "More" the rest;
// "Hidden" what they put away. Hold a tile, then move, to put it in order, onto the bar or off it
// (TileGrid.tsx); a still hold opens its menu with the same choices, and VoiceOver has them as
// actions. The phone's own bar takes no drag, so "On your bar" is where the bar is arranged.
// The plain logic is places.ts and grid.ts.
import { type Href, router, useScrollToTop } from "expo-router";
import { Activity, BookOpen, Boxes, ChartColumn, Clock, FolderClosed, House, Layers, LibraryBig, ListChecks, type LucideIcon, MessagesSquare, Settings, Store, Wrench, Zap } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { changedSpaces, isChatsPageUnread } from "@/features/chat/unread";
import type { BoardScroll } from "@/features/home/BotBoard";
import { SettingsButton } from "@/features/home/Home";
import { useSpaces, useSpacesOn } from "@/features/spaces/data";
import { taskCounts } from "@/features/work/overview";
import { useBots, useCan, useChats, useMember, usePart, useRoutines } from "@/state/hooks";
import { setPrefs, usePrefs } from "@/state/prefs";
import { needsYou } from "@/state/sessionActivity";
import { useApp } from "@/state/store";
import { BAR_MAX } from "@/state/tabs";
import { BackdropLayer, Glass, HoldMenu, IconTile, Label, LinkBanner, radius, space, T, Tap, tint, useShape, useTheme } from "@/ui";
import { countIn, type GridItem, type GridMetrics, moved, stepped } from "./grid";
import { openPlace } from "./open";
import { allItems, type AllState, CAPS, isPin, type PlaceId, placeLines, type PlaceLine, placesFor, placeTitle, savedFrom, type Zone, ZONE_TITLES } from "./places";
import { TileGrid } from "./TileGrid";

const ICONS: Record<PlaceId, LucideIcon> = {
  home: House,
  chats: MessagesSquare,
  work: Zap,
  spaces: Layers,
  market: Store,
  projects: FolderClosed,
  tasks: ListChecks,
  routines: Clock,
  activity: Activity,
  models: Boxes,
  tools: Wrench,
  skills: BookOpen,
  wiki: LibraryBig,
  usage: ChartColumn,
  settings: Settings,
};

const METRICS: GridMetrics = { columns: 2, gap: space.md, tile: 108, head: 26, section: space.lg };

/** A tile's ground: glass over a backdrop, the surface color without one (as the Spaces tab's tiles). */
function Ground({ children }: { children: ReactNode }) {
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  // A set height, not `flex`: the menu's own view between the cell and the tile takes its size from what it holds.
  const frame = { height: METRICS.tile, borderRadius: radius.lg, padding: space.md + 2, overflow: "hidden" as const };
  if (hasBackdrop) return <Glass tintColor={tint(colors.surface, dark ? 0.3 : 0.42)} style={frame}>{children}</Glass>;
  return <View style={[frame, { backgroundColor: colors.surface }]}>{children}</View>;
}

/** What a tile's menu and VoiceOver offer: the same moves a drag makes. */
type Choice = "pin" | "unpin" | "earlier" | "later" | "hide" | "show";

function PlaceTile({ id, zone, line, choices, onChoice }: { id: PlaceId; zone: Zone; line: PlaceLine; choices: Choice[]; onChoice: (choice: Choice) => void }) {
  const title = placeTitle(id);
  const words: Record<Choice, { title: string; image: string }> = {
    pin: { title: "Pin to bar", image: "pin" },
    unpin: { title: "Take off bar", image: "pin.slash" },
    earlier: { title: "Move earlier", image: "arrow.up" },
    later: { title: "Move later", image: "arrow.down" },
    hide: { title: "Hide", image: "eye.slash" },
    show: { title: "Show", image: "eye" },
  };
  return (
    <HoldMenu title={title} actions={choices.map((choice) => ({ id: choice, ...words[choice] }))} onPressAction={({ nativeEvent }) => onChoice(nativeEvent.event as Choice)}>
      <Tap
        onPress={() => openPlace(id)}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityLabel={title + ", " + line.text + (zone === "bar" ? ", on your bar" : zone === "hidden" ? ", hidden" : "")}
        accessibilityHint="Hold, then move, to put it in order. Long press for more"
        accessibilityActions={choices.map((choice) => ({ name: choice, label: words[choice].title }))}
        onAccessibilityAction={(event) => onChoice(event.nativeEvent.actionName as Choice)}
      >
        <Ground>
          <View style={{ marginBottom: space.sm }}>
            <IconTile icon={ICONS[id]} />
          </View>
          <T variant="headline" numberOfLines={1}>
            {title}
          </T>
          <T variant="footnote" color={line.tone === "warning" ? "warning" : "muted"} numberOfLines={1}>
            {line.text}
          </T>
        </Ground>
      </Tap>
    </HoldMenu>
  );
}

/** The place a group with no tile keeps, to drop one into. */
function EmptyPlace({ zone }: { zone: Zone }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg }}>
      <T variant="subhead" color="muted" center>
        {zone === "bar" ? "Move a tile here to pin it" : zone === "hidden" ? "Move a tile here to hide it" : "Nothing here"}
      </T>
    </View>
  );
}

/**
 * Page's frame for a tab's root, with a scroll view the grid can scroll itself: a dragged tile near
 * the top or bottom edge scrolls the page (Page has no handle on its scroll view). Keep it like
 * Page's, and like Home's and the Spaces tab's own frames.
 */
function AllFrame({ children, scroll, scrollEnabled }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean }) {
  useScrollToTop(scroll.ref);
  const { colors } = useTheme();
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const hasBackdrop = backdrop !== "clean";
  const insets = useSafeAreaInsets();
  // Beside the side rail on iPhone Duo, and with no room for a tab bar that is in the rail.
  const shape = useShape();
  const { height } = useWindowDimensions();
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  const { edges, offset, max } = scroll;
  useEffect(() => {
    edges.value = { top: insets.top, bottom: height - shape.tabRoom - insets.bottom };
  }, [edges, insets.top, insets.bottom, height, shape.tabRoom]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.value = event.contentOffset.y;
    },
  });
  return (
    <View style={{ flex: 1, backgroundColor: hasBackdrop ? "transparent" : colors.canvas }}>
      {hasBackdrop && <BackdropLayer backdrop={backdrop} />}
      <Animated.ScrollView
        ref={scroll.ref}
        style={{ flex: 1, backgroundColor: "transparent" }}
        contentContainerStyle={{ paddingLeft: space.xl + shape.left, paddingRight: space.xl + shape.right, paddingTop: insets.top + space.md, paddingBottom: shape.tabRoom + insets.bottom + space.xxl, gap: space.xl }}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        scrollEnabled={scrollEnabled}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(event) => {
          view.value = event.nativeEvent.layout.height;
          max.value = Math.max(0, content.value - view.value);
        }}
        onContentSizeChange={(_, h) => {
          content.value = h;
          max.value = Math.max(0, content.value - view.value);
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.md, marginBottom: space.xs }}>
          <View style={{ flex: 1 }}>
            <T variant="display" accessibilityRole="header" numberOfLines={1}>
              All
            </T>
          </View>
          <View style={{ paddingBottom: 3 }}>
            <SettingsButton />
          </View>
        </View>
        <LinkBanner />
        {children}
      </Animated.ScrollView>
    </View>
  );
}

/** The numbers the tiles' lines are made of. Each is recounted only when its own list changes. */
function useLines() {
  const bots = useBots();
  const chats = useChats();
  const tasks = usePart("tasks");
  const requests = useApp((state) => state.parts.live?.requests.length ?? 0);
  const spaces = useSpaces();
  const projects = usePart("projects");
  const routines = useRoutines();
  const servers = usePart("mcp");
  const unread = useMemo(() => chats.filter(isChatsPageUnread).length, [chats]);
  const waiting = requests + useMemo(() => needsYou({ tasks }), [tasks]);
  const activeTasks = useMemo(() => taskCounts(tasks ?? []).active, [tasks]);
  return placeLines({
    bots: bots.filter((bot) => !bot.hidden).length,
    requests,
    unread,
    waiting,
    activeTasks,
    spaces: spaces.length,
    changedSpaces: changedSpaces(spaces).length,
    projects: projects?.length ?? 0,
    routines: routines.length,
    toolsOn: servers?.filter((server) => server.enabled).length ?? 0,
  });
}

export default function All() {
  const bar = usePrefs((prefs) => prefs.bar);
  const order = usePrefs((prefs) => prefs.allOrder);
  const hidden = usePrefs((prefs) => prefs.allHidden);
  const member = !!useMember();
  const spacesOn = useSpacesOn();
  const today = useCan("today", "view");
  const models = useCan("agents", "view");
  const tools = useCan("mcp", "view");
  const skills = useCan("skills", "read");
  const available = useMemo(() => placesFor({ member, spaces: spacesOn && today, today, models, tools, skills }), [member, spacesOn, today, models, tools, skills]);
  const lines = useLines();
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  // A page left in the middle of a drag must not keep its scrolling off.
  useEffect(() => () => setDragging(false), []);

  const state: AllState = { bar, order, hidden };
  const save = (next: GridItem[]) => {
    const saved = savedFrom(next, state, available);
    setPrefs(saved);
    // The phone's bar is built again when its tabs change (the `key` in the tabs' layout), and every
    // tab's screen with it. Whatever that does to the tab on show, the person stays on All.
    if (saved.bar.join() !== bar.join()) setTimeout(() => router.navigate("/all" as Href), 0);
  };
  // A menu choice is the same move a drag makes, on the list with every group in it.
  const choose = (id: PlaceId, choice: Choice) => {
    const items = allItems(state, available, true);
    const next =
      choice === "pin" ? moved(items, id, "bar", countIn(items, "bar"), CAPS)
      : choice === "unpin" || choice === "show" ? moved(items, id, "more", 0, CAPS)
      : choice === "hide" ? moved(items, id, "hidden", countIn(items, "hidden"), CAPS)
      : stepped(items, id, choice === "earlier" ? -1 : 1, CAPS);
    if (next) save(next);
  };
  const choicesFor = (id: PlaceId, zone: Zone, items: GridItem[]): Choice[] => [
    ...(zone === "bar" ? (["unpin"] as const) : zone === "more" && isPin(id) ? (["pin"] as const) : []),
    ...(stepped(items, id, -1) ? (["earlier"] as const) : []),
    ...(stepped(items, id, 1) ? (["later"] as const) : []),
    ...(zone === "hidden" ? (["show"] as const) : (["hide"] as const)),
  ];
  const shown = allItems(state, available, dragging);
  const onBar = countIn(shown, "bar");

  return (
    <AllFrame scroll={scroll} scrollEnabled={!dragging}>
      <TileGrid
        build={(lifted) => allItems(state, available, lifted)}
        metrics={METRICS}
        caps={CAPS}
        scroll={scroll}
        onDrop={save}
        onDragging={setDragging}
        renderHead={(zone) => <Label style={{ marginBottom: 0 }}>{zone === "bar" ? ZONE_TITLES.bar + " · " + onBar + " of " + BAR_MAX : ZONE_TITLES[zone as Zone]}</Label>}
        renderEmpty={(zone) => <EmptyPlace zone={zone as Zone} />}
        renderTile={(key, zone) => <PlaceTile id={key as PlaceId} zone={zone as Zone} line={lines[key as PlaceId]} choices={choicesFor(key as PlaceId, zone as Zone, shown)} onChoice={(choice) => choose(key as PlaceId, choice)} />}
      />
    </AllFrame>
  );
}
