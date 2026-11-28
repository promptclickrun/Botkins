// The production core trial and StopWatch touch editor against scripted Wi-Fi.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WIFI = process.env.BOTKINS_GADGET_WIFI ?? join(here, "../firmware/build/botkins-gadget-wifi");

test("StopWatch Wi-Fi: touchscreen entry, saved networks, verified rollback and persistence", () => {
  let output;
  try {
    output = execFileSync(WIFI, [], { encoding: "utf8", timeout: 60000 });
  } catch (error) {
    assert.fail(`${error.stdout ?? ""}${error.message}`);
  }
  assert.match(output, /wifi checks ok/);
});
