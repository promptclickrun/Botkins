// The calls a phone makes where the app on the computer opens a file or folder dialog: a file as
// text out and in, a browser of the computer's folders, and two buttons that open nothing (clear the
// cache, the computer's own test notification). This checks what the link lets through and how it
// cleans each call's arguments (link-host/methods.mjs), and that the demo computer answers each one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FILE_TEXT, REMOTE_METHODS, remoteArgs } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { exportGroups, exportRequest, scopeFor } from "../src/features/wiki/exporting";
import { addedSkillsNote, cleanFileName, folderName, placeOf } from "../src/state/fileText";

const said = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};

test("a phone may make the calls that open nothing on the computer, and none that open a dialog", () => {
  for (const name of ["exportTemplateText", "importTemplateText", "exportUsageText", "wikiExportPlan", "exportWikiFile", "listFolders", "addProjectFolder", "addSkillFolderAt", "clearCache", "testNotification"]) assert.ok(REMOTE_METHODS.has(name), name);
  for (const name of ["exportTemplate", "importTemplate", "exportUsage", "exportWiki", "addProject", "addSkillFolder", "chooseProjectFolder", "importMcpServerFile", "chooseFiles", "copyText"]) assert.equal(REMOTE_METHODS.has(name), false, name);
});

test("a template comes in as text of a sensible size, with a plain file name", () => {
  assert.deepEqual(remoteArgs("importTemplateText", [{ name: "../../My bot.json", text: "{}", extra: 1 }]), [{ name: "My bot.json", text: "{}" }]);
  assert.deepEqual(remoteArgs("importTemplateText", [{ text: "{}" }]), [{ text: "{}" }]);
  assert.equal(said(() => remoteArgs("importTemplateText", [{ text: "  " }])), "That file is empty.");
  assert.equal(said(() => remoteArgs("importTemplateText", ["{}"])), "That file is empty.");
  assert.equal(said(() => remoteArgs("importTemplateText", [{ text: "x".repeat(MAX_FILE_TEXT + 1) }])), "That file is too big to import (2 MB at most).");
  assert.equal(MAX_FILE_TEXT, 2 * 1024 * 1024);
});

test("an export names one bot or one template, and a range in whole days", () => {
  assert.deepEqual(remoteArgs("exportTemplateText", [{ templateId: "t1", botId: "b1", path: "/tmp/x" }]), [{ templateId: "t1" }]);
  assert.deepEqual(remoteArgs("exportTemplateText", [{ botId: "b1" }]), [{ botId: "b1" }]);
  assert.equal(said(() => remoteArgs("exportTemplateText", [{}])), "Choose a bot or a template to export.");
  assert.deepEqual(remoteArgs("exportUsageText", [30, "/tmp/x"]), [30]);
  for (const days of [0, -1, 1.5, "30", 100_000, undefined]) assert.equal(said(() => remoteArgs("exportUsageText", [days])), "Choose a range to export.", String(days));
});

test("a wiki export names its format and pages inside the wiki, and never brings its own document", () => {
  assert.deepEqual(remoteArgs("exportWikiFile", [{ format: "pdf", paths: ["projects/site.md"], title: "Site", html: "<script>", everything: false }]), [{ format: "pdf", paths: ["projects/site.md"], title: "Site" }]);
  assert.deepEqual(remoteArgs("exportWikiFile", [{ format: "zip", paths: [], everything: true }]), [{ format: "zip", paths: [], everything: true }]);
  assert.equal(said(() => remoteArgs("exportWikiFile", [{ format: "exe", paths: [] }])), "Choose a format to export.");
  for (const path of ["../secrets.md", "/etc/passwd", "C:\\Users\\x.md", "", 7]) assert.equal(said(() => remoteArgs("exportWikiFile", [{ format: "zip", paths: [path] }])), "Those pages can't be exported.", String(path));
  assert.deepEqual(remoteArgs("wikiExportPlan", [{ scope: "page", path: "projects/site.md", more: 1 }]), [{ scope: "page", path: "projects/site.md" }]);
  assert.deepEqual(remoteArgs("wikiExportPlan", [{ scope: "all" }]), [{ scope: "all" }]);
  assert.equal(said(() => remoteArgs("wikiExportPlan", [{ scope: "page", path: "../x.md" }])), "Those pages can't be exported.");
  assert.equal(said(() => remoteArgs("wikiExportPlan", [{ scope: "disk" }])), "Those pages can't be exported.");
});

test("a folder is named by its whole path and never by a climb", () => {
  assert.deepEqual(remoteArgs("listFolders", []), []);
  assert.deepEqual(remoteArgs("listFolders", [null]), []);
  assert.deepEqual(remoteArgs("listFolders", ["/Users/demo/Code", "more"]), ["/Users/demo/Code"]);
  assert.deepEqual(remoteArgs("listFolders", ["C:\\Users\\demo"]), ["C:\\Users\\demo"]);
  for (const path of ["Code", "/Users/demo/../other", "/Users/demo\0", "", 7, {}]) assert.equal(said(() => remoteArgs("listFolders", [path])), "That folder can't be shown.", String(path));
  for (const method of ["addProjectFolder", "addSkillFolderAt"]) {
    assert.deepEqual(remoteArgs(method, ["/Users/demo/Code/website", "x"]), ["/Users/demo/Code/website"]);
    for (const path of [undefined, "website", "/Users/demo/../../etc"]) assert.equal(said(() => remoteArgs(method, [path])), "Choose a folder.", method + " " + String(path));
  }
});

test("the demo computer answers a template, the usage table and a wiki export as files", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  assert.ok(backend.capabilities.includes("files-v1"));

  const bot = backend.state.bots[0];
  const out = await backend.call("exportTemplateText", [{ botId: bot.id }]);
  assert.equal(out.name, bot.name + ".json");
  assert.equal(JSON.parse(out.text).name, bot.name);
  const before = backend.state.templates.length;
  const made = await backend.call("importTemplateText", [{ name: "Shared.json", text: out.text }]);
  assert.equal(backend.state.templates.length, before + 1);
  assert.equal(backend.state.templates.at(-1).id, made, "the answer is the new template's id");
  assert.equal(backend.state.templates.at(-1).source, "imported");
  await assert.rejects(backend.call("importTemplateText", [{ text: "not json" }]), /isn't a bot template/);

  const csv = await backend.call("exportUsageText", [30]);
  assert.equal(csv.name, "botkins-usage-30d.csv");
  assert.match(csv.text, /^time,date,bot,/);
  assert.ok(csv.text.trim().split("\n").length > 1);
  await assert.rejects(backend.call("exportUsageText", [14]), /7, 30 or 90/);

  const plan = await backend.call("wikiExportPlan", [{ scope: "all" }]);
  assert.ok(plan.pages.length > 0 && typeof plan.title === "string");
  const paths = plan.pages.map((page: { path: string }) => page.path);
  const html = await backend.call("exportWikiFile", [{ format: "html", paths, title: plan.title }]);
  assert.match(html.name, / wiki export\.html$/);
  assert.match(html.text, /^<!doctype html>/i);
  assert.equal("base64" in html, false);
  const pdf = await backend.call("exportWikiFile", [{ format: "pdf", paths, title: plan.title }]);
  assert.match(pdf.name, /\.pdf$/);
  assert.equal(Buffer.from(pdf.base64, "base64").subarray(0, 5).toString(), "%PDF-");
  const zip = await backend.call("exportWikiFile", [{ format: "zip", paths, title: plan.title }]);
  assert.match(zip.name, /\.zip$/);
  const bytes = Buffer.from(zip.base64, "base64");
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, "a zip's first entry");
  assert.ok(bytes.includes(Buffer.from(paths[0])), "the first page's path is an entry");
  await assert.rejects(backend.call("exportWikiFile", [{ format: "zip", paths: [] }]), /nothing to export/);
});

test("the demo computer shows its folders, and a chosen one becomes a project or a skill folder", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  assert.ok(backend.capabilities.includes("folders-v1"));

  const home = await backend.call("listFolders", []);
  assert.equal(home.parent, null);
  // A plugged-in disk is a place of its own, beside the home folder.
  assert.equal(home.roots[0].path, home.path);
  assert.ok(home.roots.length > 1);
  const disk = await backend.call("listFolders", [home.roots[1].path]);
  assert.equal(disk.parent, null);
  assert.ok(disk.folders.length > 0);
  assert.ok(home.folders.length > 0);
  for (const folder of home.folders) {
    assert.equal(folder.path, home.path + "/" + folder.name);
    assert.equal(folder.name.startsWith("."), false, "no hidden folders");
  }
  const inner = await backend.call("listFolders", [home.folders[0].path]);
  assert.equal(inner.path, home.folders[0].path);
  assert.equal(inner.parent, home.path);
  await assert.rejects(backend.call("listFolders", ["/etc"]), /can be chosen from here/);
  await assert.rejects(backend.call("listFolders", [home.path + "/nowhere"]), /doesn't exist on the computer/);

  const folder = inner.folders[0].path;
  const id = await backend.call("addProjectFolder", [folder]);
  const project = backend.state.projects.find((p: { id: string }) => p.id === id);
  assert.equal(project.folder, folder);
  assert.equal(project.name, inner.folders[0].name);
  assert.equal(await backend.call("addProjectFolder", [folder]), id, "the same folder is the same project");
  await assert.rejects(backend.call("addProjectFolder", ["/etc"]), /can be chosen from here/);

  const other = backend.state.projects.find((p: { id: string }) => p.id !== id);
  await backend.call("updateProject", [other.id, { folder: home.folders[0].path }]);
  assert.equal(other.folder, home.folders[0].path);
  await assert.rejects(backend.call("updateProject", [other.id, { folder: "/etc" }]), /can be chosen from here/);

  const folders = backend.state.skills.folders.length;
  assert.deepEqual(await backend.call("addSkillFolderAt", [home.folders[0].path]), { kind: "folder", name: home.folders[0].name, count: 0 });
  assert.equal(backend.state.skills.folders.length, folders + 1);
  assert.equal(backend.state.skills.folders.at(-1).path, home.folders[0].path);
  await assert.rejects(backend.call("addSkillFolderAt", [home.folders[0].path]), /already/);
});

test("the demo computer clears its cache and sends its own test notification", async () => {
  const backend = new MockBackend({ speed: 0.05 });
  assert.ok((await backend.call("cacheInfo", [])).bytes > 0);
  await backend.call("clearCache", []);
  assert.deepEqual(await backend.call("cacheInfo", []), { bytes: 0, catalogs: 0 });
  await backend.call("testNotification", []);
  assert.equal(backend.tested, 1);
});

// ---- the phone's plain logic for these controls

test("a file from the computer is saved under one plain name", () => {
  assert.equal(cleanFileName("a/b/Mira.json"), "Mira.json");
  assert.equal(cleanFileName("C:\\Users\\x\\Site wiki export.zip"), "Site wiki export.zip");
  assert.equal(cleanFileName('My: "bot"?.json'), "My bot .json");
  assert.equal(cleanFileName(".."), "Botkins file");
  assert.equal(cleanFileName("", "file"), "file");
  assert.equal(cleanFileName(".hidden.json"), "hidden.json");
  assert.ok(cleanFileName("x".repeat(400) + ".csv").length <= 120);
  assert.ok(cleanFileName("x".repeat(400) + ".csv").endsWith(".csv"), "the ending is what is kept");
});

test("a folder is shown by its own name, and belongs to the place its path is in", () => {
  assert.equal(folderName("/Users/demo/Code/"), "Code");
  assert.equal(folderName("C:\\Users\\demo"), "demo");
  assert.equal(folderName("/"), "/");
  const roots = [{ name: "Home", path: "/Users/demo" }, { name: "Backup", path: "/Volumes/Backup" }];
  assert.equal(placeOf({ path: "/Users/demo", roots }), "/Users/demo");
  assert.equal(placeOf({ path: "/Users/demo/Code", roots }), "/Users/demo");
  assert.equal(placeOf({ path: "/Volumes/Backup/Projects", roots }), "/Volumes/Backup");
  assert.equal(placeOf({ path: "/Users/demonstration", roots }), undefined, "a name that only starts the same is another folder");
  assert.equal(placeOf({ path: "/Users/demo" }), undefined);
});

test("adding a folder of skills says what was added, in the computer's words", () => {
  assert.equal(addedSkillsNote({ kind: "skill", name: "review" }), "Added the skill review.");
  assert.equal(addedSkillsNote({ kind: "plugin", name: "code-review" }), "Added the plugin code-review.");
  assert.equal(addedSkillsNote({ kind: "folder", name: "team-skills", count: 1 }), "Linked team-skills (1 skill).");
  assert.equal(addedSkillsNote({ kind: "folder", name: "team-skills" }), "Linked team-skills (0 skills).");
});

test("a wiki export groups its pages and asks the computer for the right thing", () => {
  assert.equal(scopeFor("projects/site.md"), "project");
  assert.equal(scopeFor("Projects/site.md"), "project");
  assert.equal(scopeFor("people/jo.md"), "page");
  const page = (path: string, section: string, why: "start" | "linked" | "related") => ({ path, title: path, section, why });
  const all = { title: "Wiki", pages: [page("projects/a.md", "Projects", "start"), page("people/jo.md", "People", "start"), page("projects/b.md", "Projects", "start")] };
  assert.deepEqual(exportGroups(all, "all").map((group) => [group.label, group.pages.length]), [["People", 1], ["Projects", 2]]);
  const one = { title: "Site", pages: [page("projects/a.md", "Projects", "start"), page("people/jo.md", "People", "linked")] };
  assert.deepEqual(exportGroups(one, "project").map((group) => group.label), ["This page", "Linked with it"]);

  // The whole wiki as Markdown, untouched, is the wiki folder itself.
  assert.deepEqual(exportRequest(all, "all", new Set(), "zip"), { format: "zip", paths: [], title: "Botkins", everything: true });
  assert.deepEqual(exportRequest(all, "all", new Set(["people/jo.md"]), "zip"), { format: "zip", paths: ["projects/a.md", "projects/b.md"], title: "Botkins" });
  assert.deepEqual(exportRequest(all, "all", new Set(), "pdf"), { format: "pdf", paths: ["projects/a.md", "people/jo.md", "projects/b.md"], title: "Botkins" });
  assert.deepEqual(exportRequest(one, "project", new Set(["people/jo.md"]), "html"), { format: "html", paths: ["projects/a.md"], title: "Site" });
  // What it asks for is what the link lets through.
  assert.deepEqual(remoteArgs("exportWikiFile", [exportRequest(one, "project", new Set(), "html")]), [{ format: "html", paths: ["projects/a.md", "people/jo.md"], title: "Site" }]);
});
