import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zip } from "../desktop/zip.mjs";
import { Workspace } from "./starter.mjs";
import { uploadSkill, MAX_ENTRIES, MAX_SKILLS, MAX_UPLOAD, MAX_UNPACKED } from "../desktop/link/skill-import.mjs";
import { skillsCatalog } from "../desktop/skills-catalog.mjs";
import { tempDir, fakeClient } from "./fake-copilot.mjs";

function setup(t) {
  return new Workspace(tempDir(t), fakeClient().client, () => {}).integrations;
}
const file = (filename, bytes) => ({ filename, data: Buffer.from(bytes).toString("base64") });
const archive = (paths) => zip(paths.map((path) => ({ path, data: "Instructions" })));

test("Markdown keeps its metadata, falls back to a safe filename, and enables a confirmed replacement", async (t) => {
  const skills = setup(t);
  assert.deepEqual((await uploadSkill(skills, file("My Notes.md", "Keep notes"))).added, ["my-notes"]);
  skills.setSkillEnabled("my-notes", false);
  const next = file("updated.md", "---\nname: my-notes\ndescription: Review notes\n---\nNew text");
  assert.deepEqual(await uploadSkill(skills, next), { added: [], conflicts: ["my-notes"] });
  assert.equal(skills.readSkill("my-notes").instructions, "Keep notes");
  assert.deepEqual((await uploadSkill(skills, { ...next, replace: ["my-notes"] })).added, ["my-notes"]);
  assert.equal(skills.readSkill("my-notes").description, "Review notes");
  assert.equal(skills.skills().find((s) => s.name === "my-notes").enabled, true);
});

test("root and nested archive skills carry companion files; a conflict holds the whole batch", async (t) => {
  const skills = setup(t);
  assert.deepEqual((await uploadSkill(skills, file("root.zip", archive(["SKILL.md", "references/example/SKILL.md", "scripts/check.sh"])))).added, [
    "root",
  ]);
  assert.equal(readFileSync(join(skills.ownSkillDir("root"), "scripts/check.sh"), "utf8"), "Instructions");
  assert.ok(!skills.skills().some((s) => s.name === "example"));
  const two = file("two.zip", archive(["bundle/root/SKILL.md", "bundle/other/SKILL.md", "bundle/other/refs/info"]));
  assert.deepEqual(await uploadSkill(skills, two), { added: [], conflicts: ["root"] });
  assert.throws(() => skills.ownSkillDir("other"));
  assert.deepEqual((await uploadSkill(skills, { ...two, replace: ["root"] })).added, ["root", "other"]);
  assert.equal(readFileSync(join(skills.ownSkillDir("other"), "refs/info"), "utf8"), "Instructions");
});

test("confirmation replaces a legacy nested skill at its stored path", async (t) => {
  const skills = setup(t);
  const old = join(skills.skillsDir, "collection", "legacy");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "SKILL.md"), "---\nname: notes\n---\nOld text");
  const next = file("notes.md", "New text");
  assert.deepEqual((await uploadSkill(skills, next)).conflicts, ["notes"]);
  await uploadSkill(skills, { ...next, replace: ["notes"] });
  assert.equal(existsSync(old), false);
  assert.equal(skills.readSkill("notes").instructions, "New text");
});

test("the computer refuses unsafe paths, special entries, empty catalogs and oversized archives", async (t) => {
  const skills = setup(t);
  for (const path of ["../x", "/bad", "C:/x"]) {
    const bytes = archive(["axxx", "SKILL.md"]);
    for (let at = bytes.indexOf("axxx"); at >= 0; at = bytes.indexOf("axxx", at + 4)) bytes.write(path, at);
    await assert.rejects(uploadSkill(skills, file("bad.zip", bytes)), /path|relative/i);
  }
  for (const mode of [0o120777, 0o010644]) {
    const bytes = archive(["SKILL.md"]);
    bytes.writeUInt32LE((mode * 65536) >>> 0, bytes.indexOf(Buffer.from("504b0102", "hex")) + 38);
    await assert.rejects(uploadSkill(skills, file("bad.zip", bytes)), /regular files/);
  }
  await assert.rejects(uploadSkill(skills, file("bad.zip", archive(["README.md"]))), /No SKILL.md/);
  await assert.rejects(uploadSkill(skills, file("bad.zip", archive(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => "f" + i)))), /Too many files/);
  await assert.rejects(uploadSkill(skills, file("bad.zip", archive(Array.from({ length: MAX_SKILLS + 1 }, (_, i) => i + "/SKILL.md")))), /24 skills/);
  await assert.rejects(uploadSkill(skills, file("large.md", Buffer.alloc(MAX_UPLOAD + 1))), /3 MiB/);
  await assert.rejects(uploadSkill(skills, file("bad.zip", zip([{ path: "SKILL.md", data: Buffer.alloc(MAX_UNPACKED + 1) }]))), /12 MiB/);
});

test("catalog search validates, sorts and caches successful answers and reports HTTP failures", async (t) => {
  const skills = setup(t);
  const rows = ["example.org", "owner/repo"].map((source, i) => ({ id: source + "/docs", source, skillId: "docs", name: "Docs", installs: i }));
  const urls = [];
  const catalog = skillsCatalog(
    () => skills,
    async (url) => {
      urls.push(url);
      return urls.length === 1 ? Response.json({ skills: rows }) : new Response(null, { status: 503 });
    },
  );
  await assert.rejects(catalog.search("a"), /2 to 200/);
  const list = await catalog.search(" docs ");
  assert.equal(new URL(urls[0]).searchParams.get("q"), "docs");
  assert.deepEqual(
    list.map((s) => [s.installs, s.available]),
    [
      [1, true],
      [0, false],
    ],
  );
  assert.deepEqual(await catalog.search("docs"), list);
  await assert.rejects(catalog.search("other"), /503/);
  assert.equal(urls.length, 2);
});

test("installation uses the files of the reviewed tree and returns a navigable installed name", async (t) => {
  const skills = setup(t);
  const manifest = "---\nname: testing\ndescription: Test things\n---\nTest steps";
  const tree = ["SKILL.md", "scripts/run"].map((path, i) => ({
    path: "skills/testing/" + path,
    mode: i ? "100755" : "100644",
    type: "blob",
    size: i ? 3 : Buffer.byteLength(manifest),
    sha: String(i).repeat(40),
  }));
  const id = "demo/repo/testing";
  const catalog = skillsCatalog(
    () => skills,
    async (url) => {
      if (url.includes("/api/search"))
        return Response.json({ skills: [{ id, source: "demo/repo", skillId: "testing", name: "Testing", installs: 12 }] });
      if (url.includes("/trees/")) return Response.json({ tree });
      if (url.endsWith(tree[0].sha)) return new Response(manifest);
      if (url.endsWith(tree[1].sha)) return new Response("run");
      throw new Error("Unexpected request");
    },
  );
  await assert.rejects(catalog.install("invalid"), /preview again/);
  const preview = await catalog.preview(id);
  assert.equal(preview.text, manifest);
  assert.deepEqual((await catalog.install(preview.token)).added, ["testing"]);
  assert.equal(readFileSync(join(skills.ownSkillDir("testing"), "scripts/run"), "utf8"), "run");
  assert.equal((await catalog.search("test"))[0].installed, "testing");
});
