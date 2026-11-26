// The Spaces tab: every space this person can open, as tiles two to a row, with who can open each.
// Those on Home first (the pinned ones), as larger tiles that say what their first panel says; then
// the others, and for an owner with Admin mode on what members made; last, the single panels pinned
// to Home. A hold on a space opens its menu: pin it to Home or take it off, move it up or down
// (VoiceOver has the same actions), and share it.
import { useScrollToTop } from "expo-router";
import { MailOpen, Plus } from "lucide-react-native";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { changedSpaces } from "@/features/chat/unread";
import type { BoardScroll } from "@/features/home/BotBoard";
import type { SpaceSummary } from "@/link/types";
import { useCan } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { type PanelPin, usePrefs } from "@/state/prefs";
import { panelHeadline } from "@/state/widgetData";
import { useApp } from "@/state/store";
import { BackdropLayer, Dot, EmptyState, Glass, HoldMenu, IconButton, IconTile, Label, LinkBanner, Loading, Page, radius, space as gap, T, Tap, type TextPromptOptions, tint, useShape, useTextPrompt, useTheme } from "@/ui";
import { markSpacesRead, openPanel, openShare, openSpace, setPanelPinned, setPinned, useArranging, useSpaceContent, useSpaces, useSpacesOn } from "./data";
import { spaceIcon } from "./icons";
import { panelPinsHere, rowLine, spaceSections, spaceTitle, withMove } from "./logic";

/** A tile's ground: glass over a backdrop, the surface color without one (as `Group` does). */
function Tile({ children, height, style }: { children: ReactNode; height: number; style?: object }) {
  const { colors, dark } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const frame = { minHeight: height, borderRadius: radius.lg, padding: gap.md + 2, overflow: "hidden" as const, ...style };
  if (hasBackdrop) return <Glass tintColor={tint(colors.surface, dark ? 0.3 : 0.42)} style={frame}>{children}</Glass>;
  return <View style={[frame, { backgroundColor: colors.surface }]}>{children}</View>;
}

/** What a pinned space's first panel says, for its tile: "Inbox · 4 need a reply". */
function FirstLine({ space }: { space: SpaceSummary }) {
  const { content } = useSpaceContent(space.id);
  const panel = content?.panels.find((one) => !one.hidden);
  const value = panel && panelHeadline(panel).value;
  if (!panel || !value) return null;
  return (
    <T variant="footnote" color="ink2" numberOfLines={2}>
      <T variant="footnote" weight="600" color="ink2">
        {panel.title}
      </T>
      {" · " + value}
    </T>
  );
}

function newSpace(ask: (options: TextPromptOptions) => void) {
  ask({
    title: "New space",
    confirm: "Create",
    onSubmit: (value) => void attempt(api["spaces.create"]({ name: value.slice(0, 40) })).then((id) => id && openSpace(id)),
  });
}

function SpaceTile({ space, spaces, big }: { space: SpaceSummary; spaces: SpaceSummary[]; /** On Home: taller, with what its first panel says. */ big?: boolean }) {
  const up = withMove(spaces, space.id, -1);
  const down = withMove(spaces, space.id, 1);
  const title = spaceTitle(space);
  const pinWord = space.pinned ? "Take off Home" : "Pin to Home";
  const actions = [
    ...(space.changed > 0 ? [{ name: "read", label: "Mark as read" }] : []),
    { name: "pin", label: pinWord },
    ...(up ? [{ name: "up", label: "Move up" }] : []),
    ...(down ? [{ name: "down", label: "Move down" }] : []),
  ];
  const run = (name: string) => {
    if (name === "read") void markSpacesRead([space.id]);
    else if (name === "pin") setPinned(spaces, space.id, !space.pinned);
    else if (name === "up" && up) void attempt(api["link.spaces.arrange"](up));
    else if (name === "down" && down) void attempt(api["link.spaces.arrange"](down));
    else if (name === "share") openShare(space.id);
  };
  return (
    <HoldMenu
      title={title}
      actions={[
        ...(space.changed > 0 ? [{ id: "read", title: "Mark as read", image: "envelope.open" }] : []),
        { id: "pin", title: pinWord, image: space.pinned ? "pin.slash" : "pin" },
        { id: "up", title: "Move up", image: "arrow.up", attributes: { disabled: !up } },
        { id: "down", title: "Move down", image: "arrow.down", attributes: { disabled: !down } },
        ...(space.can === "own" ? [{ id: "share", title: "Share", image: "square.and.arrow.up" }] : []),
      ]}
      onPressAction={({ nativeEvent }) => run(nativeEvent.event)}
    >
      <Tap
        onPress={() => openSpace(space.id)}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityLabel={title + ", " + rowLine(space) + (space.changed > 0 ? ", changed" : "")}
        accessibilityHint="Long press for more"
        accessibilityActions={actions}
        onAccessibilityAction={(event) => run(event.nativeEvent.actionName)}
      >
        <Tile height={big ? 168 : 112}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: gap.sm }}>
            <IconTile icon={spaceIcon(space)} />
            {space.changed > 0 && <Dot size={8} />}
          </View>
          <T variant={big ? "title3" : "headline"} numberOfLines={1}>
            {title}
          </T>
          <T variant="footnote" color="muted" numberOfLines={big ? 1 : 2}>
            {rowLine(space)}
          </T>
          {big && (
            <View style={{ flex: 1, justifyContent: "flex-end", paddingTop: gap.sm }}>
              <FirstLine space={space} />
            </View>
          )}
        </Tile>
      </Tap>
    </HoldMenu>
  );
}


/**
 * Page's frame for a tab's root, with a scroll view the list can scroll itself: a dragged space
 * near the top or bottom edge scrolls the page (Page has no handle on its scroll view). Keep it
 * like Page's, and like Home's own frame.
 */
function SpacesFrame({ children, scroll, scrollEnabled, actions }: { children: ReactNode; scroll: BoardScroll; scrollEnabled: boolean; actions?: ReactNode }) {
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
        contentContainerStyle={{ paddingLeft: gap.xl + shape.left, paddingRight: gap.xl + shape.right, paddingTop: insets.top + gap.md, paddingBottom: shape.tabRoom + insets.bottom + gap.xxl, gap: gap.xl }}
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
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: gap.md, marginBottom: gap.xs }}>
          <View style={{ flex: 1 }}>
            <T variant="display" accessibilityRole="header" numberOfLines={2}>
              Spaces
            </T>
          </View>
          {!!actions && <View style={{ flexDirection: "row", alignItems: "center", gap: gap.sm, paddingBottom: 3 }}>{actions}</View>}
        </View>
        <LinkBanner />
        {children}
      </Animated.ScrollView>
    </View>
  );
}

/** One panel pinned to Home, as a small tile: its title and space, and what it says. A tap opens it; a hold takes it off Home. */
function PinnedPanelTile({ pin, space }: { pin: PanelPin; space: SpaceSummary }) {
  const { content } = useSpaceContent(pin.spaceId);
  const panel = content?.panels.find((one) => one.id === pin.panelId);
  if (!panel) return null;
  const line = ["Panel in " + spaceTitle(space), panelHeadline(panel).value].filter(Boolean).join(" · ");
  const unpin = () => setPanelPinned(pin, false);
  return (
    <HoldMenu title={panel.title} actions={[{ id: "unpin", title: "Take off Home", image: "pin.slash" }]} onPressAction={unpin}>
      <Tap
        onPress={() => openPanel(pin.spaceId, pin.panelId)}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityLabel={panel.title + ", " + line}
        accessibilityHint="Long press for more"
        accessibilityActions={[{ name: "unpin", label: "Take off Home" }]}
        onAccessibilityAction={unpin}
      >
        <Tile height={64} style={{ justifyContent: "center", paddingVertical: gap.sm }}>
          <T variant="caption" color="muted" weight="400" numberOfLines={1}>
            {panel.title + " · " + spaceTitle(space)}
          </T>
          <T variant="headline" numberOfLines={1}>
            {panelHeadline(panel).value ?? "Open"}
          </T>
        </Tile>
      </Tap>
    </HoldMenu>
  );
}

/** The panels pinned to Home, under the spaces. */
function PinnedPanels({ spaces }: { spaces: SpaceSummary[] }) {
  const saved = usePrefs((prefs) => prefs.homePanels);
  const pins = useMemo(() => panelPinsHere(saved, spaces), [saved, spaces]);
  if (!pins.length) return null;
  return (
    <View>
      <Label>Panels on Home</Label>
      <TwoUp>
        {pins.map((pin) => {
          const space = spaces.find((one) => one.id === pin.spaceId);
          return space ? <PinnedPanelTile key={pin.spaceId + ":" + pin.panelId} pin={pin} space={space} /> : null;
        })}
      </TwoUp>
    </View>
  );
}

/** Children two to a row, each half the width less the gap; a last one alone keeps a half. */
function TwoUp({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: gap.md }}>{children}</View>;
}
const HALF = { width: "48.2%" } as const;

const SECTION_TITLES = { Pinned: "On Home", More: "More", "From members": "From members" } as const;

/** Every space, in its section, as tiles. A move from a tile's menu is shown at once; the computer's own order follows. */
function SpaceGrid({ spaces, onNew }: { spaces: SpaceSummary[]; onNew?: () => void }) {
  const { colors } = useTheme();
  const you = useApp((state) => state.parts.meta?.you);
  const viewer = { owner: you?.kind !== "member", admin: you?.kind === "owner" && you.admin === true };
  const shown = useArranging(spaces).shown;
  const sections = spaceSections(shown, viewer);
  return (
    <View style={{ gap: gap.xl }}>
      {sections.map((section) => (
        <View key={section.title}>
          <Label>{SECTION_TITLES[section.title]}</Label>
          <TwoUp>
            {section.spaces.map((space) => (
              <View key={space.id} style={HALF}>
                <SpaceTile space={space} spaces={shown} big={section.title === "Pinned"} />
              </View>
            ))}
            {section.title === "More" && onNew && (
              <Tap onPress={onNew} feel="select" accessibilityLabel="New space" style={{ width: "100%", height: 52, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.lineStrong, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: gap.sm }}>
                <Plus size={18} color={colors.ink2} strokeWidth={2.2} />
                <T variant="subhead" weight="600" color="ink2">
                  New space
                </T>
              </Tap>
            )}
          </TwoUp>
        </View>
      ))}
    </View>
  );
}

export default function Spaces() {
  const on = useSpacesOn();
  const synced = useApp((state) => state.synced);
  const spaces = useSpaces();
  const canCreate = useCan("today", "create");
  const prompt = useTextPrompt();
  const scroll: BoardScroll = { ref: useAnimatedRef<Animated.ScrollView>(), offset: useSharedValue(0), max: useSharedValue(0), edges: useSharedValue({ top: 0, bottom: 0 }) };
  const [dragging, setDragging] = useState(false);
  // A page left in the middle of a drag must not keep its scrolling off.
  useEffect(() => () => setDragging(false), []);
  if (!on)
    return (
      <Page tab title="Spaces">
        <EmptyState title="Update the app on your computer" />
      </Page>
    );
  const ask = () => newSpace(prompt.ask);
  const unreadSpaces = changedSpaces(spaces);
  const headerActions = (unreadSpaces.length > 0 || canCreate) ? (
    <>
      {unreadSpaces.length > 0 && (
        <IconButton
          icon={MailOpen}
          label="Mark all as read"
          variant="soft"
          size={44}
          onPress={() => void markSpacesRead(unreadSpaces.map((space) => space.id))}
        />
      )}
      {canCreate && <IconButton icon={Plus} label="New space" variant="accent" size={44} onPress={ask} />}
    </>
  ) : undefined;
  return (
    <SpacesFrame scroll={scroll} scrollEnabled={!dragging} actions={headerActions}>
      {prompt.node}
      {!synced ? <Loading /> : !spaces.length ? <EmptyState title="No spaces yet" action={canCreate ? "New space" : undefined} onAction={canCreate ? ask : undefined} /> : <SpaceGrid spaces={spaces} onNew={canCreate ? ask : undefined} />}
      {synced && <PinnedPanels spaces={spaces} />}
    </SpacesFrame>
  );
}
