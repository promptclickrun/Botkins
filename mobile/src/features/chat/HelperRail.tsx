// The helpers of the chat's newest turn, above the composer (the desktop app's "In the background"
// chip): how many are running, then one chip per helper with its state, and one per background
// command still running. A tap opens that helper's or command's sheet. It stays while the turn's
// helpers are there, finished ones too, as on the desktop. Everything on it holds still.
import { type Href, router } from "expo-router";
import { Users } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import type { Run } from "@/link/types";
import { Chip, space, T, useTheme } from "@/ui";
import { parseStepInput } from "./activityModel";
import { StepMark } from "./bits";
import { railLabel, runningCommands } from "./helpers";

/** The helper's activity sheet. (Typed routes are made when Metro starts; this one is cast until then.) */
export const helperSheet = (chatId: string, runId: string, helperId: string) => ({ pathname: "/chat/helper", params: { chatId, runId, helperId } }) as unknown as Href;
/** A background command's sheet. */
export const commandSheet = (chatId: string, runId: string, stepId: string) => ({ pathname: "/chat/command", params: { chatId, runId, stepId } }) as unknown as Href;

/** Whether the rail has anything to show for this turn. */
export const railShown = (run: Run | undefined) => !!run && (!!run.agents?.length || runningCommands(run.steps).length > 0);

export function HelperRail({ chatId, run }: { chatId: string; run: Run }) {
  const { colors } = useTheme();
  const agents = run.agents ?? [];
  const commands = runningCommands(run.steps);
  if (!agents.length && !commands.length) return null;
  const label = railLabel(agents, commands.length);
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
      {commands.map((step) => {
        const name = parseStepInput(step).command?.split("\n")[0]?.trim() || step.label || step.name;
        return <Chip key={step.id} label={name} accessibilityLabel={name + ", running, show output"} leading={<StepMark status={step.status} size={14} />} onPress={() => router.push(commandSheet(chatId, run.id, step.id))} />;
      })}
    </ScrollView>
  );
}
