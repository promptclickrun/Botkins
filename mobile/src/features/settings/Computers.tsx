import { useState } from "react";
import { router } from "expo-router";
import { ArrowDown, ArrowUp, Layers, Star, Check, Monitor, Plus, QrCode, UserPlus, Users } from "lucide-react-native";
import { View } from "react-native";
import { moveComputer, orderedComputers } from "@/state/computers";
import { setUnifiedHostIncluded, setUnifiedHosts } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { useApp } from "@/state/store";
import { selectProfileHost, useProfile, useProfileHosts } from "@/state/profile";
import { Badge, brand, Button, Group, IconButton, IconTile, Label, Page, Row, space, T, useTheme } from "@/ui";
import { addComputer, switchTo } from "@/features/home/computers";
import { linkLabel } from "./shared";
import { profileHostSubtitle } from "@/features/profile/profileLogic";

/**
 * Settings › Computers and teams: unified multi-host toggle (when 2+ computers are paired),
 * every local pairing plus every profile directory host, then ways to add one.
 */
export default function Computers() {
  const { colors } = useTheme();
  const pairings = useApp((state) => state.pairings);
  const unified = useApp((state) => state.unified);
  const unifiedStatuses = useApp((state) => state.unifiedHosts);
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
  const unifiedPref = usePrefs(prefs => prefs.unifiedHosts);
  const excludedUnified = usePrefs(prefs => prefs.excludedUnifiedHosts);
  const [editing, setEditing] = useState(false);
  const hosts = orderedComputers(pairings, directoryHosts, order);
  const ids = hosts.map(host => host.serverId);
  const statusById = new Map(unifiedStatuses.map((h) => [h.id, h]));
  return (
    <Page title="Computers and teams">
      {pairings.length >= 2 && (
        <View>
          <Label>Unified view</Label>
          <Group>
            <Row
              leading={<IconTile icon={Layers} color={brand.fern} />}
              title="Operate all bots in one view"
              subtitle="Bring bots, chats, notifications and approvals from connected computers together."
              subtitleLines={3}
              toggled={unifiedPref}
              onToggle={(next) => setUnifiedHosts(next)}
            />
            {unifiedPref && pairings.map((p) => {
              const status = statusById.get(p.serverId);
              const included = !excludedUnified.includes(p.serverId);
              const stateText = !included
                ? "Excluded from unified view"
                : status?.state === "online"
                  ? "Connected" + (status.bots ? " · " + status.bots + (status.bots === 1 ? " bot" : " bots") : "")
                  : status?.state === "connecting"
                    ? "Connecting…"
                    : "Offline";
              return (
                <Row
                  key={"inc:" + p.serverId}
                  leading={<IconTile icon={p.member ? Users : Monitor} color={p.member ? brand.clay : brand.tide} />}
                  title={p.name || (p.member ? "Team" : "Computer")}
                  subtitle={stateText}
                  toggled={included}
                  onToggle={(next) => setUnifiedHostIncluded(p.serverId, next)}
                />
              );
            })}
          </Group>
        </View>
      )}

      <View style={{ gap: space.sm }}>
        {pairings.length >= 2 && <Label>{unified ? "Focus a single computer" : "Computers"}</Label>}
        <Group>
          {hosts.map((host, index) => {
            const id = host.serverId;
            const local = pairings.some(item => item.serverId === id);
            const current = !unified && id === inUse;
            const pooled = unified && local && !excludedUnified.includes(id);
            const enrolled = local || !!profilePairings[id] || boundLocal.includes(id);
            const selectable = local || host.hosts.length > 0;
            const name = host.name || (host.member ? "Team" : "Computer");
            const migration = local && profile && directoryHosts.some(h => h.serverId === id) && !boundLocal.includes(id) && !excluded.includes(id);
            const hostStatus = statusById.get(id);
            const subtitle = [
              id === primary && "Primary host",
              local ? host.member && "Team member" : profileHostSubtitle(host, false, enrolled),
              current && linkLabel(link, route),
              pooled && (hostStatus?.state === "online" ? "Connected" : hostStatus?.state === "connecting" ? "Connecting…" : "Offline"),
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
              </View> : current ? <View accessible accessibilityLabel="In use"><Check size={18} color={colors.accentText} strokeWidth={2.6} /></View> : pooled ? <Badge label="Included" tone={hostStatus?.state === "online" ? "accent" : "neutral"} /> : undefined}
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
