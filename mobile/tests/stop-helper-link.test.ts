// A paired phone stops one helper or background command through the link ("stop-helper-v1"):
// the link's own argument check (link-host/methods.mjs), the team rule, and the demo computer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { TEAM_METHODS } from "../link-host/team.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { Run } from "../src/link/types";

test("a paired phone stops one helper of a turn through the link", async (t) => {
  const backend = new MockBackend();
  assert.ok(backend.capabilities.includes("stop-helper-v1"));
  const dir = mkdtempSync(join(tmpdir(), "botkins-stop-helper-"));
  const host = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.setEnabled(true);
  const fetcher = fetch as unknown as FetchLike;
  const pairing = await pair(fetcher, { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code }, { name: "Phone", platform: "ios" });
  const client = new LinkClient(pairing, { fetch: fetcher, onParts() {}, onState() {} });
  t.after(() => client.stop());

  const run = () => backend.state.runs.find((r: Run) => r.id === "run-crew") as Run;
  assert.equal(run().agents?.find((a) => a.id === "task-searcher")?.stoppable, true);
  await client.call("stopHelper", "chat-crew", "task-searcher");
  assert.equal(run().agents?.find((a) => a.id === "task-searcher")?.status, "Stopped");

  await assert.rejects(client.call("stopHelper", "chat-crew"), "the link wants both ids");
  await assert.rejects(client.call("stopHelper", "chat-crew", 42), "and strings");
  assert.deepEqual(TEAM_METHODS["stopHelper"], TEAM_METHODS["stop"], "whoever may stop the turn may stop one of its helpers");
});
