// Settings › Experimental, as on the computer (desktop/src/ExperimentalSettings.tsx): the Proactive agent.
import { useState } from "react";
import { Alert, View } from "react-native";
import type { ProactiveSettings, ProactiveWatch } from "@/link/types";
import { useBots, useChats, usePart, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, Field, Group, Label, Loading, Page, Row, space, T } from "@/ui";
import { ChoiceMenu } from "./Chat";

const DEFAULTS: ProactiveSettings = { enabled: false, botId: null, every: 30, sweepHours: 3, maxPerDay: 6, deliver: "chat", watch: ["runs", "tasks", "requests"], instructions: "" };
const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));
const EVERY = [15, 30, 60, 120].map((m) => ({ value: String(m), label: "Every " + minutes(m) }));
const SWEEP = [0, 1, 2, 3, 6, 12].map((h) => ({ value: String(h), label: h ? "Every " + minutes(h * 60) : "Never" }));
const CAP = [3, 6, 10, 20].map((n) => ({ value: String(n), label: String(n) }));
const WATCH: { id: ProactiveWatch; title: string; subtitle: string }[] = [
  { id: "runs", title: "Failed routines and tasks", subtitle: "A run that ended needing you" },
  { id: "tasks", title: "Tasks waiting on you", subtitle: "In Review or Blocked over four hours" },
  { id: "requests", title: "Unanswered requests", subtitle: "Open for more than 15 minutes" },
];
const OUTCOME = { alerted: "Told you", silent: "Nothing to say", failed: "Failed" } as const;
const REASON = { signals: "Something changed", sweep: "Look around", check: "Check now" } as const;

export default function Experimental() {
  const settings = useSettings();
  const bots = useBots();
  const chats = useChats();
  const part = usePart("proactive");
  const proactive = { ...DEFAULTS, ...settings?.proactive };
  const [draft, setDraft] = useState<string>();
  if (!settings)
    return (
      <Page title="Experimental">
        <Loading />
      </Page>
    );
  const set = (patch: Partial<ProactiveSettings>) => void attempt(api.setPreferences({ proactive: patch }));
  const turnOn = (enabled: boolean) =>
    enabled
      ? Alert.alert("Turn on the Proactive agent?", "Its bot wakes on its own, reads what its tools reach (such as your inbox and calendar) and messages you, with nobody watching. Each wake uses the model.", [
          { text: "Cancel", style: "cancel" },
          { text: "Turn on", onPress: () => set({ enabled: true }) },
        ])
      : set({ enabled: false });
  const bot = bots.find((b) => b.id === proactive.botId);
  const routine = part?.chatId ? chats.find((chat) => chat.id === part.chatId) : undefined;
  const log = part?.log ?? [];
  const instructions = draft ?? proactive.instructions;
  return (
    <Page title="Experimental" keyboard>
      <T variant="footnote" color="muted">
        These are new. They may change or go away, and they can use your model more than you expect.
      </T>
      <View>
        <Label>Proactive agent</Label>
        <Group>
          <ChoiceMenu
            title="Bot"
            value={proactive.botId ?? ""}
            options={[{ value: "", label: "Choose a bot" }, ...bots.map((b) => ({ value: b.id, label: b.name }))]}
            onChange={(id) => set(id ? { botId: id } : { enabled: false, botId: null })}
          />
          <Row title="Proactive agent" subtitle={proactive.botId ? "Tells you what you need to know before you ask" : "Choose a bot first"} toggled={proactive.enabled} disabled={!proactive.botId} onToggle={turnOn} />
          <ChoiceMenu title="Check for changes" subtitle="A check with nothing new uses no model" value={String(proactive.every)} options={EVERY} onChange={(v) => set({ every: Number(v) })} />
          <ChoiceMenu title="Look around" subtitle="Each look uses the model" value={String(proactive.sweepHours)} options={SWEEP} onChange={(v) => set({ sweepHours: Number(v) })} />
          <ChoiceMenu title="Most alerts a day" value={String(proactive.maxPerDay)} options={CAP} onChange={(v) => set({ maxPerDay: Number(v) })} />
          <ChoiceMenu
            title="Alerts go to"
            value={proactive.deliver}
            options={[
              { value: "chat", label: (bot?.name ?? "The bot") + "'s chat with you" },
              { value: "feed", label: "Your Feed" },
            ]}
            onChange={(deliver) => set({ deliver })}
          />
        </Group>
        <T variant="footnote" color="muted">
          The bot reads and drafts only: it never sends, posts, buys or deletes on its own. Quiet hours hold it back.
        </T>
      </View>
      <View>
        <Label>What Botkins watches</Label>
        <Group>
          {WATCH.map((w) => (
            <Row key={w.id} title={w.title} subtitle={w.subtitle} toggled={proactive.watch.includes(w.id)} onToggle={(on) => set({ watch: on ? [...proactive.watch, w.id] : proactive.watch.filter((x) => x !== w.id) })} />
          ))}
        </Group>
      </View>
      <View style={{ gap: space.md }}>
        <Field label="Your rules" hint="What is worth telling you, and what isn't." placeholder="Tell me about anything from my manager the same day. Skip newsletters." value={instructions} onChangeText={setDraft} maxLength={2000} area />
        <Button title="Save rules" variant="secondary" disabled={instructions.trim() === proactive.instructions} onPress={() => (set({ instructions }), setDraft(undefined))} />
      </View>
      {routine && (
        <View>
          <Label>Recent</Label>
          <Group>
            {log.length ? log.slice(0, 8).map((l) => <Row key={l.runId} title={REASON[l.reason]} subtitle={l.said ?? new Date(l.at).toLocaleString()} value={OUTCOME[l.outcome]} />) : <Row title="Nothing yet" />}
            <Row title="Check now" onPress={() => api.runRoutine(routine.id)} />
          </Group>
        </View>
      )}
    </Page>
  );
}
