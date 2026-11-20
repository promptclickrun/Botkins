// The logo of an app from the Marketplace. Composio serves these (most as SVG); a logo that is
// missing or doesn't load becomes a letter on a soft tile, so a list never shows a broken image.
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import { T } from "./Text";
import { useTheme } from "./theme";

const HUES = ["#E5484D", "#EF6F2E", "#F0A030", "#58C47A", "#14B8A6", "#4FA8F0", "#5B5FE6", "#8B5CF6", "#C847E0", "#E8459A"];
const hueFor = (name: string) => HUES[[...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % HUES.length];

export function AppLogo({ name, uri, size = 44 }: { name: string; uri?: string | null; size?: number }) {
  const { colors, dark } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const corner = Math.round(size * 0.24);
  const usable = uri && /^https:\/\//.test(uri) && failed !== uri;
  if (!usable) {
    const hue = hueFor(name);
    return (
      <View style={{ width: size, height: size, borderRadius: corner, backgroundColor: hue + (dark ? "38" : "24"), alignItems: "center", justifyContent: "center" }} accessibilityElementsHidden>
        <T weight="700" color={hue} style={{ fontSize: size * 0.42, lineHeight: size * 0.52 }} maxFontSizeMultiplier={1}>
          {name.trim().charAt(0).toUpperCase() || "?"}
        </T>
      </View>
    );
  }
  // Logos are drawn for a light page, so they sit on a white plate in both themes.
  return (
    <View style={{ width: size, height: size, borderRadius: corner, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: dark ? "transparent" : colors.line, alignItems: "center", justifyContent: "center", overflow: "hidden" }} accessibilityElementsHidden>
      <Image source={{ uri }} style={{ width: size * 0.68, height: size * 0.68 }} contentFit="contain" cachePolicy="disk" transition={120} recyclingKey={uri} onError={() => setFailed(uri)} />
    </View>
  );
}
