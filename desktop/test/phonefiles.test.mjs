// Files for a window that can't show a save or an open dialog (desktop/phonefiles.mjs, capability
// "files-v1"): a template and the usage report as text, a wiki export in the desktop's three
// formats, and the folder check on a project's folder sent by a paired device.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { zip } from "../desktop/zip.mjs";
import { usageCsv } from "../desktop/usage.mjs";
import { FILES, MAX_FILE, fileAnswer, usageFile, wikiExportName, wikiFile } from "../desktop/phonefiles.mjs";
import { Folders, deviceArgs } from "../desktop/folders.mjs";

const root = new URL("..", import.meta.url).pathname;
const layout = () => import("../desktop/generated/wiki-export-doc.mjs");

test("the compiled export layout was made from the window's sources as they are now", () => {
  const made = readFileSync(join(root, "desktop/generated/wiki-export-doc.mjs"), "utf8").slice(0, 2000);
  const files = /^\/\/ from: (.+)$/m.exec(made)[1].split(", ");
  assert.ok(files.includes("src/wikiExportDoc.tsx") && files.includes("src/RichText.tsx"));
  const hash = createHash("sha256");
  for (const name of [...files].sort()) hash.update(name + "\n").update(readFileSync(join(root, name)));
  assert.equal(/^\/\/ sources: ([0-9a-f]{64})$/m.exec(made)[1], hash.digest("hex"), "run `node scripts/build-wiki-export.mjs` after changing how an export looks");
});

test("a file is answered as text or as base64, and one too large to send is refused in words", () => {
  assert.equal(FILES, "files-v1");
  assert.deepEqual(fileAnswer("notes.csv", "a,b\n1,2\n"), { name: "notes.csv", text: "a,b\n1,2\n" });
  assert.deepEqual(fileAnswer("pack.zip", Buffer.from([80, 75, 3, 4])), { name: "pack.zip", base64: "UEsDBA==" });
  assert.equal(fileAnswer("edge.txt", "x".repeat(MAX_FILE)).text.length, MAX_FILE);
  assert.throws(() => fileAnswer("big.txt", "x".repeat(MAX_FILE + 1)), /That file is 4 MB, and at most 4 MB can be sent in one piece\. Export less at once, or export it on the computer itself\./);
  assert.throws(() => fileAnswer("big.zip", Buffer.alloc(5_500_000)), /That file is 5\.5 MB/);
  assert.equal(wikiExportName('  Team: "Q4" / plans  '), "Team Q4 plans wiki export");
  assert.equal(wikiExportName(""), "Wiki wiki export");
});

/** A workspace with a small wiki, and the tools a wiki export uses (the PDF printer is a stand-in). */
function rig(t) {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  ws.wiki.write("projects/garden.md", "# Garden\n\nBeans in **bed 1**. See the [Tools](tools/spade.md).\n\n| Plant | Bed |\n| --- | --- |\n| Chard | 2 |\n");
  ws.wiki.write("tools/spade.md", "# Spade\n\nKept in the shed.\n");
  const printed = [];
  const tools = { wiki: ws.wiki, zip, layout, pdf: async (html) => (printed.push(html), Buffer.from("%PDF-1.7 stand-in")) };
  return { ws, tools, printed, paths: ["projects/garden.md", "tools/spade.md"] };
}

test("a wiki export is a web page laid out on the computer, a PDF of that page, or a zip of the pages", async (t) => {
  const { tools, printed, paths } = rig(t);
  const html = await wikiFile({ format: "html", paths, title: "Garden notes" }, tools);
  assert.equal(html.name, "Garden notes wiki export.html");
  assert.match(html.text, /^<!doctype html>/);
  assert.ok(html.text.includes("Garden notes") && html.text.includes("<strong>bed 1</strong>") && html.text.includes("<table") && html.text.includes("Kept in the shed."), "both pages are in it, drawn as the window draws them");
  assert.ok(/href="#page-tools-spade"/.test(html.text), "a link to another exported page leads to its place in the document");
  assert.ok(!/<script/i.test(html.text), "the document runs nothing");
  const pdf = await wikiFile({ format: "pdf", paths, title: "Garden notes" }, tools);
  assert.deepEqual([pdf.name, Buffer.from(pdf.base64, "base64").toString()], ["Garden notes wiki export.pdf", "%PDF-1.7 stand-in"]);
  assert.equal(printed[0], html.text.replace(/<p class="when">[^<]*<\/p>/, printed[0].match(/<p class="when">[^<]*<\/p>/)?.[0] ?? ""), "the PDF is printed from the same document");
  const packed = await wikiFile({ format: "zip", paths, title: "Garden notes" }, tools);
  const bytes = Buffer.from(packed.base64, "base64");
  assert.equal(packed.name, "Garden notes wiki export.zip");
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, "a real zip archive");
  assert.ok(bytes.includes(Buffer.from("Garden notes wiki export/projects/garden.md")) && bytes.includes(Buffer.from("Garden notes wiki export/tools/spade.md")));
});

test("a wiki export says what is wrong with a request, and never sends more than fits", async (t) => {
  const { tools, paths } = rig(t);
  await assert.rejects(wikiFile({ format: "docx", paths, title: "x" }, tools), /Choose a format to export\./);
  await assert.rejects(wikiFile({ paths, title: "x" }, tools), /Choose a format to export\./);
  await assert.rejects(wikiFile({ format: "html", paths: [], title: "x" }, tools), /Choose at least one page to export\./);
  await assert.rejects(wikiFile({ format: "html", paths: ["nowhere.md"], title: "x" }, tools), /There is no wiki page at nowhere\.md\./);
  await assert.rejects(wikiFile({ format: "html", paths: ["../outside.md"], title: "x" }, tools));
  assert.equal((await wikiFile({ format: "html", paths: [paths[0]] }, tools)).name, "Wiki wiki export.html", "without a title it is the wiki's");
  // A document that would not fit in one answer is refused before anything is sent.
  await assert.rejects(wikiFile({ format: "html", paths, title: "Big" }, { ...tools, layout: async () => ({ exportDocument: () => "x".repeat(MAX_FILE + 1) }) }), /at most 4 MB can be sent in one piece/);
  await assert.rejects(wikiFile({ format: "pdf", paths, title: "x" }, { ...tools, pdf: async () => Buffer.alloc(MAX_FILE + 1) }), /at most 4 MB can be sent in one piece/);
});

test("a template travels as the text of its file, out and in again", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  const id = ws.templates.saveFromBot("scout", "Field / researcher");
  const out = ws.templates.exportText({ templateId: id });
  assert.equal(out.name, "Field researcher.json");
  assert.equal(JSON.parse(out.text).name ?? JSON.parse(out.text).template?.name, "Field / researcher");
  assert.equal(ws.templates.exportText({ botId: "pip" }).name, "Pip.json", "a bot is exported as a template of itself");
  const before = ws.state.templates.length;
  const added = ws.templates.importText({ name: "/Users/someone/Downloads/Field researcher.json", text: out.text });
  const imported = ws.templates.get(added);
  assert.deepEqual([ws.state.templates.length, imported.source, imported.from, imported.name], [before + 1, "imported", "Field researcher.json", "Field / researcher"], "only the file's own name is kept, never where it was");
  assert.equal(ws.templates.get(ws.templates.importText({ text: out.text })).from, undefined);
  assert.throws(() => ws.templates.importText({ text: "  " }), /That file is empty\./);
  assert.throws(() => ws.templates.importText({}), /That file is empty\./);
  assert.throws(() => ws.templates.importText({ text: "x".repeat(300 * 1024) }), /too large to be a bot template/);
  assert.throws(() => ws.templates.importText({ text: "not json" }));
  assert.throws(() => ws.templates.exportText({ templateId: "gone" }), /no longer exists/);
});

test("the usage report as a file is the same text the desktop saves", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  const csv = (days) => usageCsv(ws.state, { days, timeZone: "UTC" });
  const file = usageFile(30, csv);
  assert.deepEqual([file.name, file.text], ["botkins-usage-30d.csv", csv(30)]);
  assert.match(file.text, /^time,date,bot,chat,/);
  assert.equal(usageFile(7, csv).name, "botkins-usage-7d.csv");
  for (const days of [31, "30", undefined, 0]) assert.throws(() => usageFile(days, csv), /Choose 7, 30 or 90 days/, String(days));
});

test("a project's folder sent by a paired device must be one the folder browser could have shown", async (t) => {
  const base = realpathSync(tempDir(t));
  for (const dir of ["home/Projects/garden", "home/.secret", "elsewhere"]) mkdirSync(join(base, dir), { recursive: true });
  const folders = new Folders({ home: join(base, "home"), volumes: [] });
  const garden = join(base, "home", "Projects", "garden");
  assert.deepEqual(await deviceArgs(folders, "updateProject", ["p1", { name: "Garden", folder: join(base, "home", "Projects", "..", "Projects", "garden") }]), [["p1", { name: "Garden", folder: garden }]].flat(), "accepted, as its real path");
  assert.deepEqual(await deviceArgs(folders, "createProject", [{ name: "Garden", folder: garden }]), [{ name: "Garden", folder: garden }]);
  await assert.rejects(deviceArgs(folders, "updateProject", ["p1", { folder: join(base, "elsewhere") }]), /Only folders in your home folder/);
  await assert.rejects(deviceArgs(folders, "createProject", [{ name: "x", folder: join(base, "home", ".secret") }]), /Hidden folders can't be chosen/);
  await assert.rejects(deviceArgs(folders, "updateProject", ["p1", { folder: "/etc" }]), /Only folders in your home folder|doesn't exist/);
  // A change that names no folder, a folder being cleared, and every other call pass as they are.
  for (const [name, args] of [["updateProject", ["p1", { name: "New name" }]], ["updateProject", ["p1", { folder: "" }]], ["updateProject", ["p1", { folder: null }]], ["createProject", [{ name: "No folder" }]], ["send", ["chat", "hello", { folder: "/etc" }]], ["renameProject", ["p1", "/etc"]]])
    assert.deepEqual(await deviceArgs(folders, name, args), args, name);
});
