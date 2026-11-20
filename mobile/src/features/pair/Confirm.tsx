import { router, useLocalSearchParams } from "expo-router";
import { MonitorSmartphone } from "lucide-react-native";
import { View } from "react-native";
import { parsePairingUrl } from "@/link/pairing";
import { useApp } from "@/state/store";
import { Button, EmptyState, IconTile, Sheet, space, T, useTheme } from "@/ui";
import { usePairing } from "./usePairing";

/** A pairing link was opened (the phone's camera read the code). The person confirms before pairing. */
export default function Confirm() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<Record<string, string>>();
  const paired = useApp((state) => state.pairings);
  const { busy, error, start } = usePairing();
  const query = Object.entries(params)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");
  const target = parsePairingUrl("botkins://pair?" + query);
  if (!target)
    return (
      <Sheet title="Pair">
        <EmptyState title="This link isn't a pairing code" text="Show a new code on your computer and scan it." action="Close" onAction={() => router.back()} />
      </Sheet>
    );
  const name = target.name ?? "your computer";
  return (
    <Sheet title="Pair">
      <View style={{ alignItems: "center", gap: space.md, paddingTop: space.sm }}>
        <IconTile icon={MonitorSmartphone} size={64} color={colors.accent} />
        <T variant="title2" center>
          Pair with {name}?
        </T>
        <T variant="subhead" color={error ? "danger" : "muted"} center>
          {error ?? (paired.some((item) => item.serverId === target.serverId) ? "This phone is paired with it already. Pairing again replaces that pairing." : paired.length ? "Your other computers stay paired." : "This phone will be able to use your bots on that computer.")}
        </T>
      </View>
      <View style={{ gap: space.sm }}>
        <Button title="Pair" size="lg" wide loading={busy} onPress={() => void start(target)} />
        <Button title="Not now" variant="ghost" size="lg" wide onPress={() => router.back()} />
      </View>
    </Sheet>
  );
}
