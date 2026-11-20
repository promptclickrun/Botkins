// Exporting the wiki: which pages a scope holds, the files of a Markdown export, and the zip writer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { Workspace } from "./starter.mjs";
import { zip } from "../desktop/zip.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

/** Reads an archive back through its directory: { path: text }. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + packed);
    const text = method === 8 ? inflateRawSync(data) : data;
    assert.equal(text.length, size, name);
    files[name] = text.toString("utf8");
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}

function setup(t) {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  const w = ws.wiki;
  w.write("projects/portal.md", "# Portal\n\nShip the new site. Serves [Growth](goals/growth.md). Owner: [Sam](people/sam.md). Follows the [Launch playbook](playbooks/launch.md).\n");
  w.write("projects/rocket-site.md", "# Rocket site\n\nA microsite. Owner: [Sam](people/sam.md). Follows the [Launch playbook](playbooks/launch.md).\n");
  w.write("playbooks/launch.md", "# Launch playbook\n\nHow we launch.\n");
  w.write("people/dana.md", "# Dana Lee\n\nDesigner on [Portal](projects/portal.md).\n");
  w.write("people/sam.md", "# Sam Park\n\nOur lead.\n");
  w.write("goals/growth.md", "# Growth\n\nMore visits. Served by [Portal](projects/portal.md). Owner: [Sam](people/sam.md).\n");
  w.write("meetings/2026-03-01-portal-kickoff.md", "# Portal kickoff\n\nAbout [Portal](projects/portal.md) with [Dana](people/dana.md).\n");
  w.write("meetings/2026-03-02-joint.md", "# Joint call\n\n[Portal](projects/portal.md) and [Rocket site](projects/rocket-site.md) together.\n");
  w.write("meetings/2026-03-03-rocket.md", "# Rocket review\n\nWith [Rocket site](projects/rocket-site.md) and [Sam](people/sam.md).\n");
  w.write("meetings/2026-03-04-offsite.md", "# Offsite\n\nFollow-up to the [Rocket review](meetings/2026-03-03-rocket.md).\n");
  w.write("glossary.md", "# Glossary\n\nWords we use.\n");
  const plan = (scope, path) => w.exportPlan({ scope, path });
  const paths = (p) => p.pages.map((x) => x.path).sort();
  return { ws, w, plan, paths };
}

test("a project's export holds its start page, the pages linked with it and the pages related to those", (t) => {
  const { plan, paths } = setup(t);
  const portal = plan("project", "projects/portal.md");
  assert.equal(portal.title, "Portal");
  assert.deepEqual(portal.pages[0], { path: "projects/portal.md", title: "Portal", section: "Projects", why: "start" });
  assert.deepEqual(paths(portal), [
    "goals/growth.md",
    "meetings/2026-03-01-portal-kickoff.md",
    "meetings/2026-03-02-joint.md",
    "meetings/2026-03-03-rocket.md",
    "people/dana.md",
    "people/sam.md",
    "playbooks/launch.md",
    "projects/portal.md",
    "projects/rocket-site.md",
  ]);
  const why = Object.fromEntries(portal.pages.map((p) => [p.path, p.why]));
  assert.equal(why["goals/growth.md"], "linked", "a page the project links to");
  assert.equal(why["meetings/2026-03-01-portal-kickoff.md"], "linked", "a page that links to the project");
  assert.equal(why["projects/rocket-site.md"], "related", "a page one step further, through the joint call");
  assert.equal(why["meetings/2026-03-03-rocket.md"], "related");
  assert.deepEqual(portal.pages.map((p) => p.why), [...portal.pages.map((p) => p.why)].sort((a, b) => ({ start: 0, linked: 1, related: 2 })[a] - ({ start: 0, linked: 1, related: 2 })[b]), "the start page first, then linked, then related");
  // The export stops after two steps, and leaves out pages nothing links with.
  for (const other of ["meetings/2026-03-04-offsite.md", "glossary.md", "WIKI.md"]) assert.ok(!paths(portal).includes(other), other);
});

test("one page takes one step; the usual refusals", (t) => {
  const { plan, paths } = setup(t);
  // A meeting, a goal or any other page: itself and what it is linked with.
  assert.deepEqual(paths(plan("page", "meetings/2026-03-01-portal-kickoff.md")), ["meetings/2026-03-01-portal-kickoff.md", "people/dana.md", "projects/portal.md"]);
  assert.deepEqual(paths(plan("page", "projects/portal.md")), [
    "goals/growth.md",
    "meetings/2026-03-01-portal-kickoff.md",
    "meetings/2026-03-02-joint.md",
    "people/dana.md",
    "people/sam.md",
    "playbooks/launch.md",
    "projects/portal.md",
  ]);
  assert.deepEqual(paths(plan("page", "glossary.md")), ["glossary.md"]);
  // Paths in any letter case, and the usual refusals.
  assert.equal(plan("page", "Glossary.MD").pages[0].path, "glossary.md");
  assert.throws(() => plan("project", "projects/nobody.md"), /Choose the page to export/);
  assert.throws(() => plan("project", "projects/_template.md"), /Choose the page to export/);
  assert.throws(() => plan("everything"), /Choose what to export/);
  assert.throws(() => plan("page", "../outside.md"), /isn't a wiki path/);
});

test("the whole wiki, and the files of a Markdown export", (t) => {
  const { w, plan, paths } = setup(t);
  const all = plan("all");
  assert.equal(all.title, "Wiki");
  assert.equal(all.pages.length, 12, "every page and the guide; no templates");
  assert.ok(paths(all).includes("WIKI.md") && !paths(all).some((p) => p.endsWith("_template.md")));
  // A chosen set: the pages where they live, with their relative links, and a contents page.
  const chosen = ["projects/portal.md", "goals/growth.md"];
  const files = w.exportFiles({ paths: chosen, title: "Portal" });
  assert.deepEqual(files.map((f) => f.path), ["index.md", ...chosen]);
  assert.match(files[0].data, /^# Portal\n\nExported from the Botkins wiki on \d{4}-\d{2}-\d{2}\. 2 pages\.\n\n## Goals\n\n- \[Growth\]\(goals\/growth\.md\): More visits\. [^\n]*\n\n## Projects\n\n- \[Portal\]\(projects\/portal\.md\): Ship the new site\./);
  assert.match(files[2].data, /Served by \[Portal\]\(\.\.\/projects\/portal\.md\)/, "links stay as they are on disk, so they work in the export");
  assert.ok(files[1].time instanceof Date);
  assert.throws(() => w.exportFiles({ paths: [], title: "x" }), /Choose at least one page/);
  assert.throws(() => w.exportFiles({ paths: ["projects/gone.md"], title: "x" }), /no wiki page at projects\/gone\.md/);
  // The whole folder: templates, the guide, the index and the log too; never history or trash.
  w.write("projects/portal.md", "# Portal\n\nChanged.\n");
  w.remove("glossary.md");
  const everything = w.exportFiles({ everything: true }).map((f) => f.path).sort();
  assert.ok(["WIKI.md", "index.md", "log.md", "projects/_template.md", "projects/portal.md"].every((p) => everything.includes(p)));
  assert.ok(everything.every((p) => !p.startsWith(".")) && !everything.includes("glossary.md"));
  assert.deepEqual(w.exportPages(["Projects/Portal.md", "projects/portal.md"]).map((p) => [p.path, p.section, p.content]), [["projects/portal.md", "Projects", "# Portal\n\nChanged.\n"]]);
});

test("the zip writer makes an archive other tools read", (t) => {
  const dir = tempDir(t);
  const big = "A line that repeats.\n".repeat(2000);
  const files = [
    { path: "Export/index.md", data: "# Hello\n", time: new Date(2026, 2, 14, 9, 30, 0) },
    { path: "Export/notes/zoë & co.md", data: "# Zoë\n\nÜmlauts and 日本語.\n" },
    { path: "Export/long.md", data: big },
    { path: "Export/empty.md", data: "" },
    { path: "Export/bytes.bin", data: Buffer.from([0, 1, 2, 255]) },
  ];
  const archive = zip(files);
  const read = unzip(archive);
  assert.deepEqual(Object.keys(read), files.map((f) => f.path));
  assert.equal(read["Export/notes/zoë & co.md"], "# Zoë\n\nÜmlauts and 日本語.\n");
  assert.equal(read["Export/long.md"], big);
  assert.ok(archive.length < big.length / 10, "text is compressed");
  assert.throws(() => zip([{ path: "../escape.md", data: "x" }]), /Invalid archive path/);
  assert.throws(() => zip([{ path: "a.md", data: "x" }, { path: "a.md", data: "y" }]), /Invalid archive path/);
  // The system's own unzip agrees, where there is one.
  const file = join(dir, "export.zip");
  writeFileSync(file, archive);
  try {
    execFileSync("unzip", ["-tq", file], { stdio: "pipe" });
    mkdirSync(join(dir, "out"));
    execFileSync("unzip", ["-q", file, "-d", join(dir, "out")], { stdio: "pipe" });
    assert.equal(readFileSync(join(dir, "out", "Export", "long.md"), "utf8"), big);
    assert.equal(readFileSync(join(dir, "out", "Export", "notes", "zoë & co.md"), "utf8"), "# Zoë\n\nÜmlauts and 日本語.\n");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
});
