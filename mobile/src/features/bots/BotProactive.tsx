// A bot's Proactive agent (experimental), as on the computer (desktop/src/BotProactive.tsx). One bot looks out for
// several people ("proactive-team-v1"): each has their own alerts, and nobody sees another person's. Nothing runs
// until the setup steps are finished ("Set up"). The owner changes everything; a member whose role manages the bot
// changes what its people share; any other member the bot looks out for changes only their own alerts. The computer
// checks the same, and its switch (Settings › Experimental) pauses every bot.
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, View } from "react-native";
import { myself } from "@/features/chat/people";
import { ChoiceMenu } from "@/features/settings/Chat";
import type { ProactivePatch } from "@/link/types";
import { useBot, useCan, useCapability, useChats, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Button, EmptyState, Field, Group, Label, Loading, Page, Row, space, T } from "@/ui";
import { CAP, EVERY, minutes, OUTCOME, personLine, proactiveOf, proactiveRules, proactiveStanding, PROACTIVE_CAPABILITY, PROACTIVE_TEAM, REASON, recentLog, SWEEP, WIZARD } from "./proactive";

const everyOptions = EVERY.map((m) => ({ value: String(m), label: "Every " + minutes(m) }));
const sweepOptions = SWEEP.map((h) => ({ value: String(h), label: h ? "Every " + minutes(h * 60) : "Never" }));
const capOptions = CAP.map((n) => ({ value: String(n), label: String(n) }));
/** One person's row for the owner: on and notified, on and quiet, off, or taken out. */
const PERSON_CHOICES = [
  { value: "notified", label: "On · notified" },
  { value: "quiet", label: "On · not notified" },
  { value: "off", label: "Off" },
  { value: "remove", label: "Remove" },
];

export default function BotProactive() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const part = usePart("proactive");
  const team = usePart("team");
  const meta = usePart("meta");
  const chats = useChats();
  const synced = useApp((state) => state.synced);
  const learning = useCapability("proactive-learning-v1");
  const supported = useCapability(PROACTIVE_CAPABILITY);
  const teams = useCapability(PROACTIVE_TEAM);
  const manages = useCan("agents", "manage");
  const [draft, setDraft] = useState<string>();
  if (!bot) return <Page title="Proactive">{synced ? <EmptyState title="This bot is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Page>;
  const me = myself(meta);
  const entry = part?.bots?.[bot.id];
  const p = proactiveOf(entry);
  const rules = proactiveRules(entry, { id: me, manages }, learning);
  if (!supported || !teams || !rules.any)
    return (
      <Page title="Proactive">
        <Group>
          <Row title="Proactive" subtitle={supported && teams ? "Your team role can't change this" : "Update the app on your computer"} disabled />
        </Group>
      </Page>
    );
  const standing = proactiveStanding(part, entry, me);
  const watched = p.watch.filter((w) => learning || w !== "context");
  const description = learning
    ? bot.name + " uses your goals and previous conversations" + (rules.lookAround ? " and its saved memory" : "") + " to find what you could do next, and offers to take care of it. Rate an alert in your Feed or react with 👍 or 👎 in chat to teach it what helps."
    : bot.name + " checks for changes and tells you what needs your attention.";
  const set = (patch: ProactivePatch | null) => void attempt(api.setBotProactive(bot.id, patch));
  const setUp = () => router.push(("/bot/" + encodeURIComponent(bot.id) + "/proactive-setup") as Href);
  const forget = () =>
    Alert.alert("Forget " + bot.name + "'s Proactive settings?", "This removes everyone's alerts, planned follow-ups and everything it learned from ratings.", [
      { text: "Cancel", style: "cancel" },
      { text: "Forget", style: "destructive", onPress: () => set(null) },
    ]);
  if (standing === "setup")
    return (
      <Page title="Proactive">
        <T variant="footnote" color="muted">{description}</T>
        <Group>
          <Row title="Proactive agent" subtitle={rules.shared ? WIZARD.waiting : "The owner hasn't set this up yet"} subtitleLines={2} disabled />
        </Group>
        {rules.shared && <Button title={WIZARD.setUp} onPress={setUp} />}
        {rules.all && entry && <Button title="Forget settings" variant="secondary" onPress={forget} />}
      </Page>
    );
  const names = new Map((team?.people ?? []).map((person) => [person.id, person.name]));
  const nameOf = (person: string) => (person === me ? "You" : (names.get(person) ?? (person === "owner" ? "Owner" : "A member")));
  const others = Object.entries(p.people ?? {}).filter(([person]) => person !== me);
  const choose = (person: string, value: string) => set({ people: { [person]: value === "remove" ? null : { on: value !== "off", ...(value !== "off" && { notify: value === "notified" }) } } });
  const routine = p.chatId ? chats.find((chat) => chat.id === p.chatId) : undefined;
  const log = recentLog(entry);
  const instructions = draft ?? p.instructions;
  const paused = standing === "paused";
  return (
    <Page title="Proactive" keyboard>
      <T variant="footnote" color="muted">{description}</T>
      <Group>
        {rules.all && <Row title="Proactive agent" subtitle={paused ? "Paused: the Proactive agent is off on this computer" : "For everyone " + bot.name + " looks out for"} subtitleLines={2} toggled={p.enabled} onToggle={(enabled) => set({ enabled })} />}
        {!rules.all && (paused || standing === "off") && <Row title="Proactive agent" subtitle="Paused by the owner" disabled />}
        {rules.mine ? (
          <>
            <Row title="My alerts" subtitle={"What " + bot.name + " finds for you"} toggled={rules.mine.on} onToggle={(on) => set({ people: { [me]: { on } } })} />
            <Row title="Notify me" subtitle="Off still delivers alerts, quietly" toggled={rules.mine.notify} disabled={!rules.mine.on} onToggle={(notify) => set({ people: { [me]: { notify } } })} />
          </>
        ) : (
          rules.shared && <Row title="Look out for me" subtitle="Your own alerts. Nobody else sees them" toggled={false} onToggle={() => set({ people: { [me]: { on: true } } })} />
        )}
      </Group>
      {rules.all && (
        <View>
          <Label>Who it looks out for</Label>
          <Group>
            {others.map(([person, own]) => (
              <ChoiceMenu key={person} title={nameOf(person)} subtitle={personLine(own)} value={!own.on ? "off" : own.notify ? "notified" : "quiet"} options={PERSON_CHOICES} onChange={(value) => choose(person, value)} />
            ))}
            <Row title="Add or remove people" chevron onPress={setUp} />
          </Group>
          <T variant="footnote" color="muted">
            Each person gets their own alerts. Nobody sees another person's.
          </T>
        </View>
      )}
      {rules.shared ? (
        <>
          <Group>
            <ChoiceMenu title="Check for changes" subtitle="A check with nothing new uses no model" value={String(p.every)} options={everyOptions} onChange={(v) => set({ every: Number(v) })} />
            {rules.lookAround && <ChoiceMenu title="Look around" subtitle="Each look uses the model" value={String(p.sweepHours)} options={sweepOptions} onChange={(v) => set({ sweepHours: Number(v) })} />}
            <ChoiceMenu title="Most alerts a day" subtitle="For each person" value={String(p.maxPerDay)} options={capOptions} onChange={(v) => set({ maxPerDay: Number(v) })} />
            <ChoiceMenu
              title="Alerts go to"
              value={p.deliver}
              options={[
                { value: "chat", label: bot.name + "'s chat with each person" },
                { value: "feed", label: "Each person's Feed" },
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
                <Row key={w.id} title={w.title} subtitle={w.subtitle} subtitleLines={2} toggled={watched.includes(w.id)} onToggle={(on) => set({ watch: on ? [...watched, w.id] : watched.filter((x) => x !== w.id) })} />
              ))}
            </Group>
          </View>
          <View style={{ gap: space.md }}>
            <Field label="Rules" hint="What is worth telling people, and what isn't." placeholder={WIZARD.rulesPlaceholder} value={instructions} onChangeText={setDraft} maxLength={2000} area />
            <Button title="Save rules" variant="secondary" disabled={instructions.trim() === p.instructions} onPress={() => (set({ instructions }), setDraft(undefined))} />
          </View>
        </>
      ) : (
        <View>
          <Label>Set by the owner</Label>
          <Group>
            <Row title="Check for changes" value={"Every " + minutes(p.every)} />
            <Row title="Most alerts a day" value={String(p.maxPerDay)} />
            <Row title="Alerts go to" value={p.deliver === "feed" ? "Your Feed" : "Your chat"} />
          </Group>
        </View>
      )}
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
            <Row title="Check now" disabled={standing !== "on"} onPress={() => void attempt(api.runRoutine(routine.id))} />
          </Group>
        </View>
      )}
      {rules.all ? <Button title="Forget settings" variant="secondary" onPress={forget} /> : rules.mine && <Button title="Stop looking out for me" variant="secondary" onPress={() => set(null)} />}
    </Page>
  );
}
