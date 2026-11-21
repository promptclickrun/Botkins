import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { Artifacts } from "../desktop/artifacts.mjs";
import { openChatPath } from "../desktop/artifact-files.mjs";
import { ArtifactMedia } from "../desktop/artifact-media.mjs";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { Providers } from "../desktop/providers/index.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { LinkClient, pair } from "../desktop/remote/link-client.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bk-art-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chats = [{ id: "a", botId: "pip", title: "Brief", messages: [] }, { id: "b", botId: "pip", title: "Next", messages: [] }, { id: "c", botId: "ivy", title: "Private", messages: [] }];
  const ws = { dir, state: { chats, runs: [], bots: [{ id: "pip" }, { id: "ivy" }] }, projects: { folderFor: () => null } };
  const put = (name, body = "sample") => { const path = join(dir, name); writeFileSync(path, body); return path; };
  return { dir, index: new Artifacts(ws), ws, put };
}

test("media previews serve seek ranges and stop reading when closed", async () => {
  const media = new ArtifactMedia("botkins-app");
  const size = 2 * 1024 * 1024;
  const calls = [];
  const url = media.add("video/mp4", size, (offset, length) => {
    calls.push([offset, length]);
    return { artifact: { size }, data: Buffer.alloc(length, 7).toString("base64"), offset };
  });
  const request = (range) => new Request(url, { headers: { Range: range } });
  const part = media.response(request("bytes=100-110"));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 100-110/" + size);
  assert.equal((await part.arrayBuffer()).byteLength, 11);
  assert.deepEqual(calls, [[100, 11]]);
  assert.equal(media.response(request("bytes=3000000-")).status, 416);
  media.close(url);
  assert.equal(media.response(request("bytes=0-")).status, 404);
});

test("artifact provenance survives a restart, filters by bot, chat and media, and prunes missing files", (t) => {
  const { index, ws, put } = fixture(t);
  const pdf = put("brief.pdf");
  const image = put("cat.jpg");
  index.record(pdf, { botId: "pip", chatId: "a", messageIndex: 0, source: "upload", time: 10 });
  index.record(image, { botId: "pip", chatId: "b", source: "tool", time: 20 });
  index.record(put("ivy.md"), { botId: "ivy", chatId: "c", source: "export", time: 30 });
  const after = new Artifacts(ws);
  const all = after.list({ botId: "pip" }).items;
  assert.deepEqual(all.map((i) => i.name), ["cat.jpg", "brief.pdf"]);
  assert.deepEqual(after.list({ botId: "pip", kind: "media" }).items.map((i) => i.kind), ["image"]);
  assert.deepEqual(after.list({ botId: "pip", chatId: "a", kind: "files" }).items.map((i) => i.chatTitle), ["Brief"]);
  assert.deepEqual(after.resolve({ chatId: "c", paths: [pdf, image] }).items, [null, null]);
  assert.equal(after.read(all[1].id, { offset: 1, length: 2 }).data, Buffer.from("am").toString("base64"));
  assert.equal(after.read(all[1].path, { offset: 1, length: 2 }).nextOffset, 3);
  renameSync(put("edited.pdf", "updated"), pdf);
  assert.equal(Buffer.from(after.read(all[1].id).data, "base64").toString(), "updated");
  rmSync(image);
  assert.deepEqual(after.list({ botId: "pip" }).items.map((i) => i.name), ["brief.pdf"]);
  assert.throws(() => after.read(image));
});

test("folder browsing pages children without adding them to the top level or following links outside", (t) => {
  const { index, dir, put } = fixture(t);
  const folder = join(dir, "folder");
  mkdirSync(folder);
  for (let i = 0; i < 52; i++) writeFileSync(join(folder, i + ".txt"), "hello");
  const secret = put("private.txt", "private");
  const elsewhere = join(dir, "outside");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(folder, "pointer"), "junction");
  const { id } = index.record(folder, { botId: "pip", chatId: "a", source: "upload", time: 1 });
  const resolved = index.resolve({ chatId: "a", paths: [folder, folder + "/"] });
  assert.deepEqual(resolved.items.map((item) => item?.id), [id, id]);
  const first = index.list({ botId: "pip", folder: id });
  assert.equal(first.items.length, 50);
  const rest = index.list({ botId: "pip", folder: id, cursor: first.nextCursor });
  assert.equal(rest.items.length, 2);
  assert.equal(new Set([...first.items, ...rest.items].map((i) => i.id)).size, 52);
  assert.equal(index.read(first.items[0].id).data, Buffer.from("hello").toString("base64"));
  assert.equal(index.list({ botId: "pip" }).items.length, 1);
  assert.throws(() => index.read(secret));
  assert.throws(() => index.list({ botId: "ivy", folder: id }));
});

test("the open IPC opens documents and folders, reveals executables, and rejects missing paths", async (t) => {
  const { dir, put } = fixture(t);
  const calls = [];
  const shell = { openPath: async (path) => (calls.push(["open", path]), ""), showItemInFolder: (path) => calls.push(["reveal", path]) };
  const doc = put("report.txt");
  const bundle = join(dir, "Test.app");
  mkdirSync(bundle);
  const exe = put("run.command", "#!/bin/sh");
  const renamed = put("renamed.txt", Buffer.from("7f454c46", "hex"));
  chmodSync(exe, 0o755);
  await openChatPath(shell, doc, "open");
  await openChatPath(shell, dir, "open");
  await openChatPath(shell, exe, "open");
  await openChatPath(shell, renamed, "open");
  await openChatPath(shell, bundle, "open");
  await openChatPath(shell, doc, "reveal");
  await assert.rejects(openChatPath(shell, join(dir, "gone"), "open"));
  assert.deepEqual(calls.map(([action]) => action), ["open", "open", "reveal", "reveal", "reveal", "reveal"]);
});

test("an actual workspace turn records uploads, successful tool writes and MEDIA with their originating messages", async (t) => {
  const { dir, put } = fixture(t);
  const upload = put("given.txt");
  const secret = put("unrelated.txt");
  const output = join(dir, "files", "pip", "photo.png");
  const fake = fakeClient(async (_id, _message, sdk) => {
    sdk.emit({ type: "tool.execution_start", data: { toolName: "write", toolCallId: "w", arguments: { file_path: output } } });
    writeFileSync(output, "sample");
    sdk.emit({ type: "tool.execution_complete", data: { toolCallId: "w", success: true } });
    return { data: { content: 'MEDIA:"' + output + '"\nMEDIA:"' + secret + '"' } };
  });
  const ws = new Workspace(dir, fake.client, () => {});
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Make a photo", { attachments: [upload] });
  const items = ws.artifacts.list({ botId: "pip", chatId }).items;
  assert.deepEqual(items.map((a) => [a.source, a.messageIndex, a.name]).sort(), [
    ["media", 1, "photo.png"], ["tool", 0, "photo.png"], ["upload", 0, "given.txt"],
  ]);
  assert.deepEqual(ws.artifacts.resolve({ chatId, paths: [secret] }).items, [null]);
});

test("a paired client pages and reads indexed artifacts over the link", async (t) => {
  const { dir, put } = fixture(t);
  const ws = new Workspace(dir, fakeClient().client, () => {});
  const chatId = ws.createChat("pip");
  const item = ws.artifacts.record(put("shared.txt", "hello"), { botId: "pip", chatId, source: "export" });
  const exported = { name: "report.csv", text: "one,two\n" };
  assert.deepEqual(ws.artifacts.exported(exported, "pip"), exported);
  const saved = ws.artifacts.list({ botId: "pip" }).items.find((row) => row.name === "report.csv");
  assert.equal(saved.chatId, undefined);
  assert.equal(Buffer.from(ws.artifacts.read(saved.id).data, "base64").toString(), exported.text);
  const methods = { "artifacts.list": (args) => ws.artifacts.list(args), "artifacts.read": (...args) => ws.artifacts.read(...args), "artifacts.resolve": (args) => ws.artifacts.resolve(args), "artifacts.thumbnail": (...args) => ws.artifacts.thumbnail(...args) };
  const host = new LinkHost({ dir: join(dir, "wire"), port: 0, relay: false, backend: {
    info: () => ({ app: "botkins" }), capabilities: ["artifacts-v1"], snapshot: () => ws.snapshot(), subscribe: () => () => {},
    call: (name, args) => methods[name](...args),
  } });
  let phone;
  try {
    await host.setEnabled(true);
    const identity = await pair(fetch, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, { name: "Fixture", platform: "ios" });
    phone = new LinkClient(identity, { fetch, onState() {}, onParts() {} });
    const page = await phone.call("artifacts.list", { botId: "pip", chatId });
    assert.equal(page.items[0].id, item.id);
    assert.equal((await phone.call("artifacts.read", item.id, { length: 2 })).nextOffset, 2);
    assert.equal(await phone.call("artifacts.thumbnail", item.id, { size: 160 }), null, "text uses the file icon");
    const privateFile = put("not-shared.txt");
    assert.deepEqual((await phone.call("artifacts.resolve", { chatId, paths: [item.path, privateFile] })).items.map((i) => i?.id ?? null), [item.id, null]);
    await assert.rejects(phone.call("artifacts.read", privateFile), /unavailable/);
    await assert.rejects(phone.call("openChatPath", item.path, "open"));
  } finally { phone?.stop(); await host.stop(); }
});

test("a shell tool's file is indexed even when the filesystem reports the write after completion", async (t) => {
  const { dir, put } = fixture(t);
  const unshared = put("unrelated.md");
  const output = join(dir, "files", "pip", "chart.csv");
  const fake = fakeClient(async (_id, _message, sdk) => {
    const event = (type, data) => sdk.emit({ type: "tool.execution_" + type, data });
    event("start", { toolCallId: "shell", toolName: "bash", arguments: { command: "make report" } });
    await delay(15);
    writeFileSync(output, "1,2");
    event("complete", { toolCallId: "shell", success: true });
    event("start", { toolCallId: "mcp", mcpToolName: "write_file", mcpServerName: "fixture", arguments: { path: unshared } });
    event("complete", { toolCallId: "mcp", success: true });
    return { data: { content: "The report is ready." } };
  });
  const ws = new Workspace(dir, fake.client, () => {});
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Make the report");
  let items;
  for (let i = 0; i < 100; i++) {
    items = ws.artifacts.list({ botId: "pip" }).items;
    if (items.length) break;
    await delay(25);
  }
  assert.deepEqual(items.map((a) => [a.source, a.name]), [["tool", "chart.csv"]]);
});

test("a picture that a bot wrote into its own session's folder shows in that chat, and in no other", async (t) => {
  const { dir, put } = fixture(t);
  // The app as it runs: the model's runtime keeps its sessions in a folder of the app's own, and
  // gives each session a folder for its files. A bot that names no place writes its pictures there.
  const base = join(dir, "copilot");
  const sessionFiles = (sessionId) => join(base, "session-state", sessionId, "files");
  const picture = (sessionId, name) => {
    mkdirSync(join(sessionFiles(sessionId), "duo"), { recursive: true });
    const path = join(sessionFiles(sessionId), "duo", name);
    writeFileSync(path, "png");
    return path;
  };
  let reply = "";
  const fake = fakeClient(async () => ({ data: { content: reply } }));
  const open = () => new Workspace(dir, new Providers([new CopilotProvider({ connect: fake.client, baseDirectory: base })]), () => {});
  let ws = open();
  const chatId = ws.createChat("pip");
  const other = ws.createChat("pip");
  const mine = [picture(chatId, "01-anatomy.png"), picture(chatId, "02-layers.png")];
  const theirs = picture(other, "private.png");
  const unrelated = put("unrelated.png");
  // A link in the session's folder to a file somewhere else is not a file of that folder.
  const linked = join(sessionFiles(chatId), "duo", "linked.png");
  symlinkSync(unrelated, linked);
  reply = [...mine, theirs, unrelated, linked, join(sessionFiles(chatId), "..", "..", other, "files", "duo", "private.png")].map((path) => "MEDIA:" + path).join("\n");
  await ws.send(chatId, "Draw the anatomy");
  const shown = (workspace, id) => workspace.artifacts.list({ botId: "pip", chatId: id }).items.map((item) => [item.source, item.name]).sort();
  assert.deepEqual(shown(ws, chatId), [["media", "01-anatomy.png"], ["media", "02-layers.png"]]);
  // What a phone asks for each line: the two pictures are there; the rest stay text.
  assert.deepEqual(ws.artifacts.resolve({ chatId, paths: [...mine, theirs, unrelated, linked] }).items.map((item) => item?.name ?? null), ["01-anatomy.png", "02-layers.png", null, null, null]);
  // The other chat's own picture is its own: named there, it shows there.
  reply = "MEDIA:" + theirs;
  await ws.send(other, "And mine");
  assert.deepEqual(shown(ws, other), [["media", "private.png"]]);
  assert.deepEqual(shown(ws, chatId), [["media", "01-anatomy.png"], ["media", "02-layers.png"]], "and still not in the first chat");
  // A session id is one name. Nothing that is a path, or empty, names a folder.
  const provider = new CopilotProvider({ connect: fake.client, baseDirectory: base });
  assert.equal(provider.sessionFiles(chatId), sessionFiles(chatId));
  for (const id of ["", "..", ".", "../" + other, other + "/..", "a/b", "a\\b", null, undefined, 7, "x".repeat(201)]) assert.equal(provider.sessionFiles(id), null, String(id));
  assert.equal(new CopilotProvider({ connect: fake.client }).sessionFiles(chatId), null, "a runtime with no folder of the app's own has none");

  // A chat from before this rule: its pictures were said and not taken. They are found once the app starts again.
  ws.artifacts.rows.splice(0);
  ws.artifacts.save();
  delete ws.state.mediaPass;
  ws.save();
  await ws.close?.();
  ws = open();
  const names = (id) => shown(ws, id).map(([, name]) => name);
  assert.deepEqual(names(chatId).filter((name) => name !== "private.png"), ["01-anatomy.png", "02-layers.png"]);
  assert.deepEqual(names(other), ["private.png"]);
  // (The older rule stands beside the new one: a file that the bot already has a row for can be
  // named in another chat of that bot. So the first chat, which also named the other's picture,
  // may show it after this look, once that picture is the bot's by its own chat.)
  // That look happens once: the next start reads nothing again.
  assert.equal(ws.state.mediaPass, 1);
  ws.artifacts.rows.splice(0);
  ws.artifacts.save();
  ws.save();
  await ws.close?.();
  ws = open();
  assert.deepEqual(shown(ws, chatId), []);
});
