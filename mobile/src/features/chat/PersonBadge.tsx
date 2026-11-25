// A person's round badge ("people-avatars-v1"): their picture, else the owner's cloud-profile emoji,
// else their initial on their accent color. The same badge beside a message and inside an "@Name" tag.
import { Image } from "expo-image";
import { memo } from "react";
import { Text, View } from "react-native";
import { tint, useTheme } from "@/ui";
import { accentOf, initialOf, type PersonLook } from "./personLook";

export const PersonBadge = memo(function PersonBadge({ person, size = 26 }: { person: PersonLook; size?: number }) {
  const { dark, colors } = useTheme();
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (person.avatar)
    return <Image source={{ uri: person.avatar }} style={round} contentFit="cover" cachePolicy="memory" recyclingKey={person.id} accessibilityIgnoresInvertColors accessible={false} />;
  const accent = accentOf(person.id, dark);
  // As the desktop app draws it: the person's color, faint, on the page's surface, with a thin ring and the letter in that color.
  return (
    <View accessible={false} style={[round, { backgroundColor: colors.surface, overflow: "hidden" }]}>
      <View style={[round, { alignItems: "center", justifyContent: "center", backgroundColor: tint(accent, 0.18), borderWidth: 1, borderColor: tint(accent, 0.3) }]}>
        <Text allowFontScaling={false} style={{ fontSize: Math.round(size * (person.emoji ? 0.6 : 0.48)), lineHeight: Math.round(size * (person.emoji ? 0.78 : 0.6)), fontWeight: "600", color: accent, textAlign: "center" }}>
          {person.emoji ?? initialOf(person.name)}
        </Text>
      </View>
    </View>
  );
});
