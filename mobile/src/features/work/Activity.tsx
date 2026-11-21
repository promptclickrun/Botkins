// What the bots ran lately: Work's Activity page (the icon left of the plus), and the whole of Work
// for a team member whose role has no routines.
import { router } from "expo-router";
import { useMemo } from "react";
import type { Bot } from "@/link/types";
import { useBots, useChats, usePart } from "@/state/hooks";
import { useApp } from "@/state/store";
import { ago } from "@/state/time";
import { Group, Loading, Page, Row, space, T } from "@/ui";
import { RunIcon } from "./bits";

/** The latest 40 runs; a tap opens the run's chat. */
export function ActivityList() {
  const runs = usePart("runs") ?? [];
  const chats = useChats();
  const allBots = useBots();
  const bots = useMemo(() => new Map<string, Bot>(allBots.map((bot) => [bot.id, bot])), [allBots]);
  const chatBot = useMemo(() => new Map(chats.map((chat) => [chat.id, chat.botId])), [chats]);
  if (runs.length === 0)
    return (
      <T variant="callout" color="muted" center style={{ paddingVertical: space.huge }}>
        No activity yet
      </T>
    );
  return (
    <Group>
      {runs.slice(0, 40).map((run) => {
        const botId = chatBot.get(run.chatId);
        const name = botId ? bots.get(botId)?.name : undefined;
        // The icon says how it went; the words say it too when it didn't simply finish.
        const status = run.status === "Completed" ? undefined : run.status === "Needs you" ? "Failed" : run.status;
        const subtitle = [status, name, ago(run.time), run.trigger === "scheduled" ? "Scheduled" : undefined].filter(Boolean).join(" · ");
        const summary = run.status !== "Working" && run.summary && run.summary.length <= 24 ? run.summary : undefined;
        return <Row key={run.id} leading={<RunIcon status={run.status} />} title={run.title || "Run"} subtitle={subtitle} value={summary} onPress={() => router.push({ pathname: "/chat/[id]", params: { id: run.chatId } })} />;
      })}
    </Group>
  );
}

export default function Activity() {
  const synced = useApp((state) => state.synced);
  return <Page title="Activity">{synced ? <ActivityList /> : <Loading />}</Page>;
}
