// Today › Create panel: ask a bot for a panel. As on the computer (its src/app.tsx), a new chat
// with the bot opens and "/today-panel <what it should show>" is sent there.
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { useBots, useCan } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Field, Label, Sheet, space, T } from "@/ui";
import { BotChips } from "@/features/work/bits";

export default function NewPanel() {
  const canCreate = useCan("today", "create");
  const canChat = useCan("agents", "chat");
  if (!canCreate || !canChat) return <Sheet title="Create a panel"><EmptyState title="Your team role can't create panels" /></Sheet>;
  return <CreatePanel />;
}

function CreatePanel() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const bots = useBots();
  const shown = useMemo(() => bots.filter((bot) => !bot.hidden || bot.id === botId), [bots, botId]);
  const [chosen, setChosen] = useState<string | null>(botId ?? null);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  // The first bot is picked until the person picks another, as the computer's list starts on it.
  const bot = chosen ?? shown[0]?.id ?? null;
  const ready = !!bot && !!text.trim() && !asking;

  const ask = async () => {
    if (!ready || !bot) return;
    setAsking(true);
    const id = await attempt(api.createChat(bot));
    // The chat opens even if the message failed, so the person sees what happened there.
    if (id) await attempt(api.send(id, "/today-panel " + text.trim()));
    setAsking(false);
    if (!id) return;
    router.back();
    router.push({ pathname: "/chat/[id]", params: { id } });
  };

  return (
    <Sheet title="Create a panel" action="Ask bot" onAction={() => void ask()} actionDisabled={!ready} actionLoading={asking}>
      <View>
        <Label>Bot</Label>
        {shown.length ? (
          <BotChips bots={shown} value={bot} onChange={(next) => next && setChosen(next)} />
        ) : (
          <T variant="subhead" color="muted">
            Make a bot first.
          </T>
        )}
      </View>
      <View style={{ gap: space.lg }}>
        <Field label="What should the panel show?" placeholder="My weekday priorities, refreshed every morning at 9" value={text} onChangeText={setText} area maxLength={8000} autoFocus />
      </View>
    </Sheet>
  );
}
