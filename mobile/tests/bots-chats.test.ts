// The plain logic behind the bot list, a bot's access and a chat's extras: the order of the bot
// list (primary, pinned, sections, the rest), its filters, who may use a project, a side question,
// a quoted reply and a diff's lines. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot, Section } from "../src/link/types";
import { canUseProject, globalAccess, grantOf, grantSummary, MODE_LABELS, projectBlock, sortedProjects, toggleProject } from "../src/features/bots/projectAccess";
import { arrangeBots, filterBots, filterLabels, sectionOf } from "../src/features/home/arrange";
import { changedPath, diffLineKind, fileCount, kindLetter, quoteOf, sideQuestionOf } from "../src/features/chat/side";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({ id, name: id, role: "", instructions: "", face: "idle", ...extra });
const sections: Section[] = [
  { id: "work", name: "Work" },
  { id: "home", name: "Home" },
];

test("the bot list is primary, pinned, each section, then the rest; hidden bots are apart", () => {
  const bots = [bot("first", { sectionId: "work" }), bot("a", { pinned: true, sectionId: "work" }), bot("b", { sectionId: "work" }), bot("c"), bot("d", { hidden: true }), bot("e", { sectionId: "gone" })];
  const out = arrangeBots(bots, sections);
  assert.equal(out.primary?.id, "first");
  assert.deepEqual(out.pinned.map((b) => b.id), ["a"]);
  assert.deepEqual(out.sections.map((s) => [s.section.id, s.bots.map((b) => b.id)]), [["work", ["b"]], ["home", []]]);
  // A bot in a section that is gone is with the rest.
  assert.deepEqual(out.rest.map((b) => b.id), ["c", "e"]);
  assert.deepEqual(out.hidden.map((b) => b.id), ["d"]);
  assert.equal(arrangeBots([], sections).primary, undefined);
  assert.equal(sectionOf(bots[2], sections)?.name, "Work");
  assert.equal(sectionOf(bots[5], sections), undefined);
});

test("the filters show all visible, pinned and hidden bots, with counts", () => {
  const bots = [bot("a", { pinned: true }), bot("b", { pinned: true, hidden: true }), bot("c", { hidden: true }), bot("d")];
  assert.deepEqual(filterBots(bots, "All").map((b) => b.id), ["a", "d"]);
  assert.deepEqual(filterBots(bots, "Pinned").map((b) => b.id), ["a"]);
  assert.deepEqual(filterBots(bots, "Hidden").map((b) => b.id), ["b", "c"]);
  assert.deepEqual(filterLabels(bots).map((f) => f.label), ["All", "Pinned · 1", "Hidden · 2"]);
  assert.deepEqual(filterLabels([bot("x")]).map((f) => f.label), ["All", "Pinned", "Hidden · 0"]);
});

test("access: every project for everyone by default, else the bot's own grant", () => {
  const open = undefined;
  const closed = { access: { allBots: false } };
  const project = { id: "p1", name: "Website", folder: "/repo" };
  assert.equal(globalAccess(open), true);
  assert.equal(globalAccess(closed), false);
  assert.deepEqual(grantOf(bot("a")), { all: false, projects: [] });
  assert.equal(canUseProject(open, bot("a"), project), true);
  assert.equal(canUseProject(closed, bot("a"), project), false);
  assert.equal(canUseProject(closed, bot("a", { access: { all: true, projects: [] } }), project), true);
  assert.equal(canUseProject(closed, bot("a", { access: { all: false, projects: ["p1"] } }), project), true);
  assert.equal(grantSummary(open, bot("a"), [project]), "Every project");
  assert.equal(grantSummary(closed, bot("a", { access: { all: true, projects: [] } }), [project]), "All projects");
  // A project that is gone doesn't count.
  assert.equal(grantSummary(closed, bot("a", { access: { all: false, projects: ["p1", "gone"] } }), [project]), "1 project");
  assert.equal(grantSummary(closed, bot("a"), [project]), "No projects");
  assert.deepEqual(toggleProject({ all: false, projects: ["p1"] }, "p1", true), { all: false, projects: ["p1"] });
  assert.deepEqual(toggleProject({ all: false, projects: ["p1"] }, "p2", true), { all: false, projects: ["p1", "p2"] });
  assert.deepEqual(toggleProject({ all: false, projects: ["p1", "p2"] }, "p1", false), { all: false, projects: ["p2"] });
});

test("a project a chat can't use says why, in the desktop's words", () => {
  const closed = { access: { allBots: false } };
  const folder = { id: "p1", folder: "/repo" };
  const plain = { id: "p2" };
  assert.equal(projectBlock(undefined, [bot("Mira")], folder, false), "");
  assert.equal(projectBlock(closed, [bot("Mira"), bot("Patch")], folder, true), "Mira, Patch can't use it");
  assert.equal(projectBlock(undefined, [bot("Mira"), bot("Patch")], folder, true), "has a folder; group chats are text only");
  assert.equal(projectBlock(undefined, [bot("Mira"), bot("Patch")], plain, true), "");
  assert.deepEqual(sortedProjects([{ name: "b" }, { name: "A" }, { name: "c" }]).map((p) => p.name), ["A", "b", "c"]);
  assert.equal(MODE_LABELS.yolo.label, "YOLO");
});

test("a side question is /btw or /ask and the words after it", () => {
  assert.deepEqual(sideQuestionOf("/btw what's the deadline?"), { command: "btw", question: "what's the deadline?" });
  assert.deepEqual(sideQuestionOf("  /ASK  two\nlines "), { command: "ask", question: "two\nlines" });
  assert.deepEqual(sideQuestionOf("/btw"), { command: "btw", question: "" });
  assert.equal(sideQuestionOf("/btwx hi"), null);
  assert.equal(sideQuestionOf("btw hi"), null);
  assert.equal(sideQuestionOf("/compact"), null);
});

test("a reply quotes the message trimmed to 1,200 characters", () => {
  assert.equal(quoteOf("  hello \n"), "hello");
  assert.equal(quoteOf("x".repeat(2000)).length, 1200);
});

test("a diff's lines and a changed file read as on the computer", () => {
  assert.deepEqual(["+++ b/a", "--- a/a", "+new", "-old", "@@ -1 +1 @@", " same"].map(diffLineKind), ["file", "file", "add", "del", "hunk", "plain"]);
  assert.equal(kindLetter("untracked"), "U");
  assert.equal(changedPath({ path: "b.ts", from: "a.ts" }), "a.ts → b.ts");
  assert.equal(changedPath({ path: "b.ts" }), "b.ts");
  assert.equal(fileCount(1), "1 file");
  assert.equal(fileCount(3), "3 files");
});
