// No two files in the repository may differ only by case, and neither may two names an import
// reaches without its extension. A Mac's disk ignores case, so there `@/ui/Shimmer` found
// `src/ui/shimmer.ts` beside `src/ui/Shimmer.tsx`: the phone's typecheck failed on the signing Mac
// and no build could ship, while Linux and CI saw two modules and passed (0.17.9).
// Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/** What an import names a module by: its path without a code extension. */
const CODE = /\.(?:d\.)?[cm]?[jt]sx?$/;

test("no two files, or two modules as an import names them, differ only by case", (t) => {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-z", "--full-name"], { cwd: new URL("../..", import.meta.url), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    return t.skip("not a git checkout");
  }
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of files) {
    // Each folder along the way counts too: `Ui/a.ts` and `ui/b.ts` are one folder on a Mac.
    const parts = file.split("/");
    if (CODE.test(file)) {
      const module = file.replace(CODE, "") + "/";
      const key = module.toLowerCase();
      const held = seen.get(key);
      if (held === undefined) seen.set(key, module);
      else if (held !== module && !clashes.includes(held + " ≈ " + module)) clashes.push(held + " ≈ " + module);
    }
    for (let end = 1; end <= parts.length; end++) {
      const path = parts.slice(0, end).join("/");
      const key = path.toLowerCase();
      const held = seen.get(key);
      if (held === undefined) seen.set(key, path);
      else if (held !== path && !clashes.includes(held + " ≈ " + path)) clashes.push(held + " ≈ " + path);
    }
  }
  assert.deepEqual(clashes, [], "rename one of each pair");
});
