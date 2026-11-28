// What shows in place of the app when a screen throws while it draws: what went wrong, and a way
// back in. Before this there was nothing to catch such an error, and the app closed. It is drawn
// with the phone's own parts only (no gestures, no glass, no stores but the theme), because it may
// be standing in for the very things the rest of the app is built on.
import * as Clipboard from "expo-clipboard";
import type { ErrorBoundaryProps } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { crashNote, crashText } from "@/state/crashNote";
import { keepCrash } from "@/state/lastCrash";
import { radius, space, useTheme } from "@/ui";

export function Failed({ error, retry }: ErrorBoundaryProps) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  // Kept on the phone too, so Settings › About can show it after the app is opened again.
  useEffect(() => keepCrash(error, "screen"), [error]);
  const note = crashNote(error, "screen", Date.now());
  const button = { minHeight: 50, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xl } as const;
  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: space.xxl, gap: space.lg }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 24, fontWeight: "700" }}>
          This screen couldn&apos;t be shown
        </Text>
        <Text style={{ color: colors.muted, fontSize: 16, lineHeight: 22 }}>Something in the app failed while drawing it. Your chats and bots are on your computer and are not affected.</Text>
        <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
          <Text selectable style={{ color: colors.ink, fontSize: 14, lineHeight: 20 }}>
            {note.message}
          </Text>
          {!!note.stack && (
            <Text selectable numberOfLines={8} style={{ color: colors.faint, fontSize: 12, lineHeight: 16 }}>
              {note.stack}
            </Text>
          )}
        </View>
        <Pressable accessibilityRole="button" onPress={() => void retry()} style={({ pressed }) => [button, { backgroundColor: colors.ink, opacity: pressed ? 0.7 : 1 }]}>
          <Text style={{ color: colors.canvas, fontSize: 16, fontWeight: "600" }}>Try again</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void Clipboard.setStringAsync(crashText(note)).then(() => setCopied(true), () => {})}
          style={({ pressed }) => [button, { borderWidth: 1, borderColor: colors.lineStrong, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={{ color: colors.ink, fontSize: 16, fontWeight: "600" }}>{copied ? "Copied" : "Copy details"}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
