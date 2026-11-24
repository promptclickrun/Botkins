import { type Href, router } from "expo-router";
import { AudioLines, Bell, BookOpen, ChartColumn, Cpu, FlaskConical, FolderLock, Info, KeyRound, LibraryBig, MessagesSquare, Monitor, MonitorSmartphone, ScreenShare, ShieldCheck, SunMoon, UserRound, Users, Wrench } from "lucide-react-native";
import { Alert, View } from "react-native";
import { describeChoice, useDefaultProvider } from "@/features/models/shared";
import type { Preferences } from "@/link/types";
import { useModels, usePart, useSettings, useSkills } from "@/state/hooks";
import { api, attempt, unpair } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { useProfile, useProfileHosts } from "@/state/profile";
import { can } from "@/state/team";
import { Badge, brand, Group, IconTile, Label, Page, ProviderIcon, Row, useTheme } from "@/ui";
import { harnessName } from "./Harness";
import { linkLabel } from "./shared";

const APPROVAL_SHORT: Record<Preferences["approval"], string> = { ask: "Always ask", read: "Reading", assisted: "Model decides", all: "Everything" };
const APPEARANCE: Record<"system" | "light" | "dark", string> = { system: "System", light: "Light", dark: "Dark" };

export default function Settings() {
  const { colors } = useTheme();
  const name = useApp((state) => state.pairing?.name) ?? "Your computer";
  const link = useApp((state) => state.link);
  const route = useApp((state) => state.route);
  const localComputers = useApp((state) => state.pairings);
  const settings = useSettings();
  const models = useModels();
  const defaultProvider = useDefaultProvider();
  const servers = usePart("mcp");
  const skills = useSkills();
  const skillsOff = usePart("skills")?.disabled;
  const meta = usePart("meta");
  const team = usePart("team");
  const mode = usePrefs((prefs) => prefs.mode);
  const member = meta?.you?.kind === "member" && team && "me" in team ? team : undefined;
  const profile = useProfile((state) => state.session);
  const profileHosts = useProfileHosts();
  const computers = localComputers.length + profileHosts.filter((host) => !localComputers.some((pairing) => pairing.serverId === host.serverId)).length;
  const permission = (scope: Parameters<typeof can>[1], action: string) => can({ meta, team }, scope, action);
  const owner = meta?.you?.kind !== "member";

  const model = describeChoice(settings?.model, models, defaultProvider);
  const toolsOn = servers?.filter((server) => server.enabled).length;
  const skillsOn = skills?.filter((skill) => skill.enabled && !skillsOff?.includes(skill.name)).length;
  const set = (patch: Parameters<typeof api.setPreferences>[0]) => void attempt(api.setPreferences(patch));
  const count = (value: number | undefined, word: string) => (value === undefined ? undefined : value + " " + word);

  return (
    <Page title="Settings">
      <Group>
        <Row leading={<IconTile icon={Monitor} color={brand.tide} size={36} />} title={name} subtitle={linkLabel(link, route)} chevron onPress={() => router.push("/settings/desktop")} />
        <Row leading={<IconTile icon={MonitorSmartphone} color={brand.tide} />} title="Computers and teams" value={computers > 1 ? String(computers) : undefined} chevron onPress={() => router.push("/settings/computers")} />
        <Row leading={<IconTile icon={UserRound} color={brand.tide} />} title="Botkins profile" subtitle={profile ? profile.email || profile.name : "Optional · use your identity on other devices"} chevron onPress={() => router.push("/profile")} />
        {owner && <Row leading={<IconTile icon={ScreenShare} color={brand.tide} />} title="Screen" subtitle="See and control your computer" chevron onPress={() => router.push("/remote")} />}
        {owner && meta?.capabilities.includes("teams-v1") && (
          <Row
            leading={<IconTile icon={Users} color={brand.tide} />}
            title="Team"
            subtitle={team && "roles" in team ? team.name : undefined}
            trailing={team && "requests" in team && team.requests.length > 0 ? <Badge label={String(team.requests.length)} tone="warning" /> : undefined}
            chevron
            onPress={() => router.push("/settings/team")}
          />
        )}
      </Group>

      {member && (
        <Group>
          <Row
            leading={<IconTile icon={Users} color={brand.fern} />}
            title={"Member of " + member.team.name}
            subtitle={member.me.group.name + " · " + member.me.role.name}
            trailing={<Badge label="Member" tone="accent" />}
          />
          <Row
            title="Leave team"
            tone="danger"
            onPress={() =>
              Alert.alert("Leave " + member.team.name + "?", "This phone will be disconnected from the team.", [
                { text: "Cancel", style: "cancel" },
                { text: "Leave", style: "destructive", onPress: () => void unpair() },
              ])
            }
          />
        </Group>
      )}

      {(permission("agents", "view") || permission("mcp", "view") || permission("skills", "read") || owner) && (
        <View>
          <Label>Your bots' toolbox</Label>
          <Group>
            {permission("agents", "view") && <Row leading={<ProviderIcon provider={model.provider} name={model.providerLabel} size={32} tile />} title="Models" value={models && settings ? model.name : undefined} chevron onPress={() => router.push("/models")} />}
            {permission("mcp", "view") && <Row leading={<IconTile icon={Wrench} color={brand.clay} />} title="Tools" value={count(toolsOn, "on")} chevron onPress={() => router.push("/tools")} />}
            {permission("skills", "read") && <Row leading={<IconTile icon={BookOpen} color={brand.clay} />} title="Skills" value={count(skillsOn, "on")} chevron onPress={() => router.push("/skills")} />}
            {owner && <Row leading={<IconTile icon={KeyRound} color={brand.clay} />} title="Credentials" chevron onPress={() => router.push("/credentials")} />}
            {owner && <Row leading={<IconTile icon={LibraryBig} color={brand.clay} />} title="Wiki" chevron onPress={() => router.push("/wiki")} />}
          </Group>
        </View>
      )}

      <View>
        <Label>How bots work</Label>
        <Group>
          {owner && <Row leading={<IconTile icon={ShieldCheck} color={brand.fern} />} title="Approvals" value={settings ? APPROVAL_SHORT[settings.approval] : undefined} chevron onPress={() => router.push("/settings/approvals")} />}
          {owner && !!settings?.access && <Row leading={<IconTile icon={FolderLock} color={brand.fern} />} title="Access" value={settings.access.allBots ? "Every project" : "By bot"} chevron onPress={() => router.push("/settings/access" as Href)} />}
          {owner && !!settings?.harness && <Row leading={<IconTile icon={Cpu} color={brand.fern} />} title="Harness" value={harnessName(settings.harness)} chevron onPress={() => router.push("/settings/harness")} />}
          {owner && <Row leading={<IconTile icon={Users} color={brand.fern} />} title="Teamwork" subtitle="Bots can ask each other for help" toggled={settings?.teamwork !== false} disabled={!settings} onToggle={(teamwork) => set({ teamwork })} />}
          {permission("settings", "view") && <Row leading={<IconTile icon={MessagesSquare} color={brand.fern} />} title="Chat" subtitle="Thinking, steps, rich replies" chevron onPress={() => router.push("/settings/chat")} />}
          {owner && <Row leading={<IconTile icon={AudioLines} color={brand.fern} />} title="Voice" subtitle="Dictation, reading aloud, live voice" chevron onPress={() => router.push("/settings/voice")} />}
          <Row leading={<IconTile icon={Bell} color={brand.fern} />} title="Notifications" subtitle="Replies, requests, Live Activities" chevron onPress={() => router.push("/settings/notifications")} />
        </Group>
      </View>

      <View>
        <Label>This phone</Label>
        <Group>
          <Row leading={<IconTile icon={SunMoon} color={brand.rose} />} title="Appearance" value={APPEARANCE[mode]} chevron onPress={() => router.push("/settings/appearance")} />
        </Group>
      </View>

      <Group>
        {owner && <Row leading={<IconTile icon={ChartColumn} color={colors.ink2} />} title="Usage" chevron onPress={() => router.push("/settings/usage")} />}
        {owner && meta?.capabilities.includes("proactive-agent-v2") && (
          <Row leading={<IconTile icon={FlaskConical} color={colors.ink2} />} title="Experimental" value={settings?.proactive?.enabled ? "Proactive agent on" : undefined} chevron onPress={() => router.push("/settings/experimental" as Href)} />
        )}
        <Row leading={<IconTile icon={Info} color={colors.ink2} />} title="About" chevron onPress={() => router.push("/settings/about")} />
      </Group>
    </Page>
  );
}
