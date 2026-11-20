import { router, useLocalSearchParams } from "expo-router";
import { Dices } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type BotkinLook, cleanLook, lookOf, randomLook, sameLook } from "@/data/botLook";
import { useBot } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, EmptyState, Sheet, space } from "@/ui";
import { LookEditor, useLooksV2 } from "./LookEditor";
import { LookStage } from "./LookStage";

/** Picks a bot's character, eyes and colors, with the bot always in view. */
export default function BotStudio() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  if (!bot) return (
      <Sheet title="Bot Studio">
        <EmptyState title="This bot is gone" />
      </Sheet>
    );
  return <Studio id={bot.id} saved={lookOf(bot)} />;
}

function Studio({ id, saved }: { id: string; saved: BotkinLook }) {
  const insets = useSafeAreaInsets();
  const advanced = useLooksV2();
  const [look, setLook] = useState<BotkinLook>(saved);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const changed = !sameLook(look, saved);

  const save = async () => {
    setBusy(true);
    const done = await attempt(api["link.setLook"](id, cleanLook(look)).then(() => true));
    setBusy(false);
    if (done) router.back();
  };

  return (
    <Sheet title="Bot Studio" action="Save" onAction={() => void save()} actionDisabled={!changed} actionLoading={busy} scroll={false} contentStyle={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.md }}>
        <LookStage look={look} size={128}>
          <Button title="Surprise me" icon={Dices} variant="secondary" size="sm" onPress={() => setLook(randomLook({ advanced }))} style={{ alignSelf: "center" }} />
        </LookStage>
      </View>
      <ScrollView style={{ flex: 1 }} scrollEnabled={!dragging} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: insets.bottom + space.xxl }} showsVerticalScrollIndicator={false}>
        <LookEditor value={look} onChange={setLook} advanced={advanced} onDragging={setDragging} />
      </ScrollView>
    </Sheet>
  );
}
