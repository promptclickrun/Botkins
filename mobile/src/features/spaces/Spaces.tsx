// All spaces: every space this person can open, with who can open each. Pinned first (they are the
// row on Home), then the others, and for an owner with Admin mode on what members made.
import { Lightbulb, LayoutGrid, type LucideIcon, Plus, Rss, Sun, Target } from "lucide-react-native";
import { Alert, View } from "react-native";
import type { SpaceSummary } from "@/link/types";
import { useCan } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Dot, EmptyState, Group, HoldMenu, IconButton, IconTile, Label, Loading, Page, space as gap, T, Tap, useTheme } from "@/ui";
import { openShare, openSpace, setPinned, useSpaces, useSpacesOn } from "./data";
import { rowLine, spaceSections, spaceTitle, withMove } from "./logic";

const ICONS: Record<NonNullable<SpaceSummary["builtin"]>, LucideIcon> = { today: Sun, feed: Rss, ideas: Lightbulb, goals: Target };

function newSpace() {
  Alert.prompt(
    "New space",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Create",
        onPress: (value?: string) => {
          const name = value?.trim().slice(0, 40);
          if (name) void attempt(api["spaces.create"]({ name })).then((id) => id && openSpace(id));
        },
      },
    ],
    "plain-text",
    "",
  );
}

function SpaceRow({ space, spaces }: { space: SpaceSummary; spaces: SpaceSummary[] }) {
  const { colors, control } = useTheme();
  const up = withMove(spaces, space.id, -1);
  const down = withMove(spaces, space.id, 1);
  const title = spaceTitle(space);
  const actions = [
    { name: "pin", label: space.pinned ? "Unpin" : "Pin" },
    ...(up ? [{ name: "up", label: "Move up" }] : []),
    ...(down ? [{ name: "down", label: "Move down" }] : []),
  ];
  const run = (name: string) => {
    if (name === "pin") setPinned(spaces, space.id, !space.pinned);
    else if (name === "up" && up) void attempt(api["link.spaces.arrange"](up));
    else if (name === "down" && down) void attempt(api["link.spaces.arrange"](down));
    else if (name === "share") openShare(space.id);
  };
  return (
    <HoldMenu
      title={title}
      actions={[
        { id: "pin", title: space.pinned ? "Unpin" : "Pin", image: space.pinned ? "pin.slash" : "pin" },
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
        <View style={{ minHeight: control.row + 8, paddingHorizontal: gap.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: gap.md }}>
          <IconTile icon={space.builtin ? ICONS[space.builtin] : LayoutGrid} color={colors.ink2} />
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <T variant="callout" weight="500" numberOfLines={1}>
              {title}
            </T>
            <T variant="footnote" color="muted" numberOfLines={1}>
              {rowLine(space)}
            </T>
          </View>
          {space.changed > 0 && <Dot size={8} />}
        </View>
      </Tap>
    </HoldMenu>
  );
}

export default function Spaces() {
  const on = useSpacesOn();
  const synced = useApp((state) => state.synced);
  const spaces = useSpaces();
  const canCreate = useCan("today", "create");
  const you = useApp((state) => state.parts.meta?.you);
  if (!on)
    return (
      <Page title="Spaces">
        <EmptyState title="Update the app on your computer" />
      </Page>
    );
  const sections = spaceSections(spaces, { owner: you?.kind !== "member", admin: you?.kind === "owner" && you.admin === true });
  return (
    <Page title="Spaces" actions={canCreate ? <IconButton icon={Plus} label="New space" variant="soft" size={44} onPress={newSpace} /> : undefined}>
      {!synced ? (
        <Loading />
      ) : !spaces.length ? (
        <EmptyState title="No spaces yet" action={canCreate ? "New space" : undefined} onAction={canCreate ? newSpace : undefined} />
      ) : (
        sections.map((section) => (
          <View key={section.title} style={{ gap: gap.xs }}>
            <Label>{section.title}</Label>
            <Group flat inset={gap.lg + 40 + gap.md}>
              {section.spaces.map((space) => (
                <SpaceRow key={space.id} space={space} spaces={spaces} />
              ))}
            </Group>
          </View>
        ))
      )}
    </Page>
  );
}
