// The featured shelf of Marketplace › Skills (desktop/skills-featured.mjs): pinned upstream skills,
// read at their commit, installed with their license through the catalog's preview, conflict and
// install path (desktop/skills-catalog.mjs). Against a fake GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { FEATURED_SKILLS, RENAMED } from "../desktop/skills-featured.mjs";
import { skillsCatalog } from "../desktop/skills-catalog.mjs";
import { REMOTE_METHODS } from "../desktop/link/methods.mjs";
import { WORKSPACE } from "../desktop/terminal/coverage.mjs";

const setup = (t) => new Workspace(tempDir(t), fakeClient().client, () => {}).integrations;
const PINS = {
  "openai/skills": "49f948faa9258a0c61caceaf225e179651397431",
  "anthropics/skills": "3b3fad96af16a10759d930941b4520ba0c40edae",
  "cursor/plugins": "792440e8a560a4a3f63748cdee70491ecd412982",
};

test("every featured skill is pinned to its commit, with its license and author shown", () => {
  assert.equal(new Set(FEATURED_SKILLS.map((s) => s.id)).size, FEATURED_SKILLS.length);
  assert.equal(FEATURED_SKILLS.length, 16);
  for (const skill of FEATURED_SKILLS) {
    assert.equal(skill.commit, PINS[skill.repo], skill.id + " is at the pinned commit");
    assert.match(skill.id, /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{7}$/);
    assert.ok(["MIT", "Apache-2.0"].includes(skill.license), skill.id);
    assert.ok(skill.author && skill.summary && skill.licensePath, skill.id);
    assert.ok(skill.path.endsWith("/" + skill.name), skill.id);
    assert.equal(skill.url, "https://github.com/" + skill.repo + "/tree/" + skill.commit + "/" + skill.path);
  }
  // The pstack pack keeps Lauren Tan's MIT license beside the pack, not in each skill.
  for (const skill of FEATURED_SKILLS.filter((s) => s.pack === "pstack")) assert.deepEqual([skill.license, skill.author, skill.licensePath], ["MIT", "Lauren Tan", "pstack/LICENSE"]);
  // Names asked for under another name use the upstream one.
  for (const upstream of Object.values(RENAMED)) assert.ok(FEATURED_SKILLS.some((s) => s.name === upstream), upstream);
  assert.ok(REMOTE_METHODS.has("skillsCatalog.featured"));
  assert.deepEqual(WORKSPACE["skillsCatalog.featured"], { command: "skills featured" });
});

/** A fake GitHub holding one repository tree at one commit. */
function github(files, commit) {
  const urls = [];
  const blobs = new Map();
  const tree = Object.entries(files).map(([path, text], i) => {
    const sha = (i + 1).toString(16).padStart(40, "a");
    blobs.set(sha, text);
    return { path, mode: "100644", type: "blob", size: Buffer.byteLength(text), sha };
  });
  const request = async (url) => {
    urls.push(url);
    if (url.includes("/trees/")) return url.includes("/trees/" + commit + "?") ? Response.json({ tree }) : new Response(null, { status: 404 });
    const sha = url.split("/blobs/")[1];
    if (blobs.has(sha)) return new Response(blobs.get(sha));
    return new Response(null, { status: 404 });
  };
  return { request, urls };
}

test("the shelf is there with no search, and a pstack skill installs from its commit with the pack's license", async (t) => {
  const skills = setup(t);
  const tdd = FEATURED_SKILLS.find((s) => s.name === "tdd");
  const fake = github({ "pstack/LICENSE": "MIT License\n\nCopyright (c) 2026 Lauren Tan\n", "pstack/skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first\n---\nWrite the failing test.\n", "pstack/skills/other/SKILL.md": "---\nname: other\n---\n" }, tdd.commit);
  const catalog = skillsCatalog(() => skills, fake.request);
  const shelf = catalog.featured();
  assert.equal(shelf.length, FEATURED_SKILLS.length, "no query is needed");
  assert.deepEqual(Object.keys(shelf[0]).sort(), ["author", "commit", "group", "id", "installed", "license", "name", "path", "repo", "summary", "url"].sort());
  const preview = await catalog.preview(tdd.id);
  assert.ok(fake.urls[0].endsWith("/git/trees/" + tdd.commit + "?recursive=1"), "the tree is read at the pinned commit, not HEAD");
  assert.deepEqual(preview.files.sort(), ["LICENSE", "SKILL.md"]);
  assert.deepEqual([preview.source.license, preview.source.author, preview.source.commit], ["MIT", "Lauren Tan", tdd.commit]);
  assert.deepEqual((await catalog.install(preview.token)).added, ["tdd"]);
  const dir = skills.ownSkillDir("tdd");
  assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /Lauren Tan/, "the license is kept with the installed skill");
  assert.equal(existsSync(join(dir, "other")), false, "only the skill's own folder is taken");
  assert.equal(catalog.featured().find((s) => s.id === tdd.id).installed, "tdd");
  // A second install of the same name is a conflict, replaced only when the person says so.
  const again = await catalog.preview(tdd.id);
  assert.deepEqual((await catalog.install(again.token)).conflicts, ["tdd"]);
  assert.deepEqual((await catalog.install(again.token, ["tdd"])).added, ["tdd"]);
});

test("an upstream skill with its license in its own folder keeps it, and a missing license blocks the install", async (t) => {
  const skills = setup(t);
  const threat = FEATURED_SKILLS.find((s) => s.name === "security-threat-model");
  const base = "skills/.curated/security-threat-model/";
  const fake = github({ [base + "SKILL.md"]: "---\nname: security-threat-model\ndescription: Threat model\n---\nSteps\n", [base + "LICENSE.txt"]: "Apache License\nVersion 2.0\n" }, threat.commit);
  const catalog = skillsCatalog(() => skills, fake.request);
  const preview = await catalog.preview(threat.id);
  assert.deepEqual(preview.files.sort(), ["LICENSE.txt", "SKILL.md"]);
  await catalog.install(preview.token);
  assert.match(readFileSync(join(skills.ownSkillDir("security-threat-model"), "LICENSE.txt"), "utf8"), /Apache/);
  const bare = skillsCatalog(() => setup(t), github({ [base + "SKILL.md"]: "---\nname: security-threat-model\n---\n" }, threat.commit).request);
  await assert.rejects(bare.preview(threat.id), /license .* is missing/);
  // A skill gone from that commit says so.
  const gone = skillsCatalog(() => setup(t), github({}, threat.commit).request);
  await assert.rejects(gone.preview(threat.id), /no longer at openai\/skills@49f948f/);
});
