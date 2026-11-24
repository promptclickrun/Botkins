// A gadget's own page (Settings › Devices › a gadget, "gadget-settings-v1"): the bot it talks with,
// its sound and screen, its Wi-Fi networks, rename, restart and remove. The gadget itself has only
// quick controls; everything else is here, and on the desktop app's page with the same words
// (desktop/src/GadgetPage.tsx). The plain logic is gadget.ts.
//
// The device list is not a part, so the page reads it when it opens and again while it is open (the
// gadget changes its own settings and takes Wi-Fi changes by itself). Every change goes through
// `attempt`, and the list the call answers is what shows; a slider sends once, when it is let go.
// A Wi-Fi password lives only in its field and leaves it the moment it is sent.
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { Check, Speaker } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, Modal, View } from "react-native";
import { SecretField } from "@/features/credentials/shared";
import { Choice } from "@/features/voice/settings/shared";
import type { Bot, GadgetSettings, PairedDevice } from "@/link/types";
import { useBots, useCapability, useOnline } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useAppActive } from "@/state/useAppActive";
import { ago } from "@/state/time";
import { BotAvatar, EmptyState, Field, Group, Label, Loading, Page, Row, Segmented, Sheet, Slider, space, T, useTextPrompt, useTheme } from "@/ui";
import { BRIGHTNESS, DIM_CHOICES, firmwareLabel, GADGET_SETTINGS, headerLine, lookAgainMs, MIC_CHOICES, networkProblem, OFF_CHOICES, passwordProblem, shownSettings, talksWith, timerOptions, VOLUME, wifiRows } from "./gadget";

/** How long ago, in the words of the device list: "5m ago", "yesterday". */
function seenWords(time: number) {
  const seen = ago(time);
  if (!seen) return "";
  if (seen === "now") return "just now";
  if (/^\d+[mh]$/.test(seen)) return seen + " ago";
  return seen === "Yesterday" ? "yesterday" : seen;
}

/** A label on the left and a control filling the rest of the row: a slider, a segmented control. */
function ControlRow({ title, children, value }: { title: string; children: ReactNode; value?: string }) {
  return (
    <View style={{ minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.xs, flexDirection: "row", alignItems: "center", gap: space.md }}>
      <T variant="callout" weight="500" style={{ minWidth: 92 }}>
        {title}
      </T>
      <View style={{ flex: 1 }}>{children}</View>
      {value !== undefined && (
        <T variant="subhead" color="muted" style={{ minWidth: 34, textAlign: "right", fontVariant: ["tabular-nums"] }}>
          {value}
        </T>
      )}
    </View>
  );
}

export default function GadgetPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const online = useOnline();
  const supported = useCapability(GADGET_SETTINGS);
  const bots = useBots();
  const [devices, setDevices] = useState<PairedDevice[]>();
  // What the person is changing now: a slider being moved, or a call under way.
  const [held, setHeld] = useState<Partial<GadgetSettings>>({});
  const [sheet, setSheet] = useState<"bot" | "wifi" | null>(null);
  // Renaming asks for a line of text on both phones (Android has no Alert.prompt).
  const prompt = useTextPrompt();
  const device = devices?.find((item) => item.id === id && item.kind === "gadget");
  const gadget = device?.gadget;
  const wait = lookAgainMs(gadget);
  const active = useAppActive(useIsFocused());

  useEffect(() => {
    if (!active || !supported || !online) return;
    let live = true;
    const look = () =>
      void api["link.devices.list"]().then(
        (list) => live && setDevices(list),
        () => {},
      );
    look();
    const timer = setInterval(look, wait);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, supported, online, wait, id]);

  if (!supported) return <Page title="Gadget"><EmptyState icon={Speaker} title="Update the app on your computer" /></Page>;
  if (!devices) return <Page title="Gadget"><Loading /></Page>;
  if (!device) return <Page title="Gadget"><EmptyState icon={Speaker} title="This gadget is no longer paired" /></Page>;

  const settings = shownSettings(gadget, held);
  const saved = shownSettings(gadget);
  const bot = talksWith(bots, gadget?.botId);
  const disabled = !online;

  const configure = async (patch: Partial<GadgetSettings> & { botId?: string }) => {
    const { botId: _botId, ...shown } = patch;
    setHeld((was) => ({ ...was, ...shown }));
    const list = await attempt(api["link.gadgets.configure"](device.id, patch));
    if (list) setDevices(list);
    setHeld((was) => {
      const rest = { ...was };
      for (const key of Object.keys(shown) as (keyof GadgetSettings)[]) delete rest[key];
      return rest;
    });
  };
  /** A slider's value on show while it moves; sent once when it is let go. */
  const slide = (key: "volume" | "brightness") => ({
    onChange: (value: number) => setHeld((was) => ({ ...was, [key]: value })),
    onEnd: (value: number) => {
      if (value !== saved[key]) void configure({ [key]: value });
      else
        setHeld((was) => {
          const { [key]: _gone, ...rest } = was;
          return rest;
        });
    },
  });
  const readAgain = async () => {
    const list = await api["link.devices.list"]().catch(() => undefined);
    if (list) setDevices(list);
  };
  const forget = (ssid: string) =>
    Alert.alert("Forget " + ssid + "?", "The gadget won't join it again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => void attempt(api["link.gadgets.wifi"](device.id, { forget: ssid })).then((queued) => queued && readAgain()),
      },
    ]);
  const rename = () =>
    prompt.ask({
      title: "Rename gadget",
      value: device.name,
      max: 60,
      onSubmit: (next) => {
        if (next !== device.name) void attempt(api["link.devices.rename"](device.id, next)).then((list) => list && setDevices(list));
      },
    });
  const restart = async () => {
    // It answers null; a failure answers undefined.
    if ((await attempt(api["link.gadgets.restart"](device.id))) !== undefined) await readAgain();
  };
  const remove = () =>
    Alert.alert("Remove " + device.name + "?", "It can't reach your computer until it is set up again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void attempt(api["link.devices.remove"](device.id), "Removed").then((list) => {
            if (list) router.back();
          }),
      },
    ]);

  return (
    <Page title={device.name} caption={headerLine(device, seenWords(device.lastSeenAt))}>
      <View>
        <Label>Talks with</Label>
        <Group>
          <Row leading={bot && <BotAvatar bot={bot} size={36} badge={false} />} title={bot?.name ?? "No bot"} value={bot?.role} chevron disabled={disabled || !bots.length} onPress={() => setSheet("bot")} />
        </Group>
      </View>

      <View>
        <Label>Sound</Label>
        <Group>
          <ControlRow title="Volume" value={String(settings.volume)}>
            <Slider value={settings.volume} min={VOLUME.min} max={VOLUME.max} label="Volume" {...slide("volume")} />
          </ControlRow>
          <ControlRow title="Microphone">
            <Segmented options={MIC_CHOICES} value={settings.mic} onChange={(mic) => mic !== settings.mic && void configure({ mic })} />
          </ControlRow>
          <Row title="Microphone off" toggled={settings.mute} disabled={disabled} onToggle={(mute) => void configure({ mute })} />
        </Group>
      </View>

      <View>
        <Label>Screen</Label>
        <Group>
          <ControlRow title="Brightness" value={settings.brightness + "%"}>
            <Slider value={settings.brightness} min={BRIGHTNESS.min} max={BRIGHTNESS.max} label="Brightness" {...slide("brightness")} />
          </ControlRow>
          <Choice title="Dim after" value={String(settings.dimAfter)} options={timerOptions(DIM_CHOICES, settings.dimAfter)} disabled={disabled} onChange={(value) => void configure({ dimAfter: Number(value) })} />
          <Choice title="Turn off after" value={String(settings.offAfter)} options={timerOptions(OFF_CHOICES, settings.offAfter)} disabled={disabled} onChange={(value) => void configure({ offAfter: Number(value) })} />
        </Group>
      </View>

      <View>
        <Label>Wi-Fi</Label>
        <Group>
          {wifiRows(gadget).map((row) => (
            <Row
              key={row.ssid}
              title={row.ssid}
              subtitle={row.status}
              trailing={row.inUse && !row.waiting ? <Check size={18} color={colors.ink2} strokeWidth={2.4} /> : undefined}
              onPress={row.canForget && !disabled ? () => forget(row.ssid) : undefined}
            />
          ))}
          <Row title="Add a network…" tone="accent" disabled={disabled} onPress={() => setSheet("wifi")} />
        </Group>
      </View>

      <View>
        <Label>Gadget</Label>
        <Group>
          <Row title="Rename" chevron disabled={disabled} onPress={rename} />
          <Row title="Restart" subtitle={gadget?.restarting ? "Restarting…" : undefined} disabled={disabled || !!gadget?.restarting} onPress={() => void restart()} />
          <Row title="Firmware" value={firmwareLabel(gadget)} />
        </Group>
      </View>

      <Group>
        <Row title="Remove gadget…" tone="danger" disabled={disabled} onPress={remove} />
      </Group>

      {sheet === "bot" && <BotSheet bots={bots} chosen={bot?.id} onClose={() => setSheet(null)} onPick={(botId) => void configure({ botId })} />}
      {sheet === "wifi" && <WifiSheet deviceId={device.id} onClose={() => setSheet(null)} onSent={() => void readAgain()} />}
      {prompt.node}
    </Page>
  );
}

/** "Talks with": the bots to pick from, each with its Botkin and role. A pick starts a new chat on the gadget. */
function BotSheet({ bots, chosen, onClose, onPick }: { bots: Bot[]; chosen?: string; onClose: () => void; onPick: (botId: string) => void }) {
  const shown = bots.filter((bot) => !bot.hidden || bot.id === chosen);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Sheet title="Talks with" onClose={onClose}>
        <Group>
          {shown.map((bot) => (
            <Row
              key={bot.id}
              leading={<BotAvatar bot={bot} size={40} badge={false} />}
              title={bot.name}
              subtitle={bot.role}
              trailing={bot.id === chosen ? <PickedMark /> : undefined}
              onPress={() => {
                if (bot.id !== chosen) onPick(bot.id);
                onClose();
              }}
            />
          ))}
        </Group>
      </Sheet>
    </Modal>
  );
}

function PickedMark() {
  const { colors } = useTheme();
  return <Check size={20} color={colors.accentText} strokeWidth={2.6} accessibilityLabel="Chosen" />;
}

/** "Add a network…": its name and password. The password is held only in its field and cleared as it is sent. */
function WifiSheet({ deviceId, onClose, onSent }: { deviceId: string; onClose: () => void; onSent: () => void }) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const nameProblem = ssid ? networkProblem(ssid) : null;
  const keyProblem = passwordProblem(password);
  // Closed with a password typed, the field is emptied first: a secure field that goes away with text
  // in it makes iOS offer to save it as a password.
  const close = () => {
    setPassword("");
    requestAnimationFrame(onClose);
  };
  const send = async () => {
    const change = { add: { ssid, password } };
    // The typed password leaves the field as it is sent.
    setPassword("");
    setSending(true);
    const queued = await attempt(api["link.gadgets.wifi"](deviceId, change));
    setSending(false);
    if (queued) {
      onSent();
      close();
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <Sheet title="Add a network" onClose={close} action="Add" onAction={() => void send()} actionDisabled={!ssid || !!networkProblem(ssid) || !!keyProblem} actionLoading={sending}>
        <Field label="Network" value={ssid} onChangeText={setSsid} placeholder="Name" autoCapitalize="none" autoCorrect={false} autoFocus error={nameProblem ?? undefined} />
        <View style={{ gap: space.sm }}>
          <SecretField label="Password" value={password} onChangeText={setPassword} placeholder="None for an open network" error={password.length > 0 ? (keyProblem ?? undefined) : undefined} />
          <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
            The gadget joins it within 10 minutes.
          </T>
        </View>
      </Sheet>
    </Modal>
  );
}
