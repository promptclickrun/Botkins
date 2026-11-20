// The context meter in a chat's header: a ring that fills with the share of the window in use,
// tinted by how full it is, and the percent. A tap opens the context sheet.
import { router } from "expo-router";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { ChatContext } from "@/link/types";
import { T, Tap, useTheme } from "@/ui";
import { contextPercent, contextTone } from "./contextMath";

export function ContextMeter({ chatId, context }: { chatId: string; context: ChatContext }) {
  const { colors } = useTheme();
  const percent = contextPercent(context);
  const tone = contextTone(percent);
  const size = 18;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <Tap
      onPress={() => router.push({ pathname: "/chat/context", params: { id: chatId } })}
      feel="select"
      sink={0.9}
      testID="chat-context"
      accessibilityRole="button"
      accessibilityLabel={"Context " + percent + "% used"}
      accessibilityHint="Shows what fills the context window"
      style={{ minWidth: 44, height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 2 }}
    >
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none" />
        {percent > 0 && (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colors[tone]}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={length}
            strokeDashoffset={length * (1 - Math.max(0.04, percent / 100))}
            transform={"rotate(-90 " + size / 2 + " " + size / 2 + ")"}
          />
        )}
      </Svg>
      <View>
        <T variant="caption" color={tone === "success" ? "muted" : tone} maxFontSizeMultiplier={1.2}>
          {percent + "%"}
        </T>
      </View>
    </Tap>
  );
}
