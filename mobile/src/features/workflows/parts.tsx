// Small pieces the workflow designer's sheets share: step icons, option chips, and text fields that take {{field}} chips.
import { Bot, Clock, GitBranch, GitPullRequest, Hand, ListChecks, MessageSquareText, Repeat, Send, ShieldCheck, Sparkles, Webhook, type LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import type { WorkflowNode, WorkflowTriggerKind } from "@/link/types";
import { Chip, Field, haptic, T, Tap, radius, space, useTheme } from "@/ui";
import type { AvailableField } from "./fields";

export const TRIGGER_ICON: Record<WorkflowTriggerKind, LucideIcon> = {
  manual: Hand,
  schedule: Clock,
  task: ListChecks,
  chat: MessageSquareText,
  routine: Repeat,
  webhook: Webhook,
  github: GitPullRequest,
};
const STEP_ICON: Record<Exclude<WorkflowNode["kind"], "trigger">, LucideIcon> = {
  agent: Bot,
  model: Sparkles,
  condition: GitBranch,
  approval: ShieldCheck,
  output: Send,
};
export function iconFor(node: Pick<WorkflowNode, "kind" | "triggerKind">): LucideIcon {
  return node.kind === "trigger" ? TRIGGER_ICON[node.triggerKind ?? "manual"] : STEP_ICON[node.kind];
}

/** Each kind keeps one color in the flow and on the canvas. */
export function useKindColor() {
  const { colors } = useTheme();
  return (kind: WorkflowNode["kind"]) =>
    kind === "trigger" ? colors.accent : kind === "agent" ? colors.info : kind === "model" ? colors.primary : kind === "condition" ? colors.warning : kind === "approval" ? colors.danger : colors.success;
}

/** A row of chips that picks one value (or several with `multi`). */
export function Choice<V extends string>({ label, options, value, onChange, multi }: { label?: string; options: { value: V; label: string }[]; value: V | V[] | undefined; onChange: (next: any) => void; multi?: boolean }) {
  const chosen = new Set(Array.isArray(value) ? value : value !== undefined ? [value] : []);
  return (
    <View style={{ gap: space.sm }}>
      {!!label && (
        <T variant="footnote" color="muted" weight="600">
          {label}
        </T>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {options.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            selected={chosen.has(o.value)}
            onPress={() => {
              haptic.select();
              if (!multi) return onChange(o.value);
              const next = new Set(chosen);
              if (next.has(o.value)) next.delete(o.value);
              else next.add(o.value);
              onChange(options.map((x) => x.value).filter((v) => next.has(v)));
            }}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * A text field for a prompt or message, with the fields earlier steps give as chips under it.
 * Tapping a chip puts {{name}} where the cursor is. A token no earlier step gives is named under the field.
 */
export function TemplateField({ label, value, onChange, fields, problems, placeholder, area = true }: { label: string; value: string; onChange: (next: string) => void; fields: AvailableField[]; problems?: string[]; placeholder?: string; area?: boolean }) {
  const { colors } = useTheme();
  const [cursor, setCursor] = useState<number | null>(null);
  const insert = (name: string) => {
    haptic.select();
    const at = cursor ?? value.length;
    const token = `{{${name}}}`;
    onChange(value.slice(0, at) + token + value.slice(at));
    setCursor(at + token.length);
  };
  const unique = [...new Map(fields.map((f) => [f.name, f])).values()];
  return (
    <View style={{ gap: space.sm }}>
      <Field
        label={label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        area={area}
        autoCapitalize="sentences"
        onSelectionChange={(e) => setCursor(e.nativeEvent.selection.start)}
        error={problems?.length ? `No earlier step gives ${problems.map((p) => `{{${p}}}`).join(", ")}.` : undefined}
      />
      {unique.length > 0 && (
        <View style={{ gap: space.xs }}>
          <T variant="caption" color="muted">
            Insert a field
          </T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: space.sm }}>
            {unique.map((f) => (
              <Tap
                key={f.name}
                onPress={() => insert(f.name)}
                accessibilityRole="button"
                accessibilityLabel={`Insert ${f.name}, from ${f.sourceLabel}`}
                style={{ paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: f.guaranteed ? colors.accentSoft : colors.warningSoft }}
              >
                <T variant="footnote" weight="600" color={f.guaranteed ? "accentText" : "warning"} style={{ fontFamily: undefined }}>
                  {`{{${f.name}}}`}
                </T>
              </Tap>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}
