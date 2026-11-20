import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { HtmlFrame, useTheme } from "@/ui";

/** A custom view on the whole screen, where its page scrolls and zooms by itself. */
export default function FrameScreen() {
  const { frame, title } = useLocalSearchParams<{ frame: string; title?: string }>();
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen options={{ headerTitle: title || "View" }} />
      <HtmlFrame frame={frame} height={480} title={title || undefined} fill />
    </View>
  );
}
