// A phone's bug report or feature request ("feedback-v1"): the computer signs it with its relay key and
// sends it to the relay's feedback route. A real LinkHost and paired phone; the relay is a recording fetch.
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";

const fetcher = fetch as unknown as FetchLike;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

async function setup(status = 201) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-feedback-")));
  folders.push(dir);
  const seen: { url: string; body: any }[] = [];
  const relay = (async (url: string, init: any) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (status !== 201) return new Response("{}", { status });
    return Response.json({ number: 7, url: "https://github.com/promptclickrun/Botkins/issues/7" }, { status: 201 });
  }) as unknown as typeof fetch;
  const link = new LinkHost({ dir, backend: new MockBackend({ speed: 0.05 }), port: 0, extraHosts: ["127.0.0.1"], searchPath: [], relay: false, fetch: relay });
  (link as any).relayUrl = () => "https://relay.test";
  await link.setEnabled(true);
  const paired = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const parts: Record<string, any> = {};
  const client = new LinkClient(paired, { fetch: fetcher, onParts: (next) => void Object.assign(parts, next), onState() {} });
  client.start();
  const end = Date.now() + 5000;
  while (!parts.meta) {
    if (Date.now() > end) throw new Error("no first state");
    await delay(15);
  }
  const call = (method: string, ...args: unknown[]): Promise<any> => (client as any).call(method, ...args);
  return { link, parts, seen, call, done: async () => { client.stop(); await link.stop(); } };
}

test("a phone's report is signed by the computer and comes back as the issue", async () => {
  const { link, parts, seen, call, done } = await setup();
  try {
    assert.ok(parts.meta.capabilities.includes("feedback-v1"));
    const answer = await call("link.feedback.send", { kind: "bug", title: "List jumps", body: "Opening a chat scrolls to the top.", app: "Botkins iOS", version: "0.17.16", platform: "iOS 26.1" });
    assert.deepEqual(answer, { number: 7, url: "https://github.com/promptclickrun/Botkins/issues/7" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://relay.test/v1/feedback");
    const { v, key, time, sig, report } = seen[0]!.body;
    assert.equal(v, 1);
    assert.equal(key, (link as any).store.relayKey().publicKey);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" });
    assert.ok(verify(null, Buffer.from("botkins-feedback-v1:" + time + ":" + report, "utf8"), pub, Buffer.from(sig, "base64url")));
    assert.deepEqual(JSON.parse(report), { kind: "bug", title: "List jumps", body: "Opening a chat scrolls to the top.", app: "Botkins iOS", version: "0.17.16", platform: "iOS 26.1" });
    assert.ok(!JSON.stringify(seen[0]!.body).includes("Test phone"), "the device's name is not sent");
  } finally {
    await done();
  }
});

test("a bad report is refused on the computer, and relay refusals read plainly", async () => {
  const { seen, call, done } = await setup(429);
  try {
    await assert.rejects(call("link.feedback.send", { kind: "rant", title: "Hello there", body: "words here" }), /bug report or a feature request/);
    await assert.rejects(call("link.feedback.send", { kind: "bug", title: "no", body: "words here" }), /title/);
    assert.equal(seen.length, 0);
    await assert.rejects(call("link.feedback.send", { kind: "feature", title: "Dark mode", body: "Please add it." }), /Too many reports/);
  } finally {
    await done();
  }
});
