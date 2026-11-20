import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import type { Bot } from "@/link/types";
import { useBot } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Field, Sheet, space } from "@/ui";
import { counter, LIMITS } from "./limits";

export default function EditBot() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  if (!bot)
    return (
      <Sheet title="Edit bot">
        <EmptyState title="This bot is gone" />
      </Sheet>
    );
  return <Editor bot={bot} />;
}

function Editor({ bot }: { bot: Bot }) {
  const [name, setName] = useState(bot.name);
  const [role, setRole] = useState(bot.role);
  const [summary, setSummary] = useState(bot.summary ?? "");
  const [clarify, setClarify] = useState(bot.clarificationInstructions ?? "");
  const [busy, setBusy] = useState(false);

  const patch: Partial<Pick<Bot, "name" | "role" | "summary" | "clarificationInstructions">> = {};
  if (name.trim() !== bot.name) patch.name = name.trim();
  if (role.trim() !== bot.role) patch.role = role.trim();
  if (summary.trim() !== (bot.summary ?? "")) patch.summary = summary.trim();
  if (clarify.trim() !== (bot.clarificationInstructions ?? "").trim()) patch.clarificationInstructions = clarify.trim();
  const changed = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy(true);
    const done = await attempt(api.updateBot(bot.id, patch).then(() => true));
    setBusy(false);
    if (done) router.back();
  };

  return (
    <Sheet title="Edit bot" action="Save" onAction={() => void save()} actionDisabled={!changed || !name.trim()} actionLoading={busy}>
      <View style={{ gap: space.lg }}>
        <Field label="Name" value={name} onChangeText={setName} maxLength={LIMITS.name} autoCapitalize="words" returnKeyType="next" error={name.trim() ? undefined : "A bot needs a name"} />
        <Field label="Role" placeholder="Writing partner" value={role} onChangeText={setRole} maxLength={LIMITS.role} />
        <Field label="About" placeholder="A line about what it's for" value={summary} onChangeText={setSummary} maxLength={LIMITS.summary} area style={{ minHeight: 96 }} />
        <Field
          label="Ask for clarification when"
          placeholder="Ask me for a deadline before planning a project."
          value={clarify}
          onChangeText={setClarify}
          maxLength={LIMITS.clarification}
          area
          hint={counter(clarify, LIMITS.clarification) ?? "Added to the questions in Chats & approvals."}
          style={{ minHeight: 96 }}
        />
      </View>
    </Sheet>
  );
}
