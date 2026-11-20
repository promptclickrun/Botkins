// Botkins' look: a theme's colors in light or dark, the type scale at the chosen text size, and
// control sizes. The colors live in themes.ts; the choices in @/state/prefs.
import { Platform, useColorScheme } from "react-native";
import { usePrefs } from "@/state/prefs";
import { DEFAULT_FONT, fontFamilyOf, type FontId } from "./fonts";
import { type Colors, contrast, themeById } from "./themes";

export type { Colors } from "./themes";

/** The kit's core palette, for illustration and tints, plus two colors from the artwork. */
export const brand = {
  oat: "#FBF1DE",
  cream: "#FFF8EA",
  espresso: "#42291F",
  clay: "#B45432",
  honey: "#E8A945",
  fern: "#70834B",
  tide: "#548376",
  rose: "#BB6776",
  /** The app icon's background. */
  rust: "#A83519",
  /** The paper of the welcome illustration. */
  peach: "#FCD097",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, huge: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

const mono = Platform.select({ ios: "ui-monospace", default: "monospace" });
/** The kit's faces: DejaVu Serif Bold for names and short headlines, Open Sans for everything else. */
export const DISPLAY_FONT = "DejaVu Serif";
export const BODY_FONT = "Open Sans";

/**
 * The type scale at the default text size (16). A phone pairs a 32-point headline with 16-point
 * body and 13- to 14-point labels. Components read the person's size through `useType()`.
 */
export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700", fontFamily: DISPLAY_FONT, letterSpacing: -0.4 },
  title1: { fontSize: 26, lineHeight: 32, fontWeight: "700", fontFamily: DISPLAY_FONT, letterSpacing: -0.3 },
  title2: { fontSize: 21, lineHeight: 27, fontWeight: "700", fontFamily: DISPLAY_FONT, letterSpacing: -0.2 },
  /** A bot's name, wherever it stands as a title. */
  name: { fontSize: 17, lineHeight: 22, fontWeight: "700", fontFamily: DISPLAY_FONT },
  title3: { fontSize: 18, lineHeight: 24, fontWeight: "700", fontFamily: BODY_FONT },
  headline: { fontSize: 16, lineHeight: 22, fontWeight: "600", fontFamily: BODY_FONT },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400", fontFamily: BODY_FONT },
  callout: { fontSize: 16, lineHeight: 22, fontWeight: "400", fontFamily: BODY_FONT },
  subhead: { fontSize: 14, lineHeight: 20, fontWeight: "400", fontFamily: BODY_FONT },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: "400", fontFamily: BODY_FONT },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "600", fontFamily: BODY_FONT },
  label: { fontSize: 12, lineHeight: 16, fontWeight: "700", fontFamily: BODY_FONT, letterSpacing: 0.6 },
  mono: { fontSize: 13, lineHeight: 19, fontWeight: "400", fontFamily: mono },
} as const;
export type TypeVariant = keyof typeof type;
type Style = (typeof type)[TypeVariant];
export type TypeScale = { [K in TypeVariant]: Omit<(typeof type)[K], "fontSize" | "lineHeight" | "fontFamily"> & { fontSize: number; lineHeight: number; fontFamily: string | undefined } };

export const TEXT_SIZES = { min: 13, max: 20, default: 16 } as const;

const scales = new Map<string, TypeScale>();
/**
 * The type scale at a text size (13 to 20; 16 is the scale as drawn) and in a font. The kit's own
 * pairing keeps its two faces; any other font is one face for everything but code. The phone's own
 * text size still applies on top.
 */
export function scaleType(textSize: number, font: string = DEFAULT_FONT): TypeScale {
  const size = Math.max(TEXT_SIZES.min, Math.min(TEXT_SIZES.max, Math.round(textSize)));
  const family = fontFamilyOf(font, Platform.OS);
  const key = size + ":" + (family ?? "");
  let scaled = scales.get(key);
  if (!scaled) {
    const factor = size / TEXT_SIZES.default;
    scaled = Object.fromEntries(
      (Object.entries(type) as [TypeVariant, Style][]).map(([variant, style]) => [
        variant,
        { ...style, ...(family && variant !== "mono" && { fontFamily: family }), fontSize: Math.round(style.fontSize * factor), lineHeight: Math.round(style.lineHeight * factor) },
      ]),
    ) as TypeScale;
    scales.set(key, scaled);
  }
  return scaled;
}

export type ControlSize = "compact" | "regular" | "large";
/** Heights of the things a person taps. Anything below 44 points gets hit slop up to 44. */
export type ControlMetrics = {
  size: ControlSize;
  button: { lg: number; md: number; sm: number };
  field: number;
  row: number;
  chip: number;
  segmented: number;
  icon: number;
  /** The Close and action buttons in a sheet's header. */
  sheetButton: number;
};
export const CONTROLS: Record<ControlSize, ControlMetrics> = {
  compact: { size: "compact", button: { lg: 48, md: 42, sm: 34 }, field: 44, row: 46, chip: 32, segmented: 36, icon: 40, sheetButton: 32 },
  regular: { size: "regular", button: { lg: 54, md: 46, sm: 36 }, field: 50, row: 54, chip: 36, segmented: 40, icon: 40, sheetButton: 34 },
  large: { size: "large", button: { lg: 60, md: 54, sm: 44 }, field: 58, row: 62, chip: 44, segmented: 48, icon: 48, sheetButton: 40 },
};
/** Hit slop that brings a control of this height up to a 44-point target, and never under 6. */
export const slopFor = (height: number) => Math.max(6, Math.ceil((44 - height) / 2));

export type Theme = { dark: boolean; colors: Colors; type: TypeScale; control: ControlMetrics; themeId: string; /** No color of its own (Ink): icon tiles are drawn in ink. */ mono: boolean };

const themes = new Map<string, Theme>();
/** One theme object per combination, so screens that read it don't redraw for nothing. */
export function resolveTheme(themeId: string, dark: boolean, textSize: number, controlSize: ControlSize, font: FontId = DEFAULT_FONT): Theme {
  const def = themeById(themeId);
  const control = CONTROLS[controlSize] ?? CONTROLS.regular;
  const key = def.id + (dark ? ":d:" : ":l:") + textSize + ":" + control.size + ":" + font;
  let theme = themes.get(key);
  if (!theme) {
    theme = { dark, colors: dark ? def.dark : def.light, type: scaleType(textSize, font), control, themeId: def.id, mono: !!def.mono };
    themes.set(key, theme);
  }
  return theme;
}

/**
 * The colors of a count on the tab bar. iPhone draws the number in white whatever it is asked, so
 * the badge has to be dark enough for white and still stand out from the bar: the action color
 * where that works, else the theme's daytime action color, else a gray.
 */
export function badgeColors(theme: Pick<Theme, "colors" | "themeId">): { background: string; text: string } {
  const { colors } = theme;
  const fits = (color: string) => contrast(color, "#FFFFFF") >= 3 && contrast(color, colors.canvas) >= 1.6;
  return { background: [colors.accent, themeById(theme.themeId).light.accent, colors.faint].find(fits) ?? colors.faint, text: "#FFFFFF" };
}

/** The theme in use: the person's light or dark theme, following the phone unless they chose a mode. */
export function useTheme(): Theme {
  const system = useColorScheme();
  const mode = usePrefs((prefs) => prefs.mode);
  const lightTheme = usePrefs((prefs) => prefs.lightTheme);
  const darkTheme = usePrefs((prefs) => prefs.darkTheme);
  const textSize = usePrefs((prefs) => prefs.textSize);
  const controlSize = usePrefs((prefs) => prefs.controlSize);
  const font = usePrefs((prefs) => prefs.font);
  const dark = mode === "system" ? system === "dark" : mode === "dark";
  return resolveTheme(dark ? darkTheme : lightTheme, dark, textSize, controlSize, font);
}

/** The type scale at the person's text size. */
export function useType(): TypeScale {
  return scaleType(
    usePrefs((prefs) => prefs.textSize),
    usePrefs((prefs) => prefs.font),
  );
}

/** A soft tile color behind an icon: the color at low strength over the surface. */
export function tint(hex: string, strength: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  return "#" + match[1] + Math.round(Math.max(0, Math.min(1, strength)) * 255).toString(16).padStart(2, "0");
}

/** A soft shadow that lifts a card off the canvas. Barely there in dark mode, where borders do the work. */
export function lift(theme: Pick<Theme, "dark" | "colors">, level: 1 | 2 = 1) {
  return {
    shadowColor: theme.colors.shadow,
    shadowOpacity: theme.dark ? 0.3 : level === 1 ? 0.06 : 0.12,
    shadowRadius: level === 1 ? 10 : 22,
    shadowOffset: { width: 0, height: level === 1 ? 3 : 10 },
    elevation: level === 1 ? 2 : 8,
  } as const;
}
