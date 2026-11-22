import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Copy, Eye, Link, Pencil, Plus, Share2, Trash2, UserMinus, UserPlus, Users } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Share, View } from "react-native";
import type { Group as TeamGroup, Invite, JoinRequest, Member, Role } from "@/link/types";
import { formatCode } from "@/link/pairing";
import { useOnline, usePart, useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ago } from "@/state/time";
import { Badge, Button, Dot, EmptyState, Group, haptic, HoldMenu, IconButton, IconTile, Label, Loading, Page, QrCode, Row, Segmented, space, T, useTextPrompt, useTheme } from "@/ui";
import { memberActions, memberChoice } from "./memberMenu";

/** The computer takes a member's name up to this long. */
const MEMBER_NAME_MAX = 60;

function pickGroup(groups: TeamGroup[], title: string, current: string, done: (id: string) => void) {
  Alert.alert(title, undefined, [
    ...groups.map((group) => ({ text: (group.id === current ? "✓ " : "") + group.name, onPress: () => done(group.id) })),
    { text: "Cancel", style: "cancel" },
  ]);
}

function roleName(roles: Role[], id: string) {
  return roles.find((role) => role.id === id)?.name ?? "Role";
}

export default function Team() {
  const part = usePart("team");
  const team = part && "roles" in part ? part : undefined;
  const you = usePart("meta")?.you;
  const online = useOnline();
  const spacesOn = useCapability("spaces-v1");
  const { colors } = useTheme();
  if (part && !team) return <Page title="Team"><EmptyState title="Only the owner can manage the team" /></Page>;
  if (!team) return <Page title="Team"><Loading label="Loading team" /></Page>;
  // Told by a computer that has Admin mode; an older one says nothing, and shows everything as before.
  const admin = you?.kind === "owner" ? you.admin : undefined;

  const rename = () =>
    Alert.prompt(
      "Rename team",
      undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save", onPress: (value?: string) => value?.trim() && void attempt(api["link.team.rename"](value.trim()), "Team renamed") },
      ],
      "plain-text",
      team.name,
    );

  return (
    <Page title="Team">
      <Group>
        <Row leading={<IconTile icon={Users} />} title={team.name} subtitle="Team name" trailing={<Pencil size={17} color={colors.faint} />} disabled={!online} onPress={rename} />
        {/* Admin mode is this phone's own way of looking: off, it lists what you are part of; it never changes what you may do. */}
        {typeof admin === "boolean" && (
          <Row
            leading={<IconTile icon={Eye} />}
            title="Admin mode"
            subtitle="See every member's spaces, bots and chats."
            subtitleLines={2}
            toggled={admin}
            disabled={!online}
            onToggle={(on) => void attempt(api["link.team.setAdminMode"](on))}
          />
        )}
        {/* A link shows a space to anyone who has it, so members share by link only when the owner says so. */}
        {spacesOn && (
          <Row
            leading={<IconTile icon={Link} />}
            title="Members may share by link"
            subtitle="Anyone with a link can look at that space."
            subtitleLines={2}
            toggled={team.linkSharing === true}
            disabled={!online}
            onToggle={(on) => void attempt(api["link.team.setLinkSharing"](on))}
          />
        )}
      </Group>

      <Requests requests={team.requests} invites={team.invites} groups={team.groups} online={online} />
      <Invites teamName={team.name} groups={team.groups} invites={team.invites} online={online} />
      <Members members={team.members} groups={team.groups} online={online} />
      <Groups groups={team.groups} roles={team.roles} online={online} />
      <Roles roles={team.roles} groups={team.groups} online={online} />
    </Page>
  );
}

function Requests({ requests, invites, groups, online }: { requests: JoinRequest[]; invites: Invite[]; groups: TeamGroup[]; online: boolean }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const groupOf = (request: JoinRequest) => picked[request.id] ?? invites.find((invite) => invite.id === request.inviteId)?.groupId ?? groups[0]?.id ?? "";
  if (!requests.length) {
    return <View><Label>Requests</Label><T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>No requests waiting</T></View>;
  }
  return (
    <View>
      <Label>Requests</Label>
      <View style={{ gap: space.md }}>
        {requests.map((request) => {
          const groupId = groupOf(request);
          const group = groups.find((item) => item.id === groupId);
          return (
            <Group key={request.id}>
              <Row leading={<IconTile icon={UserPlus} />} title={request.person || request.name} subtitle={[request.person ? request.name : request.platform, ago(request.at)].filter(Boolean).join(" · ")} trailing={<Badge label="Waiting" tone="warning" />} />
              <Row title="Group" value={group?.name ?? "Choose a group"} chevron disabled={!online} onPress={() => pickGroup(groups, "Approve into group", groupId, (id) => setPicked((current) => ({ ...current, [request.id]: id })))} />
              <View style={{ flexDirection: "row", gap: space.sm, padding: space.lg }}>
                <Button title="Deny" variant="secondary" style={{ flex: 1 }} disabled={!online} onPress={() => void attempt(api["link.team.deny"](request.id), "Request denied")} />
                <Button title="Approve" style={{ flex: 1 }} disabled={!online || !groupId} onPress={() => void attempt(api["link.team.approve"](request.id, groupId), "Request approved")} />
              </View>
            </Group>
          );
        })}
      </View>
    </View>
  );
}

function Invites({ teamName, groups, invites, online }: { teamName: string; groups: TeamGroup[]; invites: Invite[]; online: boolean }) {
  const { colors } = useTheme();
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [uses, setUses] = useState<"1" | "5" | "25">("1");
  const [created, setCreated] = useState<Invite>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!groups.some((group) => group.id === groupId)) setGroupId(groups[0]?.id ?? "");
  }, [groups, groupId]);
  const group = groups.find((item) => item.id === groupId);
  const active = invites.filter((invite) => !invite.revoked && invite.uses < invite.maxUses && invite.expiresAt > Date.now());

  async function create() {
    if (!groupId) return;
    setBusy(true);
    const invite = await attempt(api["link.team.createInvite"]({ groupId, days: Number(days) as 1 | 7 | 30, maxUses: Number(uses) as 1 | 5 | 25 }), "Invite created");
    setBusy(false);
    if (invite) setCreated(invite);
  }
  async function copy(invite: Invite) {
    await Clipboard.setStringAsync(formatCode(invite.code));
    haptic.success();
  }
  async function share(invite: Invite) {
    const code = formatCode(invite.code);
    await Share.share({ message: "Join my Botkins team: " + invite.link + " or enter code " + code });
  }

  return (
    <View style={{ gap: space.md }}>
      <View><Label>Invite</Label></View>
      <Group>
        <Row leading={<IconTile icon={Users} />} title="Group" value={group?.name} chevron onPress={() => pickGroup(groups, "Invite group", groupId, setGroupId)} />
        <View style={{ padding: space.lg, gap: space.md }}>
          <T variant="label" color="muted">EXPIRY</T>
          <Segmented options={[{ value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} value={days} onChange={setDays} />
          <T variant="label" color="muted">USES</T>
          <Segmented options={[{ value: "1", label: "1" }, { value: "5", label: "5" }, { value: "25", label: "25" }]} value={uses} onChange={setUses} />
          <Button title="Create invite" icon={Plus} wide loading={busy} disabled={!online || !groupId} onPress={() => void create()} />
        </View>
      </Group>
      {created && (
        <Group>
          <View style={{ alignItems: "center", padding: space.xl, gap: space.md }}>
            <T variant="label" color="muted">INVITE CODE</T>
            <T variant="mono" selectable style={{ fontSize: 30, lineHeight: 38, letterSpacing: 2 }}>{formatCode(created.code)}</T>
            {created.published === false && <T variant="footnote" color="muted" center>Codes work when Relay is on in the computer's Phone settings.</T>}
            {/* The same invite as a QR code: the other person scans it from "Join a team". */}
            {!!created.link && <QrCode text={created.link} label="Invite QR code" />}
            {!!created.link && <T variant="footnote" color="muted" center>Scan to join</T>}
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button title="Copy" icon={Copy} variant="secondary" onPress={() => void copy(created)} />
              <Button title="Share" icon={Share2} onPress={() => void share(created)} />
            </View>
          </View>
        </Group>
      )}
      {active.length > 0 && (
        <View>
          <Label>Live invites</Label>
          <Group>
            {active.map((invite) => (
              <Row
                key={invite.id}
                leading={<IconTile icon={Link} />}
                title={formatCode(invite.code)}
                subtitle={[groups.find((item) => item.id === invite.groupId)?.name, invite.maxUses - invite.uses + " uses left"].filter(Boolean).join(" · ")}
                // A tap shows this invite's code and QR again, above.
                onPress={() => setCreated(invite)}
                trailing={<IconButton icon={Trash2} label={"Revoke " + formatCode(invite.code)} color={colors.danger} disabled={!online} onPress={() => void attempt(api["link.team.revokeInvite"](invite.id), "Invite revoked")} />}
              />
            ))}
          </Group>
        </View>
      )}
      {!!teamName && <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>Invites let people ask to join {teamName}.</T>}
    </View>
  );
}

function Members({ members, groups, online }: { members: Member[]; groups: TeamGroup[]; online: boolean }) {
  const { colors } = useTheme();
  const canRename = useCapability("member-rename-v1");
  const prompt = useTextPrompt();
  const rename = (member: Member) =>
    prompt.ask({
      title: "Rename " + member.name,
      value: member.name,
      max: MEMBER_NAME_MAX,
      onSubmit: (name) => {
        if (name !== member.name) void attempt(api["link.team.renameMember"](member.id, name), "Member renamed");
      },
    });
  const move = (member: Member) =>
    pickGroup(groups, "Move " + member.name, member.groupId, (groupId) => {
      if (groupId !== member.groupId) void attempt(api["link.team.moveMember"](member.id, groupId), "Member moved");
    });
  const remove = (member: Member) =>
    Alert.alert("Remove " + member.name + "?", "Their devices leave the team and can't connect until they join again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void attempt(api["link.team.removeMember"](member.id), "Member removed") },
    ]);
  const choose = (member: Member, event: string) => {
    const choice = memberChoice(event);
    if (choice?.do === "rename") rename(member);
    else if (choice?.do === "remove") remove(member);
    else if (choice?.do === "move" && choice.groupId !== member.groupId) void attempt(api["link.team.moveMember"](member.id, choice.groupId), "Member moved");
  };
  return (
    <View>
      <Label>Members</Label>
      {members.length ? (
        <Group flat inset={space.lg}>
          {members.map((member) => (
            // A hold opens the member's menu; a tap still moves them to a group.
            <HoldMenu key={member.id} title={member.name} actions={online ? memberActions(member, groups, canRename) : []} onPressAction={({ nativeEvent }) => choose(member, nativeEvent.event)}>
              <Row
                title={member.name}
                subtitle={[groups.find((group) => group.id === member.groupId)?.name, member.devices?.length ? member.devices.map((device) => device.name).join(", ") : "No devices"].filter(Boolean).join(" · ")}
                trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><View style={{ flexDirection: "row", gap: 4 }}>{member.devices?.map((device) => <Dot key={device.id} tone={device.connected ? "success" : "neutral"} />)}</View><IconButton icon={UserMinus} label={"Remove " + member.name} color={colors.danger} disabled={!online} onPress={() => remove(member)} /></View>}
                onPress={!online ? undefined : () => move(member)}
              />
            </HoldMenu>
          ))}
        </Group>
      ) : <T variant="subhead" color="muted" style={{ paddingHorizontal: space.xs }}>No members yet</T>}
      {prompt.node}
    </View>
  );
}

function Groups({ groups, roles, online }: { groups: TeamGroup[]; roles: Role[]; online: boolean }) {
  const saveGroup = (group: TeamGroup, patch: Partial<TeamGroup>) => void attempt(api["link.team.saveGroup"]({ ...group, ...patch }));
  const rename = (group: TeamGroup) =>
    Alert.prompt("Rename group", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Save", onPress: (name?: string) => name?.trim() && saveGroup(group, { name: name.trim() }) },
    ], "plain-text", group.name);
  const chooseRole = (group: TeamGroup) =>
    Alert.alert("Role for " + group.name, undefined, [
      ...roles.map((role) => ({ text: (role.id === group.roleId ? "✓ " : "") + role.name, onPress: () => saveGroup(group, { roleId: role.id }) })),
      { text: "Cancel", style: "cancel" },
    ]);
  const remove = (group: TeamGroup) => {
    const destinations = groups.filter((item) => item.id !== group.id);
    if (!destinations.length) return;
    Alert.alert("Delete " + group.name + "?", "Where should its members move?", [
      ...destinations.map((destination) => ({ text: destination.name, onPress: () => void attempt(api["link.team.deleteGroup"](group.id, destination.id), "Group deleted") })),
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const create = () => {
    Alert.prompt("New group", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Next", onPress: (name?: string) => {
        if (!name?.trim() || !roles[0]) return;
        Alert.alert("Choose a role", undefined, [
          ...roles.map((role) => ({ text: role.name, onPress: () => void attempt(api["link.team.saveGroup"]({ id: "g_" + Math.random().toString(36).slice(2, 12), name: name.trim(), roleId: role.id }), "Group created") })),
          { text: "Cancel", style: "cancel" },
        ]);
      } },
    ], "plain-text");
  };
  const actions = (group: TeamGroup) =>
    Alert.alert(group.name, roleName(roles, group.roleId), [
      { text: "Rename", onPress: () => rename(group) },
      { text: "Change role", onPress: () => chooseRole(group) },
      ...(groups.length > 1 ? [{ text: "Delete", style: "destructive" as const, onPress: () => remove(group) }] : []),
      { text: "Cancel", style: "cancel" },
    ]);
  return (
    <View>
      <Label>Groups</Label>
      <Group>
        {groups.map((group) => <Row key={group.id} leading={<IconTile icon={Users} />} title={group.name} value={roleName(roles, group.roleId)} chevron disabled={!online} onPress={() => actions(group)} />)}
        <Row leading={<IconTile icon={Plus} />} title="New group" tone="accent" disabled={!online} onPress={create} />
      </Group>
    </View>
  );
}

function Roles({ roles, groups, online }: { roles: Role[]; groups: TeamGroup[]; online: boolean }) {
  return (
    <View>
      <Label>Roles</Label>
      <Group>
        {roles.map((role) => {
          const uses = groups.filter((group) => group.roleId === role.id).length;
          return <Row key={role.id} title={role.name} subtitle={uses ? uses + (uses === 1 ? " group" : " groups") : undefined} value={role.bots === "all" ? "All agents" : String(role.bots.length)} chevron disabled={!online} onPress={() => router.push({ pathname: "/settings/team/role", params: { id: role.id } })} />;
        })}
        <Row leading={<IconTile icon={Plus} />} title="New role" tone="accent" disabled={!online} onPress={() => router.push({ pathname: "/settings/team/role", params: { id: "new" } })} />
      </Group>
    </View>
  );
}
