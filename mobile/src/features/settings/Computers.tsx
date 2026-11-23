import { router } from "expo-router";
import { Check, Monitor, Plus, QrCode, UserPlus, Users } from "lucide-react-native";
import { View } from "react-native";
import { useApp } from "@/state/store";
import { brand, Group, IconTile, Page, Row, space, T, useTheme } from "@/ui";
import { addComputer, switchTo } from "@/features/home/computers";
import { linkLabel } from "./shared";

/**
 * Settings › Computers and teams: every computer and team this phone is paired with, the one in use
 * ticked (a tap on another uses it), then the ways to add one. The one in use has its own page
 * (Settings › its name).
 */
export default function Computers() {
  const { colors } = useTheme();
  const pairings = useApp((state) => state.pairings);
  const inUse = useApp((state) => state.pairing?.serverId);
  const link = useApp((state) => state.link);
  const route = useApp((state) => state.route);
  return (
    <Page title="Computers and teams">
      <View style={{ gap: space.sm }}>
        <Group>
          {pairings.map((item) => {
            const current = item.serverId === inUse;
            const subtitle = [item.member ? "Team member" : undefined, current ? linkLabel(link, route) : undefined].filter(Boolean).join(" · ");
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
        </Group>
        {pairings.length > 1 && (
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
