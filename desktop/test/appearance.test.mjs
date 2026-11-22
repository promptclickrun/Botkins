// How the app looks: its themes (the phone app's, with Ink until a person picks one), light or
// dark, the fonts, the text sizes, and what becomes of an appearance saved by an earlier version.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_FONT, DEFAULT_THEME, FONT_IDS, THEME_IDS, appearanceField, canvasColor, changeSettings, defaultSettings } from "../desktop/preferences.mjs";

const catalog = JSON.parse(readFileSync(new URL("../desktop/themes.json", import.meta.url), "utf8"));
const theme = (id) => catalog.themes.find((t) => t.id === id);
const usual = { theme: "system", colorTheme: "ink", themePicked: false, textSize: "default", font: "system", fontPicked: false, bubble: "theme", avatarAnimations: true, lightBackground: "cream", darkBackground: "charcoal" };

test("the themes are Botkins, the six named after the kit's palettes, Paper and Ink; Ink is what a new person sees", () => {
  assert.deepEqual(THEME_IDS, ["botkins", "honey", "fern", "tidepool", "bluebell", "fig", "paper", "ink"]);
  assert.equal(DEFAULT_THEME, "ink");
  assert.deepEqual(defaultSettings.appearance, usual);
  assert.deepEqual(appearanceField(undefined), usual);
  // Ink: black on white and white on black, and the action color is the ink itself.
  const ink = theme("ink");
  assert.deepEqual([ink.light.canvas, ink.light.ink, ink.light.accent, ink.light.onAccent], ["#FFFFFF", "#000000", "#000000", "#FFFFFF"]);
  assert.deepEqual([ink.dark.canvas, ink.dark.ink, ink.dark.accent, ink.dark.onAccent], ["#000000", "#FFFFFF", "#FFFFFF", "#000000"]);
  assert.equal(ink.mono, true);
  // The window is the theme's own paper before its page draws.
  assert.equal(canvasColor(usual, false), "#FFFFFF");
  assert.equal(canvasColor(usual, true), "#000000");
  assert.equal(canvasColor(undefined, true), "#000000");
  assert.equal(canvasColor({ colorTheme: "botkins" }, false), "#FBF1DE");
  // Every theme has the same colors by name, in light and dark, so the page can draw any of them.
  for (const t of catalog.themes) for (const mode of ["light", "dark"]) assert.deepEqual(Object.keys(t[mode]), Object.keys(ink.light), t.id + " " + mode);
});

test("the Botkins theme is the design kit's palette, value for value", () => {
  const tokens = JSON.parse(readFileSync(new URL("../design/botkins-kit/theme/tokens.json", import.meta.url), "utf8"));
  for (const mode of ["light", "dark"]) {
    const kit = tokens[mode];
    const ours = theme("botkins")[mode];
    assert.deepEqual(
      [ours.canvas, ours.surface, ours.ink, ours.muted, ours.accent, ours.onAccent, ours.lineStrong, ours.success, ours.warning, ours.danger],
      [kit.canvas, kit.surface, kit.ink, kit.muted, kit.action, kit.onAction, kit.border, kit.success, kit.attention, kit.error],
      mode,
    );
  }
});

test("text is readable in every theme", () => {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const t of catalog.themes)
    for (const mode of ["light", "dark"]) {
      const c = t[mode];
      const pairs = { "ink on canvas": [c.ink, c.canvas, 7], "muted on canvas": [c.muted, c.canvas, 4.5], "muted on surface": [c.muted, c.surface, 4.5], "the action color as text": [c.accentText, c.canvas, 4.5], "text on the action color": [c.onAccent, c.accent, 4.5], "text on a bubble": [c.onBubble, c.bubble, 7] };
      for (const [what, [a, b, least]] of Object.entries(pairs)) assert.ok(contrast(a, b) >= least, t.name + " " + mode + ": " + what + " is " + contrast(a, b).toFixed(2) + " to 1");
    }
});

test("the catalog file is what the script writes, and matches the phone app's themes and fonts", async (t) => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-themes.mjs", import.meta.url)), "--check"]);
  // With the phone app's repo beside this one, its own files are the reference.
  const mobile = new URL("../../mobile/src/ui/", import.meta.url);
  const phone = existsSync(new URL("themes.ts", mobile)) ? mobile : new URL("../../botkins/src/ui/", import.meta.url);
  if (!existsSync(new URL("themes.ts", phone))) return t.skip("the phone app's repo isn't beside this one");
  const themes = await import(new URL("themes.ts", phone).href);
  assert.equal(catalog.default, themes.DEFAULT_THEME);
  assert.deepEqual(catalog.themes, JSON.parse(JSON.stringify(themes.THEMES)), "the same themes, value for value");
  const fonts = await import(new URL("fonts.ts", phone).href);
  assert.deepEqual(FONT_IDS, fonts.FONT_IDS);
  assert.equal(DEFAULT_FONT, fonts.DEFAULT_FONT);
});

test("a theme counts once the person picks it; until then the app wears Ink", () => {
  let settings = structuredClone(defaultSettings);
  settings = changeSettings(settings, { appearance: { theme: "dark" } });
  assert.deepEqual([settings.appearance.colorTheme, settings.appearance.themePicked], ["ink", false], "choosing light or dark is not picking a theme");
  settings = changeSettings(settings, { appearance: { textSize: "large", font: "lora" } });
  assert.deepEqual([settings.appearance.colorTheme, settings.appearance.themePicked, settings.appearance.textSize, settings.appearance.font], ["ink", false, "large", "lora"]);
  settings = changeSettings(settings, { appearance: { colorTheme: "tidepool" } });
  assert.deepEqual([settings.appearance.colorTheme, settings.appearance.themePicked], ["tidepool", true]);
  settings = changeSettings(settings, { appearance: { theme: "light" } });
  assert.equal(settings.appearance.colorTheme, "tidepool", "changing light or dark keeps the theme");
  // Botkins, the old usual theme, is a choice like any other once it is picked.
  settings = changeSettings(settings, { appearance: { colorTheme: "botkins" } });
  assert.deepEqual([settings.appearance.colorTheme, settings.appearance.themePicked], ["botkins", true]);
  assert.equal(appearanceField(settings.appearance).colorTheme, "botkins", "and it is kept at the next start");
  // So is Ink.
  settings = changeSettings(settings, { appearance: { colorTheme: "ink" } });
  assert.deepEqual([settings.appearance.colorTheme, settings.appearance.themePicked], ["ink", true]);
  assert.throws(() => changeSettings(settings, { appearance: { colorTheme: "neon" } }), /Invalid appearance/);
  assert.throws(() => changeSettings(settings, { appearance: { textSize: "huge" } }), /Invalid appearance/);
  assert.throws(() => changeSettings(settings, { appearance: { font: "comic" } }), /Invalid appearance/);
  assert.throws(() => changeSettings(settings, { appearance: "dark" }), /Invalid appearance/);
});

test("avatar animations start on for desktop and older settings, and accept an explicit off", () => {
  assert.equal(defaultSettings.appearance.avatarAnimations, true);
  assert.equal(appearanceField(undefined).avatarAnimations, true);
  assert.equal(appearanceField({ avatarAnimations: false }).avatarAnimations, false);
  assert.equal(appearanceField({ avatarAnimations: "no" }).avatarAnimations, true);
  const settings = changeSettings(structuredClone(defaultSettings), { appearance: { avatarAnimations: false } });
  assert.equal(settings.appearance.avatarAnimations, false);
  assert.throws(() => changeSettings(settings, { appearance: { avatarAnimations: "no" } }), /Invalid appearance/);
});

test("an appearance saved by an earlier version keeps a look the person chose, and moves to Ink when they had not chosen", () => {
  const from = (saved) => {
    const a = appearanceField(saved);
    return [a.colorTheme, a.themePicked];
  };
  // Before themes: a background preset other than the usual one was a choice. The light one decides, else the dark one.
  assert.deepEqual(from({ theme: "system", lightBackground: "cream", darkBackground: "charcoal", bubble: "theme" }), ["ink", false]);
  assert.deepEqual(from({ lightBackground: "paper", darkBackground: "charcoal" }), ["paper", true]);
  assert.deepEqual(from({ lightBackground: "sage", darkBackground: "midnight" }), ["fern", true]);
  assert.deepEqual(from({ lightBackground: "cream", darkBackground: "midnight" }), ["bluebell", true]);
  assert.deepEqual(from({ lightBackground: "cream", darkBackground: "forest" }), ["fern", true]);
  // From the first version with themes, which saved "botkins" for everyone: only another theme shows a choice.
  assert.deepEqual(from({ theme: "light", colorTheme: "botkins", textSize: "default", bubble: "theme" }), ["ink", false]);
  assert.deepEqual(from({ theme: "light", colorTheme: "fig", lightBackground: "sage" }), ["fig", true]);
  // Everything else about it is kept: light or dark, the text size, a bubble color of their own, and the old preset names.
  assert.deepEqual(appearanceField({ theme: "dark", colorTheme: "botkins", textSize: "larger", bubble: "#AA5533", lightBackground: "cream", darkBackground: "charcoal" }), { ...usual, theme: "dark", textSize: "larger", bubble: "#AA5533" });
  // Unreadable choices fall back to the usual ones.
  assert.deepEqual(appearanceField({ theme: "neon", colorTheme: "nope", textSize: "huge", font: "comic", bubble: "red", lightBackground: "x" }), usual);
  assert.deepEqual(appearanceField("dark"), usual);
  // An earlier version, or a phone that still offers the presets, picks a theme by choosing one.
  let settings = changeSettings(structuredClone(defaultSettings), { appearance: { darkBackground: "midnight" } });
  assert.deepEqual([settings.appearance.colorTheme, settings.appearance.themePicked], ["bluebell", true]);
  // The same preset sent again (a client that sends the whole appearance) leaves a picked theme alone.
  settings = changeSettings(structuredClone(defaultSettings), { appearance: { colorTheme: "fern" } });
  settings = changeSettings(settings, { appearance: { theme: "light", lightBackground: "cream", darkBackground: "charcoal", bubble: "theme" } });
  assert.equal(settings.appearance.colorTheme, "fern");
  // A settings file from before themes changes without trouble.
  const old = { ...structuredClone(defaultSettings), appearance: { theme: "light", lightBackground: "paper", darkBackground: "charcoal", bubble: "theme" } };
  assert.equal(changeSettings(old, { appearance: { theme: "dark" } }).appearance.colorTheme, "paper");
});

test("the app reads in the system's face until the person picks a font, and a font they picked is kept", () => {
  const font = (saved) => {
    const a = appearanceField(saved);
    return [a.font, a.fontPicked];
  };
  assert.equal(DEFAULT_FONT, "system");
  // Nothing saved: the system's face.
  assert.deepEqual(font(undefined), ["system", false]);
  assert.deepEqual(font({ theme: "dark" }), ["system", false]);
  // "botkins" was saved for everyone before, so without the flag it isn't a choice.
  assert.deepEqual(font({ font: "botkins" }), ["system", false]);
  // Any other saved font was a choice, and is kept as it is.
  for (const id of ["system", "rounded", "avenir", "georgia", "lora", "mono"]) assert.deepEqual(font({ font: id }), [id, true], id);
  // A font picked from now on is kept, the kit's pairing too, and stays kept at the next start.
  let settings = structuredClone(defaultSettings);
  settings = changeSettings(settings, { appearance: { font: "botkins" } });
  assert.deepEqual([settings.appearance.font, settings.appearance.fontPicked], ["botkins", true]);
  assert.deepEqual(font(settings.appearance), ["botkins", true]);
  assert.deepEqual(font(JSON.parse(JSON.stringify(settings.appearance))), ["botkins", true], "after a trip through the settings file");
  settings = changeSettings(settings, { appearance: { theme: "light", textSize: "large" } });
  assert.deepEqual([settings.appearance.font, settings.appearance.fontPicked], ["botkins", true], "other changes keep it");
  settings = changeSettings(settings, { appearance: { font: "lora" } });
  assert.deepEqual(font(settings.appearance), ["lora", true]);
  // Changing something else is not picking a font, nor is the usual font sent again unchanged.
  settings = changeSettings(structuredClone(defaultSettings), { appearance: { textSize: "small" } });
  assert.deepEqual([settings.appearance.font, settings.appearance.fontPicked], ["system", false]);
  settings = changeSettings(settings, { appearance: { theme: "dark", font: "system" } });
  assert.deepEqual([settings.appearance.font, settings.appearance.fontPicked], ["system", false]);
  // An old file that saved "botkins" moves to the system's face on its next change, unless that change picks a font.
  const old = { ...structuredClone(defaultSettings), appearance: { theme: "light", colorTheme: "ink", font: "botkins" } };
  assert.deepEqual(font(changeSettings(old, { appearance: { theme: "dark" } }).appearance), ["system", false]);
  assert.deepEqual(font(changeSettings(old, { appearance: { font: "botkins" } }).appearance), ["botkins", true]);
  // A picked font that is no longer offered falls back to the system's face.
  assert.deepEqual(font({ font: "comic", fontPicked: true }), ["system", false]);
});

test("the fonts are the phone app's: the system's faces where it has them (the default first), the kit's pairing, and Lora", () => {
  assert.deepEqual(FONT_IDS, ["system", "botkins", "rounded", "avenir", "georgia", "lora", "mono"]);
  assert.equal(DEFAULT_FONT, "system");
  const font = (id) => catalog.fonts.find((f) => f.id === id);
  // The kit's pairing has no single family: the styles' own serif and sans are used.
  assert.deepEqual(font("botkins"), { id: "botkins", name: "Botkins" });
  // A face is offered where the system has it: SF Rounded and Avenir Next are the Mac's.
  assert.deepEqual(catalog.fonts.filter((f) => f.id === "botkins" || f.windows).map((f) => f.windowsName ?? f.name), ["Segoe UI", "Botkins", "Georgia", "Lora", "Cascadia Mono"]);
  assert.deepEqual(catalog.fonts.filter((f) => f.id === "botkins" || f.mac).map((f) => f.name), ["San Francisco", "Botkins", "SF Rounded", "Avenir Next", "Georgia", "Lora", "SF Mono"]);
  // Lora ships with the app, in the weights the app uses.
  for (const file of ["Lora-Regular.ttf", "Lora-Italic.ttf", "Lora-SemiBold.ttf", "Lora-Bold.ttf", "Lora-LICENSE.txt"]) assert.ok(existsSync(new URL("../src/fonts/" + file, import.meta.url)), file);
  const styles = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
  assert.equal((styles.match(/font-family: "Lora"/g) ?? []).length, 4);
  // No font is loaded from the network.
  assert.ok(!/url\(["']?https?:/i.test(styles));
});
