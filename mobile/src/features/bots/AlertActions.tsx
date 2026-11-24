// What a person can do with a proactive alert ("proactive-team-v1"), under the alert in a chat and on its Feed
// card, as on the computer (desktop/src/AlertActions.tsx). "Take care of it" starts a normal turn in the person's
// chat with what the bot offered: its tools ask for approval as usual. "Not now" holds what it was about back for
// a day. The 👍 and 👎 ratings stay where they were. Only the person the alert was for is sent it.
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { ProactiveAlert } from "@/link/types";
import { useCapability } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, space, T } from "@/ui";
import { ALERT, PROACTIVE_TEAM } from "./proactive";

export function AlertActions({ botId, alert, chatId }: { botId: string; alert?: ProactiveAlert; /** The chat the alert is shown in, if any: taking it there opens nothing. */ chatId?: string }) {
  const supported = useCapability(PROACTIVE_TEAM);
  const [busy, setBusy] = useState(false);
  if (!alert?.runId || !supported) return null;
  if (alert.chosen)
    return (
      <T variant="footnote" color="muted">
        {alert.chosen === "take" ? ALERT.taken : ALERT.held}
      </T>
    );
  const act = async (action: "take" | "later") => {
    if (busy) return;
    setBusy(true);
    const answer = await attempt(api.proactiveAct(botId, alert.runId, action));
    setBusy(false);
    if (action === "take" && answer?.chatId && answer.chatId !== chatId) router.push({ pathname: "/chat/[id]", params: { id: answer.chatId } });
  };
  return (
    <View style={{ gap: space.sm }}>
      {!!alert.offer && (
        <T variant="subhead" weight="600">
          {alert.offer}
        </T>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        {!!alert.offer && <Button title={ALERT.take} size="sm" disabled={busy} onPress={() => void act("take")} accessibilityLabel={ALERT.take + ": " + alert.offer} />}
        <Button title={ALERT.later} variant="ghost" size="sm" disabled={busy} onPress={() => void act("later")} />
      </View>
    </View>
  );
}
