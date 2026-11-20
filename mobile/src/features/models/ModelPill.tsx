// A compact model and thinking level, for a chat's composer or a header. Tap to change it.
import { ChevronDown } from "lucide-react-native";
import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import type { ModelChoice } from "@/link/types";
import { useModels } from "@/state/hooks";
import { ProviderIcon, radius, T, Tap, useTheme } from "@/ui";
import { describeChoice, shortName, useDefaultProvider } from "./shared";

export type ModelPillProps = { choice?: ModelChoice; onPress?: () => void; style?: StyleProp<ViewStyle> };

export function ModelPill({ choice, onPress, style }: ModelPillProps) {
  const { colors } = useTheme();
  const models = useModels();
  const defaultProvider = useDefaultProvider();
  const shown = describeChoice(choice, models, defaultProvider);
  const name = choice ? shortName(shown.name, shown.provider, models) : "Default model";
  return (
    <Tap
      onPress={onPress}
      feel="select"
      sink={0.95}
      hitSlop={8}
      accessibilityLabel={"Model, " + shown.name + (shown.effort ? ", thinking " + shown.effort : "")}
      accessibilityHint="Changes the model"
      style={[{ height: 32, maxWidth: 260, paddingLeft: 10, paddingRight: 9, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }, style]}
    >
      {!!shown.provider && <ProviderIcon provider={shown.provider} name={shown.providerLabel} size={15} />}
      <T variant="footnote" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
        {name}
      </T>
      {!!shown.effort && (
        <T variant="footnote" color="muted" numberOfLines={1}>
          {shown.effort}
        </T>
      )}
      <ChevronDown size={14} color={colors.muted} strokeWidth={2.4} />
    </Tap>
  );
}

export default ModelPill;
