// The setup steps of a bot's Proactive agent ("proactive-team-v1"), as on the computer (desktop/src/ProactiveSetup.tsx):
// who the bot looks out for, who is notified, what matters most, and how often. Nothing runs, and no model is used,
// until they are finished. The steps, their words and what they save are link-host/proactive-words.mjs, which both
// apps read. Route `/bot/[id]/proactive-setup`: the bot's Proactive page opens it ("Set up"), and so may whatever
// makes a new bot.
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { myself } from "@/features/chat/people";
import { ChoiceMenu } from "@/features/settings/Chat";
import type { ProactivePatch } from "@/link/types";
import { useBot, useCan, useCapability, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, EmptyState, Field, Group, Row, Sheet, space, T } from "@/ui";
import { CAP, EVERY, minutes, proactiveRules, PROACTIVE_TEAM, SWEEP, WIZARD, WIZARD_STEPS, wizardPatch, wizardPeople, wizardReady, wizardStart, type WizardDraft } from "./proactive";

const everyOptions = EVERY.map((m) => ({ value: String(m), label: "Every " + minutes(m) }));
const sweepOptions = SWEEP.map((h) => ({ value: String(h), label: h ? "Every " + minutes(h * 60) : "Never" }));
const capOptions = CAP.map((n) => ({ value: String(n), label: String(n) }));

export default function ProactiveSetup() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const part = usePart("proactive");
  const team = usePart("team");
  const meta = usePart("meta");
  const supported = useCapability(PROACTIVE_TEAM);
  const learning = useCapability("proactive-learning-v1");
  const manages = useCan("agents", "manage");
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WizardDraft>();
  const [saving, setSaving] = useState(false);
  const viewer = { id: myself(meta), name: meta?.you?.kind === "member" ? meta.you.name : undefined, manages };
  const entry = bot ? part?.bots?.[bot.id] : undefined;
  const rules = proactiveRules(entry, viewer, learning);
  if (!bot || !supported || !rules.shared)
    return (
      <Sheet title={WIZARD.setUp}>
        <EmptyState title={!bot ? "This bot is gone" : supported ? "Your team role can't set this up" : "Update the app on your computer"} />
      </Sheet>
    );
  const people = wizardPeople(team && "members" in team ? team : undefined, bot.id, viewer);
  const d = draft ?? wizardStart(entry, viewer, people);
  const change = (patch: Partial<WizardDraft>) => setDraft({ ...d, ...patch });
  const person = (personId: string, patch: Partial<WizardDraft["people"][string]>) => change({ people: { ...d.people, [personId]: { ...d.people[personId], ...patch } } });
  const name = WIZARD_STEPS[step];
  const last = step === WIZARD_STEPS.length - 1;
  const finish = async () => {
    setSaving(true);
    const saved = await attempt(api.setBotProactive(bot.id, wizardPatch(d, entry, viewer) as ProactivePatch).then(() => true));
    setSaving(false);
    if (saved) router.back();
  };
  const ready = wizardReady(d);
  return (
    <Sheet title={WIZARD.setUp} action={last ? WIZARD.finish : WIZARD.next} onAction={last ? () => void finish() : () => setStep(step + 1)} actionDisabled={!ready} actionLoading={saving}>
      <View style={{ gap: space.xs }}>
        <T variant="title2" accessibilityRole="header">
          {WIZARD.title[name](bot.name)}
        </T>
        <T variant="footnote" color="muted">
          {ready ? WIZARD.note[name] : WIZARD.needsOne}
        </T>
      </View>
      {name === "people" && (
        <Group>
          {people.map((who) => (
            <Row key={who.id} title={who.name} subtitle={who.you ? "You" : undefined} toggled={d.people[who.id]?.on === true} onToggle={(on) => person(who.id, { on })} />
          ))}
        </Group>
      )}
      {name === "notify" && (
        <Group>
          {people
            .filter((who) => d.people[who.id]?.on)
            .map((who) => (
              <Row key={who.id} title={who.name} subtitle={who.you ? "You" : undefined} toggled={d.people[who.id]?.notify !== false} onToggle={(notify) => person(who.id, { notify })} />
            ))}
        </Group>
      )}
      {name === "matters" && (
        <>
          <Group>
            {rules.watches.map((watch) => (
              <Row key={watch.id} title={watch.title} subtitle={watch.subtitle} subtitleLines={2} toggled={d.watch.includes(watch.id)} onToggle={(on) => change({ watch: on ? [...d.watch, watch.id] : d.watch.filter((item) => item !== watch.id) })} />
            ))}
          </Group>
          <Field label={WIZARD.rules} placeholder={WIZARD.rulesPlaceholder} value={d.instructions} onChangeText={(instructions) => change({ instructions })} maxLength={2000} />
          {rules.lookAround && (
            <Group>
              <ChoiceMenu title={WIZARD.lookAround} subtitle={WIZARD.lookAroundNote} value={String(d.sweepHours)} options={sweepOptions} onChange={(value) => change({ sweepHours: Number(value) })} />
            </Group>
          )}
        </>
      )}
      {name === "often" && (
        <Group>
          <ChoiceMenu title={WIZARD.every} value={String(d.every)} options={everyOptions} onChange={(value) => change({ every: Number(value) })} />
          <ChoiceMenu title={WIZARD.cap} value={String(d.maxPerDay)} options={capOptions} onChange={(value) => change({ maxPerDay: Number(value) })} />
        </Group>
      )}
      {step > 0 && <Button title={WIZARD.back} variant="ghost" onPress={() => setStep(step - 1)} />}
    </Sheet>
  );
}
