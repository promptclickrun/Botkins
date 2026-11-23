import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessStatus } from "../src/link/types";
import { HARNESSES, harnessChoices, harnessName, programAction } from "../src/features/settings/harnessChoices";

const status = (id: string, installed: boolean): HarnessStatus => ({
  id,
  name: id === "omp" ? "OMP" : "Pi",
  description: "",
  harness: true,
  installed,
  connected: installed,
  install: { url: "https://" + id + ".test", command: "install-" + id },
});

test("harness choices show each program only when the computer reports it or it is selected", () => {
  // The computer's order: Pi (the default), each provider's own, the Copilot SDK, OMP.
  assert.deepEqual(HARNESSES.map((choice) => choice.value), ["pi", "provider", "copilot", "omp"]);
  assert.deepEqual(harnessChoices("copilot", undefined).map((choice) => choice.value), ["provider", "copilot"]);
  assert.deepEqual(harnessChoices("copilot", [status("pi", true)]).map((choice) => choice.value), ["pi", "provider", "copilot"]);
  assert.deepEqual(harnessChoices("omp", []).map((choice) => choice.value), ["provider", "copilot", "omp"]);
  assert.deepEqual(harnessChoices("pi", []).map((choice) => choice.value), ["pi", "provider", "copilot"]);
  assert.equal(harnessName("omp"), "OMP");
});

test("program harness install actions are generic for Pi and OMP", () => {
  const pi = status("pi", false);
  const omp = status("omp", false);
  assert.equal(programAction(pi, true), "install");
  assert.equal(programAction(omp, false), "guide");
  assert.equal(programAction({ ...omp, installed: true }, true), null);
  assert.equal(programAction({ ...omp, install: undefined }, false), null);
});
