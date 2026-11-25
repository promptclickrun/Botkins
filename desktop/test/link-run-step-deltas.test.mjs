import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost as DesktopHost } from "../desktop/link/server.mjs";
import { LinkHost as PortableHost } from "../../mobile/link-host/server.mjs";

const step = (id) => ({ id, name: "shell", label: "Read file", input: "run a command", output: "finished", status: "Done", started: 1700000000000 });
for (const [name, Host] of [["desktop", DesktopHost], ["portable", PortableHost]]) {
  test(name + " sends only changed authorized light steps and recovers without a matching base", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "botkins-step-deltas-"));
    const run = { id: "r", chatId: "c", title: "work", status: "Working", time: 1000, steps: [] };
    const state = { bots: [{ id: "b", name: "B" }], chats: [{ id: "c", botId: "b", messages: [] }], runs: [run], streams: { c: "" } };
    for (let i = 0; i < 79; i++) state.runs.push({ id: "old-" + i, chatId: "c", title: "Completed task " + i, status: "Completed", time: i, steps: [step("s")] });
    const host = new Host({ dir, backend: { snapshot: () => state, info: () => ({}), subscribe: () => () => {} }, relay: false });
    t.after(async () => { await host.stop(); rmSync(dir, { recursive: true, force: true }); });
    const device = host.store.addDevice({ name: "Test", platform: "ios", publicKey: Buffer.alloc(32) });
    const session = { deviceId: device.id };
    const legacy = { deviceId: device.id };
    const fresh = { deviceId: device.id };
    const never = new Promise(() => {});
    const sync = (have, next = session, options = {}) => {
      const raw = host.sync(next, { epoch: host.epoch, watch: ["c"], steps: "light", appends: {}, reasoningWatch: ["c"], runSteps: "delta", runSummaries: "delta", have, ...options }, never);
      return raw.text ? JSON.parse(raw.text) : raw;
    };
    let news = sync({});
    const key = "run:c";
    let summaries = news.parts.runs;
    let summaryBytes = 0;
    assert.equal(summaries.length, 80);
    assert.ok(news.parts.meta.capabilities.includes("run-step-deltas-v1"));
    assert.deepEqual(news.parts[key], run);
    let rows = 0;
    let bytes = 0;
    // One independently acknowledged change per sample: 200 unique short rows previously sent
    // 20,100 rows. This measures run JSON before encryption; real network coalescing may skip ticks.
    for (let i = 0; i < 200; i++) {
      run.steps.push(step("s" + i));
      host.changed();
      const base = news.v[key];
      news = sync(news.v);
      const changed = news.parts.runs;
      assert.equal(changed.patch, "summaries");
      assert.equal(changed.set.length, 1);
      assert.equal(changed.set[0].id, run.id);
      assert.equal(changed.set[0].stepCount, i + 1);
      assert.equal(changed.order, undefined);
      summaries[0] = changed.set[0];
      summaryBytes += Buffer.byteLength(JSON.stringify(changed));
      const patch = news.parts[key];
      assert.equal(patch.base, base);
      assert.equal(patch.patch, "steps");
      assert.deepEqual(patch.set, [run.steps[i]]);
      assert.equal(patch.order, undefined);
      bytes += Buffer.byteLength(JSON.stringify(patch));
      rows += patch.set.length;
    }
    assert.deepEqual(summaries, sync({}, fresh, { runSummaries: undefined }).parts.runs);
    assert.ok(summaryBytes < 50_000);
    t.diagnostic("200 separate summary changes: " + summaryBytes + " bytes with 79 unchanged historical runs.");
    assert.equal(rows, 200);
    assert.ok(bytes < 45_000);
    t.diagnostic("200 separate step appends: " + rows + " rows and " + bytes + " bytes of run JSON.");

    state.runs.splice(3, 1);
    state.runs.unshift(state.runs.pop());
    host.changed();
    const beforeMove = news.v;
    news = sync(beforeMove);
    assert.deepEqual(news.parts.runs.remove, ["old-2"]);
    assert.deepEqual(news.parts.runs.order, state.runs.map(item => item.id));
    assert.equal(news.parts.runs.set, undefined);
    assert.deepEqual(sync(beforeMove).parts.runs, sync({}, fresh, { runSummaries: undefined }).parts.runs, "lost reorder recovers the full authorized list");
    const beforeEdit = news.v;
    const [first] = run.steps;
    run.steps[0] = { ...first, input: "private-tool-body".repeat(150), status: "Running" };
    run.steps.splice(3, 1);
    run.steps.reverse();
    run.title = "renamed";
    host.changed();
    news = sync(beforeEdit);
    const patch = news.parts[key];
    assert.equal(patch.metadata.title, run.title);
    assert.equal(patch.metadata.steps, undefined);
    assert.deepEqual(patch.remove, ["s3"]);
    assert.deepEqual(patch.order, run.steps.map(row => row.id));
    assert.equal(patch.set.length, 1);
    assert.equal(patch.set[0].more, true);
    assert.ok(!JSON.stringify(news.parts).includes("private-tool-body"));
    // The response was lost. It replaced the host's sent baseline, so an older ack gets a full view.
    const replay = sync(beforeEdit);
    assert.ok(Array.isArray(replay.parts[key].steps));
    assert.ok(!JSON.stringify(replay.parts).includes("private-tool-body"));
    run.steps[0].status = "Failed";
    host.changed();
    assert.ok(sync(replay.v).parts[key].set);
    assert.ok(Array.isArray(sync(replay.v, legacy, { runSteps: undefined }).parts[key].steps));
    assert.ok(Array.isArray(sync({}, legacy, { steps: undefined }).parts[key].steps));
    // Removing the owner's visibility clears the run and the diff base. No hidden data can be diffed.
    state.chats[0].createdBy = "another-person";
    run.steps[0].output = "other-person-secret";
    host.changed();
    const hidden = sync(news.v);
    assert.equal(hidden.parts[key], null);
    assert.ok(!JSON.stringify(hidden.parts).includes("other-person-secret"));
    assert.ok(!session.runStepBases.has(key));
    assert.deepEqual(hidden.parts.runs, [], "the phone loses access to all its former summaries immediately");
    delete state.chats[0].createdBy;
    host.changed();
    const restored = sync(hidden.v);
    assert.ok(Array.isArray(restored.parts[key].steps));
    // A new turn, or ambiguous historical step IDs, must round-trip in the original snapshot form.
    run.id = "r-next";
    host.changed();
    const replacement = sync(restored.v);
    assert.equal(replacement.parts[key].id, run.id);
    run.steps.push({ ...run.steps[0] });
    host.changed();
    assert.ok(Array.isArray(sync(replacement.v).parts[key].steps));
    // On a short run list, replacing a changed row takes fewer bytes than wrapping it in a patch.
    state.runs = [run];
    host.changed();
    const one = sync({});
    run.title = "Only row";
    host.changed();
    const shortList = sync(one.v).parts.runs;
    assert.ok(Array.isArray(shortList));
    assert.equal(shortList[0].title, run.title);
  });
}
