import * as Crypto from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import type { Role, Scope } from "@/link/types";
import { useBots, useOnline, usePart, useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { BotAvatar, Button, EmptyState, Field, Group, Label, Row, Segmented, Sheet, space, T } from "@/ui";
import { SCOPE_ACTIONS, toggleRoleAction } from "@/state/team";

const SCOPES: { id: Scope; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "today", label: "Today" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
  { id: "plugins", label: "Plugins" },
  { id: "settings", label: "Settings" },
];
const ACTION_LABEL: Record<string, string> = {
  view: "Can view",
  chat: "Can chat",
  use: "Can use",
  read: "Can read",
  create: "Can create",
  install: "Can install",
  manage: "Can manage",
  delete: "Can delete",
  uninstall: "Can uninstall",
};
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function roleId() {
  return "r_" + [...Crypto.getRandomBytes(10)].map((byte) => CROCKFORD[byte & 31]).join("");
}

const blankRole = (): Role => ({
  id: roleId(),
  name: "",
  perms: { agents: [], today: [], skills: [], mcp: [], plugins: [], settings: [] },
  bots: [],
});

export default function RoleEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const team = usePart("team");
  const owner = team && "roles" in team ? team : undefined;
  const role = owner?.roles.find((item) => item.id === id);
  const online = useOnline();
  const bots = useBots();
  if (id !== "new" && !role) return <Sheet title="Role"><EmptyState title="This role is gone" action="Close" onAction={() => router.back()} /></Sheet>;
  return <Editor ownerGroups={owner?.groups ?? []} role={role} online={online} bots={bots} />;
}

function Editor({ ownerGroups, role, online, bots }: { ownerGroups: { id: string; name: string; roleId: string }[]; role?: Role; online: boolean; bots: ReturnType<typeof useBots> }) {
  const [original] = useState(() => role ?? blankRole());
  const [name, setName] = useState(original.name);
  const spacesOn = useCapability("spaces-v1");
  const [perms, setPerms] = useState<Role["perms"]>(() => Object.fromEntries(SCOPES.map(({ id }) => [id, [...original.perms[id]]])) as Role["perms"]);
  const [visible, setVisible] = useState<Role["bots"]>(original.bots === "all" ? "all" : [...original.bots]);
  const [busy, setBusy] = useState(false);
  const used = !!role && ownerGroups.some((group) => group.roleId === role.id);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const saved = await attempt(api["link.team.saveRole"]({ ...original, name: name.trim(), perms, bots: visible }), "Role saved");
    setBusy(false);
    if (saved) router.back();
  };
  const remove = () => {
    if (!role) return;
    Alert.alert("Delete " + role.name + "?", "Groups using this role keep using it until it is deleted, so move them first.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void attempt(api["link.team.deleteRole"](role.id), "Role deleted").then((result) => result && router.back()) },
    ]);
  };
  const selectMode = (mode: string) => setVisible(mode === "all" ? "all" : (Array.isArray(visible) ? visible : []));

  return (
    <Sheet title={role ? "Edit role" : "New role"} action="Save" onAction={() => void save()} actionDisabled={!name.trim() || !online} actionLoading={busy}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={40} autoCapitalize="words" autoFocus={!role} />
      {SCOPES.map((scope) => (
        <View key={scope.id}>
          {/* The scope is still "today" on the wire. On a computer with spaces it governs every space, and is shown as Spaces. */}
          <Label>{scope.id === "today" && spacesOn ? "Spaces" : scope.label}</Label>
          <Group>
            {SCOPE_ACTIONS[scope.id].map((action) => (
              <Row
                key={action}
                title={ACTION_LABEL[action] ?? action}
                toggled={perms[scope.id].includes(action)}
                disabled={!online}
                onToggle={(enabled) => setPerms((current) => toggleRoleAction(current, scope.id, action, enabled))}
              />
            ))}
          </Group>
        </View>
      ))}

      <View>
        <Label>Visible agents</Label>
        <Group>
          <View style={{ padding: space.lg }}>
            <Segmented options={[{ value: "all", label: "All" }, { value: "picked", label: "Pick bots" }]} value={visible === "all" ? "all" : "picked"} onChange={selectMode} />
          </View>
          {visible !== "all" &&
            bots.map((bot) => (
              <Row
                key={bot.id}
                leading={<BotAvatar bot={bot} size={40} />}
                title={bot.name}
                toggled={visible.includes(bot.id)}
                onToggle={(on) => setVisible((current) => on ? [...(Array.isArray(current) ? current : []), bot.id] : (Array.isArray(current) ? current.filter((id) => id !== bot.id) : []))}
              />
            ))}
        </Group>
      </View>

      {!!role && (
        <View style={{ gap: space.sm }}>
          <Button title="Delete role" variant="danger" wide disabled={used || !online} onPress={remove} />
          {used && <T variant="footnote" color="muted" center>Groups using this role must move first.</T>}
        </View>
      )}
    </Sheet>
  );
}
