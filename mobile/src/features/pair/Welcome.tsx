import { Image } from "expo-image";
import { type Href, router } from "expo-router";
import { type LucideIcon, Plus, QrCode, Users } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, radius, space, T, Tap, useTheme } from "@/ui";

// How much of the illustration's ground the panel covers, so the bots stand just above it.
const OVERLAP = 96;
const WORDMARK = 208;

/** One of the three ways in: a large card with an icon, what it does, and how. The first is dark. */
function Choice({ icon: Icon, color, title, subtitle, href, primary }: { icon: LucideIcon; color: string; title: string; subtitle: string; href: Href; primary?: boolean }) {
  const { colors } = useTheme();
  const ink = primary ? colors.onPrimary : colors.ink;
  return (
    <Tap
      onPress={() => router.push(href)}
      accessibilityLabel={title + ", " + subtitle}
      style={{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.md + 2, padding: space.lg, borderRadius: radius.lg, backgroundColor: primary ? colors.primary : colors.sunken }}
    >
      <Icon size={24} color={primary ? ink : color} strokeWidth={2.2} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="headline" weight="700" color={ink}>
          {title}
        </T>
        <T variant="footnote" color={primary ? ink : "muted"} style={primary ? { opacity: 0.8 } : undefined}>
          {subtitle}
        </T>
      </View>
    </Tap>
  );
}

export default function Welcome() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [panel, setPanel] = useState(0);
  const art = Math.min(width, 560);
  // The panel may grow up to just under the wordmark; past that (a small phone, large text) it scrolls.
  const top = insets.top + space.xxl + WORDMARK * (421 / 1400) + space.lg;
  return (
    <View style={{ flex: 1, backgroundColor: brand.peach }}>
      {panel > 0 && (
        <Animated.View entering={FadeIn.duration(500)} style={{ position: "absolute", bottom: panel - OVERLAP, left: (width - art) / 2 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Image source={require("../../../assets/images/welcome.jpg")} style={{ width: art, height: art * 1.5 }} contentFit="cover" />
        </Animated.View>
      )}
      <Animated.View entering={FadeInDown.delay(150).duration(500)} style={{ marginTop: insets.top + space.xxl, alignItems: "center" }}>
        <Image source={require("../../../assets/images/wordmark.png")} style={{ width: WORDMARK, height: WORDMARK * (421 / 1400) }} contentFit="contain" accessibilityLabel="Botkins" />
      </Animated.View>
      <View
        onLayout={(event) => setPanel(event.nativeEvent.layout.height)}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: height - top, backgroundColor: colors.canvas, borderTopLeftRadius: 34, borderTopRightRadius: 34, overflow: "hidden" }}
      >
        <ScrollView
          bounces={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ width: "100%", maxWidth: 560, alignSelf: "center", paddingTop: space.huge - 2, paddingHorizontal: space.xl, paddingBottom: insets.bottom + space.lg, gap: space.md }}
        >
          <T variant="title1" center accessibilityRole="header" style={{ marginBottom: space.xs }}>
            Your bots, in your pocket
          </T>
          <Choice icon={QrCode} color={brand.tide} title="Connect to my computer" subtitle="Scan the code, or type it in" href="/pair/scan" primary />
          <Choice icon={Users} color={brand.clay} title="Join a team" subtitle="With the invite code from its owner" href="/join" />
          <Choice icon={Plus} color={brand.tide} title="Set up a new Botkins" subtitle="On your Mac or PC, or a server on Azure" href="/setup" />
        </ScrollView>
      </View>
    </View>
  );
}
