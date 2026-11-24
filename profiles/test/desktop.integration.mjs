import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { setup, signup, passkey } from "./support.mjs";
import { ORIGIN, random } from "../src/common.mjs";
import { LinkHost } from "../../desktop/desktop/link/index.mjs";
import { seedApp } from "../../desktop/test/starter.mjs";

const { _electron, expect } = createRequire(new URL("../../desktop/package.json", import.meta.url))(
  "@playwright/test",
);
const root = fileURLToPath(new URL("../../desktop/", import.meta.url));

async function launch(dir) {
  const env = { ...process.env, BOTKINS_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ cwd: root, args: [root], env, timeout: 15000 });
  try {
    const page = await app.firstWindow({ timeout: 10000 });
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => typeof window.botkins?.profileStatus === "function");
    return { app, page };
  } catch (e) {
    await app.close();
    throw e;
  }
}

test("fresh and upgraded desktops can opt out once and reopen their local workspace", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "botkins-desktop-profile-"));
  t.after(() => rmSync(scratch, { force: true, recursive: true }));
  for (const upgraded of [false, true]) {
    const dir = join(scratch, upgraded ? "upgrade" : "fresh");
    if (upgraded) seedApp(dir);
    const { app, page } = await launch(dir);
    try {
      const before = await page.evaluate(() => window.botkins.profileStatus());
      assert.equal(before.migration.needed, upgraded);
      const optOut = page.getByRole("button", {
        name: /keep (this|using).*local.only|continue without (a )?profile|use without (a )?profile/i,
      });
      await optOut.first().click();
      await expect
        .poll(() => page.evaluate(async () => (await window.botkins.profileStatus()).optedOut))
        .toBe(true);
      assert.equal((await page.evaluate(() => window.botkins.profileStatus())).signedIn, false);
    } finally {
      await app.close();
    }
    const reopened = await launch(dir);
    try {
      const after = await reopened.page.evaluate(() => window.botkins.profileStatus());
      assert.equal(after.optedOut, true);
      assert.equal(after.migration.needed, false);
      assert.equal(after.pending, null);
    } finally {
      await reopened.app.close();
    }
  }
});

test("a new desktop opens a linked host directly from profile onboarding", async (t) => {
  const fixture = setup(t);
  const { session, auth } = await signup(fixture);
  const scratch = mkdtempSync(join(tmpdir(), "botkins-desktop-open-host-"));
  const host = new LinkHost({
    dir: join(scratch, "host"),
    port: 0,
    extraHosts: ["127.0.0.1"],
    relay: false,
    profileFetch: fixture.fetchWorker,
    backend: {
      info: () => ({ app: "botkins" }),
      snapshot: () => ({ bots: [], chats: [], runs: [] }),
      subscribe: () => () => {},
    },
  });
  t.after(async () => {
    await host.stop();
    rmSync(scratch, { force: true, recursive: true });
  });
  await host.setEnabled(true);
  host.setName("Profile test workstation");
  const serverId = host.store.data.serverId,
    serverKey = Buffer.from(host.store.data.keys.publicKey).toString("base64url");
  const { ticket } = await fixture.api(
    "proofs/issue",
    { purpose: "bind", serverId, serverKey },
    session.token,
  );
  const descriptor = await host.bindOwnerProfile(ticket);
  await fixture.api("hosts/put", descriptor, session.token);

  // Route only this temporary Electron process's profile requests to the local Worker fixture.
  const proxy = createServer(async (req, res) => {
    try {
      const data = [];
      for await (const chunk of req) data.push(chunk);
      const result = await fixture.fetchWorker(ORIGIN + req.url, {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(data),
      });
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(await result.text());
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((ready) => proxy.listen(0, "127.0.0.1", ready));
  t.after(() => {
    proxy.closeAllConnections();
    return new Promise((done) => proxy.close(done));
  });
  const { app, page } = await launch(join(scratch, "client"));
  try {
    await app.evaluate(
      (_electron, { origin, proxyUrl }) => {
        const transport = globalThis.fetch;
        globalThis.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          return transport(url.origin === origin ? proxyUrl + url.pathname : input, init);
        };
      },
      { origin: ORIGIN, proxyUrl: "http://127.0.0.1:" + proxy.address().port },
    );
    await page
      .getByRole("button", {
        name: /set up profile|sign in or create|create or sign in|create or use a profile/i,
      })
      .first()
      .click();
    await expect
      .poll(() => page.evaluate(async () => !!(await window.botkins.profileStatus()).pending))
      .toBe(true);
    const { pending } = await page.evaluate(() => window.botkins.profileStatus());
    assert.match(pending.code, /^\d{6}$/);
    const browser = random();
    const step = (action, data = {}) =>
      fixture.api("browser/" + action, { id: pending.id, browser, ...data });
    await step("open", { code: pending.code });
    await passkey({ page: step }, auth);
    assert.equal((await page.evaluate(() => window.botkins.profileStatus())).signedIn, false);
    await fixture.api("devices/approve", { id: pending.id, code: pending.code }, session.token);
    await page.getByRole("button", { name: /^finish(?: sign.in)?$/i }).click();
    await page.getByText("Profile test workstation", { exact: true }).first().waitFor();
    assert.equal(
      (await fixture.api("home", {}, session.token)).hosts.length,
      1,
      "signing in on an empty client cannot publish an additional host",
    );
    await page
      .getByRole("button", { name: /^open(?: profile test workstation)?$/i })
      .first()
      .click();
    await expect
      .poll(() => page.evaluate(async () => (await window.botkins.remoteHosts()).using?.id), {
        timeout: 10000,
      })
      .toBe(serverId);
    const connected = await page.evaluate(() => window.botkins.remoteHosts());
    assert.equal(
      connected.hosts.length,
      1,
      JSON.stringify({
        serverId,
        hostCount: host.store.data.devices.length,
        using: connected.using,
        feedback: await page.locator("[role=alert]").allTextContents(),
      }),
    );
    assert.equal(host.store.data.devices.filter((d) => d.profile?.profileId === session.profileId).length, 1);
  } finally {
    await app.close();
  }
});
