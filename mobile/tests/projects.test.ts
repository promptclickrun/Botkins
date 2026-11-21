// Projects in Work: the chats "Add existing chat" offers, moving a started chat, and the artifacts a
// project keeps ("project-artifacts-v1": the link's shapes and policy, and the demo end to end).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { remoteArgs, REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { TEAM_METHODS } from "../link-host/team.mjs";
import { addableChats, artifactCount } from "../src/features/projects/logic";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { Artifact, ArtifactPage, ChatSummary, Project } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const chat = (id: string, more: Partial<ChatSummary> = {}): ChatSummary => ({ id, botId: "mira", title: id, time: 1, count: 2, ...more });

test("Add a chat offers ordinary chats that are not in the project, newest first", () => {
  const projects = [{ id: "p1", name: "Launch" }, { id: "p2", name: "Garden" }];
  const chats = [
    chat("here", { projectId: "p1", time: 50 }),
    chat("free", { time: 10 }),
    chat("Seed order", { projectId: "p2", time: 30 }),
    chat("group", { botIds: ["mira", "patch"], time: 20 }),
    chat("archived", { archived: true, time: 99 }),
    chat("panel", { panelId: "x", time: 98 }),
    chat("routine", { schedules: [{ id: "s", routine: true } as never], time: 97 }),
  ];
  const offered = addableChats(chats, { id: "p1" }, projects);
  assert.deepEqual(offered.map((row) => row.chat.id), ["Seed order", "group", "free"]);
  // A chat in another project says where it is; adding moves it.
  assert.equal(offered[0].inProject, "Garden");
  assert.equal(offered[2].inProject, undefined);
  // A project with a folder takes no group chat.
  assert.deepEqual(addableChats(chats, { id: "p1", folder: "/Users/demo/launch" }, projects).map((row) => row.chat.id), ["Seed order", "free"]);
  // Search reads the title and the bot's name.
  assert.deepEqual(addableChats(chats, { id: "p1" }, projects, "seed").map((row) => row.chat.id), ["Seed order"]);
  assert.deepEqual(addableChats(chats, { id: "p1" }, projects, "MIRA", () => "Mira").length, 3);
  assert.deepEqual(addableChats(chats, { id: "p1" }, projects, "nothing like it"), []);
  assert.equal(artifactCount(0), "Nothing attached yet.");
  assert.equal(artifactCount(1), "1 artifact");
  assert.equal(artifactCount(12), "12 artifacts");
});

test("the link takes a project's artifact calls with a project id and an artifact id, for the owner", () => {
  for (const method of ["addProjectArtifact", "removeProjectArtifact", "projectArtifacts"]) {
    assert.ok(REMOTE_METHODS.has(method), method);
    assert.equal(TEAM_METHODS[method], "owner", method);
  }
  assert.deepEqual(remoteArgs("addProjectArtifact", ["p1", "a1", { extra: true }]), ["p1", "a1"]);
  assert.deepEqual(remoteArgs("removeProjectArtifact", ["p1", "a1"]), ["p1", "a1"]);
  assert.deepEqual(remoteArgs("projectArtifacts", ["p1", "a1"]), ["p1"]);
  assert.throws(() => remoteArgs("projectArtifacts", [{ id: "p1" }]), /Unknown project/);
  assert.throws(() => remoteArgs("addProjectArtifact", ["p1"]), /no longer exists/);
  assert.throws(() => remoteArgs("addProjectArtifact", ["p1", "x".repeat(5000)]), /no longer exists/);
  assert.throws(() => remoteArgs("addProjectArtifact", ["p".repeat(300), "a1"]), /Unknown project/);
});

async function demo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-projects-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
  const paired = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
  const client = new LinkClient(paired, { fetch: real, onParts() {}, onState() {} });
  return { backend, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args), stop: async () => (client.stop(), await link.stop()) };
}

test("the demo keeps a project's artifacts: attach, list, move to the front, remove", async () => {
  const { backend, call, stop } = await demo();
  try {
    assert.ok(backend.capabilities.includes("project-artifacts-v1"));
    const project = backend.state.projects[0] as Project;
    const bot = backend.artifacts[0].item.botId;
    const page = await call<ArtifactPage>("artifacts.list", { botId: bot });
    const [first, second] = page.items as Artifact[];
    assert.deepEqual(await call("addProjectArtifact", project.id, first.id), [first.id]);
    assert.deepEqual(await call("addProjectArtifact", project.id, second.id), [second.id, first.id]);
    // One that is there moves to the front.
    assert.deepEqual(await call("addProjectArtifact", project.id, first.id), [first.id, second.id]);
    const listed = await call<{ items: Artifact[] }>("projectArtifacts", project.id);
    assert.deepEqual(listed.items.map((item) => item.id), [first.id, second.id]);
    assert.equal(listed.items[0].name, first.name);
    await assert.rejects(call("addProjectArtifact", project.id, "not-an-artifact"), /no longer exists/);
    await assert.rejects(call("projectArtifacts", "no-such-project"), /Unknown project/);
    assert.deepEqual(await call("removeProjectArtifact", project.id, first.id), [second.id]);
    // Removing one that isn't attached is no error; the last one leaves no list behind.
    assert.deepEqual(await call("removeProjectArtifact", project.id, first.id), [second.id]);
    assert.deepEqual(await call("removeProjectArtifact", project.id, second.id), []);
    assert.equal(project.artifacts, undefined);
  } finally {
    await stop();
  }
});

test("the demo moves a started chat into a project unless its folder would change", async () => {
  const { backend, call, stop } = await demo();
  try {
    const started = backend.state.chats.find((item: any) => item.messages.length > 0 && !item.projectId);
    const plain = backend.state.projects.find((item: any) => !item.folder) ?? backend.state.projects[backend.state.projects.push({ id: "p-plain", name: "Plain", todos: [], lastUsed: 1, createdAt: 1 }) - 1];
    await call("setChatProject", started.id, plain.id, "default");
    assert.equal(started.projectId, plain.id);
    await call("setChatProject", started.id, null);
    assert.equal(started.projectId, undefined);
    const withFolder = backend.state.projects.find((item: any) => item.folder);
    if (withFolder) await assert.rejects(call("setChatProject", started.id, withFolder.id, "default"), /another folder/);
  } finally {
    await stop();
  }
});
