import { router } from "expo-router";
import { Check, Monitor, Plus, QrCode, UserPlus, Users } from "lucide-react-native";
import { View } from "react-native";
import { useApp } from "@/state/store";
import { selectProfileHost, useProfile, useProfileHosts } from "@/state/profile";
import { brand, Group, IconTile, Page, Row, space, T, useTheme } from "@/ui";
import { addComputer, switchTo } from "@/features/home/computers";
import { linkLabel } from "./shared";
import { profileHostSubtitle } from "@/features/profile/profileLogic";

/**
 * Settings › Computers and teams: every local pairing plus every profile directory host, the one in
 * use ticked (a tap on another uses it), then the ways to add one.
 */
export default function Computers() {
  const { colors } = useTheme();
  const pairings = useApp((state) => state.pairings);
  const profile = useProfile((state) => state.session);
  const directoryHosts = useProfileHosts();
  const profilePairings = useProfile((state) => state.pairings);
  const boundLocal = useProfile((state) => state.boundLocal);
  const excluded = useProfile((state) => state.excluded);
  const inUse = useApp((state) => state.pairing?.serverId);
  const link = useApp((state) => state.link);
  const route = useApp((state) => state.route);
  return (
    <Page title="Computers and teams">
      <View style={{ gap: space.sm }}>
        <Group>
          {pairings.map((item) => {
            const current = item.serverId === inUse;
            const directoryHost = directoryHosts.find((host) => host.serverId === item.serverId);
            const migrationPending = !!profile && !!directoryHost && !boundLocal.includes(item.serverId) && !excluded.includes(item.serverId);
            const unlinked = !!profile && excluded.includes(item.serverId);
            const subtitle = [item.member ? "Team member" : undefined, current ? linkLabel(link, route) : undefined, migrationPending ? "Profile transfer waiting for this computer" : undefined, unlinked ? "Not linked to this profile" : undefined].filter(Boolean).join(" · ");
            return (
              <Row
                key={item.serverId}
                leading={item.member ? <IconTile icon={Users} color={brand.clay} /> : <IconTile icon={Monitor} color={brand.tide} />}
                title={item.name || (item.member ? "Team" : "Computer")}
                subtitle={subtitle || undefined}
                trailing={
                  current ? (
                    <View accessible accessibilityLabel="In use">
                      <Check size={18} color={colors.accentText} strokeWidth={2.6} />
                    </View>
                  ) : undefined
                }
                chevron={!current}
                onPress={current ? undefined : () => switchTo(item.serverId)}
              />
            );
          })}
          {profile && directoryHosts.filter((host) => !pairings.some((pairing) => pairing.serverId === host.serverId)).map((host) => {
            const current = host.serverId === inUse;
            const enrolled = boundLocal.includes(host.serverId) || !!profilePairings[host.serverId];
            const selectable = host.hosts.length > 0;
            return (
              <Row
                key={host.serverId}
                leading={host.member ? <IconTile icon={Users} color={brand.clay} /> : <IconTile icon={Monitor} color={brand.tide} />}
                title={host.name || (host.member ? "Team" : "Computer")}
                subtitle={profileHostSubtitle(host, false, enrolled)}
                trailing={current ? <View accessible accessibilityLabel="In use"><Check size={18} color={colors.accentText} strokeWidth={2.6} /></View> : undefined}
                chevron={!current && selectable}
                disabled={!selectable}
                onPress={current || !selectable ? undefined : () => void selectProfileHost(host)}
              />
            );
          })}
        </Group>
        {(pairings.length + directoryHosts.filter((host) => !pairings.some((pairing) => pairing.serverId === host.serverId)).length) > 1 && (
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            Tap one to use it. The app shows one computer or team at a time.
          </T>
        )}
      </View>

      <Group>
        <Row leading={<IconTile icon={QrCode} color={brand.tide} />} title="Connect a computer" chevron onPress={addComputer} />
        <Row leading={<IconTile icon={UserPlus} color={brand.clay} />} title="Join a team" chevron onPress={() => router.push("/join")} />
        <Row leading={<IconTile icon={Plus} color={colors.ink2} />} title="Set up a new Botkins" subtitle="Mac, Windows, Linux or Azure" chevron onPress={() => router.push("/setup")} />
      </Group>
    </Page>
  );
}
