import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, useWindowDimensions } from "react-native";
import { useBot } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, EmptyState, Field, Loading, Sheet } from "@/ui";

/** What a bot remembers between chats, as plain text the person can edit. */
export default function Memory() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const bot = useBot(id);
  const { height } = useWindowDimensions();
  // undefined: loading. null: it didn't load.
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [attemptNo, setAttemptNo] = useState(0);

  useEffect(() => {
    let live = true;
    void attempt(api.botMemory(id)).then((memory) => {
      if (!live) return;
      setSaved(memory ?? null);
      setText(memory ?? "");
    });
    return () => {
      live = false;
    };
  }, [id, attemptNo]);

  const save = async (next: string) => {
    setBusy(true);
    const done = await attempt(api.setBotMemory(id, next).then(() => true), next ? undefined : "Memory cleared");
    setBusy(false);
    return !!done;
  };
  const clear = () =>
    Alert.alert("Clear memory?", (bot?.name ?? "This bot") + " forgets everything it remembered.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: async () => {
          if (await save("")) {
            setSaved("");
            setText("");
          }
        },
      },
    ]);

  if (!bot)
    return (
      <Sheet title="Memory">
        <EmptyState title="This bot is gone" />
      </Sheet>
    );
  return (
    <Sheet title="Memory" action="Save" onAction={async () => (await save(text)) && router.back()} actionDisabled={typeof saved !== "string" || text === saved} actionLoading={busy}>
      {saved === undefined ? (
        <Loading />
      ) : saved === null ? (
        <EmptyState title="Memory didn't load" action="Try again" onAction={() => {
          setSaved(undefined);
          setAttemptNo(attemptNo + 1);
        }} />
      ) : (
        <>
          <Field accessibilityLabel={bot.name + "'s memory"} placeholder="Nothing remembered yet" value={text} onChangeText={setText} area scrollEnabled={false} style={{ minHeight: Math.max(220, height * 0.5) }} />
          {!!saved && <Button title="Clear memory" variant="ghost" size="sm" onPress={clear} style={{ alignSelf: "center" }} />}
        </>
      )}
    </Sheet>
  );
}
