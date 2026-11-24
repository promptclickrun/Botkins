import { useState } from "react";
import { router } from "expo-router";
import { ArrowDown, ArrowUp, Star, Check, Monitor, Plus, QrCode, UserPlus, Users } from "lucide-react-native";
import { View } from "react-native";
import { moveComputer, orderedComputers } from "@/state/computers";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { selectProfileHost, useProfile, useProfileHosts } from "@/state/profile";
import { brand, Button, Group, IconButton, IconTile, Page, Row, space, T, useTheme } from "@/ui";
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
  const order = usePrefs(prefs => prefs.computerOrder);
  const primary = usePrefs(prefs => prefs.primaryHost);
  const [editing, setEditing] = useState(false);
  const hosts = orderedComputers(pairings, directoryHosts, order);
  const ids = hosts.map(host => host.serverId);
  return (
    <Page title="Computers and teams">
      <View style={{ gap: space.sm }}>
        <Group>
          {hosts.map((host, index) => {
            const id = host.serverId;
            const local = pairings.some(item => item.serverId === id);
            const current = id === inUse;
            const enrolled = local || !!profilePairings[id] || boundLocal.includes(id);
            const selectable = local || host.hosts.length > 0;
            const name = host.name || (host.member ? "Team" : "Computer");
            const migration = local && profile && directoryHosts.some(h => h.serverId === id) && !boundLocal.includes(id) && !excluded.includes(id);
            const subtitle = [
              id === primary && "Primary host",
              local ? host.member && "Team member" : profileHostSubtitle(host, false, enrolled),
              current && linkLabel(link, route),
              migration && "Profile transfer waiting for this computer",
              local && profile && excluded.includes(id) && "Not linked to this profile",
            ].filter(Boolean).join(" · ");
            return <Row key={id}
              leading={<IconTile icon={host.member ? Users : Monitor} color={host.member ? brand.clay : brand.tide} />}
              title={name} subtitle={subtitle} subtitleLines={2}
              trailing={editing ? <View style={{ flexDirection: "row" }}>
                <IconButton icon={Star} label={(primary === id ? "Unset " : "Set ") + name + " as primary host"} disabled={!enrolled} color={primary === id ? colors.accentText : colors.muted} onPress={() => setPrefs({ primaryHost: primary === id ? null : id })} />
                <IconButton icon={ArrowUp} label={"Move " + name + " up"} disabled={index === 0} onPress={() => setPrefs({ computerOrder: moveComputer(ids, index, -1) })} />
                <IconButton icon={ArrowDown} label={"Move " + name + " down"} disabled={index === ids.length - 1} onPress={() => setPrefs({ computerOrder: moveComputer(ids, index, 1) })} />
              </View> : current ? <View accessible accessibilityLabel="In use"><Check size={18} color={colors.accentText} strokeWidth={2.6} /></View> : undefined}
              chevron={!editing && !current && selectable}
              disabled={!editing && !selectable}
              onPress={editing || current || !selectable ? undefined : () => local ? switchTo(id) : void selectProfileHost(host)}
            />;
          })}
        </Group>
        {hosts.length > 0 && <Button title={editing ? "Done" : "Edit hosts"} variant="secondary" onPress={() => setEditing(!editing)} />}
        {editing && <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          Use the arrows to reorder hosts. Star a connected host to open it when Botkins starts.
        </T>}
      </View>

      <Group>
        <Row leading={<IconTile icon={QrCode} color={brand.tide} />} title="Connect a computer" chevron onPress={addComputer} />
        <Row leading={<IconTile icon={UserPlus} color={brand.clay} />} title="Join a team" chevron onPress={() => router.push("/join")} />
        <Row leading={<IconTile icon={Plus} color={colors.ink2} />} title="Set up a new Botkins" subtitle="Mac, Windows, Linux or Azure" chevron onPress={() => router.push("/setup")} />
      </Group>
    </Page>
  );
}
