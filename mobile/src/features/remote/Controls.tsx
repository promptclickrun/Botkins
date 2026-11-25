// The viewer uses Botkins' glass controls and sheets. Keeping help and stats in a local sheet
// lets the picture continue playing while the person reads them.
import { type MenuAction, MenuView } from "@react-native-menu/menu";
import * as Clipboard from "expo-clipboard";
import { ChevronLeft, CircleHelp, ClipboardPaste, Ellipsis, Keyboard } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";
import type { LinkRoute } from "@/link/client";
import type { ScreenDisplay } from "@/link/types";
import { Glass, Group, IconButton, Label, Row, Sheet, space, T, useTheme } from "@/ui";
import { chrome, QUALITY, type QualityId } from "./chrome";
import type { PointerMode } from "./gestures";

export type Panel = "help" | "stats";
export type ViewerOptions = {
  mode: PointerMode;
  control: boolean;
  displays: ScreenDisplay[];
  display?: string;
  video: boolean;
  quality: QualityId;
  onMode: () => void;
  onFit: () => void;
  onDisplay: (id: string) => void;
  onQuality: (id: QualityId) => void;
};

const routeLabel = (route: LinkRoute | null) => route === "direct" ? "Direct connection" : route === "relay" ? "Relay connection" : undefined;
const sf = (symbol: string) => Platform.OS === "ios" ? symbol : undefined;
const selected = (on: boolean) => on ? "on" as const : "off" as const;

function MenuIcon({ icon: Icon, label }: { icon: typeof Ellipsis; label: string }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityRole="button" accessibilityLabel={label}>
      <Glass style={styles.circle}>
        <Icon size={22} color={colors.ink} strokeWidth={2} />
      </Glass>
    </View>
  );
}

export function ViewerHeader({ name, route, status, viewOnly, options, back, help, stats }: {
  name: string;
  route: LinkRoute | null;
  status?: string;
  viewOnly?: boolean;
  options?: ViewerOptions;
  back: () => void;
  help: () => void;
  stats: () => void;
}) {
  const actions: MenuAction[] = [];
  if (options) {
    actions.push(
      { id: "mode", title: "Trackpad mode", image: sf("cursorarrow.motionlines"), state: selected(options.mode === "trackpad"), attributes: { disabled: !options.control } },
      { id: "fit", title: "Fit to screen", image: sf("arrow.down.right.and.arrow.up.left") },
    );
    if (options.displays.length > 1) {
      actions.push({ id: "display", title: "Display", image: sf("display.2"), subactions: options.displays.map(item => ({
        id: "display:" + item.id, title: item.label, state: selected(item.id === options.display),
      })) });
    }
    actions.push({ id: "quality", title: "Quality", image: sf("speedometer"), subactions: (Object.keys(QUALITY) as QualityId[]).map(id => ({
      id: "quality:" + id, title: QUALITY[id].title + (options.video ? " (" + QUALITY[id].fps + " fps)" : ""), state: selected(id === options.quality),
    })) });
  }
  actions.push({ id: "stats", title: "Connection stats", image: sf("chart.bar") });

  function select(id: string) {
    if (id === "stats") return stats();
    if (!options) return;
    if (id === "mode" && options.control) options.onMode();
    else if (id === "fit") options.onFit();
    else if (id.startsWith("display:")) {
      const display = options.displays.find(item => "display:" + item.id === id);
      if (display && display.id !== options.display) options.onDisplay(display.id);
    } else if (id.startsWith("quality:")) {
      const quality = id.slice("quality:".length) as QualityId;
      if (Object.hasOwn(QUALITY, quality) && quality !== options.quality) options.onQuality(quality);
    }
  }

  const subtitle = [status ?? routeLabel(route), viewOnly ? "View only" : undefined].filter(Boolean).join(" · ");
  return (
    <View style={styles.header}>
      <IconButton icon={ChevronLeft} label="Back" variant="glass" size={44} onPress={back} />
      <View accessible accessibilityRole="header" accessibilityLabel={[name, subtitle].filter(Boolean).join(", ")} style={styles.title}>
        <T variant="headline" color={chrome.ink} numberOfLines={1}>{name}</T>
        {!!subtitle && <T variant="caption" color={chrome.muted} numberOfLines={2}>{subtitle}</T>}
      </View>
      <IconButton icon={CircleHelp} label="Gesture help" variant="glass" size={44} onPress={help} />
      <MenuView actions={actions} onPressAction={({ nativeEvent }) => select(nativeEvent.event)} isAnchoredToRight>
        <MenuIcon icon={Ellipsis} label="Computer options" />
      </MenuView>
    </View>
  );
}

/** While connection or viewing permissions are pending these still explain where input will live. */
export function ControlBar({ enabled, paste, keyboard }: { enabled: boolean; paste: () => void; keyboard: () => void }) {
  return (
    <View style={styles.bar}>
      {enabled ? (
        <MenuView actions={[{ id: "paste", title: "Paste from phone", image: sf("doc.on.clipboard") }]} onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "paste") paste();
        }}>
          <MenuIcon icon={ClipboardPaste} label="Clipboard" />
        </MenuView>
      ) : <IconButton icon={ClipboardPaste} label="Clipboard" disabled variant="glass" size={44} />}
      <IconButton icon={Keyboard} label="Keyboard" variant="glass" size={44} disabled={!enabled} onPress={keyboard} />
    </View>
  );
}

export function ProblemLine({ text }: { text: string }) {
  return (
    <View style={styles.problem} accessibilityRole="alert">
      <T variant="footnote" weight="600" color={chrome.inkOn} center>{text}</T>
    </View>
  );
}

const HELP = [
  { title: "Pointer", rows: [
    ["Trackpad", "Slide one finger to move the pointer. Tap once to click, or twice to double-click."],
    ["Drag", "Tap, then touch again and slide without lifting your finger."],
    ["Right-click", "Tap with two fingers or hold one finger still."],
    ["Scroll", "Slide two fingers together to scroll on the computer, even when zoomed in."],
    ["Direct touch", "Turn off Trackpad mode in Computer options. Tap where you want to click, or slide from an item to drag it."],
  ] },
  { title: "Screen", rows: [
    ["Zoom and pan", "Pinch to zoom. Slide three fingers to move around the enlarged screen. In trackpad mode the view also follows the pointer."],
    ["Fit, display and quality", "Use Computer options to fit the entire screen, switch displays or adjust picture quality."],
  ] },
  { title: "Keyboard and clipboard", rows: [
    ["Type", "Tap Keyboard. Use the row above the phone keyboard for Escape, Tab, Delete and the arrow keys."],
    ["Shortcuts", "Tap one or more modifier keys, then the letter or key for the shortcut. The modifiers release after that key."],
    ["Paste", "Tap Clipboard, then Paste from phone to type your clipboard text on the computer."],
  ] },
];

export type StreamDetails = {
  route: LinkRoute | null;
  state: string;
  source?: "video" | "jpeg";
  display?: ScreenDisplay;
  quality?: QualityId;
  frame?: { id: number; width: number; height: number } | null;
  video?: { width: number; height: number; fps: number } | null;
  fallbackReason?: string;
  live?: boolean;
};

export function ViewerPanel({ panel, close, details }: { panel: Panel; close: () => void; details: StreamDetails }) {
  return (
    <Modal visible presentationStyle="pageSheet" animationType="slide" supportedOrientations={["portrait", "landscape"]} onRequestClose={close}>
      {panel === "help" ? (
        <Sheet title="Using the computer" onClose={close}>
          {HELP.map(group => (
            <View key={group.title}>
              <Label>{group.title}</Label>
              <Group>
                {group.rows.map(([title, body]) => <Row key={title} title={title!} subtitle={body} subtitleLines={8} />)}
              </Group>
            </View>
          ))}
        </Sheet>
      ) : <ConnectionStats details={details} close={close} />}
    </Modal>
  );
}

function ConnectionStats({ details, close }: { details: StreamDetails; close: () => void }) {
  const { route, source, frame, video, display, quality } = details;
  const [copied, setCopied] = useState("");
  const [jpegFps, setJpegFps] = useState<number | null>(null);
  const count = useRef(0);
  // Count changes to the displayed slot. A static desktop sends no new JPEGs and measures 0 fps.
  useEffect(() => { if (frame) count.current++; }, [frame?.id]);
  useEffect(() => {
    setJpegFps(null);
    if (source !== "jpeg" || !details.live) return;
    let previous = performance.now();
    count.current = 0;
    const clock = setInterval(() => {
      const now = performance.now();
      setJpegFps(count.current * 1000 / Math.max(1, now - previous));
      count.current = 0;
      previous = now;
    }, 1000);
    return () => clearInterval(clock);
  }, [source, details.live, display?.id, quality]);

  const size = source === "video" ? video : frame;
  const fps = source === "video" ? video?.fps : jpegFps;
  const groups = [
    { title: "Connection", rows: [["Status", details.state], ["Route", routeLabel(route)], ["Display", display?.label]] },
    { title: "Picture", rows: [
      ["Source", source === "video" ? "Live video" : source === "jpeg" ? "JPEG frames" : undefined],
      ["Resolution", size ? size.width + " × " + size.height : undefined],
      ["Frame rate", fps == null || !Number.isFinite(fps) || !details.live ? undefined : Number(fps.toFixed(1)) + " fps"],
      ["Requested quality", quality ? QUALITY[quality].title + (source === "video" ? " · " + QUALITY[quality].fps + " fps" : "") : undefined],
    ] },
  ];
  async function copy() {
    const report = groups.flatMap(group => group.rows.map(([label, value]) => label + ": " + (value ?? "—"))).join("\n");
    try {
      setCopied(await Clipboard.setStringAsync(report) ? "Copied" : "Copy failed");
    } catch {
      setCopied("Copy failed");
    }
  }
  return (
    <Sheet title="Connection stats" onClose={close} action={copied || "Copy"} onAction={() => void copy()}>
      {groups.map(group => (
        <View key={group.title}>
          <Label>{group.title}</Label>
          <Group>
            {group.rows.map(([label, value]) => <Row key={label} title={label!} value={value ?? "—"} />)}
          </Group>
        </View>
      ))}
      {!!details.fallbackReason && <T variant="footnote" color="muted">{details.fallbackReason}</T>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.xs },
  title: { flex: 1, minWidth: 0, paddingHorizontal: space.xs },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.lg, paddingVertical: space.xs },
  problem: { marginHorizontal: space.lg, marginTop: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 12, backgroundColor: chrome.warn },
});
