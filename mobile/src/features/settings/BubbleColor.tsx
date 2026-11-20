// Your computer's window › Your messages › Bubble color: the color of the person's own messages in
// the app on the computer. It is sent when a color is settled on (the finger lifts, a swatch, a hex).
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { ColorPicker, Loading, Sheet, space, THEMES } from "@/ui";
import { isHexColor } from "./computer";

// The themes' own bubbles, light and dark, as swatches.
const SWATCHES = [...new Set(THEMES.flatMap((theme) => [theme.light.bubble, theme.dark.bubble]))];

export default function BubbleColor() {
  const bubble = useSettings()?.appearance.bubble;
  const [hex, setHex] = useState<string>();
  if (bubble === undefined)
    return (
      <Sheet title="Bubble color">
        <Loading />
      </Sheet>
    );
  const shown = hex ?? (isHexColor(bubble) ? bubble : SWATCHES[0]);
  return (
    <Sheet title="Bubble color" action="Done" onAction={() => router.back()} scroll={false}>
      <View style={{ gap: space.lg }}>
        <ColorPicker label="Bubble color" value={shown} swatches={SWATCHES} onChange={setHex} onCommit={(next) => next.toLowerCase() !== bubble.toLowerCase() && void attempt(api.setPreferences({ appearance: { bubble: next } }))} />
      </View>
    </Sheet>
  );
}
