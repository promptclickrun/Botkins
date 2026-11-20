// Bots are Botkins: the look model (desktop/looks.mjs), its move from the phone link's file onto
// the bots, what happens to the avatars of earlier versions, and the design kit behind it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { Workspace } from "../desktop/workspace.mjs";
import { CUSTOM, EYES, HEADS, LOOKS_CAPABILITY, PALETTES, cleanLook, linkLooks, lookField, migrateLooks, nextLook, templateLook } from "../desktop/looks.mjs";
import { cleanLook as linkCleanLook } from "../desktop/link/store.mjs";
import { parseTemplateFile, templateFields, templateFile } from "../desktop/templates.mjs";
import { kitOptions } from "../src/lookRender.ts";

const KIT = new URL("../design/botkins-kit/", import.meta.url);
const kitFile = (name) => readFileSync(new URL(name, KIT), "utf8");
/** The kit's renderers, loaded the way a browser loads them: three scripts that share globals. */
function kit() {
  const context = vm.createContext({});
  for (const name of ["customize.js", "motion/catalog.js", "motion/render.js"]) vm.runInContext(kitFile(name), context, { filename: name });
  return vm.runInContext("({ Botkins, BotkinsMotion, BotkinsMotionCatalog })", context);
}
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-looks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const bot = (id, more = {}) => ({ id, name: id, role: "R", instructions: "I", ...more });
const open = (dir) => new Workspace(dir, async () => ({}), () => {});
const seed = (dir, bots) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots, chats: [], runs: [] }));
};

test("the characters and palettes are the design kit's", () => {
  const files = readdirSync(new URL("avatars/", KIT)).filter((name) => name.endsWith(".svg")).map((name) => name.replace(/\.svg$/, "")).sort();
  assert.deepEqual(HEADS, files, "one id for each of the kit's avatars");
  assert.equal(HEADS.length, 20);
  const { Botkins } = kit();
  assert.deepEqual(PALETTES, Object.keys(Botkins.palettes).map((name) => name.toLowerCase()));
  assert.equal(PALETTES.length, 7);
});

test("the kit's own renderer draws every character in every palette and state", () => {
  const { BotkinsMotion, BotkinsMotionCatalog } = kit();
  const states = Object.keys(BotkinsMotionCatalog.states);
  assert.deepEqual(states, ["Idle", "Listening", "Thinking", "Planning", "Browsing", "Coding", "Working", "Waiting", "Needs input", "Retrying", "Completed", "Error", "Like", "Love", "Laugh", "Sad"]);
  const names = { original: "Original", terracotta: "Terracotta", honey: "Honey", fern: "Fern", tidepool: "Tidepool", bluebell: "Bluebell", fig: "Fig" };
  for (const head of HEADS) {
    const source = kitFile("avatars/" + head + ".svg");
    for (const [index, state] of states.entries()) {
      // Each state with a different palette, so every palette and every state is drawn for every head.
      const palette = names[PALETTES[index % PALETTES.length]];
      const svg = BotkinsMotion.render(source, state, { palette });
      assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"), head + " " + state);
      assert.match(svg, new RegExp("<title>[A-Z][a-z]+ · " + state + "</title>"));
      const moving = BotkinsMotionCatalog.states[state];
      assert.ok(svg.includes("@keyframes bk-" + state.toLowerCase().replaceAll(" ", "-")), "it moves through the state's poses");
      assert.equal(svg.includes("infinite"), moving.loop || /bk-blink/.test(svg), head + " " + state);
      // Held still: no motion and no blinking, for people who ask for less motion and for long lists.
      const still = BotkinsMotion.render(source, state, { palette, reducedMotion: true });
      assert.ok(!still.includes("@keyframes"), "a still picture has no animation");
    }
  }
});

test("a look is a character and a palette the kit has", () => {
  assert.deepEqual(lookField({ head: "sprig", palette: "fig", extra: 1 }), { head: "sprig", palette: "fig" });
  assert.throws(() => lookField({ head: "unicorn", palette: "fig" }), /Unknown character/);
  assert.throws(() => lookField({ head: "sprig", palette: "neon" }), /Unknown palette/);
  assert.throws(() => lookField("sprig"), /Choose a character/);
  assert.throws(() => lookField(null), /Choose a character/);
  assert.equal(cleanLook({ head: "sprig" }), null);
  assert.equal(cleanLook({ body: "bighelp.biggie" }), null, "a silhouette from an earlier version is not a look");
  assert.deepEqual(cleanLook({ head: "pip", palette: "original" }), { head: "pip", palette: "original" });
});

test("a new bot gets a character few other bots have", () => {
  const looks = [];
  // Twenty bots in a row are twenty different characters, each in its own colors.
  for (let i = 0; i < 20; i++) looks.push(nextLook("bot-" + i, looks));
  assert.equal(new Set(looks.map((look) => look.head)).size, 20);
  assert.ok(looks.every((look) => look.palette === "original"));
  // The twenty-first shares with one other, not more.
  const more = nextLook("bot-20", looks);
  assert.equal(looks.filter((look) => look.head === more.head).length, 1);
  // The same bot among the same others always gets the same character.
  assert.deepEqual(nextLook("stable", looks.slice(0, 5)), nextLook("stable", looks.slice(0, 5)));
  assert.ok(!looks.slice(0, 5).some((look) => look.head === nextLook("stable", looks.slice(0, 5)).head));
});

test("every bot gets a look on load, and the looks a phone saved in link.json move onto the bots", (t) => {
  const dir = folder(t);
  seed(dir, [
    bot("pip", { face: "idle" }),
    bot("scout", { face: "searching", avatar: { body: "bighelp.scout", main: "#3E9B5E" } }),
    bot("patch", { face: "coding", look: { head: "tinker", palette: "honey" } }),
    bot("odd", { look: { head: "unicorn", palette: "original" } }),
  ]);
  // What the phone link kept before bots had looks: one per bot it had seen, and one for a bot that is gone.
  mkdirSync(join(dir, "link"), { recursive: true });
  const link = { version: 1, serverId: "abc", publicKey: "pk", privateKey: "sk", port: 47610, enabled: true, name: "", devices: [{ id: "d1", publicKey: "x" }], looks: { pip: { head: "luna", palette: "tidepool" }, scout: { head: "muse", palette: "original" }, patch: { head: "wick", palette: "fig" }, gone: { head: "pearl", palette: "original" } } };
  writeFileSync(join(dir, "link", "link.json"), JSON.stringify(link, null, 1));
  assert.deepEqual(Object.keys(linkLooks(dir)), ["pip", "scout", "patch", "gone"]);

  const ws = open(dir);
  assert.deepEqual(ws.bot("pip").look, { head: "luna", palette: "tidepool" }, "the phone's choice moves onto the bot");
  assert.deepEqual(ws.bot("scout").look, { head: "muse", palette: "original" });
  assert.deepEqual(ws.bot("patch").look, { head: "tinker", palette: "honey" }, "a bot's own look wins over the link's");
  const odd = ws.bot("odd").look;
  assert.ok(HEADS.includes(odd.head) && odd.palette === "original", "a look the kit doesn't have is replaced");
  assert.ok(!["luna", "muse", "tinker"].includes(odd.head), "by a character no other bot has");

  // The fields earlier versions drew from are still in the file, untouched, and nothing depends on them.
  const saved = JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  assert.deepEqual(saved.bots.map((b) => b.look), ws.state.bots.map((b) => b.look), "the looks are saved with the bots");
  assert.equal(saved.bots[0].face, "idle");
  assert.deepEqual(saved.bots[1].avatar, { body: "bighelp.scout", main: "#3E9B5E" });
  assert.equal(ws.snapshot().bots[0].look.head, "luna", "the app's page and the phone get the look with the bot");
  // The link's own file is read, never written.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "link", "link.json"), "utf8")), link);

  // Loading again changes nothing, even after the link's file is gone.
  rmSync(join(dir, "link"), { recursive: true });
  assert.deepEqual(open(dir).state.bots.map((b) => b.look), ws.state.bots.map((b) => b.look));
});

test("a workspace from an earlier version opens with its old avatars ignored", (t) => {
  const dir = folder(t);
  // Every shape `avatar` ever had: a silhouette, a cartoon kit character, a body that no longer exists, junk.
  seed(dir, [
    bot("a", { face: "idle", avatar: { body: "classics.kit", eyes: "wide" } }),
    bot("b", { face: "coding", avatar: { character: "fox", theme: "ocean", color: "#3e9b5e" } }),
    bot("c", { face: "searching", avatar: { body: "hermes.round" } }),
    bot("d", { face: "nope", avatar: "bits.bop" }),
    bot("e"),
  ]);
  const ws = open(dir);
  const heads = ws.state.bots.map((b) => b.look.head);
  assert.equal(new Set(heads).size, 5, "five bots, five characters");
  assert.deepEqual(ws.bot("a").avatar, { body: "classics.kit", eyes: "wide" }, "the old field is left as it was");
  assert.equal(ws.bot("d").avatar, "bits.bop");
  // A phone or a template may still send the old fields with a new bot: they are accepted and not kept.
  const id = ws.addBot({ name: "Nova", role: "Editor", instructions: "Edit prose", face: "searching", avatar: { body: "pocket-curios.quill" } });
  assert.equal(ws.bot(id).avatar, undefined);
  assert.ok(!heads.includes(ws.bot(id).look.head), "it gets a character none of the others has");
  ws.updateBot(id, { avatar: { body: "bighelp.scout" }, name: "Nova 2" });
  assert.equal(ws.bot(id).name, "Nova 2", "an update that still carries an avatar goes through");
  assert.equal(ws.bot(id).avatar, undefined);
  assert.throws(() => ws.updateBot(id, { look: { head: "unicorn", palette: "original" } }), /Unknown character/);
  assert.throws(() => ws.addBot({ name: "X", role: "R", instructions: "I", look: { head: "pip", palette: "neon" } }), /Unknown palette/);
});

test("migrateLooks says whether anything changed", () => {
  const state = { bots: [bot("a"), bot("b", { look: { head: "pip", palette: "fern" } })] };
  assert.equal(migrateLooks(state, { a: { head: "pip", palette: "original" } }), true);
  assert.deepEqual(state.bots[0].look, { head: "pip", palette: "original" }, "a look a phone chose is kept even when another bot has that character");
  assert.equal(migrateLooks(state), false);
  assert.equal(migrateLooks({ bots: [] }), false);
});

test("a phone changes a bot's look on the bot itself, and the link keeps no looks of its own", async (t) => {
  const { LinkHost } = await import("../desktop/link/index.mjs");
  const dir = folder(t);
  seed(dir, [bot("pip"), bot("scout")]);
  const ws = open(dir);
  const before = ws.bot("scout").look;
  // The backend desktop/main.mjs gives the link: with `setLook`, looks live on the bots.
  const link = new LinkHost({
    dir: join(dir, "link"),
    port: 0,
    backend: {
      info: () => ({ app: "botkins", version: "0.0.0", platform: process.platform }),
      snapshot: () => ws.snapshot(),
      call: () => {},
      subscribe: () => () => {},
      setLook: (botId, look) => ws.updateBot(String(botId), { look }),
    },
  });
  t.after(() => link.stop());
  await link.dispatch({}, { m: "link.setLook", a: ["pip", { head: "wicket", palette: "bluebell" }] });
  assert.deepEqual(ws.bot("pip").look, { head: "wicket", palette: "bluebell" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")).bots[0].look, { head: "wicket", palette: "bluebell" }, "saved with the bot");
  assert.deepEqual(ws.bot("scout").look, before, "the other bot is untouched");
  // A character the kit doesn't have is refused by the app, and nothing changes.
  await assert.rejects(link.dispatch({}, { m: "link.setLook", a: ["pip", { head: "unicorn", palette: "original" }] }), /Unknown character/);
  await assert.rejects(link.dispatch({}, { m: "link.setLook", a: ["nobody", { head: "pip", palette: "original" }] }), /no longer exists|Unknown bot/);
  assert.deepEqual(ws.bot("pip").look, { head: "wicket", palette: "bluebell" });
  assert.deepEqual(link.store.data.looks, {}, "the link stores none");
});

// Eyes and custom colors. The rules are the phone link's (`cleanLook` in desktop/link/store.mjs,
// the phone's link-host/store.mjs): every case below is checked against it as well.
const FOUR = ["#3E4F86", "#e0b354", "#E8ECF6", "#151a2e"];
const four = FOUR.map((color) => color.toLowerCase());
/** The phone link's verdict: the look it saves, or null when it refuses. */
const linkVerdict = (look) => {
  try {
    return linkCleanLook(look);
  } catch {
    return null;
  }
};

test("a look keeps its eyes and custom colors exactly as the phone link does", () => {
  assert.equal(LOOKS_CAPABILITY, "looks-v2");
  assert.equal(CUSTOM, "custom");
  assert.deepEqual(EYES, ["oval", "button", "smile", "sleepy", "wink", "curious"]);
  const { Botkins } = kit();
  assert.deepEqual(EYES, Array.from(Botkins.eyeStyles, (name) => name.toLowerCase()), "the kit's eye styles");
  const accepted = [
    [{ head: "sprig", palette: "fig", eyes: "wink" }, { head: "sprig", palette: "fig", eyes: "wink" }],
    [{ head: "sprig", palette: "fig", eyes: "oval" }, { head: "sprig", palette: "fig" }],
    [{ head: "sprig", palette: "fig", eyes: null }, { head: "sprig", palette: "fig" }],
    [{ head: "sprig", palette: "fig", eyes: undefined }, { head: "sprig", palette: "fig" }],
    [{ head: "pip", palette: "custom", colors: FOUR }, { head: "pip", palette: "custom", colors: four }],
    [{ head: "pip", palette: "custom", colors: FOUR, eyes: "curious" }, { head: "pip", palette: "custom", eyes: "curious", colors: four }],
    // A kit palette drops colors, good or bad, as the phone link does.
    [{ head: "pip", palette: "honey", colors: FOUR }, { head: "pip", palette: "honey" }],
    [{ head: "pip", palette: "original", colors: ["nope"] }, { head: "pip", palette: "original" }],
    [{ head: "pip", palette: "original", colors: "red" }, { head: "pip", palette: "original" }],
  ];
  for (const eyes of EYES) accepted.push([{ head: "luna", palette: "original", eyes }, eyes === "oval" ? { head: "luna", palette: "original" } : { head: "luna", palette: "original", eyes }]);
  for (const [given, saved] of accepted) {
    assert.deepEqual(cleanLook(given), saved, JSON.stringify(given));
    assert.deepEqual(lookField(given), saved, JSON.stringify(given));
    assert.deepEqual(linkVerdict(given), saved, "the phone link agrees: " + JSON.stringify(given));
    assert.ok(!("eyes" in cleanLook(given)) || cleanLook(given).eyes !== "oval", "oval is never stored");
  }
  const refused = [
    [{ head: "sprig", palette: "fig", eyes: "Wink" }, /Unknown eyes/],
    [{ head: "sprig", palette: "fig", eyes: "laser" }, /Unknown eyes/],
    [{ head: "sprig", palette: "fig", eyes: "" }, /Unknown eyes/],
    [{ head: "sprig", palette: "fig", eyes: 3 }, /Unknown eyes/],
    [{ head: "sprig", palette: "custom" }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: FOUR.slice(0, 3) }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: [...FOUR, "#000000"] }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: ["#3e4f8", ...four.slice(1)] }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: ["#abc", ...four.slice(1)] }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: ["3e4f86", ...four.slice(1)] }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: ["#gggggg", ...four.slice(1)] }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: [null, ...four.slice(1)] }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: "#3e4f86" }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: { 0: "#3e4f86", 1: "#e0b354", 2: "#e8ecf6", 3: "#151a2e", length: 4 } }, /four colors/],
    [{ head: "sprig", palette: "custom", colors: four, eyes: "laser" }, /Unknown eyes/],
  ];
  for (const [given, error] of refused) {
    assert.equal(cleanLook(given), null, JSON.stringify(given));
    assert.throws(() => lookField(given), error, JSON.stringify(given));
    assert.equal(linkVerdict(given), null, "the phone link refuses it too: " + JSON.stringify(given));
  }
  // Stricter than the link on purpose: the app draws only the kit's characters and palettes.
  assert.equal(cleanLook({ head: "unicorn", palette: "custom", colors: four }), null);
  assert.equal(cleanLook({ head: "pip", palette: "neon", eyes: "wink" }), null);
});

test("looks from before eyes and custom colors are unchanged", (t) => {
  for (const head of HEADS) for (const palette of PALETTES) assert.deepEqual(cleanLook({ head, palette }), { head, palette });
  assert.deepEqual(nextLook("x", [{ head: "pip", palette: "custom", colors: four, eyes: "wink" }]).palette, "original");
  // A workspace keeps old looks as they were and new ones with their eyes and colors.
  const dir = folder(t);
  const custom = { head: "pip", palette: "custom", colors: four, eyes: "sleepy" };
  seed(dir, [bot("a", { look: { head: "sprig", palette: "fig" } }), bot("b", { look: custom }), bot("c", { look: { head: "luna", palette: "custom" } }), bot("d", { look: { head: "luna", palette: "fern", eyes: "oval" } })]);
  const ws = open(dir);
  assert.deepEqual(ws.bot("a").look, { head: "sprig", palette: "fig" });
  assert.deepEqual(ws.bot("b").look, custom);
  assert.ok(ws.bot("c").look.palette === "original", "custom without its colors is not a look, so the bot is given one");
  assert.deepEqual(ws.bot("d").look, { head: "luna", palette: "fern" }, "oval is dropped on load");
  ws.updateBot("a", { look: { head: "sprig", palette: "fig", eyes: "smile" } });
  assert.deepEqual(ws.bot("a").look, { head: "sprig", palette: "fig", eyes: "smile" });
  ws.updateBot("a", { look: { head: "sprig", palette: "custom", colors: FOUR } });
  assert.deepEqual(ws.bot("a").look, { head: "sprig", palette: "custom", colors: four });
  assert.throws(() => ws.updateBot("a", { look: { head: "sprig", palette: "custom", colors: FOUR.slice(1) } }), /four colors/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")).bots[0].look, { head: "sprig", palette: "custom", colors: four });
  const id = ws.addBot({ name: "Nova", role: "R", instructions: "I", look: { head: "toast", palette: "honey", eyes: "button", colors: FOUR } });
  assert.deepEqual(ws.bot(id).look, { head: "toast", palette: "honey", eyes: "button" });
});

test("a template carries eyes and custom colors there and back", () => {
  const look = { head: "pip", palette: "custom", eyes: "wink", colors: four };
  const fields = templateFields({ name: "Scout", role: "Researcher", instructions: "Look things up.", look: { ...look, colors: FOUR } });
  assert.deepEqual(fields.look, look);
  const file = templateFile({ ...fields, id: "t1", source: "saved" });
  assert.deepEqual(file.look, look);
  assert.deepEqual(templateFields(parseTemplateFile(JSON.stringify(file))).look, look);
  assert.deepEqual(templateLook({ look: { head: "pip", palette: "fig", eyes: "oval" } }), { head: "pip", palette: "fig" });
  // A look the app can't draw is dropped, and the template still loads.
  assert.equal(templateFields({ name: "X", role: "R", instructions: "I", look: { head: "pip", palette: "custom" } }).look, undefined);
  assert.equal(templateFields({ name: "X", role: "R", instructions: "I", look: { head: "pip", palette: "fig", eyes: "laser" } }).look, undefined);
});

test("the renderer draws a custom look in its four colors and its own eyes", () => {
  const { Botkins, BotkinsMotion, BotkinsMotionCatalog } = kit();
  const draw = (look, state) => BotkinsMotion.render(kitFile("avatars/" + look.head + ".svg"), state, { ...kitOptions(look, BotkinsMotionCatalog.states[state].eyes, Botkins.palettes), reducedMotion: true });
  const colors = ["#2f7fa6", "#e0b354", "#f0c8dc", "#151a2e"];
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // The kit keeps the art's shading: a shell, accent or faceplate color becomes the chosen color
  // made darker (toward black) or lighter (toward white). So each one lies on that line.
  const onLine = (hex, chosen) => {
    const [r, c] = [rgb(hex), rgb(chosen)];
    const near = (made) => made.every((value, i) => Math.abs(Math.round(value) - r[i]) <= 1);
    const top = c.indexOf(Math.max(...c));
    const low = c.indexOf(Math.min(...c));
    const darker = r[top] / c[top];
    const lighter = (r[low] - c[low]) / (255 - c[low]);
    return (darker <= 1.01 && near(c.map((v) => v * darker))) || (lighter >= -0.01 && near(c.map((v) => v + (255 - v) * lighter)));
  };
  // Five characters have no accent in the kit's art, so their accent color has nothing to tint.
  const noAccent = ["crumb", "skiff", "tinker", "wick", "wicket"];
  for (const head of HEADS) {
    const look = { head, palette: "custom", colors };
    const svg = draw(look, "Idle");
    assert.match(svg, new RegExp('<g data-layer="eyes"[^>]*fill="' + colors[3] + '"'), head + ": the eyes are the fourth color, exactly");
    for (const [index, role] of ["shell", "accent", "paper"].entries()) {
      const fills = [...svg.matchAll(new RegExp('<path data-role="' + role + '" fill="(#[0-9a-f]{6})"', "gi"))].map((m) => m[1].toLowerCase());
      assert.equal(fills.length === 0, role === "accent" && noAccent.includes(head), head + " " + role);
      for (const fill of fills) assert.ok(onLine(fill, colors[index]), head + " " + role + " " + fill + " comes from " + colors[index]);
    }
    assert.notEqual(svg, draw({ head, palette: "original" }, "Idle"));
  }
  const look = { head: "sprig", palette: "custom", colors };
  assert.deepEqual(kitOptions(look, "Oval", Botkins.palettes), { palette: colors });
  assert.deepEqual(kitOptions({ ...look, eyes: "wink" }, "Oval", Botkins.palettes), { palette: colors, eyes: "Wink" });
  assert.deepEqual(kitOptions({ head: "sprig", palette: "fig", eyes: "wink" }, "Curious", Botkins.palettes), { palette: "Fig" }, "a state's own expression stays");
  assert.deepEqual(kitOptions({ head: "sprig", palette: "fig" }, "Oval", Botkins.palettes), { palette: "Fig" }, "a look from before passes what it always did");
  assert.deepEqual(kitOptions({ head: "sprig", palette: "custom", colors: colors.slice(1) }, "Oval", Botkins.palettes), { palette: "Original" }, "custom without four colors draws as Original");
  // Idle's eyes are Oval: every eye style draws differently there, and Oval is the same as none.
  const idle = EYES.map((eyes) => draw({ ...look, eyes }, "Idle"));
  assert.equal(new Set(idle).size, EYES.length);
  assert.equal(idle[0], draw(look, "Idle"));
  // Listening is Curious and Completed smiles: their own eyes stay, whatever the bot's are.
  for (const state of ["Listening", "Completed", "Waiting", "Like"]) {
    assert.notEqual(BotkinsMotionCatalog.states[state].eyes, "Oval");
    assert.equal(new Set(EYES.map((eyes) => draw({ ...look, eyes }, state))).size, 1, state);
  }
  // Every state with eyes of Oval takes the bot's eyes.
  for (const [state, clip] of Object.entries(BotkinsMotionCatalog.states)) if (clip.eyes === "Oval") assert.notEqual(draw({ ...look, eyes: "sleepy" }, state), draw(look, state), state);
  // A look from before draws exactly as it did: the kit palette by its name, nothing else.
  for (const palette of PALETTES) {
    const name = Object.keys(Botkins.palettes).find((n) => n.toLowerCase() === palette);
    const source = kitFile("avatars/pip.svg");
    assert.equal(BotkinsMotion.render(source, "Idle", { ...kitOptions({ head: "pip", palette }, "Oval", Botkins.palettes) }), BotkinsMotion.render(source, "Idle", { palette: name }));
  }
});
