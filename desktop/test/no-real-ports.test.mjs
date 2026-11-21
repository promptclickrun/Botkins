// No test listens on a port the installed app uses. The app on the same computer answers its
// sign-ins on REDIRECT_PORT and its phone link on DEFAULT_PORT: a test that listens there takes
// the port from the real app, and does something else when the real app has it. A test asks the
// system for a port (listen(0)) and gives that to the code.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { REDIRECT_PORT } from "../desktop/oauth.mjs";
import { DEFAULT_PORT } from "../desktop/link/store.mjs";

test("no test file listens on the installed app's ports", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const real = ["REDIRECT_PORT", "DEFAULT_PORT", String(REDIRECT_PORT), String(DEFAULT_PORT)].join("|");
  const listens = new RegExp("\\.listen\\(\\s*(?:Number\\()?(?:" + real + ")\\b");
  const found = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".mjs") || name === "no-real-ports.test.mjs") continue;
    readFileSync(join(dir, name), "utf8").split("\n").forEach((line, index) => {
      if (listens.test(line)) found.push(name + ":" + (index + 1));
    });
  }
  assert.deepEqual(found, [], "ask the system for a port with listen(0) and hand it to the code");
});
