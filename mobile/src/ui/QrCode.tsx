import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { qrPath } from "./qr";
import { radius } from "./theme";

/**
 * A QR code of `text`, dark on its own white square whatever the theme, so a camera reads it in
 * light and dark. `label` is what VoiceOver says for it.
 */
export function QrCode({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const code = qrPath(text, { margin: 3, level: "M" });
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size, borderRadius: radius.md, overflow: "hidden", backgroundColor: "#FFFFFF" }}>
      <Svg width={size} height={size} viewBox={"0 0 " + code.size + " " + code.size}>
        <Path d={code.d} fill="#1A1420" />
      </Svg>
    </View>
  );
}
