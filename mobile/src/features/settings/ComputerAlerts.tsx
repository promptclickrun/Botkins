// The computer's own notifications (its Settings › Notifications): what it alerts about, and quiet
// hours. These are the computer's alerts, not this phone's, so they sit in a group of their own.
import DateTimePicker from "@react-native-community/datetimepicker";
import { BellOff, BellRing, CircleHelp, MessageCircle, Repeat } from "lucide-react-native";
import { useState } from "react";
import { Platform, View } from "react-native";
import type { NotificationSettings } from "@/link/types";
import { useCapability, useOnline, useSettings } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Group, IconTile, Label, Row, space, useTheme } from "@/ui";
import { clockToDate, dateToClock } from "./computer";
import { useHeld } from "./shared";

type Quiet = NotificationSettings["quietHours"];

const timeWords = (clock: string) => clockToDate(clock).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function ComputerAlerts() {
  const theme = useTheme();
  const { colors } = theme;
  const online = useOnline();
  const [alerts, hold] = useHeld(useSettings()?.notifications);
  const [picking, setPicking] = useState<"from" | "to">();
  const canTest = useCapability("maintenance-v1");
  if (!alerts) return null;
  // The computer takes the whole setting at once.
  const set = (patch: Partial<NotificationSettings>) => void hold(patch, () => api.setPreferences({ notifications: { ...alerts, ...patch } }));
  const quiet = alerts.quietHours;
  const setQuiet = (patch: Partial<Quiet>) => set({ quietHours: { ...quiet, ...patch } });

  const timeRow = (which: "from" | "to") => {
    const open = picking === which;
    return (
      <View key={which}>
        <Row title={which === "from" ? "From" : "To"} value={timeWords(quiet[which])} disabled={!online} onPress={() => setPicking(open ? undefined : which)} />
        {open && (
          <View style={{ alignItems: "center", paddingHorizontal: space.sm, paddingBottom: space.sm }}>
            <DateTimePicker
              value={clockToDate(quiet[which])}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              themeVariant={theme.dark ? "dark" : "light"}
              textColor={colors.ink}
              accentColor={colors.accent}
              onValueChange={(_event, date) => {
                if (Platform.OS !== "ios") setPicking(undefined);
                if (date && dateToClock(date) !== quiet[which]) setQuiet({ [which]: dateToClock(date) });
              }}
              onDismiss={() => setPicking(undefined)}
            />
          </View>
        )}
      </View>
    );
  };

  return (
    <>
      <View>
        <Label>On your computer</Label>
        <Group>
          <Row leading={<IconTile icon={MessageCircle} color={colors.ink2} />} title="Replies" subtitle="When a bot finishes in the background" toggled={alerts.replies} disabled={!online} onToggle={(replies) => set({ replies })} />
          <Row leading={<IconTile icon={Repeat} color={colors.ink2} />} title="Routines" subtitle="When a routine finishes or fails" toggled={alerts.routines} disabled={!online} onToggle={(routines) => set({ routines })} />
          <Row leading={<IconTile icon={CircleHelp} color={colors.ink2} />} title="Questions and approvals" subtitle="When a bot needs your answer" toggled={alerts.requests} disabled={!online} onToggle={(requests) => set({ requests })} />
          <Row
            leading={<IconTile icon={BellRing} color={colors.ink2} />}
            title="Send test"
            subtitle={canTest ? "Shows on your computer" : "Update the app on your computer"}
            disabled={!canTest || !online}
            onPress={() => void attempt(api.testNotification(), "Sent. Nothing? Allow Botkins in your computer's system settings.")}
          />
        </Group>
      </View>
      <View>
        <Label>Quiet hours on your computer</Label>
        <Group>
          <Row leading={<IconTile icon={BellOff} color={colors.ink2} />} title="Silence notifications" subtitle="Skipped, not sent later" toggled={quiet.enabled} disabled={!online} onToggle={(enabled) => setQuiet({ enabled })} />
          {quiet.enabled && timeRow("from")}
          {quiet.enabled && timeRow("to")}
        </Group>
      </View>
    </>
  );
}
