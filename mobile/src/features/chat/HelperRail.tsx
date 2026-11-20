// The helpers of the chat's newest turn, above the composer (the desktop app's "In the background"
// chip): how many are running, then one chip per helper with its state. A tap opens that helper's
// activity. It stays while the turn's helpers are there, finished ones too, as on the desktop.
import { type Href, router } from "expo-router";
import { Users } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import type { Run } from "@/link/types";
import { Chip, space, T, useTheme } from "@/ui";
import { StepMark } from "./bits";
import { railLabel } from "./helpers";

/** The helper's activity sheet. (Typed routes are made when Metro starts; this one is cast until then.) */
export const helperSheet = (chatId: string, runId: string, helperId: string) => ({ pathname: "/chat/helper", params: { chatId, runId, helperId } }) as unknown as Href;

export function HelperRail({ chatId, run }: { chatId: string; run: Run }) {
  const { colors } = useTheme();
  const agents = run.agents ?? [];
  if (!agents.length) return null;
  const label = railLabel(agents);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, alignItems: "center" }} accessibilityLabel="Background helpers">
      <View accessible accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: space.xs }}>
        <Users size={14} color={colors.muted} strokeWidth={2.2} />
        <T variant="footnote" weight="600" color="muted" numberOfLines={1}>
          {label}
        </T>
      </View>
      {agents.map((agent) => (
        <Chip key={agent.id} label={agent.name} leading={<StepMark status={agent.status} size={14} />} onPress={() => router.push(helperSheet(chatId, run.id, agent.id))} />
      ))}
    </ScrollView>
  );
}
