// Run with node test/plugins-public-live.mjs. Reads the public GitHub catalog and opens two
// signed-out local Copilot SDK sessions. It makes no inference calls or changes to user data.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] !== "--isolated") {
  const root = mkdtempSync(join(tmpdir(), "botkins-catalog-proof-"));
  try {
    const env = {
      HOME: root,
      USERPROFILE: root,
      COPILOT_HOME: join(root, "copilot"),
      BOTKINS_DATA_DIR: join(root, "data"),
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--isolated"], { env, stdio: "inherit", timeout: 120000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const { Workspace } = await import("./starter.mjs");
  const { fakeClient } = await import("./fake-copilot.mjs");
  const { CopilotClient, RuntimeConnection } = await import("@microsoft/copilot-sdk");
  const { sessionOptions } = await import("../desktop/providers/copilot/index.mjs");
  const ws = new Workspace(process.env.BOTKINS_DATA_DIR, fakeClient().client, () => {});
  const { plugins } = await ws.plugins.browse({ marketplace: "awesome-copilot", query: "project-planning" });
  const { id } = plugins.find((plugin) => plugin.name === "project-planning");
  const card = await ws.plugins.preview(id);
  assert.ok(card.contents.skills.length, "the reviewed upstream package must actually contain skills");
  assert.deepEqual(card.contents.hooks, []);
  assert.deepEqual(card.contents.mcpServers, []);
  const installed = await ws.plugins.install(id, { bots: ["pip"], revision: card.revision });
  const workingDirectory = join(process.env.HOME, "work");
  mkdirSync(workingDirectory);
  const client = new CopilotClient({
    mode: "coding-agent",
    github: { useLoggedInUser: false },
    runtime: RuntimeConnection.forSpawnedStdio({ baseDirectory: process.env.COPILOT_HOME, workingDirectory }),
  });
  try {
    await client.start();
    for (const botId of ["pip", "scout"]) {
      const bot = ws.bot(botId),
        chat = ws.chat(ws.createChat(botId));
      const { directories } = await ws.plugins.session(bot, chat);
      const session = await client.createSession(
        sessionOptions({ model: { model: "gpt-5" }, folder: workingDirectory, plugins: directories }, { handlers: {} }),
      );
      await session.rpc.skills.ensureLoaded();
      const { skills } = await session.rpc.skills.list();
      const match = skills.find((s) => s.name === "breakdown-epic-arch" || s.name.endsWith(":breakdown-epic-arch"));
      assert.equal(Boolean(match?.enabled), botId === "pip", "real SDK skill inventory for " + botId);
      console.log(
        JSON.stringify({ bot: botId, catalog: id, version: installed.version, revision: installed.revision, loaded: match?.name ?? null }),
      );
    }
  } finally {
    await client.stop();
  }
}
