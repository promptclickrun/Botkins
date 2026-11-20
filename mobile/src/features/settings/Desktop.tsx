import { router } from "expo-router";
import { Check, Eraser, HardDrive, LogIn, Monitor, MonitorCog, Plus, QrCode, RefreshCw, SquareSlash, Unplug, Users } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { isRelayHost } from "@/link/relay";
import { useCapability, useOnline, usePart, useSettings } from "@/state/hooks";
import { api, attempt, unpair, wake } from "@/state/link";
import { useApp } from "@/state/store";
import { Badge, brand, Button, Group, IconTile, Label, Mascot, Page, radius, Row, space, T, tint, useTheme } from "@/ui";
import { addComputer, switchTo } from "@/features/home/computers";
import { ScreenAccess } from "@/features/remote/ScreenAccess";
import { AppUpdates } from "./AppUpdates";
import { megabytes } from "./computer";
import { Devices } from "./Devices";
import { capitalize, InfoRow, LINK_STATUS, linkLabel, useHeld } from "./shared";

/**
 * Settings › General › Background on the computer: keep running with the window closed, and start
 * with the computer. These change the app on the computer only, never this phone; the words say so,
 * because a person read them as the phone's own and turned them off to save the phone's battery.
 */
function Background({ name }: { name: string }) {
  const { colors } = useTheme();
  const online = useOnline();
  const [background, hold] = useHeld(useSettings()?.background);
  // An older computer has no such setting.
  if (!background) return null;
  // The computer puts a choice back when the system refuses it, and says why; the switch then shows what it kept.
  const set = (patch: Partial<typeof background>) => void hold(patch, () => api.setPreferences({ background: { ...background, ...patch } }));
  return (
    <View>
      <Label>{"Botkins on " + name}</Label>
      <Group>
        <Row leading={<IconTile icon={MonitorCog} color={colors.ink2} />} title="Keep running with its window closed" titleLines={2} subtitle="Routines keep running, and your phones can reach it" subtitleLines={2} toggled={background.keepRunning} disabled={!online} onToggle={(keepRunning) => set({ keepRunning })} />
        <Row leading={<IconTile icon={LogIn} color={colors.ink2} />} title="Start when the computer starts" titleLines={2} subtitle="Opens quietly when you sign in to it" subtitleLines={2} toggled={background.runAtStartup} disabled={!online} onToggle={(runAtStartup) => set({ runAtStartup })} />
      </Group>
      <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, paddingTop: space.sm }}>
        These change the app on your computer, not on this phone.
      </T>
    </View>
  );
}

/** Settings › Storage on the computer: its workspace cache, and clearing it. */
function Storage() {
  const { colors } = useTheme();
  const online = useOnline();
  const canClear = useCapability("maintenance-v1");
  const [cache, setCache] = useState<{ bytes: number; catalogs: number }>();
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (!online) return;
    let live = true;
    void api.cacheInfo().then((info) => live && setCache(info), () => {});
    return () => {
      live = false;
    };
  }, [online]);
  if (!cache) return null;
  const clear = async () => {
    setClearing(true);
    await attempt(api.clearCache(), "Cache cleared.");
    // The numbers are the computer's: read them again instead of guessing zero.
    await api.cacheInfo().then(setCache, () => {});
    setClearing(false);
  };
  return (
    <View>
      <Label>Storage</Label>
      <Group>
        <Row leading={<IconTile icon={HardDrive} color={colors.ink2} />} title="Browser cache" value={megabytes(cache.bytes)} />
        <Row leading={<IconTile icon={SquareSlash} color={colors.ink2} />} title="Saved capability menus" subtitle="So “/” opens fast" value={String(cache.catalogs)} />
        <Row
          leading={<IconTile icon={Eraser} color={colors.ink2} />}
          title="Clear cache"
          subtitle={canClear ? "Keeps your chats, bots, panels and routines" : "Update the app on your computer"}
          subtitleLines={2}
          disabled={!canClear || !online || clearing}
          onPress={() => void clear()}
        />
      </Group>
    </View>
  );
}

/** Every computer this phone is paired with. The phone uses one at a time: a tap on another switches to it. */
function Computers() {
  const { colors } = useTheme();
  const computers = useApp((state) => state.pairings);
  const inUse = useApp((state) => state.pairing?.serverId);
  return (
    <View>
      <Label>Computers</Label>
      <Group>
        {computers.map((item) => {
          const current = item.serverId === inUse;
          return (
            <Row
              key={item.serverId}
              leading={<IconTile icon={Monitor} color={colors.ink2} />}
              title={item.name || "Computer"}
              subtitle={current ? "In use" : undefined}
              trailing={current ? <Check size={18} color={colors.accentText} strokeWidth={2.6} /> : undefined}
              onPress={current ? undefined : () => switchTo(item.serverId)}
            />
          );
        })}
        <Row leading={<IconTile icon={Plus} />} title="Add a computer" tone="accent" chevron onPress={addComputer} />
        <Row leading={<IconTile icon={Users} />} title="Join a team with a code" tone="accent" chevron onPress={() => router.push("/join")} />
      </Group>
    </View>
  );
}

/** The computer in use: whether it can be reached, what it runs, the other paired computers, and how to let go of it. */
export default function Desktop() {
  const theme = useTheme();
  const { colors } = theme;
  const pairing = useApp((state) => state.pairing);
  const link = useApp((state) => state.link);
  const route = useApp((state) => state.route);
  const meta = usePart("meta");
  const member = meta?.you?.kind === "member";
  const teamPart = usePart("team");
  const teamName = teamPart && "me" in teamPart ? teamPart.team.name : undefined;
  const name = pairing?.name ?? "Your computer";
  const others = useApp((state) => state.pairings.length > 1);
  const status = LINK_STATUS[link];
  // The relay entry is not an address a person reads: it shows as one row, "Away from home".
  const hosts = pairing?.hosts.filter((host) => !isRelayHost(host)).slice(0, 3) ?? [];
  const awayFromHome = !!pairing?.hosts.some(isRelayHost);
  const label = linkLabel(link, route);

  const confirmUnpair = () =>
    Alert.alert(member ? "Leave this team?" : "Unpair from " + name + "?", member ? "This phone will be disconnected from the team." : others ? "Your other computers stay paired." : undefined, [
      { text: "Cancel", style: "cancel" },
      { text: member ? "Leave" : "Unpair", style: "destructive", onPress: () => void unpair() },
    ]);

  return (
    <Page>
      <View style={{ alignItems: "center", gap: space.md }}>
        <View style={{ alignSelf: "stretch", height: 168, borderRadius: radius.xl, backgroundColor: tint(brand.tide, theme.dark ? 0.2 : 0.14), alignItems: "center", justifyContent: "center" }}>
          <Mascot size={124} state={status.mascot} />
        </View>
        <T variant="title1" center accessibilityRole="header" numberOfLines={2}>
          {name}
        </T>
        <View style={{ alignItems: "center" }} accessible accessibilityLabel={"Status: " + label}>
          <Badge label={label} tone={status.tone} />
        </View>
      </View>

      {link === "offline" && <Button title="Try again" icon={RefreshCw} size="lg" wide onPress={wake} />}
      {link === "revoked" && (
        <View style={{ gap: space.md }}>
          <T variant="subhead" color="muted" center>
            This phone was removed on your computer.
          </T>
          <Button title="Pair again" icon={QrCode} size="lg" wide onPress={() => router.push("/pair/scan")} />
        </View>
      )}

      <Computers />

      {(meta || hosts.length > 0 || awayFromHome) && (
        <Group>
          {meta && (
            <InfoRow title="App">
              <T variant="callout" weight="500">
                {capitalize(meta.app) + " " + meta.version}
              </T>
            </InfoRow>
          )}
          {hosts.length > 0 && (
            <InfoRow title={hosts.length === 1 ? "Address" : "Addresses"}>
              {hosts.map((host) => (
                <T key={host} variant="mono" color="ink2" numberOfLines={1} selectable>
                  {host}
                </T>
              ))}
            </InfoRow>
          )}
          {awayFromHome && (
            <InfoRow title="Away from home">
              <T variant="callout" weight="500">
                On
              </T>
            </InfoRow>
          )}
        </Group>
      )}

      {/* Keyed by the computer: after a switch, nothing of the last computer's update shows. */}
      {!member && <AppUpdates key={pairing?.serverId} name={name} />}

      {!member && <ScreenAccess />}

      {!member && <Devices />}

      {!member && <Background name={name} />}

      {!member && <Storage />}

      <Group>
        <Row leading={<IconTile icon={Unplug} color={colors.danger} />} title={member ? "Leave " + (teamName ?? "team") : "Unpair from " + name} titleLines={2} tone="danger" onPress={confirmUnpair} />
      </Group>
    </Page>
  );
}
