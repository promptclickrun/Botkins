// The bot's work drawn on the chat itself, the way T3 Code draws it: no card and no border. A step
// is one quiet row with an icon for its kind ("Read auth/session.ts"). The step running now is in
// ink, a failed one has its icon and a small X in the danger color. Nothing here moves (no spinner,
// no shimmer): the owner's battery rule. The bot's thinking and its updates are in Aside.tsx.
import { Ban, Bot, Eye, FilePlus, Globe, LayoutTemplate, ListTodo, type LucideIcon, MessageCircleQuestionMark, PanelsTopLeft, Plug, Search, Sparkles, SquarePen, SquareTerminal, Wrench, X } from "lucide-react-native";
import { View } from "react-native";
import type { Step } from "@/link/types";
import { T, useTheme } from "@/ui";
import { stepKind, stepLabel } from "./turn";

const ICONS: Record<string, LucideIcon> = {
  command: SquareTerminal,
  read: Eye,
  write: FilePlus,
  edit: SquarePen,
  "search-files": Search,
  web: Globe,
  "web-page": Globe,
  ask: MessageCircleQuestionMark,
  helper: Bot,
  plan: ListTodo,
  skill: Sparkles,
  card: LayoutTemplate,
  panel: PanelsTopLeft,
};

/** The icon for a step: a server's tool is a plug, a kind without its own icon a wrench. */
export function stepIcon(step: Pick<Step, "name" | "source">): LucideIcon {
  return step.source ? Plug : (ICONS[stepKind(step)] ?? Wrench);
}

/** A step's row height. */
export const STEP_ROW = 28;
/** A small face and its gap: what steps and text under a face are indented by (Aside.tsx). */
export const FACE = 22;
export const FACE_INDENT = FACE + 8;

/** One step as a quiet row. The press belongs to whatever holds the rows. */
export function StepRow({ step }: { step: Step }) {
  const { colors } = useTheme();
  const Icon = stepIcon(step);
  const label = stepLabel(step);
  const running = step.status === "Running";
  const failed = step.status === "Failed";
  return (
    <View accessible accessibilityLabel={label + ", " + step.status.toLowerCase()} style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: STEP_ROW }}>
      <View style={{ width: 20, alignItems: "center" }}>
        <Icon size={14} color={failed ? colors.danger : running ? colors.ink : colors.muted} strokeWidth={2.2} />
      </View>
      <T variant="subhead" color={running ? "ink" : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </T>
      {failed && <X size={12} color={colors.danger} strokeWidth={2.6} />}
      {step.status === "Stopped" && <Ban size={12} color={colors.faint} strokeWidth={2.4} />}
    </View>
  );
}

/** The kind most of these steps are, for a line that stands for them all ("Ran 3 commands"). */
export function mostIcon(steps: Step[]): LucideIcon {
  const counts = new Map<string, { n: number; step: Step }>();
  for (const step of steps) {
    const key = step.source ? "source" : stepKind(step);
    const held = counts.get(key);
    counts.set(key, { n: (held?.n ?? 0) + 1, step: held?.step ?? step });
  }
  let best: { n: number; step: Step } | undefined;
  for (const value of counts.values()) if (!best || value.n > best.n) best = value;
  return best ? stepIcon(best.step) : Wrench;
}
