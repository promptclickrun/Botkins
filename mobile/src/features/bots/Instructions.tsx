import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useWindowDimensions } from "react-native";
import type { Bot } from "@/link/types";
import { useBot } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { EmptyState, Field, Sheet } from "@/ui";
import { counter, LIMITS } from "./limits";

export default function Instructions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  if (!bot)
    return (
      <Sheet title="Instructions">
        <EmptyState title="This bot is gone" />
      </Sheet>
    );
  return <Editor bot={bot} />;
}

function Editor({ bot }: { bot: Bot }) {
  const { height } = useWindowDimensions();
  const [text, setText] = useState(bot.instructions);
  const [busy, setBusy] = useState(false);
  const changed = text !== bot.instructions;

  const save = async () => {
    setBusy(true);
    const done = await attempt(api.updateBot(bot.id, { instructions: text }).then(() => true));
    setBusy(false);
    if (done) router.back();
  };

  // The field fills the sheet and grows with the text; the sheet scrolls to keep the caret in view.
  return (
    <Sheet title="Instructions" action="Save" onAction={() => void save()} actionDisabled={!changed} actionLoading={busy}>
      <Field
        accessibilityLabel={"Instructions for " + bot.name}
        placeholder={"What should " + bot.name + " do, and how?"}
        value={text}
        onChangeText={setText}
        maxLength={LIMITS.instructions}
        area
        scrollEnabled={false}
        hint={counter(text, LIMITS.instructions)}
        style={{ minHeight: Math.max(240, height * 0.62) }}
      />
    </Sheet>
  );
}
