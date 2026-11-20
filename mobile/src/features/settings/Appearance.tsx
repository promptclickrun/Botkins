// How this phone draws the app: light or dark, which theme for each, the font, text size, control size.
// Every choice applies at once.
import { MenuView } from "@react-native-menu/menu";
import { type Href, router } from "expo-router";
import { ChevronsUpDown, Monitor, Moon, SunMoon, Sun, Vibrate } from "lucide-react-native";
import { Platform, StyleSheet, View } from "react-native";
import { useMember, useSettings } from "@/state/hooks";
import { type Prefs, setPrefs, usePrefs } from "@/state/prefs";
import { BotAvatar, brand, Button, type Colors, DEFAULT_FONT, type FontId, fontsFor, Group, IconTile, Label, Page, radius, Row, Segmented, Slider, space, T, Tap, TEXT_SIZES, THEMES, type ThemeDef, themeById, useTheme } from "@/ui";

const MODES: { value: Prefs["mode"]; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const CONTROL_SIZES: { value: Prefs["controlSize"]; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "regular", label: "Regular" },
  { value: "large", label: "Large" },
];

const MOCK = { width: 58, height: 96 };

/** A tiny phone screen in a theme: a title, a row of bots, two list lines and the action color. */
function Screenlet({ colors }: { colors: Colors }) {
  const line = (width: `${number}%`, color: string) => <View style={{ width, height: 3, borderRadius: 2, backgroundColor: color }} />;
  return (
    <View style={{ width: MOCK.width, height: MOCK.height, backgroundColor: colors.canvas, padding: 7, gap: 6 }}>
      {line("55%", colors.ink)}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {[0, 1, 2].map((index) => (
          <View key={index} style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: index === 0 ? colors.primary : colors.lineStrong }} />
        ))}
      </View>
      <View style={{ gap: 4, padding: 4, borderRadius: 4, backgroundColor: colors.surface }}>
        {line("80%", colors.muted)}
        {line("60%", colors.lineStrong)}
      </View>
      <View style={{ marginTop: "auto", height: 9, borderRadius: 5, backgroundColor: colors.primary }} />
    </View>
  );
}

function ModeCard({ value, label, selected }: { value: Prefs["mode"]; label: string; selected: boolean }) {
  const { colors } = useTheme();
  const light = usePrefs((prefs) => themeById(prefs.lightTheme).light);
  const dark = usePrefs((prefs) => themeById(prefs.darkTheme).dark);
  const half = MOCK.width / 2;
  return (
    <Tap
      onPress={() => setPrefs({ mode: value })}
      feel="select"
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      style={{ flex: 1, alignItems: "center", gap: space.sm, paddingVertical: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 2, borderColor: selected ? colors.accent : "transparent" }}
    >
      <View style={{ flexDirection: "row", borderRadius: 10, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong }}>
        {value === "system" ? (
          <>
            <View style={{ width: half, overflow: "hidden" }}>
              <Screenlet colors={light} />
            </View>
            <View style={{ width: half, overflow: "hidden" }}>
              <View style={{ marginLeft: -half }}>
                <Screenlet colors={dark} />
              </View>
            </View>
          </>
        ) : (
          <Screenlet colors={value === "light" ? light : dark} />
        )}
      </View>
      <T variant="subhead" weight="600" color={selected ? "accentText" : "ink"} numberOfLines={1}>
        {label}
      </T>
    </Tap>
  );
}

const ORB = 44;

/** A theme's light or dark look as a small round swatch: its page, a card, and its action color. */
function Orb({ theme, half, selected }: { theme: ThemeDef; half: "light" | "dark"; selected: boolean }) {
  const { colors } = useTheme();
  const look = theme[half];
  const Icon = half === "light" ? Sun : Moon;
  return (
    <Tap
      onPress={() => setPrefs(half === "light" ? { lightTheme: theme.id, themePicked: true } : { darkTheme: theme.id, themePicked: true })}
      feel="select"
      sink={0.92}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={theme.name + ", " + half}
      style={{ padding: 3, borderRadius: ORB, borderWidth: 2, borderColor: selected ? colors.accent : "transparent" }}
    >
      <View style={{ width: ORB, height: ORB, borderRadius: ORB / 2, overflow: "hidden", backgroundColor: look.canvas, borderWidth: StyleSheet.hairlineWidth, borderColor: look.lineStrong }}>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: ORB * 0.42, backgroundColor: look.surface }} />
        <View style={{ position: "absolute", left: ORB / 2 - 8, top: ORB * 0.58 - 8, width: 16, height: 16, borderRadius: 8, backgroundColor: look.primary }} />
      </View>
      {selected && (
        <View style={{ position: "absolute", right: -4, bottom: -4, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.surface, alignItems: "center", justifyContent: "center" }}>
          <Icon size={10} color={colors.onAccent} strokeWidth={2.8} />
        </View>
      )}
    </Tap>
  );
}

/** One theme: tap the card for both halves, or one swatch for just that half. */
function ThemeCard({ theme }: { theme: ThemeDef }) {
  const { colors } = useTheme();
  const lightOn = usePrefs((prefs) => prefs.lightTheme === theme.id);
  const darkOn = usePrefs((prefs) => prefs.darkTheme === theme.id);
  return (
    <View style={{ flex: 1, borderRadius: radius.lg, backgroundColor: colors.surface, paddingTop: space.md, paddingBottom: space.sm, alignItems: "center", gap: 6 }}>
      <Tap
        onPress={() => setPrefs({ lightTheme: theme.id, darkTheme: theme.id, themePicked: true })}
        feel="select"
        sink={1}
        hitSlop={0}
        accessibilityRole="radio"
        accessibilityState={{ checked: lightOn && darkOn }}
        accessibilityLabel={theme.name}
        accessibilityHint="Uses it in light and dark"
        style={StyleSheet.absoluteFill}
      />
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <Orb theme={theme} half="light" selected={lightOn} />
        <Orb theme={theme} half="dark" selected={darkOn} />
      </View>
      <View pointerEvents="none">
        <T variant="footnote" weight="600" color={lightOn || darkOn ? "ink" : "muted"} numberOfLines={1}>
          {theme.name}
        </T>
      </View>
    </View>
  );
}

/** A short chat at the chosen text size. */
function TextPreview() {
  const { colors } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ gap: space.md, padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <BotAvatar look={{ head: "sprig", palette: "original" }} size={32} badge={false} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="name">Sprig</T>
          <T variant="body">Your plan for today is ready.</T>
        </View>
      </View>
      <View style={{ alignSelf: "flex-end", maxWidth: "80%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.lg, backgroundColor: colors.bubble }}>
        <T variant="callout" color="onBubble">
          Thanks, looks good.
        </T>
      </View>
    </View>
  );
}

const pairs = <V,>(items: V[]) => Array.from({ length: Math.ceil(items.length / 2) }, (_, index) => items.slice(index * 2, index * 2 + 2));

const FONTS = fontsFor(Platform.OS);

/** The font the app is read in: a row that opens the phone's own menu of the faces it has. */
function FontMenu() {
  const { colors } = useTheme();
  const font = usePrefs((prefs) => prefs.font);
  const current = FONTS.find((option) => option.id === font) ?? FONTS.find((option) => option.id === DEFAULT_FONT)!;
  return (
    <MenuView
      actions={FONTS.map((option) => ({ id: option.id, title: option.name, state: option.id === current.id ? "on" : "off" }))}
      onPressAction={({ nativeEvent }) => setPrefs({ font: nativeEvent.event as FontId, fontPicked: true })}
      isAnchoredToRight
    >
      <View accessible accessibilityRole="button" accessibilityLabel={"Font, " + current.name} accessibilityHint="Opens the choices">
        <Row title="Font" value={current.name} trailing={<ChevronsUpDown size={16} color={colors.faint} strokeWidth={2.2} />} />
      </View>
    </MenuView>
  );
}

export default function Appearance() {
  const mode = usePrefs((prefs) => prefs.mode);
  const textSize = usePrefs((prefs) => prefs.textSize);
  const controlSize = usePrefs((prefs) => prefs.controlSize);
  const haptics = usePrefs((prefs) => prefs.haptics);
  const paired = !!useSettings();
  const member = useMember();
  const fixed = { maxFontSizeMultiplier: 1 } as const;

  return (
    <Page title="Appearance" quietLink>
      <View>
        <Label>Mode</Label>
        <View style={{ flexDirection: "row", gap: space.md }} accessibilityRole="radiogroup">
          {MODES.map((choice) => (
            <ModeCard key={choice.value} value={choice.value} label={choice.label} selected={choice.value === mode} />
          ))}
        </View>
      </View>

      <View>
        <Label>Theme</Label>
        <View style={{ gap: space.md }}>
          {pairs(THEMES).map((row) => (
            <View key={row[0].id} style={{ flexDirection: "row", gap: space.md }}>
              {row.map((theme) => (
                <ThemeCard key={theme.id} theme={theme} />
              ))}
              {row.length === 1 && <View style={{ flex: 1 }} />}
            </View>
          ))}
        </View>
      </View>

      <View style={{ gap: space.md }}>
        <Label style={{ marginBottom: 0 }}>Text</Label>
        <TextPreview />
        <Group>
          <FontMenu />
        </Group>
        <Slider
          value={textSize}
          min={TEXT_SIZES.min}
          max={TEXT_SIZES.max}
          onChange={(next) => setPrefs({ textSize: next })}
          label="Text size"
          start={
            <T variant="footnote" weight="600" color="muted" style={{ fontSize: 13, lineHeight: 18 }} {...fixed}>
              A
            </T>
          }
          end={
            <T variant="title2" style={{ fontSize: 22, lineHeight: 28 }} {...fixed}>
              A
            </T>
          }
        />
      </View>

      <View style={{ gap: space.md }}>
        <Label style={{ marginBottom: 0 }}>Controls</Label>
        <Segmented options={CONTROL_SIZES} value={controlSize} onChange={(next) => setPrefs({ controlSize: next })} />
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ gap: space.md }}>
          <Button title="Button" wide />
          <Group>
            <Row leading={<IconTile icon={SunMoon} color={brand.rose} />} title="Row" chevron onPress={() => {}} />
          </Group>
        </View>
      </View>

      <Group>
        <Row leading={<IconTile icon={Vibrate} color={brand.rose} />} title="Haptics" toggled={haptics} onToggle={(next) => setPrefs({ haptics: next })} />
      </Group>

      {paired && !member && (
        <Group>
          <Row leading={<IconTile icon={Monitor} color={brand.tide} />} title="Your computer's window" subtitle="Its theme, text and side menu" chevron onPress={() => router.push("/settings/window" as Href)} />
        </Group>
      )}
    </Page>
  );
}
