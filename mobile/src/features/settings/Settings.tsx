// Settings, grouped as the desktop app's Settings groups them (its side list in desktop/src/Settings.tsx):
// the computer in use, then a group of who and where (General, Profile, Computers and teams, Team,
// Control computer), "Your bots' toolbox", "How bots work", "This phone", and last Usage, Experimental,
// Send feedback and About. A search at the top keeps the rows whose words match (search.ts).
// Approvals are reached from Chat, and the harness from General, as on the computer.
import { type Href, router } from "expo-router";
import {
  AudioLines,
  Bell,
  Bug,
  BookOpen,
  ChartColumn,
  FlaskConical,
  FolderLock,
  Info,
  KeyRound,
  LibraryBig,
  MessagesSquare,
  Monitor,
  MonitorSmartphone,
  PanelBottom,
  ScreenShare,
  Search,
  Settings2,
  Smartphone,
  SunMoon,
  UserRound,
  Users,
  UsersRound,
  Wrench,
  X,
  Boxes,
} from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import type { Preferences } from "@/link/types";
import { usePart, useProviders, useSettings, useSkills } from "@/state/hooks";
import { unpair } from "@/state/link";
import { usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { useProfile, useProfileHosts } from "@/state/profile";
import { can } from "@/state/team";
import { Badge, backdropById, brand, Glass, Group, IconTile, Label, Page, radius, Row, space, T, Tap, tint, useTheme } from "@/ui";
import { themeById } from "@/ui/themes";
import { findSettings } from "./search";
import { linkLabel } from "./shared";

export const APPROVAL_SHORT: Record<Preferences["approval"], string> = { ask: "Always ask", read: "Reading", assisted: "Model decides", all: "Everything" };

/** A row of Settings: what search reads, and the row itself. */
type Item = { key: string; title: string; subtitle?: string; words?: string; node: ReactNode };
type Section = { key: string; label?: string; rows: Item[] };

function SearchField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const { colors, dark, type, control } = useTheme();
  const hasBackdrop = usePrefs((prefs) => prefs.backdrop !== "clean");
  const inner = (
    <>
      <Search size={17} color={colors.muted} strokeWidth={2.3} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search settings"
        placeholderTextColor={colors.faint}
        keyboardAppearance={dark ? "dark" : "light"}
        selectionColor={colors.accent}
        autoCorrect={false}
        returnKeyType="search"
        maxFontSizeMultiplier={1.3}
        accessibilityLabel="Search settings"
        style={[type.callout, { flex: 1, color: colors.ink, paddingVertical: 0, height: control.field }]}
      />
      {!!value && (
        <Tap onPress={() => onChange("")} accessibilityLabel="Clear search" feel="select" sink={0.9} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: colors.faint, alignItems: "center", justifyContent: "center" }}>
            <X size={12} color={colors.sunken} strokeWidth={3} />
          </View>
        </Tap>
      )}
    </>
  );
  const frame = { height: control.field, flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, paddingLeft: space.md, borderRadius: radius.md, overflow: "hidden" as const };
  if (hasBackdrop) return <Glass tintColor={tint(colors.surface, dark ? 0.28 : 0.42)} style={frame}>{inner}</Glass>;
  return <View style={[frame, { backgroundColor: colors.sunken }]}>{inner}</View>;
}

export default function Settings() {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const name = useApp((state) => state.pairing?.name) ?? "Your computer";
  const link = useApp((state) => state.link);
  const route = useApp((state) => state.route);
  const localComputers = useApp((state) => state.pairings);
  const settings = useSettings();
  const providers = useProviders();
  const servers = usePart("mcp");
  const skills = useSkills();
  const skillsOff = usePart("skills")?.disabled;
  const meta = usePart("meta");
  const team = usePart("team");
  const lightTheme = usePrefs((prefs) => prefs.lightTheme);
  const backdrop = usePrefs((prefs) => prefs.backdrop);
  const member = meta?.you?.kind === "member" && team && "me" in team ? team : undefined;
  const profile = useProfile((state) => state.session);
  const profileHosts = useProfileHosts();
  const computers = localComputers.length + profileHosts.filter((host) => !localComputers.some((pairing) => pairing.serverId === host.serverId)).length;
  const permission = (scope: Parameters<typeof can>[1], action: string) => can({ meta, team }, scope, action);
  const owner = meta?.you?.kind !== "member";

  const toolsOn = servers?.filter((server) => server.enabled).length;
  const skillsOn = skills?.filter((skill) => skill.enabled && !skillsOff?.includes(skill.name)).length;
  const signedIn = providers?.filter((provider) => provider.connected).length;
  const count = (value: number | undefined, word: string) => (value === undefined ? undefined : value + " " + word);
  const go = (path: string) => () => router.push(path as Href);
  const row = (key: string, title: string, node: ReactNode, extra: { subtitle?: string; words?: string } = {}): Item => ({ key, title, ...extra, node });
  const requests = team && "requests" in team ? team.requests.length : 0;
  const chatSettings = permission("settings", "view") || (!!meta?.capabilities.includes("main-chat-v1") && permission("agents", "view"));

  const sections: Section[] = [
    {
      key: "you",
      rows: [
        ...(owner || permission("agents", "view")
          ? [row("general", "General", <Row leading={<IconTile icon={Settings2} color={brand.tide} />} title="General" subtitle="Default model, harness, Claude artifacts, background" chevron onPress={go("/settings/general")} />, { subtitle: "Default model, harness, Claude artifacts, background", words: "model harness copilot claude artifacts grants codex pi omp background startup storage" })]
          : []),
        row(
          "profile",
          "Profile",
          <Row
            leading={<IconTile icon={UserRound} color={brand.tide} />}
            title="Profile"
            subtitle={profile ? profile.email || profile.name : meta?.capabilities.includes("people-avatars-v1") ? "Your picture · your identity on other devices" : "Optional · use your identity on other devices"}
            chevron
            onPress={go("/profile")}
          />,
          { words: "botkins profile name picture photo account sign in" },
        ),
        row("computers", "Computers and teams", <Row leading={<IconTile icon={MonitorSmartphone} color={brand.tide} />} title="Computers and teams" value={computers > 1 ? String(computers) : undefined} chevron onPress={go("/settings/computers")} />, { words: "pair connect join switch host" }),
        ...(owner && meta?.capabilities.includes("teams-v1")
          ? [
              row(
                "team",
                "Team",
                <Row
                  leading={<IconTile icon={Users} color={brand.tide} />}
                  title="Team"
                  subtitle={team && "roles" in team ? team.name : undefined}
                  trailing={requests > 0 ? <Badge label={requests === 1 ? "1 request" : requests + " requests"} tone="warning" /> : undefined}
                  chevron
                  onPress={go("/settings/team")}
                />,
                { words: "members invite requests roles groups admin mode" },
              ),
            ]
          : []),
        ...(owner ? [row("remote", "Control computer", <Row leading={<IconTile icon={ScreenShare} color={brand.tide} />} title="Control computer" subtitle="Open the screen, pointer and keyboard" chevron onPress={go("/remote")} />, { subtitle: "Open the screen, pointer and keyboard", words: "screen remote" })] : []),
      ],
    },
    {
      key: "toolbox",
      label: "Your bots’ toolbox",
      rows: [
        ...(permission("agents", "view") ? [row("models", "Model providers", <Row leading={<IconTile icon={Boxes} color={brand.clay} />} title="Model providers" value={count(signedIn, "signed in")} chevron onPress={go("/models")} />, { words: "models default sign in api key copilot chatgpt claude opencode openrouter limits" })] : []),
        ...(permission("mcp", "view") ? [row("tools", "Tools", <Row leading={<IconTile icon={Wrench} color={brand.clay} />} title="Tools" value={count(toolsOn, "on")} chevron onPress={go("/tools")} />, { words: "mcp servers apps" })] : []),
        ...(permission("skills", "read") ? [row("skills", "Skills", <Row leading={<IconTile icon={BookOpen} color={brand.clay} />} title="Skills" value={count(skillsOn, "on")} chevron onPress={go("/skills")} />, { words: "skill scripts commands plugins" })] : []),
        ...(owner ? [row("credentials", "Credentials", <Row leading={<IconTile icon={KeyRound} color={brand.clay} />} title="Credentials" chevron onPress={go("/credentials")} />, { words: "keys secrets passwords vault 1password bitwarden proton" })] : []),
        ...(owner ? [row("wiki", "Wiki", <Row leading={<IconTile icon={LibraryBig} color={brand.clay} />} title="Wiki" chevron onPress={go("/wiki")} />, { words: "pages notes knowledge" })] : []),
      ],
    },
    {
      key: "how",
      label: "How bots work",
      rows: [
        ...(chatSettings
          ? [
              row(
                "chat",
                "Chat",
                <Row leading={<IconTile icon={MessagesSquare} color={brand.fern} />} title="Chat" subtitle="Thinking, steps, approvals" value={owner && settings ? APPROVAL_SHORT[settings.approval] : undefined} chevron onPress={go("/settings/chat")} />,
                { subtitle: "Thinking, steps, approvals", words: "approvals ask first allow permissions steps thinking rich cards markdown streaming bot tap" },
              ),
            ]
          : []),
        ...(owner && !!settings?.access ? [row("access", "Access", <Row leading={<IconTile icon={FolderLock} color={brand.fern} />} title="Access" value={settings.access.allBots ? "Every project" : "By bot"} chevron onPress={go("/settings/access")} />, { words: "projects folders files permissions" })] : []),
        ...(owner ? [row("teamwork", "Teamwork", <Row leading={<IconTile icon={UsersRound} color={brand.fern} />} title="Teamwork" value={settings ? (settings.teamwork !== false ? "On" : "Off") : undefined} chevron onPress={go("/settings/teamwork")} />, { words: "handoff delegate help other computer" })] : []),
        ...(owner ? [row("voice", "Voice", <Row leading={<IconTile icon={AudioLines} color={brand.fern} />} title="Voice" subtitle="Dictation, reading aloud, live voice" chevron onPress={go("/settings/voice")} />, { subtitle: "Dictation, reading aloud, live voice", words: "speech microphone speak" })] : []),
        row("notifications", "Notifications", <Row leading={<IconTile icon={Bell} color={brand.fern} />} title="Notifications" subtitle="Replies, requests, Live Activities" chevron onPress={go("/settings/notifications")} />, { subtitle: "Replies, requests, Live Activities", words: "alerts push quiet" }),
      ],
    },
    {
      key: "phone",
      label: "This phone",
      rows: [
        row("appearance", "Appearance", <Row leading={<IconTile icon={SunMoon} color={brand.rose} />} title="Appearance" value={themeById(lightTheme).name + " · " + backdropById(backdrop).name} chevron onPress={go("/settings/appearance")} />, { words: "theme dark light mode color backdrop grid font text size" }),
        row("tabs", "Tabs", <Row leading={<IconTile icon={PanelBottom} color={brand.rose} />} title="Tabs" chevron onPress={go("/settings/tabs")} />, { words: "tab bar order" }),
        row("device", "Device access", <Row leading={<IconTile icon={Smartphone} color={brand.rose} />} title="Device access" chevron onPress={go("/tools/device")} />, { words: "calendar contacts health location photos music mail" }),
      ],
    },
    {
      key: "more",
      rows: [
        ...(owner ? [row("usage", "Usage", <Row leading={<IconTile icon={ChartColumn} color={colors.ink2} />} title="Usage" chevron onPress={go("/settings/usage")} />, { words: "tokens cost plans limits" })] : []),
        ...(owner && meta?.capabilities.includes("proactive-agent-v2")
          ? [row("experimental", "Experimental", <Row leading={<IconTile icon={FlaskConical} color={colors.ink2} />} title="Experimental" value={settings?.proactive?.enabled ? "Proactive agent on" : undefined} chevron onPress={go("/settings/experimental")} />, { words: "proactive beta" })]
          : []),
        row("feedback", "Send feedback", <Row leading={<IconTile icon={Bug} color={colors.ink2} />} title="Send feedback" subtitle="Report a bug or ask for a feature" chevron onPress={go("/settings/feedback")} />, { subtitle: "Report a bug or ask for a feature", words: "bug issue" }),
        row("about", "About", <Row leading={<IconTile icon={Info} color={colors.ink2} />} title="About" chevron onPress={go("/settings/about")} />, { words: "version update" }),
      ],
    },
  ];
  const found = findSettings(sections, query);
  const searching = !!query.trim();

  return (
    <Page title="Settings" keyboard>
      <SearchField value={query} onChange={setQuery} />
      {!searching && (
        <Group>
          <Row leading={<IconTile icon={Monitor} color={brand.tide} size={36} />} title={name} subtitle={linkLabel(link, route)} chevron onPress={go("/settings/desktop")} />
        </Group>
      )}

      {member && !searching && (
        <Group>
          <Row leading={<IconTile icon={Users} color={brand.fern} />} title={"Member of " + member.team.name} subtitle={member.me.group.name + " · " + member.me.role.name} trailing={<Badge label="Member" tone="accent" />} />
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

      {found.map((section) => (
        <View key={section.key}>
          {!!section.label && <Label>{section.label}</Label>}
          <Group>
            {section.rows.map((item) => (
              <View key={item.key}>{item.node}</View>
            ))}
          </Group>
        </View>
      ))}

      {searching && found.length === 0 && (
        <T variant="callout" color="muted" center style={{ paddingVertical: space.xl }}>
          {"No settings match “" + query.trim() + "”"}
        </T>
      )}
    </Page>
  );
}
