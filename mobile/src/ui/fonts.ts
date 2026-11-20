// The fonts a person can read the app in (Settings › Appearance). No React Native imports here.
//
// The default is the phone's own face ("system": San Francisco on an iPhone), the one the app wears
// until a person picks another. "botkins" is the design kit's pairing: DejaVu Serif Bold for names
// and headlines, Open Sans for the rest. Every other choice is one face used for everything,
// headlines too. Code is always set in the phone's fixed-width face (SF Mono on an iPhone). Lora
// ships with the app; the others belong to the phone, so a choice is listed only where the phone
// has it.

export type FontId = "botkins" | "system" | "rounded" | "avenir" | "georgia" | "lora" | "mono";
export type FontOs = "ios" | "android";

type FontDef = {
  id: FontId;
  /** The name shown on iPhone, and on Android when it differs. */
  name: string;
  androidName?: string;
  /** The family to ask each system for. Missing: this phone doesn't have the face. */
  ios?: string;
  android?: string;
};

const ALL: FontDef[] = [
  { id: "system", name: "San Francisco", androidName: "System", ios: "system-ui", android: "sans-serif" },
  { id: "botkins", name: "Botkins" },
  { id: "rounded", name: "SF Rounded", ios: "ui-rounded" },
  { id: "avenir", name: "Avenir Next", ios: "Avenir Next" },
  { id: "georgia", name: "Georgia", androidName: "Serif", ios: "Georgia", android: "serif" },
  { id: "lora", name: "Lora", ios: "Lora", android: "Lora" },
  { id: "mono", name: "SF Mono", androidName: "Monospace", ios: "ui-monospace", android: "monospace" },
];

/** Families with no medium weight. Asked for one, a phone gives them bold, so a medium is drawn regular instead. */
export const NO_MEDIUM = new Set(["Georgia", "Lora", "serif"]);

export const DEFAULT_FONT: FontId = "system";
/** The kit's own pairing. It names no family: the type scale's own two faces are used. */
export const KIT_FONT: FontId = "botkins";
export const FONT_IDS: FontId[] = ALL.map((font) => font.id);

const osOf = (os: string): FontOs => (os === "android" ? "android" : "ios");

/** The fonts this phone can show, in menu order, with the name to show for each. */
export function fontsFor(os: string): { id: FontId; name: string }[] {
  const which = osOf(os);
  return ALL.filter((font) => font.id === KIT_FONT || font[which]).map((font) => ({ id: font.id, name: (which === "android" && font.androidName) || font.name }));
}

/** The family to set for a choice, or null for the kit's own pairing (also when this phone lacks the face). */
export function fontFamilyOf(id: string | undefined, os: string): string | null {
  return ALL.find((font) => font.id === id)?.[osOf(os)] ?? null;
}
