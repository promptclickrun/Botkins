// A gadget's page in Settings › Phone ("gadget-settings-v1"): the calls only that page makes
// (desktop/phonepage.mjs) against a real LinkHost, and the page's plain logic (src/gadgetSettings.ts),
// which has the phone's choices and words (mobile/src/features/settings/gadget.ts).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkHost, qrPath, REMOTE_METHODS } from "../desktop/link/index.mjs";
import { phonePage } from "../desktop/phonepage.mjs";
import * as words from "../src/gadgetSettings.ts";

const folders = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const bots = [
  { id: "bot-mira", name: "Mira", role: "Chief of staff" },
  { id: "bot-pip", name: "Pip", role: "Researcher" },
];
function computer(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-gadget-page-"));
  folders.push(dir);
  const link = new LinkHost({
    dir,
    port: 0,
    searchPath: [],
    backend: { info: () => ({ app: "botkins", version: "0.0.0", platform: process.platform }), snapshot: () => ({ bots, chats: [], runs: [] }), call: () => {}, subscribe: () => () => {} },
  });
  t.after(() => link.stop());
  const page = phonePage({ link: () => link, qrPath, screens: { granted: () => ({ system: false, screenRecording: false, accessibility: false }), request: async () => {} } });
  const publicKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x;
  const { deviceId } = link.addGadget({ publicKey, name: "Desk gadget", board: "M5Stack StopWatch", botId: "bot-mira" });
  return { link, page, id: deviceId };
}
const gadgetOf = (status, id) => status.devices.find((device) => device.id === id)?.gadget;

test("the page's calls change the gadget, answer what the page shows, and a phone can make none of them", async (t) => {
  const { page, id } = computer(t);
  for (const name of ["configureGadget", "gadgetWifi", "restartGadget"]) assert.equal(REMOTE_METHODS.has(name), false, name);

  const first = page.phoneLink();
  assert.equal(first.gadgetSettings, true);
  assert.deepEqual(gadgetOf(first, id), { board: "M5Stack StopWatch", botId: "bot-mira", settings: words.GADGET_DEFAULTS });

  const loud = page.configureGadget(id, { volume: 85, mic: "high", mute: true, brightness: 40, dimAfter: 15, offAfter: 900, botId: "bot-pip" });
  assert.deepEqual(gadgetOf(loud, id), { board: "M5Stack StopWatch", botId: "bot-pip", settings: { volume: 85, mic: "high", mute: true, brightness: 40, dimAfter: 15, offAfter: 900 } });
  // A bad value changes nothing, and says why in a sentence the page shows as it comes.
  assert.throws(() => page.configureGadget(id, { volume: 101, mute: false }), /Volume is from 0 to 100\./);
  assert.equal(gadgetOf(page.phoneLink(), id).settings.mute, true);

  // A network waits for the gadget, by name only: the password is in nothing the page is shown.
  const waiting = page.gadgetWifi(id, { add: { ssid: "Studio", password: "correct horse battery" } });
  assert.deepEqual(gadgetOf(waiting, id).wifiWaiting, [{ add: "Studio" }]);
  assert.equal(JSON.stringify(waiting).includes("correct horse"), false);
  assert.throws(() => page.gadgetWifi(id, { add: { ssid: "Studio", password: "short" } }), /8 to 63 characters/);
  assert.deepEqual(words.wifiRows(gadgetOf(waiting, id)).map((row) => [row.ssid, row.status]), [["Studio", "Waiting for the gadget"]]);

  assert.equal(gadgetOf(page.restartGadget(id), id).restarting, true);
  assert.throws(() => page.configureGadget("nobody", { volume: 10 }), /no longer paired/);
});

test("the page's choices and words are the phone's", () => {
  assert.deepEqual(words.DIM_CHOICES.map(words.timerLabel), ["Never", "15 seconds", "30 seconds", "1 minute", "2 minutes", "5 minutes"]);
  assert.deepEqual(words.OFF_CHOICES.map(words.timerLabel), ["Never", "1 minute", "5 minutes", "15 minutes", "30 minutes"]);
  assert.deepEqual(words.MIC_CHOICES.map((choice) => choice.label), ["Low", "Normal", "High"]);
  const phoneFile = new URL("../../mobile/src/features/settings/gadget.ts", import.meta.url);
  if (!existsSync(phoneFile)) return;
  // Below their headers the two files are the same code.
  const body = (url) => readFileSync(url, "utf8").split("\n/** What a gadget starts with")[1];
  assert.equal(body(new URL("../src/gadgetSettings.ts", import.meta.url)), body(phoneFile), "src/gadgetSettings.ts and the phone's gadget.ts have drifted apart");
});
