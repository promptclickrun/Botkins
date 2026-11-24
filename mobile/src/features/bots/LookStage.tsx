// The big live preview of a look, bare on the page. A tap makes the bot act something out.
import { type ComponentProps, type ReactNode, useState } from "react";
import { View } from "react-native";
import type { BotkinLook } from "@/data/botLook";
import { BotAvatar, space, Tap } from "@/ui";

const ACTS: NonNullable<ComponentProps<typeof BotAvatar>["state"]>[] = ["idle", "listening", "thinking", "coding", "completed", "laugh"];

export function LookStage({ look, size = 132, children }: { look: BotkinLook; size?: number; children?: ReactNode }) {
  const [act, setAct] = useState(0);
  return (
    <View style={{ paddingTop: space.sm, alignItems: "center", gap: space.lg }}>
      <Tap onPress={() => setAct((act + 1) % ACTS.length)} feel="select" sink={0.95} accessibilityLabel="Preview" accessibilityHint="Plays the next mood">
        <BotAvatar look={look} state={ACTS[act]} size={size} animated />
      </Tap>
      {children}
    </View>
  );
}
