// A gadget's page (src/features/settings/gadget.ts): the timer choices and their words, the value a
// setting shows, what each Wi-Fi row says, and the checks a new network gets before it is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSettings, cleanWifiChange, GADGET_DEFAULTS as HOST_DEFAULTS } from "../link-host/gadget.mjs";
import { DIM_CHOICES, GADGET_DEFAULTS, headerLine, lookAgainMs, networkProblem, OFF_CHOICES, passwordProblem, shownSettings, talksWith, timerLabel, timerOptions, wifiRows } from "../src/features/settings/gadget";

test("the timers' choices and words, and a value set elsewhere shown among them", () => {
  assert.deepEqual(DIM_CHOICES.map(timerLabel), ["Never", "15 seconds", "30 seconds", "1 minute", "2 minutes", "5 minutes"]);
  assert.deepEqual(OFF_CHOICES.map(timerLabel), ["Never", "1 minute", "5 minutes", "15 minutes", "30 minutes"]);
  assert.equal(timerLabel(3600), "1 hour");
  assert.equal(timerLabel(90), "90 seconds");
  assert.deepEqual(timerOptions(DIM_CHOICES, 30), DIM_CHOICES.map((seconds) => ({ value: String(seconds), label: timerLabel(seconds) })));
  assert.deepEqual(
    timerOptions(OFF_CHOICES, 120).map((option) => option.label),
    ["Never", "1 minute", "2 minutes", "5 minutes", "15 minutes", "30 minutes"],
  );
  // Every choice is one the computer takes.
  for (const dimAfter of DIM_CHOICES) assert.deepEqual(cleanSettings({ dimAfter }), { dimAfter });
  for (const offAfter of OFF_CHOICES) assert.deepEqual(cleanSettings({ offAfter }), { offAfter });
});

test("a setting shows what is being changed, else the computer's, else the default", () => {
  assert.deepEqual(GADGET_DEFAULTS, HOST_DEFAULTS);
  assert.deepEqual(shownSettings(undefined), GADGET_DEFAULTS);
  const gadget = { settings: { ...GADGET_DEFAULTS, volume: 35, mute: true } };
  assert.equal(shownSettings(gadget).volume, 35);
  assert.equal(shownSettings(gadget, { volume: 72 }).volume, 72);
  assert.equal(shownSettings(gadget, { volume: 72 }).mute, true);
});

test("the header says online or when it was seen, then the board", () => {
  assert.equal(headerLine({ connected: true, lastSeenAt: 1, gadget: { board: "M5Stack StopWatch" } }, "now"), "Online · M5Stack StopWatch");
  assert.equal(headerLine({ connected: false, lastSeenAt: 1, gadget: {} }, "5m ago"), "Last seen 5m ago");
  assert.equal(headerLine({ connected: false, lastSeenAt: 0 }, ""), "Not seen yet");
});

test("the bot it talks with is the one it names, else the first shown", () => {
  const bots = [
    { id: "a", hidden: true },
    { id: "b" },
    { id: "c" },
  ];
  assert.equal(talksWith(bots, "c")?.id, "c");
  assert.equal(talksWith(bots, "gone")?.id, "b");
  assert.equal(talksWith(bots, undefined)?.id, "b");
  assert.equal(talksWith([], "c"), undefined);
});

test("Wi-Fi rows: the network in use with its signal, the saved ones, and changes still waiting", () => {
  const rows = wifiRows({
    wifi: { network: "Home", saved: ["Studio", "Home", "Cafe"], signal: -60 },
    wifiWaiting: [{ add: "Attic" }, { forget: "Cafe" }, { add: "Studio" }],
  });
  assert.deepEqual(
    rows.map((row) => [row.ssid, row.status, row.canForget]),
    [
      ["Home", "Connected · Good signal", true],
      ["Studio", "Saved · Waiting for the gadget", true],
      ["Cafe", "Forgetting · Waiting for the gadget", false],
      ["Attic", "Waiting for the gadget", false],
    ],
  );
  assert.equal(rows[0].inUse, true);
  // Once the gadget took them, nothing waits.
  assert.deepEqual(
    wifiRows({ wifi: { network: "Home", saved: ["Home", "Attic"] } }).map((row) => [row.ssid, row.status, row.waiting]),
    [
      ["Home", "Connected", false],
      ["Attic", "Saved", false],
    ],
  );
  assert.deepEqual(wifiRows(undefined), []);
});

test("a new network is checked as the computer checks it, and the page looks again sooner while one waits", () => {
  for (const [ssid, password] of [
    ["Home", "correct horse"],
    ["Open cafe", ""],
    ["x".repeat(32), "p".repeat(63)],
  ]) {
    assert.equal(networkProblem(ssid), null);
    assert.equal(passwordProblem(password), null);
    assert.doesNotThrow(() => cleanWifiChange({ add: { ssid, password } }));
  }
  for (const ssid of ["", "x".repeat(33), "é".repeat(17), "line\nbreak"]) {
    assert.equal(networkProblem(ssid), "Give the Wi-Fi network's name (up to 32 letters).");
    assert.throws(() => cleanWifiChange({ add: { ssid, password: "" } }));
  }
  for (const password of ["short", "p".repeat(64)]) {
    assert.equal(passwordProblem(password), "A Wi-Fi password has 8 to 63 characters, or none for an open network.");
    assert.throws(() => cleanWifiChange({ add: { ssid: "Home", password } }));
  }
  assert.equal(lookAgainMs({ wifiWaiting: [{ add: "Attic" }] }), 3000);
  assert.equal(lookAgainMs({ restarting: true }), 3000);
  assert.equal(lookAgainMs({}), 15000);
});
