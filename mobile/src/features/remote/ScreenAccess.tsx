// The computer's page › Screen: what phones may do with this computer's screen.
//
// On a computer with its own settings the level is shown and changed there. On a headless host (a
// server with no window) the person sets it here: Off, View only, or View and control. Turning a
// level on asks first what it grants, then for Face ID, Touch ID or the passcode (the phone's
// presence key signs only after that). Turning it off is one tap. Only this section makes these
// calls, and only from a tap by the person.
import { Check, Monitor, ScreenShare } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import type { ScreenMode } from "@/link/types";
import { useCapability, useOnline, usePart } from "@/state/hooks";
import { canProvePresence, hasPresenceKey, PresenceCancelled } from "@/state/presence";
import { showToast, useApp } from "@/state/store";
import { Group, IconTile, Label, Row, space, T, useTheme } from "@/ui";
import { grantScreen, revokeScreen } from "./grant";
import { BLOCKED, confirmWords, displayLine, displayNote, GRANT_CAPABILITY, levelOf, LEVELS, screenAccess, setByLine } from "./grantWords";

export function ScreenAccess() {
  const { colors } = useTheme();
  const host = usePart("host");
  const capable = useCapability(GRANT_CAPABILITY);
  const online = useOnline();
  const route = useApp((state) => state.route);
  const pairing = useApp((state) => state.pairing);
  const phones = usePart("phones");
  const [busy, setBusy] = useState<ScreenMode>();
  if (!pairing) return null;
  const access = screenAccess({ host, capable, online, route, pinned: phones?.[pairing.deviceId]?.presence === true, hasKey: hasPresenceKey(pairing.presenceTag), canProve: canProvePresence() });
  if (access.kind === "none") return null;

  if (access.kind === "computer")
    return (
      <View>
        <Label>Screen</Label>
        <Group>
          <Row leading={<IconTile icon={ScreenShare} color={colors.ink2} />} title={levelOf(access.level).label} subtitle="What phones may do. Change this on your computer." subtitleLines={2} />
        </Group>
      </View>
    );

  const run = async (level: ScreenMode) => {
    setBusy(level);
    try {
      if (level === "off") await revokeScreen();
      else await grantScreen(level, pairing);
      showToast(level === "off" ? "Screen turned off" : levelOf(level).label + " is on", "success");
    } catch (error) {
      // Closing the Face ID or passcode question is an answer: nothing changes and nothing is said.
      if (!(error instanceof PresenceCancelled)) showToast(error instanceof Error ? error.message : "That didn't work.", "error");
    }
    setBusy(undefined);
  };
  // A level is turned on only after the person has read what it grants and said yes.
  const ask = (level: "view" | "control") => {
    const words = confirmWords(level, pairing.name || "this computer");
    Alert.alert(words.title, words.message, [
      { text: "Cancel", style: "cancel" },
      { text: words.action, onPress: () => void run(level) },
    ]);
  };
  const blockedNow = access.level === "off" ? access.turnOn : (access.turnOn ?? access.turnOff);
  const who = setByLine(access.setBy, pairing.deviceId, access.level);

  return (
    <View style={{ gap: space.sm }}>
      <View>
        <Label>Screen</Label>
        <Group>
          {LEVELS.map((level) => {
            const current = level.value === access.level;
            const blocked = level.value === "off" ? access.turnOff : access.turnOn;
            const value = level.value;
            return (
              <Row
                key={value}
                title={level.label}
                subtitle={level.grants}
                subtitleLines={3}
                trailing={busy === value ? <ActivityIndicator color={colors.muted} /> : current ? <Check size={18} color={colors.accentText} strokeWidth={2.6} /> : undefined}
                disabled={!!busy || (!current && !!blocked)}
                onPress={current ? undefined : value === "off" ? () => void run("off") : () => ask(value as "view" | "control")}
              />
            );
          })}
          <Row leading={<IconTile icon={Monitor} color={colors.ink2} />} title="Display" value={displayLine(access.display)} subtitle={displayNote(access.display)} subtitleLines={3} />
        </Group>
      </View>
      {(!!who || !!blockedNow) && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          {[who, blockedNow ? BLOCKED[blockedNow] : undefined].filter(Boolean).join(". ").replace(/\.\.$/, ".")}
        </T>
      )}
    </View>
  );
}
