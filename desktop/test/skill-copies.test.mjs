// The copy of a person's skills folder that a session gets (desktop/skill-copies.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionSkills, sweepSkillCopies } from "../desktop/skill-copies.mjs";
import { skillsIn } from "../desktop/integrations.mjs";
import { plainHeaderFile } from "../desktop/plugin-runtime.mjs";

const links = process.platform === "win32" ? { skip: "needs symbolic links" } : {};

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "botkins-skill-copies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "data");
  const source = join(root, "skills");
  mkdirSync(dir, { recursive: true });
  mkdirSync(source, { recursive: true });
  return { root, dir, source };
}
const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const copyOf = (dir, source, chatId = "chat-1") => sessionSkills({ dir, chatId, sources: [source] });

test("a copied SKILL.md keeps its name and description and loses what asks for tools or hooks", (t) => {
  const { dir, source } = setup(t);
  write(
    join(source, "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Ship it\nallowed-tools: shell\nhooks:\n  PreToolUse: x\nmcp-servers:\n  evil: node evil.js\ndisable-model-invocation: true\n---\n\nSteps.\n",
  );
  const { directories } = copyOf(dir, source);
  const copied = readFileSync(join(directories[0], "deploy", "SKILL.md"), "utf8");
  assert.equal(copied, '---\nname: "deploy"\ndescription: "Ship it"\ndisable-model-invocation: true\n---\n\nSteps.\n');
  assert.doesNotMatch(copied, /allowed-tools|hooks|mcp-servers|evil/);
  assert.match(readFileSync(join(source, "deploy", "SKILL.md"), "utf8"), /allowed-tools: shell/, "the original is not touched");
});

test("a header written with capital letters keeps its name and description", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "folder-name", "SKILL.md"), "---\nName: Shouty\nDESCRIPTION: Loud one\nAllowed-Tools: shell\n---\nBody\n");
  const { directories } = copyOf(dir, source);
  const copied = readFileSync(join(directories[0], "folder-name", "SKILL.md"), "utf8");
  assert.equal(copied, '---\nname: "Shouty"\ndescription: "Loud one"\n---\nBody\n');
  // The name that Botkins reads from the copy is the name it read from the original, so switching it off by name still works.
  assert.deepEqual(skillsIn(directories[0], "folder").map((s) => s.name), ["Shouty"]);
  assert.deepEqual(skillsIn(source, "folder").map((s) => s.name), ["Shouty"]);
});

test("a skill header keeps an argument hint, and a command or an agent header is read in any letter case too", () => {
  assert.equal(plainHeaderFile("---\nname: a\nargument-hint: <file>\n---\nx", "skill"), '---\nname: "a"\ndescription: ""\nargument-hint: "<file>"\n---\nx');
  assert.equal(plainHeaderFile("---\nNAME: a\nTools: [Read]\n---\nx", "agent"), '---\nname: "a"\ndescription: ""\ntools: ["Read"]\n---\nx');
});

test("folder and file names are kept, and the same skills are found in the copy", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nA\n");
  write(join(source, "group", "beta", "SKILL.md"), "---\nname: beta\ndescription: B\n---\nB\n");
  write(join(source, "group", "beta", "scripts", "run.sh"), "echo hi\n");
  const { directories } = copyOf(dir, source);
  assert.deepEqual(
    skillsIn(directories[0], "folder").map((s) => [s.name, s.description]),
    skillsIn(source, "folder").map((s) => [s.name, s.description]),
  );
  assert.equal(readFileSync(join(directories[0], "group", "beta", "scripts", "run.sh"), "utf8"), "echo hi\n");
});

test("a resource file is a hard link to the original, and removing the copy leaves the original", { skip: process.platform === "win32" }, (t) => {
  const { dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(source, "s", "data.bin"), "resource bytes");
  const { directories } = copyOf(dir, source);
  const original = lstatSync(join(source, "s", "data.bin"));
  const copied = lstatSync(join(directories[0], "s", "data.bin"));
  assert.ok(copied.isFile());
  assert.equal(copied.ino, original.ino);
  assert.equal(copied.dev, original.dev);
  sweepSkillCopies(dir, []);
  assert.ok(!existsSync(directories[0]));
  assert.equal(readFileSync(join(source, "s", "data.bin"), "utf8"), "resource bytes");
  assert.ok(existsSync(join(source, "s", "SKILL.md")));
});

test("another Markdown file keeps a harmless header and is written again when its header names tools or hooks", (t) => {
  const { dir, source } = setup(t);
  const harmless = "---\ntitle: Post\ntags: [a, b]\n---\n\nA paper of the skill.\n";
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(source, "s", "post.md"), harmless);
  write(join(source, "s", "tool.MD"), "---\ntitle: T\nAllowed_Tools: shell\n---\nText\n");
  write(join(source, "s", "hooky.md"), "\uFEFF---\nhooks:\n  x: y\n---\nText\n");
  write(join(source, "s", "spaced.md"), "\n  ---\nallowed-tools: shell\n---\nText\n");
  write(join(source, "s", "plain.md"), "No header here, but allowed-tools is said in the text.\n");
  const { directories } = copyOf(dir, source);
  assert.equal(readFileSync(join(directories[0], "s", "post.md"), "utf8"), harmless);
  assert.equal(readFileSync(join(directories[0], "s", "plain.md"), "utf8"), "No header here, but allowed-tools is said in the text.\n");
  assert.doesNotMatch(readFileSync(join(directories[0], "s", "tool.MD"), "utf8"), /allowed/i);
  assert.doesNotMatch(readFileSync(join(directories[0], "s", "hooky.md"), "utf8"), /hooks/);
  // A header after leading space is not one for plainHeaderFile, but the new header is first, and that is the one the runtime reads.
  assert.match(readFileSync(join(directories[0], "s", "spaced.md"), "utf8"), /^---\ndescription: ""\n---\n/);
});

test("a SKILL.md in another letter case is written again, and one over a million bytes is left out", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "a", "skill.md"), "---\nname: a\ndescription: A\nallowed-tools: shell\n---\n");
  write(join(source, "b", "SKILL.md"), "---\nname: b\ndescription: B\n---\n" + "x".repeat(1_000_001));
  const { directories } = copyOf(dir, source);
  assert.doesNotMatch(readFileSync(join(directories[0], "a", "skill.md"), "utf8"), /allowed-tools/);
  assert.ok(!existsSync(join(directories[0], "b", "SKILL.md")));
});

test("dot names, node_modules and symbolic links are not in the copy", links, (t) => {
  const { root, dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(source, "s", ".secret"), "x");
  write(join(source, ".hidden", "SKILL.md"), "---\nname: h\ndescription: H\n---\n");
  write(join(source, "node_modules", "dep", "SKILL.md"), "---\nname: d\ndescription: D\n---\n");
  write(join(root, "outside", "SKILL.md"), "---\nname: out\ndescription: O\nallowed-tools: shell\n---\n");
  write(join(root, "outside.txt"), "private");
  symlinkSync(join(root, "outside.txt"), join(source, "s", "link.txt"));
  symlinkSync(join(root, "outside"), join(source, "folder-link"));
  const { directories } = copyOf(dir, source);
  assert.deepEqual(readdirSync(directories[0]).sort(), ["s"]);
  assert.deepEqual(readdirSync(join(directories[0], "s")).sort(), ["SKILL.md"]);
  // A source that is itself a link gives an empty copy.
  const linkedSource = join(root, "linked-source");
  symlinkSync(join(root, "outside"), linkedSource);
  const second = copyOf(dir, linkedSource, "chat-2");
  assert.deepEqual(readdirSync(second.directories[0]), []);
});

test("a source that is missing or is a file gets an empty copy and keeps its place in the list", (t) => {
  const { root, dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(root, "a-file"), "x");
  const { directories } = sessionSkills({ dir, chatId: "c", sources: [join(root, "missing"), source, join(root, "a-file")] });
  assert.equal(directories.length, 3);
  assert.deepEqual(readdirSync(directories[0]), []);
  assert.deepEqual(readdirSync(directories[1]), ["s"]);
  assert.deepEqual(readdirSync(directories[2]), []);
  assert.match(directories[1], /\.botkins-skills-runtime\/c\/1-[0-9a-f]{10}$/);
});

test("nothing is written again when nothing changed, and it is when the original changes", (t) => {
  const { dir, source } = setup(t);
  const file = join(source, "s", "SKILL.md");
  write(file, "---\nname: s\ndescription: first\n---\n");
  const one = copyOf(dir, source);
  const copiedFile = join(one.directories[0], "s", "SKILL.md");
  const inode = lstatSync(copiedFile).ino;
  const two = copyOf(dir, source);
  assert.equal(lstatSync(copiedFile).ino, inode, "the copy was not written again");
  assert.equal(two.revision, one.revision);
  assert.match(one.revision, /^[0-9a-f]{16}$/);
  writeFileSync(file, "---\nname: s\ndescription: second, and longer\n---\n");
  const three = copyOf(dir, source);
  assert.notEqual(three.revision, one.revision);
  assert.match(readFileSync(copiedFile, "utf8"), /second, and longer/);
});

test("a copy that was changed by someone else is written again", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  const { directories } = copyOf(dir, source);
  const copiedFile = join(directories[0], "s", "SKILL.md");
  writeFileSync(copiedFile, "---\nname: s\ndescription: S\nallowed-tools: shell\n---\n");
  copyOf(dir, source);
  assert.doesNotMatch(readFileSync(copiedFile, "utf8"), /allowed-tools/);
});

test("a file that is changed and gets its time put back is still noticed by its size", (t) => {
  const { dir, source } = setup(t);
  const file = join(source, "s", "SKILL.md");
  write(file, "---\nname: s\ndescription: aaaa\n---\n");
  const when = new Date(2020, 0, 1);
  utimesSync(file, when, when);
  const one = copyOf(dir, source);
  writeFileSync(file, "---\nname: s\ndescription: bbbbbb\n---\n");
  utimesSync(file, when, when);
  const two = copyOf(dir, source);
  assert.notEqual(two.revision, one.revision);
  assert.match(readFileSync(join(two.directories[0], "s", "SKILL.md"), "utf8"), /bbbbbb/);
});

test("two chats get two separate copies, and a second chat does not make the first one look changed", { skip: process.platform === "win32" }, (t) => {
  const { dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(source, "s", "res.txt"), "r");
  const a = copyOf(dir, source, "chat-a");
  const b = copyOf(dir, source, "chat-b");
  assert.notEqual(a.directories[0], b.directories[0]);
  const aFile = join(a.directories[0], "s", "SKILL.md");
  const inode = lstatSync(aFile).ino;
  const again = copyOf(dir, source, "chat-a");
  assert.equal(lstatSync(aFile).ino, inode, "a link made for another chat does not make a copy again");
  assert.equal(again.revision, a.revision);
  assert.equal(b.revision, a.revision);
});

test("a chat id cannot leave the copy place", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  const { directories } = copyOf(dir, source, "../../escape");
  assert.ok(directories[0].startsWith(join(dir, ".botkins-skills-runtime") + "/") || process.platform === "win32");
  assert.ok(!existsSync(join(dir, "..", "escape")));
});

test("the sweep removes the copy of a chat that is not kept, and leaves the kept one and the originals", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(source, "s", "res.txt"), "r");
  const keep = copyOf(dir, source, "keep");
  const gone = copyOf(dir, source, "gone");
  sweepSkillCopies(dir, ["keep", "other"]);
  assert.ok(existsSync(join(keep.directories[0], "s", "SKILL.md")));
  assert.ok(!existsSync(gone.directories[0]));
  assert.equal(readFileSync(join(source, "s", "res.txt"), "utf8"), "r");
  // It does not throw when there is nothing to sweep, and a swept chat is made again when it asks.
  sweepSkillCopies(join(dir, "nowhere"), []);
  assert.ok(existsSync(copyOf(dir, source, "gone").directories[0]));
});

test("at most 5,000 files of one source are copied, and it does not fail", (t) => {
  const { dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  mkdirSync(join(source, "z"));
  for (let i = 0; i < 5_050; i++) writeFileSync(join(source, "z", "f" + String(i).padStart(5, "0")), "");
  const { directories } = copyOf(dir, source);
  assert.ok(existsSync(join(directories[0], "s", "SKILL.md")));
  assert.equal(readdirSync(join(directories[0], "z")).length, 4_999);
});

test("a source that holds a hard link to a file outside is still copied as a link, and the sweep does not touch that file", { skip: process.platform === "win32" }, (t) => {
  const { root, dir, source } = setup(t);
  write(join(source, "s", "SKILL.md"), "---\nname: s\ndescription: S\n---\n");
  write(join(root, "shared.txt"), "shared");
  linkSync(join(root, "shared.txt"), join(source, "s", "shared.txt"));
  copyOf(dir, source);
  sweepSkillCopies(dir, []);
  assert.equal(readFileSync(join(root, "shared.txt"), "utf8"), "shared");
});
