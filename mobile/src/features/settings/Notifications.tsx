// Settings › Notifications: whether this phone is told about replies, requests and routines, what a
// notification shows, and Live Activities. The choices are kept on the computer for this phone, so
// it knows what to send; the switch that turns everything on is this phone's own. Under them, the
// computer's own notifications (ComputerAlerts).
import { Bell, BellRing, CircleHelp, Download, Eye, MessageCircle, Repeat, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { Linking, View } from "react-native";
import type { PushPrefs } from "@/link/types";
import { useCapability, useMember, useOnline, usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { disablePush, enablePush, pushDefaults, usePush, usePushPrefs } from "@/state/push";
import { showToast } from "@/state/store";
import { Group, IconTile, Label, Page, Row, space, T, useTheme } from "@/ui";
import { ComputerAlerts } from "./ComputerAlerts";

export default function Notifications() {
  const { colors } = useTheme();
  const online = useOnline();
  const supported = usePart("meta")?.capabilities.includes("push-v1");
  const member = useMember();
  const canUpdate = useCapability("app-update-v1");
  const { wanted, status, problem } = usePush();
  const saved = usePushPrefs();
  const [busy, setBusy] = useState(false);
  // A switch holds its new place until the computer says it changed.
  const [pending, setPending] = useState<Partial<PushPrefs>>({});
  const prefs = { ...pushDefaults, ...saved, ...pending };
  const on = wanted && status === "on";

  const toggle = async (next: boolean) => {
    setBusy(true);
    if (next) {
      const result = await enablePush();
      if (result === "denied") showToast("Notifications are off for Botkins in Settings.", "error");
    } else await disablePush();
    setBusy(false);
  };
  const set = async (patch: Partial<PushPrefs>) => {
    setPending((held) => ({ ...held, ...patch }));
    await attempt(api["link.push.prefs"](patch));
    setPending((held) => {
      const rest = { ...held };
      for (const name of Object.keys(patch) as (keyof PushPrefs)[]) delete rest[name];
      return rest;
    });
  };

  if (status === "unsupported")
    return (
      <Page title="Notifications">
        <T variant="subhead" color="muted">
          Update the app to get notifications.
        </T>
        {!member && <ComputerAlerts />}
      </Page>
    );

  return (
    <Page title="Notifications">
      <Group>
        <Row
          leading={<IconTile icon={on ? BellRing : Bell} color={on ? colors.accent : colors.ink2} />}
          title="Notifications"
          subtitle={supported === false ? "Update Botkins on your computer" : status === "denied" ? "Off in Settings" : (problem ?? undefined)}
          subtitleLines={2}
          toggled={on}
          disabled={busy || !online || supported === false}
          onToggle={(next) => void toggle(next)}
        />
        {status === "denied" && <Row key="settings" title="Open Settings" tone="accent" onPress={() => void Linking.openSettings()} />}
      </Group>

      {on && (
        <>
          <View>
            <Label>Tell me when</Label>
            <Group>
              <Row leading={<IconTile icon={MessageCircle} color={colors.ink2} />} title="A bot replies" toggled={prefs.replies} onToggle={(replies) => void set({ replies })} />
              <Row leading={<IconTile icon={CircleHelp} color={colors.ink2} />} title="A bot needs me" subtitle="Approvals and questions" toggled={prefs.requests} onToggle={(requests) => void set({ requests })} />
              <Row leading={<IconTile icon={Repeat} color={colors.ink2} />} title="A routine finishes" subtitle="Each routine can also be made quiet" toggled={prefs.routines} onToggle={(routines) => void set({ routines })} />
              {/* "app-update-v1": a computer from before leaves the choice out, and it counts as on. */}
              {canUpdate && !member && (
                <Row leading={<IconTile icon={Download} color={colors.ink2} />} title="A Botkins update is out" subtitle="For your computer" toggled={prefs.updates !== false} onToggle={(updates) => void set({ updates })} />
              )}
            </Group>
          </View>

          <View>
            <Label>What shows</Label>
            <Group>
              <Row leading={<IconTile icon={Eye} color={colors.ink2} />} title="Show previews" subtitle="The first line of a reply" toggled={prefs.previews} onToggle={(previews) => void set({ previews })} />
              <Row leading={<IconTile icon={Smartphone} color={colors.ink2} />} title="Live Activities" subtitle="A turn on the Lock Screen and in the Dynamic Island" subtitleLines={2} toggled={prefs.activities} onToggle={(activities) => void set({ activities })} />
            </Group>
            <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: space.sm }}>
              What a notification says is sealed between your computer and this phone. A Live Activity shows a step's name only with previews on.
            </T>
          </View>

          {!member && <Group>
            <Row title="Send a test" tone="accent" disabled={!online} onPress={() => void attempt(api["link.push.test"](), "Sent")} />
          </Group>}
        </>
      )}

      {!member && <ComputerAlerts />}
    </Page>
  );
}
