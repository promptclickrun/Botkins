// "Ask about this space", and "Ask <bot> to change it" for one panel: a sentence and a bot. The
// computer starts a chat with that bot in the space, and the chat opens, as a new panel's does.
// Opened from one of a panel's chips (`ask`: its place among the panel's asks), the field starts
// with the chip's words. They are not sent: the person reads, changes and sends them.
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { BotChips } from "@/features/work/bits";
import { useBots, useCan } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Field, Label, Sheet, T } from "@/ui";
import { useSpace, useSpaceContent } from "./data";
import { asksOf, spaceTitle } from "./logic";

export default function AskSheet() {
  const { spaceId, panelId, ask: at } = useLocalSearchParams<{ spaceId: string; panelId?: string; ask?: string }>();
  const canChat = useCan("agents", "chat");
  const space = useSpace(spaceId);
  const panel = useSpaceContent(spaceId).content?.panels.find((one) => one.id === panelId);
  const bots = useBots();
  const shown = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const [chosen, setChosen] = useState<string | null>(null);
  // The route names only which chip; the words are the panel's own, read here.
  const [text, setText] = useState(() => (at === undefined ? "" : (asksOf(panel)[Number(at)] ?? "")));
  const [asking, setAsking] = useState(false);
  // A panel is changed by its own bot; a space is asked about with the first bot until another is picked.
  const bot = panel?.botId ?? chosen ?? shown[0]?.id ?? null;
  const name = bots.find((one) => one.id === bot)?.name ?? "the bot";
  const title = panel ? "Ask " + name + " to change it" : "Ask about this space";
  if (!canChat || !space) return <Sheet title={title}><EmptyState title={space ? "Your team role can't chat with bots" : "This space no longer exists."} /></Sheet>;
  const ready = !!bot && !!text.trim() && !asking;
  const ask = async () => {
    if (!ready || !bot) return;
    setAsking(true);
    const made = await attempt(api["spaces.ask"]({ spaceId: space.id, botId: bot, text: text.trim(), ...(panel && { panelId: panel.id }) }));
    setAsking(false);
    if (!made) return;
    router.back();
    router.push({ pathname: "/chat/[id]", params: { id: made.chatId } });
  };
  return (
    <Sheet title={title} action="Ask" onAction={() => void ask()} actionDisabled={!ready} actionLoading={asking}>
      {!panel && (
        <View>
          <Label>Bot</Label>
          {shown.length ? <BotChips bots={shown} value={bot} onChange={(next) => next && setChosen(next)} /> : <T variant="subhead" color="muted">Make a bot first.</T>}
        </View>
      )}
      <Field label={panel ? panel.title : spaceTitle(space)} placeholder={panel ? "Add a column for last week" : "What changed since Monday?"} value={text} onChangeText={setText} area maxLength={8000} autoFocus />
    </Sheet>
  );
}
