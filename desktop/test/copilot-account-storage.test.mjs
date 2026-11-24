// Exercise the bundled native runtime against a disposable account. GitHub account lookups
// go to loopback and the runtime cannot touch the user's keychain, home or CLI sign-in.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { CopilotClient, RuntimeConnection } from "@microsoft/copilot-sdk";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { tempDir } from "./fake-copilot.mjs";

test("the native SDK can disconnect one Botkins host while its saved Copilot account still exists", async (t) => {
  const home = tempDir(t);
  const api = createServer((request, response) => {
    if (request.url !== "/copilot_internal/user") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ login: "fixture", id: 101, copilot_plan: "free", chat_enabled: true }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const endpoint = "http://127.0.0.1:" + api.address().port;
  const env = {
    HOME: home, USERPROFILE: home, PATH: "", COPILOT_DISABLE_KEYTAR: "1",
    COPILOT_DEBUG_GITHUB_API_URL: endpoint, COPILOT_API_URL: endpoint,
    ...(process.platform === "win32" && { SystemRoot: process.env.SystemRoot }),
  };
  writeFileSync(join(home, "settings.json"), JSON.stringify({ storeTokenPlaintext: true }), { mode: 0o600 });
  const sdk = {
    CopilotClient,
    RuntimeConnection: {
      forSpawnedStdio: (options) => RuntimeConnection.forSpawnedStdio({ ...options, env }),
    },
  };
  const host = () => {
    const provider = new CopilotProvider({ baseDirectory: home, workingDirectory: home, sdk });
    provider.inProcess = () => false;
    t.after(() => provider.stop());
    return provider;
  };
  const seed = host();
  const client = await seed.client();
  const saved = await client.rpc.account.login({ host: "https://github.com", login: "fixture", token: "gho_invalidBotkinsFixture" });
  assert.equal(saved.storedInVault, true);
  await seed.stop();

  const active = host();
  assert.equal((await active.status()).account, "fixture");
  await active.disconnectAccount();
  assert.equal((await active.status()).connected, false);
  await active.stop();

  const restarted = host();
  assert.equal((await restarted.status()).connected, false);
  // A normal SDK consumer still sees the saved account. Disconnect is local to Botkins.
  await restarted.stop();
  const other = new CopilotClient({ mode: "coding-agent", runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: home, workingDirectory: home, env }) });
  try {
    await other.start();
    assert.equal((await other.getAuthStatus()).login, "fixture");
  } finally {
    await other.stop();
  }
});
