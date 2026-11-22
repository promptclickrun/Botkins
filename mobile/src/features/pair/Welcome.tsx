import { Image } from "expo-image";
import { router } from "expo-router";
import { Keyboard, QrCode, Users } from "lucide-react-native";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, Button, space, T, useTheme } from "@/ui";

// How much of the illustration's ground the panel covers, so the bots stand just above it.
const OVERLAP = 96;

export default function Welcome() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [panel, setPanel] = useState(0);
  const art = Math.min(width, 560);
  return (
    <View style={{ flex: 1, backgroundColor: brand.peach }}>
      {panel > 0 && (
        <Animated.View entering={FadeIn.duration(500)} style={{ position: "absolute", bottom: panel - OVERLAP, left: (width - art) / 2 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Image source={require("../../../assets/images/welcome.jpg")} style={{ width: art, height: art * 1.5 }} contentFit="cover" />
        </Animated.View>
      )}
      <Animated.View entering={FadeInDown.delay(150).duration(500)} style={{ marginTop: insets.top + space.xxl, alignItems: "center" }}>
        <Image source={require("../../../assets/images/wordmark.png")} style={{ width: 208, height: 208 * (421 / 1400) }} contentFit="contain" accessibilityLabel="Botkins" />
      </Animated.View>
      <View
        onLayout={(event) => setPanel(event.nativeEvent.layout.height)}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.canvas, borderTopLeftRadius: 34, borderTopRightRadius: 34, paddingTop: space.huge, paddingHorizontal: space.xxl, paddingBottom: insets.bottom + space.lg, gap: space.md }}
      >
        <T variant="display" center accessibilityRole="header">
          Your bots,{"\n"}in your pocket
        </T>
        <T variant="callout" color="muted" center style={{ marginBottom: space.md }}>
          Pair with your computer to chat with your bots and run everything they do.
        </T>
        <Button title="Scan pairing code" icon={QrCode} size="lg" wide onPress={() => router.push("/pair/scan")} />
        <Button title="Enter a code instead" icon={Keyboard} variant="ghost" size="lg" wide onPress={() => router.push("/pair/manual")} />
        <Button title="Join a team with a code" icon={Users} variant="ghost" size="lg" wide onPress={() => router.push("/join")} />
      </View>
    </View>
  );
}
