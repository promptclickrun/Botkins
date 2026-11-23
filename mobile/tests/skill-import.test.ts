import assert from "node:assert/strict";
import test from "node:test";
import { finishSkillImport } from "../src/features/skills/importSkill";
import { authorize } from "../link-host/team.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkHost } from "../link-host/index.mjs";
import { pair, LinkClient, type FetchLike } from "../src/link/client";
import { MockBackend } from "../link-host/mock-backend.mjs";
import type { CatalogPreview, CatalogSkill, SkillImportResult } from "../src/link/types";

test("replacing skills needs the named conflicts, a yes, and the same computer", async () => {
  const sent: (string[] | undefined)[] = [];
  const send = async (replace?: string[]) => {
    sent.push(replace);
    return replace ? { added: ["notes"], conflicts: [] } : { added: [], conflicts: ["notes"] };
  };
  assert.equal(
    await finishSkillImport(
      send,
      async () => false,
      () => true,
    ),
    undefined,
  );
  assert.deepEqual(sent, [undefined]);
  let connected = true;
  await assert.rejects(
    finishSkillImport(
      send,
      async () => {
        connected = false;
        return true;
      },
      () => connected,
    ),
    /Reconnect/,
  );
  assert.deepEqual(
    await finishSkillImport(
      send,
      async (names) => names[0] === "notes",
      () => true,
    ),
    ["notes"],
  );
  assert.deepEqual(sent, [undefined, undefined, undefined, ["notes"]]);
});

test("link permissions distinguish reading, adding and replacing", () => {
  const perms: {skills: string[]} = { skills: [] };
  const team = { roles: [{ id: "r", perms, bots: "all" }], groups: [{ id: "g", roleId: "r" }], members: [{ id: "m", groupId: "g" }] };
  const member = { kind: "member", memberId: "m" };
  for (const method of ["skillsCatalog.search", "skillsCatalog.preview"]) assert.match(authorize(member, team, method, []), /role/);
  perms.skills.push("read");
  for (const method of ["skillsCatalog.search", "skillsCatalog.preview"]) assert.equal(authorize(member, team, method, []), "");
  for (const method of ["skills.upload", "skillsCatalog.install"]) assert.match(authorize(member, team, method, []), /role/);
  perms.skills.push("create");
  assert.equal(authorize(member, team, "skills.upload", [{}]), "");
  assert.equal(authorize(member, team, "skillsCatalog.install", ["token"]), "");
  assert.match(authorize(member, team, "skills.upload", [{ replace: ["notes"] }]), /replace/);
  assert.match(authorize(member, team, "skillsCatalog.install", ["token", ["notes"]]), /replace/);
});

test("the demo accepts a phone upload and searches, previews and installs a skill offline", async (t) => {
  const backend = new MockBackend();
  const dir = mkdtempSync(join(tmpdir(), "botkins-skills-link-"));
  const host = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.setEnabled(true);
  const localFetch = fetch as unknown as FetchLike;
  const pairing = await pair(localFetch, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, { name: "Phone", platform: "ios" });
  const client = new LinkClient(pairing, { fetch: localFetch, onParts() {}, onState() {} });
  t.after(() => client.stop());
  const upload: SkillImportResult = await client.call<SkillImportResult>("skills.upload", {
    filename: "Field Notes.md",
    data: Buffer.from("Write a note.").toString("base64"),
  });
  assert.deepEqual(upload.added, ["field-notes"]);
  const rows: CatalogSkill[] = await client.call<CatalogSkill[]>("skillsCatalog.search", "design");
  const preview: CatalogPreview = await client.call<CatalogPreview>("skillsCatalog.preview", rows[0].id);
  assert.match(preview.text, /contrast/);
  await client.call("skillsCatalog.install", preview.token);
  const after: CatalogSkill[] = await client.call<CatalogSkill[]>("skillsCatalog.search", "design");
  assert.equal(after[0].installed, preview.name);
});
