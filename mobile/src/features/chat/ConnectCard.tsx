// A chat's Connect card: a bot asked the person to connect a Composio app (the computer's
// desktop/connects.mjs), with the desktop's words. The computer's own Composio account is used, so
// only its owner presses Connect; a member sees that the owner is asked. Connect asks the computer to
// start or join the app's sign-in and opens the page it answers; coming back looks again, and the
// computer goes on with the chat once the app is connected.
import * as WebBrowser from "expo-web-browser";
import { Check } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import type { ConnectCard as Card, ConnectStatus } from "@/link/types";
import { useMember, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { AppLogo, Button, radius, space, T, useTheme } from "@/ui";

/** What the card says under the app's name, and its button, for each state (the desktop's words). */
const WORDS: Record<ConnectStatus, { line: (name: string) => string; button?: string }> = {
  needed: { line: (name) => "Connect your " + name + " account so the bot can go on.", button: "Connect" },
  waiting: { line: (name) => "Finish signing in to " + name + " in your browser.", button: "Open page again" },
  connected: { line: () => "Connected" },
  failed: { line: (name) => "Connecting " + name + " didn't finish.", button: "Try again" },
  expired: { line: () => "The sign-in page expired.", button: "Try again" },
  sign_in: { line: () => "Sign in with Composio in Marketplace › Apps on the computer first.", button: "Check again" },
  unavailable: { line: () => "This bot can't use Composio in this chat any more." },
};

export function ConnectCard({ chatId, card }: { chatId: string; card: Card }) {
  const { colors } = useTheme();
  const member = useMember();
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const words = WORDS[card.status] ?? WORDS.needed;
  const look = () => void api["composio.cardCheck"](chatId, card.id).catch(() => {});

  // Back in the app from the browser: the computer looks at Composio again at once.
  useEffect(() => {
    if (member || card.status !== "waiting") return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void api["composio.cardCheck"](chatId, card.id).catch(() => {});
    });
    return () => subscription.remove();
  }, [member, chatId, card.id, card.status]);

  const press = async () => {
    setBusy(true);
    try {
      if (card.status === "sign_in") return void (await attempt(api["composio.cardCheck"](chatId, card.id)));
      const state = await attempt(api["composio.cardOpen"](chatId, card.id));
      if (!state?.url) return;
      await WebBrowser.openBrowserAsync(state.url).catch(() => {});
      look();
    } finally {
      setBusy(false);
    }
  };

  const done = card.status === "connected";
  const line = member && !done && card.status !== "unavailable" ? "Waiting for the computer's owner to connect " + card.name + "." : card.note || words.line(card.name);
  return (
    <View
      accessible={false}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.lg }}
    >
      <AppLogo name={card.name} uri={card.logo} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="headline" numberOfLines={1}>
          {done ? card.name : "Connect " + card.name}
        </T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }} accessibilityLiveRegion="polite">
          {done && <Check size={13} color={colors.success} strokeWidth={3} />}
          <T variant="footnote" color={done ? "success" : "muted"} style={{ flexShrink: 1 }}>
            {line}
          </T>
        </View>
      </View>
      {!member && words.button && <Button title={words.button} size="sm" variant={card.status === "needed" ? "primary" : "secondary"} loading={busy} disabled={busy || !online} onPress={() => void press()} accessibilityLabel={words.button + ", " + card.name} />}
    </View>
  );
}
