// The pictures of the Market: an app's brand mark (its Simple Icons glyph on a tile that reads in
// light and dark, or a letter on a gradient when it has none) and the soft art band behind a bot.
import { LinearGradient } from "expo-linear-gradient";
import { memo } from "react";
import { View, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { APP_ICONS } from "@/data/appIcons.generated";
import { colorsOf, lookOf } from "@/data/botLook";
import { brandOf, letterStyle, markStyle, tint, wash } from "@/data/marketColors";
import type { BotkinLook } from "@/link/types";
import { BotAvatar, T, useTheme } from "@/ui";

/** How much of a tile its glyph fills, and how round its corners are (of its size). */
const GLYPH = 0.56;
const CORNER = 0.24;

/** The official color of an app's brand, or a hue hashed from its name. */
export const brandColor = (id: string, name: string) => brandOf(name, APP_ICONS[id]?.hex);

/** An app's mark: the brand glyph on its tile, or its first letter on a tinted gradient. Never animated. */
export const BrandIcon = memo(function BrandIcon({ id, name, size = 48 }: { id: string; name: string; size?: number }) {
  const { dark } = useTheme();
  const icon = APP_ICONS[id];
  const corner = Math.round(size * CORNER);
  if (icon) {
    const mark = markStyle(icon.hex);
    return (
      <View style={{ width: size, height: size, borderRadius: corner, backgroundColor: mark.tile, alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={size * GLYPH} height={size * GLYPH} viewBox="0 0 24 24">
          <Path d={icon.path} fill={mark.glyph} />
        </Svg>
      </View>
    );
  }
  const letter = letterStyle(name, dark);
  return (
    <LinearGradient colors={[letter.from, letter.to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: size, height: size, borderRadius: corner, alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden>
      <T weight="700" color={letter.letter} style={{ fontSize: size * 0.44, lineHeight: size * 0.54 }} maxFontSizeMultiplier={1}>
        {name.trim().charAt(0).toUpperCase() || "?"}
      </T>
    </LinearGradient>
  );
});

/** A flat tint of an app's brand color over the card, for the card's own background. */
export function useBrandTint(id: string, name: string) {
  const { colors, dark } = useTheme();
  return tint(brandColor(id, name), colors.surface, dark);
}

/** A bot's wash: two soft stops tinted from its look's shell and accent. */
export function useBotWash(look: BotkinLook | undefined, id: string): [string, string] {
  const { colors, dark } = useTheme();
  const [shell, accent] = colorsOf(lookOf({ id, look }));
  return wash([shell, accent], colors.surface, dark);
}

/** The art band of a bot: a soft diagonal gradient with its Botkin still in the middle. */
export const BotArt = memo(function BotArt({ id, look, height, avatar, style }: { id: string; look?: BotkinLook; height: number; avatar: number; style?: ViewStyle }) {
  const stops = useBotWash(look, id);
  return (
    <LinearGradient colors={stops} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ height, alignItems: "center", justifyContent: "center" }, style]}>
      <BotAvatar bot={{ id, look }} size={avatar} />
    </LinearGradient>
  );
});
