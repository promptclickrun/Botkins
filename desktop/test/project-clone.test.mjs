import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneProjectRepository } from "../desktop/project-clone.mjs";
import { repositoryName } from "../desktop/link/project-folders.mjs";

test("only GitHub repository names and supported GitHub URLs are accepted", () => {
  for (const input of ["Org/repo", "https://github.com/Org/repo", "git@github.com:Org/repo.git", "ssh://git@github.com/Org/repo.git"]) assert.equal(repositoryName(input), "Org/repo");
  for (const input of ["https://evil.test/Org/repo", "Org/..", "Org/.", "-Org/foo", "Org/a?b", "Org/a/b", "Org/repo\n--flag", "git@github.com:Org/-x", "Org/repo#main", "Org/repo/.git"]) assert.throws(() => repositoryName(input), /GitHub/);
});

test("clone uses signed-in gh or HTTPS git, publishing only a complete checkout", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "botkins-clone-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  let signedIn = true, fail = false;
  const tools = {
    find: (name) => name,
    run: async (_label, tool, args, { env }) => {
      if (args[0] === "auth") {
        if (!signedIn) throw new Error("signed out");
        return;
      }
      assert.equal(env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(tool, signedIn ? "gh" : "git");
      assert.deepEqual(args.slice(0, -1), signedIn ? ["repo", "clone", "--no-upstream", "--", "Owner/site"] : ["clone", "--", "https://github.com/Owner/site.git"]);
      mkdirSync(args.at(-1));
      writeFileSync(join(args.at(-1), "tracked"), "content");
      if (fail) throw Object.assign(new Error(), { detail: "repository not found" });
    },
  };
  const clone = () => cloneProjectRepository("Owner/site", parent, (folder) => folder, tools);
  const dest = join(parent, "site");
  assert.equal(await clone(), dest);
  await assert.rejects(clone(), /not empty/);
  rmSync(dest, { recursive: true });
  signedIn = false;
  fail = true;
  await assert.rejects(clone(), /Sign in/);
  assert.deepEqual(readdirSync(parent), []);
  mkdirSync(dest);
  await assert.rejects(clone(), /access denied/);
  assert.deepEqual(readdirSync(dest), []);
  fail = false;
  assert.equal(await clone(), dest);
});
