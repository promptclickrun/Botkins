// `relay.own` on the terminal host (desktop/terminal/config.mjs): the relay is the server's own and the
// only way phones reach it, so the link takes the screen grant through it (desktop/link/grant.mjs).
// What the link then does through that relay is tested on the link itself (test/headless.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalPaths } from "../desktop/terminal/paths.mjs";
import { startService } from "../desktop/terminal/serve.mjs";

const skip = process.platform === "win32" && "The terminal host runs on Linux and macOS.";
const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

test("relay.own makes the host's relay its own, and only that setting does", { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bk-relay-own-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const own of [true, false]) {
    const paths = terminalPaths({ root: join(dir, String(own)), env: {} });
    mkdirSync(paths.root, { recursive: true });
    // Nothing answers at this relay: only the setting is under test.
    writeFileSync(paths.config, JSON.stringify({ link: { port: await freePort(), announce: false }, relay: { enabled: true, url: "https://127.0.0.1:9", own } }));
    const running = await startService({ paths, version: "9.9.9", trial: true });
    try {
      assert.equal(running.runtime.link.ownRelay(), own);
    } finally {
      await running.stop("the test ended");
    }
  }
});
