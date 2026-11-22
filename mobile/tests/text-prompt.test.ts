import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const src = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Alert.prompt exists on iOS only: on Android it does nothing. Typing a line goes through useTextPrompt.
test("only ui/TextPrompt.tsx calls Alert.prompt", () => {
  const callers = sources(src)
    .filter((path) => readFileSync(path, "utf8").includes("Alert.prompt("))
    .map((path) => relative(src, path));
  assert.deepEqual(callers, ["ui/TextPrompt.tsx"]);
});
