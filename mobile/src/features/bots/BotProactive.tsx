// A bot's Proactive agent (experimental): one switch and its settings, as on the computer
// (desktop/src/BotProactive.tsx). Any bot may have one, and the computer's switch (Settings › Experimental)
// pauses them all. A team member whose role manages the bot sets their own: it works for them, hears only of
// their chats, never looks around the computer's own accounts, and tells them.
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import { ChoiceMenu } from "@/features/settings/Chat";
import type { ProactiveBotSettings } from "@/link/types";
import { useBot, useCan, useCapability, useChats, useMember, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, EmptyState, Field, Group, Label, Loading, Page, Row, space, T } from "@/ui";
import { CAP, EVERY, isPaused, minutes, OUTCOME, proactiveOf, proactiveRules, PROACTIVE_CAPABILITY, REASON, recentLog, SWEEP } from "./proactive";

const everyOptions = EVERY.map((m) => ({ value: String(m), label: "Every " + minutes(m) }));
const sweepOptions = SWEEP.map((h) => ({ value: String(h), label: h ? "Every " + minutes(h * 60) : "Never" }));
const capOptions = CAP.map((n) => ({ value: String(n), label: String(n) }));

export default function BotProactive() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const part = usePart("proactive");
  const chats = useChats();
  const synced = useApp((state) => state.synced);
  const learning = useCapability("proactive-learning-v1");
  const supported = useCapability(PROACTIVE_CAPABILITY);
  const canManage = useCan("agents", "manage");
  const member = useMember();
  const [draft, setDraft] = useState<string>();
  if (!bot) return <Page title="Proactive">{synced ? <EmptyState title="This bot is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Page>;
  if (!supported || !canManage)
    return (
      <Page title="Proactive">
        <Group>
          <Row title="Proactive" subtitle={supported ? "Your team role can't change this" : "Update the app on your computer"} disabled />
        </Group>
      </Page>
    );
  const entry = part?.bots?.[bot.id];
  const p = proactiveOf(entry);
  const rules = proactiveRules(entry, member, learning);
  const watched = p.watch.filter((w) => learning || w !== "context");
  const description = learning
    ? bot.name + " uses your goals and previous conversations" + (rules.lookAround ? " and its saved memory" : "") + " to suggest what you could do next. Rate a suggestion in your Feed or react with 👍 or 👎 in chat to teach it what helps."
    : bot.name + " checks for changes and tells you what needs your attention.";
  const set = (patch: Partial<ProactiveBotSettings> | null) => void attempt(api.setBotProactive(bot.id, patch));
  const turnOn = (enabled: boolean) =>
    enabled
      ? Alert.alert("Turn on the Proactive agent for " + bot.name + "?", bot.name + " wakes on its own" + (member ? " and reads what Botkins tells it about your chats" : ", reads what its tools reach (such as your inbox and calendar)") + ", and messages you, with nobody watching. Each wake uses the model.", [
          { text: "Cancel", style: "cancel" },
          { text: "Turn on", onPress: () => set({ enabled: true }) },
        ])
      : set({ enabled: false });
  const forget = () =>
    Alert.alert("Forget " + bot.name + "'s Proactive settings?", "This removes its proactive routine, planned follow-up and everything it learned from ratings.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => set(null) },
    ]);
  const routine = p.chatId ? chats.find((chat) => chat.id === p.chatId) : undefined;
  const log = recentLog(entry);
  const instructions = draft ?? p.instructions;
  if (rules.taken)
    return (
      <Page title="Proactive">
        <Group>
          <Row title="Proactive agent" subtitle="Another person has set up a Proactive agent for this bot" disabled />
        </Group>
      </Page>
    );
  return (
    <Page title="Proactive" keyboard>
      <T variant="footnote" color="muted">{description}</T>
      <Group>
        <Row
          title="Proactive agent"
          subtitle={isPaused(part, entry) ? "Paused: the owner has the Proactive agent off on this computer" : p.person && p.person !== "owner" && !entry?.mine ? "Set up by a team member: its alerts go to them" : "Tells you what you need to know before you ask"}
          toggled={p.enabled}
          onToggle={turnOn}
        />
        <ChoiceMenu title="Check for changes" subtitle="A check with nothing new uses no model" value={String(p.every)} options={everyOptions} onChange={(v) => set({ every: Number(v) })} />
        {rules.lookAround && <ChoiceMenu title="Look around" subtitle="Each look uses the model" value={String(p.sweepHours)} options={sweepOptions} onChange={(v) => set({ sweepHours: Number(v) })} />}
        <ChoiceMenu title="Most alerts a day" value={String(p.maxPerDay)} options={capOptions} onChange={(v) => set({ maxPerDay: Number(v) })} />
        <ChoiceMenu
          title="Alerts go to"
          value={p.deliver}
          options={[
            { value: "chat", label: bot.name + "'s chat with you" },
            { value: "feed", label: "Your Feed" },
          ]}
          onChange={(deliver) => set({ deliver })}
        />
      </Group>
      <T variant="footnote" color="muted">
        {learning && p.deliver === "feed" ? "A shared Feed sends personal suggestions to private chat." : "Quiet hours hold it back."}
      </T>
      <View>
        <Label>What Botkins watches</Label>
        <Group>
          {rules.watches.map((w) => (
            <Row key={w.id} title={w.title} subtitle={w.subtitle} toggled={watched.includes(w.id)} onToggle={(on) => set({ watch: on ? [...watched, w.id] : watched.filter((x) => x !== w.id) })} />
          ))}
        </Group>
      </View>
      <View style={{ gap: space.md }}>
        <Field label="Your rules" hint="What is worth telling you, and what isn't." placeholder="Tell me about anything from my manager the same day. Skip newsletters." value={instructions} onChangeText={setDraft} maxLength={2000} area />
        <Button title="Save rules" variant="secondary" disabled={instructions.trim() === p.instructions} onPress={() => (set({ instructions }), setDraft(undefined))} />
      </View>
      {!!p.nextReviewAt && <Row title="Planned follow-up" value={new Date(p.nextReviewAt).toLocaleString()} />}
      {!!p.learning?.rated && (
        <View>
          <Label>What helped</Label>
          <Group>
            <Row title="Rated suggestions" value={String(p.learning.rated)} />
            {!!p.learning.preferred.length && <Row title="Preferred approaches" subtitle={p.learning.preferred.join(", ")} />}
            {!!p.learning.retired.length && <Row title="Set aside" subtitle={p.learning.retired.join(", ")} />}
          </Group>
        </View>
      )}
      {routine && (
        <View>
          <Label>Recent</Label>
          <Group>
            {log.length ? log.map((l) => <Row key={l.runId} title={REASON[l.reason]} subtitle={l.said ?? new Date(l.at).toLocaleString()} value={OUTCOME[l.outcome] + (l.score == null ? "" : " · Score " + l.score + "/100")} />) : <Row title="Nothing yet" />}
            <Row title="Check now" disabled={!p.enabled || isPaused(part, entry)} onPress={() => void attempt(api.runRoutine(routine.id))} />
          </Group>
        </View>
      )}
      {entry && <Button title="Forget settings" variant="secondary" onPress={forget} />}
    </Page>
  );
}
