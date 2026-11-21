// Share: who can open a space. It is the only way a space leaves "Only you". Four choices; picking
// members lists the people on this computer, each to edit or only to view; "Only you" takes it back.
// A link is asked about first, since anyone who has it sees everything on the space.
import { MenuView } from "@react-native-menu/menu";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { Bell, Check, ChevronDown, Link, RefreshCw } from "lucide-react-native";
import { Alert, View } from "react-native";
import { myself } from "@/features/chat/people";
import type { SpaceAccess, SpaceSummary } from "@/link/types";
import { useCan, useMember, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { EmptyState, Group, IconTile, Label, Row, Sheet, space as gap, T, Tap, useTheme } from "@/ui";
import { useSpace } from "./data";
import { linkNote, NOTIFY, pickRows, type ShareChoice, shareChoices, spaceTitle, withPick } from "./logic";

const CAN: { value: "edit" | "view"; label: string }[] = [
  { value: "edit", label: "Can edit" },
  { value: "view", label: "Can view" },
];

/** A round mark: filled when the choice is the one in force. */
function Mark({ on, check }: { on: boolean; check?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: on ? 0 : 1.5, borderColor: colors.lineStrong, backgroundColor: on ? colors.ink : "transparent", alignItems: "center", justifyContent: "center" }}>
      {on && (check ? <Check size={14} color={colors.canvas} strokeWidth={3} /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.canvas }} />)}
    </View>
  );
}

function choose(space: SpaceSummary, choice: ShareChoice) {
  if (choice.disabled || choice.access === space.access) return;
  const share = (access: SpaceAccess) => void attempt(api["link.spaces.share"](space.id, access === "members" ? { access, grants: (space.people ?? []).map((person) => ({ id: person.id, can: person.can })) } : { access }));
  if (choice.access !== "link") return share(choice.access);
  Alert.alert("Share by link?", "Anyone with the link can see everything on this space. They can't change it.", [
    { text: "Cancel", style: "cancel" },
    { text: "Share by link", onPress: () => share("link") },
  ]);
}

export default function ShareSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const space = useSpace(id);
  const team = usePart("team");
  const host = usePart("host");
  const member = useMember();
  const manage = useCan("today", "manage");
  const me = myself(usePart("meta"));
  const computer = useApp((state) => state.pairing?.name) ?? "this computer";
  if (!space || space.can !== "own")
    return (
      <Sheet title="Share">
        <EmptyState title={space ? "Only the person who made this space can share it." : "This space no longer exists."} />
      </Sheet>
    );
  const people = team?.people ?? [];
  const choices = shareChoices(space, { people, computer, linkSharing: team?.linkSharing === true, relay: host?.relay === true }, { member, manage });
  const rows = pickRows(people, space, me);
  const note = linkNote(space);
  const notify = NOTIFY.find((choice) => choice.value === space.notify) ?? NOTIFY[1]!;
  const copy = async () => {
    if (!space.link) return;
    await Clipboard.setStringAsync(space.link);
    showToast("Link copied", "success");
  };
  const newLink = () =>
    Alert.alert("Make a new link?", "The link you shared before stops working.", [
      { text: "Cancel", style: "cancel" },
      { text: "New link", onPress: () => void attempt(api["link.spaces.newLink"](space.id), "New link made") },
    ]);

  return (
    <Sheet title={"Share " + spaceTitle(space)} action="Done" onAction={() => router.back()}>
      <View>
        <Label>Who can open it</Label>
        <Group>
          {choices.map((choice) => (
            <Tap key={choice.access} onPress={() => choose(space, choice)} disabled={!!choice.disabled} feel="select" sink={1} hitSlop={0} accessibilityRole="radio" accessibilityState={{ selected: choice.access === space.access, disabled: !!choice.disabled }} accessibilityLabel={choice.title + ", " + (choice.disabled ?? choice.line)}>
              <View style={{ minHeight: 56, paddingHorizontal: gap.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: gap.md, opacity: choice.disabled ? 0.5 : 1 }}>
                <Mark on={choice.access === space.access} />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="callout" weight="500">
                    {choice.title}
                  </T>
                  <T variant="footnote" color="muted">
                    {choice.disabled ?? choice.line}
                  </T>
                </View>
              </View>
            </Tap>
          ))}
        </Group>
      </View>

      {space.access === "members" && (
        <View>
          <Label>Members</Label>
          <Group>
            {rows.length === 0 && <Row title="Nobody else is on this computer yet" disabled />}
            {rows.map((row) => (
              <View key={row.id} style={{ minHeight: 56, paddingLeft: gap.lg, paddingRight: gap.md, flexDirection: "row", alignItems: "center", gap: gap.md }}>
                <Tap
                  onPress={() => void attempt(api["link.spaces.share"](space.id, withPick(space, row.id, row.can ? null : "view")))}
                  feel="select"
                  sink={1}
                  hitSlop={0}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: !!row.can }}
                  accessibilityLabel={row.name}
                  style={{ flex: 1, minHeight: 56, flexDirection: "row", alignItems: "center", gap: gap.md }}
                >
                  <Mark on={!!row.can} check />
                  <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.sunken, alignItems: "center", justifyContent: "center" }}>
                    <T variant="caption" weight="700" color="ink2">
                      {row.initials}
                    </T>
                  </View>
                  <T variant="callout" weight="500" numberOfLines={1} style={{ flex: 1 }}>
                    {row.name}
                  </T>
                </Tap>
                {!!row.can && (
                  <MenuView actions={CAN.map((one) => ({ id: one.value, title: one.label, state: row.can === one.value ? ("on" as const) : ("off" as const) }))} onPressAction={({ nativeEvent }) => void attempt(api["link.spaces.share"](space.id, withPick(space, row.id, nativeEvent.event as "edit" | "view")))}>
                    <View accessible accessibilityRole="button" accessibilityLabel={row.name + ", " + (row.can === "edit" ? "Can edit" : "Can view")} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: gap.sm }}>
                      <T variant="subhead" color="muted">
                        {row.can === "edit" ? "Can edit" : "Can view"}
                      </T>
                      <ChevronDown size={14} color={colors.muted} strokeWidth={2.4} />
                    </View>
                  </MenuView>
                )}
              </View>
            ))}
          </Group>
        </View>
      )}

      {(space.access === "team" || space.access === "link") && (
        <Group>
          <MenuView actions={CAN.map((one) => ({ id: one.value, title: one.label, state: (space.teamCan ?? "view") === one.value ? ("on" as const) : ("off" as const) }))} onPressAction={({ nativeEvent }) => void attempt(api["link.spaces.share"](space.id, { access: space.access, teamCan: nativeEvent.event as "edit" | "view" }))}>
            <Row title="Members" value={space.teamCan === "edit" ? "Can edit" : "Can view"} trailing={<ChevronDown size={14} color={colors.muted} strokeWidth={2.4} />} />
          </MenuView>
        </Group>
      )}

      <Group>
        {space.access === "link" && !!space.link && <Row leading={<IconTile icon={Link} color={colors.ink2} />} title="Copy link" onPress={() => void copy()} />}
        {space.access === "link" && !!space.link && <Row leading={<IconTile icon={RefreshCw} color={colors.ink2} />} title="New link" onPress={newLink} />}
        {!!note && <Row leading={<IconTile icon={Link} color={colors.ink2} />} title={note} disabled />}
        <MenuView title="Notify me" actions={NOTIFY.map((choice) => ({ id: choice.value, title: choice.label, state: choice.value === space.notify ? ("on" as const) : ("off" as const) }))} onPressAction={({ nativeEvent }) => void attempt(api["link.spaces.notify"](space.id, nativeEvent.event as SpaceSummary["notify"]))}>
          <Row leading={<IconTile icon={Bell} color={colors.ink2} />} title="Notify me" value={notify.label} />
        </MenuView>
      </Group>
    </Sheet>
  );
}
