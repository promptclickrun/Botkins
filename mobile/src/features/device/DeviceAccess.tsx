// Tools › Device access: what bots may use on this phone, source by source, and what they used.
import { ExternalLink, Laptop, Mail, MessageCircle } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, View } from "react-native";
import type { Access } from "@/device/access";
import { levelsOf, SOURCE_NAMES, SOURCES, toolLabel, toolOf } from "@/device/tools";
import type { DeviceLevel, DeviceSource } from "@/link/types";
import { setSourceLevel, useDevicePrefs } from "@/state/devicePrefs";
import { usePart, useSettings } from "@/state/hooks";
import { ago } from "@/state/time";
import { Group, IconTile, Label, Page, Row, Segmented, space, T, useTheme } from "@/ui";
import { SOURCE_UI } from "./sources";

type On = Exclude<DeviceLevel, "off">;
type Held = { access?: Access; refused?: boolean };

const LEVEL_WORDS: Record<DeviceLevel, string> = { off: "Off", read: "Read", interact: "Interact" };
const MAC_WORDS: Record<DeviceLevel, string> = { off: "Off. Turn it on in Botkins on your Mac", read: "Read", interact: "Read and interact" };
const PHONE_SOURCES = Platform.OS === "ios" ? SOURCES : SOURCES.filter((source) => source !== "music");

const usable = (access: Access | undefined) => access?.state === "granted" || access?.state === "limited" || access?.state === "asked";
const openSettings = () => void Linking.openSettings().catch(() => {});

/** The short word at the right of a source: what iOS allows, when it matters. */
function statusOf(source: DeviceSource, level: DeviceLevel, held: Held): string | undefined {
  if (held.refused) return "Not allowed";
  const access = held.access;
  if (level === "off" || !access) return undefined;
  if (access.state === "denied") return "Off in iOS Settings";
  if (access.state === "unavailable") return access.reason ?? "Update the app";
  if (access.state === "undetermined") return "Not set up";
  if (access.state === "asked") return "Allowed in Health";
  if (access.state === "limited") return source === "photos" ? "Some photos" : source === "contacts" ? "Some contacts" : "Partly allowed";
  if (access.approximate) return "Approximate";
  return undefined;
}

function SourceCard({ source, held, onHeld }: { source: DeviceSource; held: Held; onHeld: (source: DeviceSource, held: Held) => void }) {
  const ui = SOURCE_UI[source];
  const level = useDevicePrefs((state) => state.sources[source] ?? "off");
  const [busy, setBusy] = useState(false);
  const levels = levelsOf(source);

  const change = async (next: DeviceLevel) => {
    if (next === level || busy) return;
    if (next === "off") {
      setSourceLevel(source, "off");
      onHeld(source, { access: held.access });
      return;
    }
    setBusy(true);
    let access: Access;
    try {
      access = await ui.ask(next as On);
    } catch {
      access = { state: "unavailable" };
    }
    setBusy(false);
    // iOS said no: the switch stays where it was, and the row offers Settings.
    if (!usable(access)) return onHeld(source, { access, refused: access.state === "denied" || access.state === "undetermined" });
    setSourceLevel(source, next);
    onHeld(source, { access });
  };

  const status = statusOf(source, level, held);
  const denied = held.refused || (level !== "off" && held.access?.state === "denied");
  const limited = level !== "off" && held.access?.state === "limited" && ui.more;
  const unavailable = held.access?.state === "unavailable";
  const name = SOURCE_NAMES[source];

  return (
    <Group>
      <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <IconTile icon={ui.icon} color={ui.color} size={32} />
          <T variant="callout" weight="600" style={{ flex: 1 }} numberOfLines={1}>
            {name}
          </T>
          {!!(status || unavailable) && (
            <T variant="footnote" color="muted" numberOfLines={1} style={{ maxWidth: "55%" }}>
              {status ?? held.access?.reason ?? "Update the app"}
            </T>
          )}
        </View>
        <Segmented
          options={levels.map((value) => ({ value, label: ui.labels?.[value] ?? LEVEL_WORDS[value] }))}
          value={level}
          onChange={(next) => void change(next)}
        />
        <View style={{ gap: 2 }}>
          <T variant="footnote" color="muted">
            {ui.says[level]}
          </T>
          {!!ui.note && (
            <T variant="footnote" color="muted">
              {ui.note}
            </T>
          )}
        </View>
      </View>
      {denied && <Row title="Open Settings" tone="accent" leading={<IconTile icon={ExternalLink} size={28} />} onPress={openSettings} />}
      {!denied && limited && <Row title={ui.more!.label} tone="accent" onPress={() => void ui.more!.run().then(() => ui.check(level as On).then((access) => onHeld(source, { access })), () => {})} />}
      {!denied && source === "health" && level !== "off" && held.access?.state === "asked" && <Row title="Health settings" subtitle="Choose what Botkins may read" tone="accent" onPress={openSettings} />}
    </Group>
  );
}

function MacTools() {
  const settings = useSettings();
  const meta = usePart("meta");
  if (!meta) return null;
  if (meta.platform !== "darwin")
    return (
      <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
        iMessage needs Botkins on a Mac
      </T>
    );
  const mac = settings?.macTools;
  if (!mac) return null;
  return (
    <View>
      <Label>On your Mac</Label>
      <Group>
        <Row leading={<IconTile icon={MessageCircle} size={32} />} title="iMessage" subtitle={MAC_WORDS[mac.imessage ?? "off"]} subtitleLines={2} />
        <Row leading={<IconTile icon={Mail} size={32} />} title="Mail" subtitle={MAC_WORDS[mac.mail ?? "off"]} subtitleLines={2} />
      </Group>
    </View>
  );
}

function Activity() {
  const { colors } = useTheme();
  const activity = useDevicePrefs((state) => state.activity);
  const bots = usePart("bots");
  return (
    <View>
      <Label>Recent activity</Label>
      {activity.length === 0 ? (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          Nothing yet
        </T>
      ) : (
        <Group>
          {activity.map((entry) => {
            const source = toolOf(entry.tool)?.source;
            const bot = bots?.find((candidate) => candidate.id === entry.botId)?.name ?? entry.bot ?? "A bot";
            const outcome = entry.ok ? undefined : entry.error ?? "Didn't work";
            return (
              <Row
                key={entry.id}
                leading={<IconTile icon={source ? SOURCE_UI[source].icon : Laptop} color={entry.ok ? (source ? SOURCE_UI[source].color : undefined) : colors.danger} size={32} />}
                title={toolLabel(entry.tool)}
                subtitle={[bot, ago(entry.at), outcome].filter(Boolean).join(" · ")}
                subtitleLines={outcome ? 2 : 1}
              />
            );
          })}
        </Group>
      )}
    </View>
  );
}

export default function DeviceAccess() {
  const meta = usePart("meta");
  const sources = useDevicePrefs((state) => state.sources);
  const [held, setHeld] = useState<Partial<Record<DeviceSource, Held>>>({});
  const onHeld = useCallback((source: DeviceSource, next: Held) => setHeld((all) => ({ ...all, [source]: next })), []);

  const heldNow = useRef(held);
  useEffect(() => {
    heldNow.current = held;
  }, [held]);

  // What iOS allows is read again whenever the app comes back, as a person may have changed it in
  // Settings: for each source that is on, and each one iOS refused.
  const look = useCallback(async () => {
    const levels = useDevicePrefs.getState().sources;
    const found = await Promise.all(
      PHONE_SOURCES.map(async (source) => {
        const level = levels[source] ?? "off";
        const refused = heldNow.current[source]?.refused;
        if (level === "off" && !refused) return [source, undefined] as const;
        try {
          const access = await SOURCE_UI[source].check(level === "off" ? (levelsOf(source)[1] as On) : level);
          // A refusal stands until Settings allows it.
          return [source, { access, refused: level === "off" ? !usable(access) : undefined }] as const;
        } catch {
          return [source, undefined] as const;
        }
      }),
    );
    setHeld((all) => {
      const next = { ...all };
      for (const [source, value] of found) if (value) next[source] = value;
      return next;
    });
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => state === "active" && void look());
    return () => subscription.remove();
  }, [look]);
  // A level that changed elsewhere (another screen, a restore) is checked too.
  useEffect(() => {
    void look();
  }, [sources, look]);

  const old = meta && !meta.capabilities?.includes("device-v1");

  return (
    <Page title="Device access" caption="Bots can use what you turn on here. They ask while Botkins is open, or soon after a notification.">
      {old && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: -space.md }}>
          Update Botkins on your computer
        </T>
      )}
      {PHONE_SOURCES.map((source) => (
        <SourceCard key={source} source={source} held={held[source] ?? {}} onHeld={onHeld} />
      ))}
      <MacTools />
      <Activity />
    </Page>
  );
}
