import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginCatalog, inspectPlugin } from "../desktop/plugin-catalog.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "botkins-plugin-catalog-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  const market = join(root, "market");
  const plugin = join(market, "plugins", "memory");
  await mkdir(join(market, ".github", "plugin"), { recursive: true });
  await mkdir(join(plugin, "skills", "remember"), { recursive: true });
  await mkdir(join(plugin, "hooks"), { recursive: true });
  await writeFile(join(market, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: "test-market",
    plugins: [{
      name: "memory",
      source: "plugins/memory",
      description: "Remember things",
      version: "1.0.0",
      keywords: ["memory"],
    }],
  }));
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({
    name: "memory",
    version: "1.0.0",
    description: "Remember things",
    extensions: { "com.github.awesome-copilot": { skills: ["./skills/remember/"] } },
    userConfig: { MEMORY_API_KEY: { title: "Memory API key", sensitive: true, required: true } },
  }));
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
    mcpServers: {
      memory: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${MEMORY_API_KEY}" } },
    },
  }));
  await writeFile(join(plugin, "hooks", "hooks.json"), JSON.stringify({
    hooks: { userPromptSubmitted: [{ matcher: "*", hooks: [{ type: "command", bash: "node \"${PLUGIN_ROOT}/recall.mjs\"" }] }] },
  }));
  await writeFile(join(plugin, "skills", "remember", "SKILL.md"), "# Remember\n");
  await writeFile(join(plugin, "recall.mjs"), "console.log('not run')\n");
  return { root, market, plugin };
}

test("catalog browses a local marketplace and parses components without executing them", async (t) => {
  const { root, market } = await fixture(t);
  const catalog = new PluginCatalog(join(root, "host-data"));
  const marketplace = await catalog.addMarketplace(market);
  assert.equal(marketplace.id, "test-market");
  assert.equal(marketplace.count, 1);
  assert.deepEqual((await catalog.browse({query:"remember",marketplace:marketplace.id})).plugins.map((item) => item.name), ["memory"]);
  const restored = new PluginCatalog(join(root, "host-data"));
  assert.equal((await restored.browse({ marketplace: "test-market" })).plugins[0].name, "memory", "fresh catalogs use the hourly marketplace cache");

  const preview = await catalog.preview("memory@test-market");
  assert.match(preview.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.contents.skills, ["skills/remember/SKILL.md"]);
  assert.deepEqual(preview.contents.mcpServers, [{ name: "memory", kind: "remote", url: "https://example.test/mcp", headers: ["Authorization"] }]);
  // The fixture's hook has the matcher "*", which means all: the hook runs, so it is shown.
  assert.deepEqual(preview.contents.hooks, [{ event: "userPromptSubmitted", command: "node \"${PLUGIN_ROOT}/recall.mjs\"", env: [], timeoutSec: 10 }]);
  assert.equal("notRun" in preview.contents, false);
  assert.equal(preview.starts, 1, "a preview has the mark of this reading");
  // The files that are not skills, agents or commands: counted, with the manifest, the tool and hook files and the script.
  assert.deepEqual(preview.contents.otherFiles.files.map((file) => file.path), [".mcp.json", "hooks/hooks.json", "plugin.json", "recall.mjs"]);
  assert.equal(preview.contents.otherFiles.count, 4);
  assert.match(preview.warnings.join(" "), /A command runs with the plugin's own files/);
  assert.deepEqual(preview.config, [{
    key: "MEMORY_API_KEY",
    label: "Memory API key",
    secret: true,
    required: true,
    // Where the value goes: this header of this tool, at this address.
    sentTo: [{ tool: "memory", header: "Authorization", url: "https://example.test/mcp" }],
  }]);
  assert.match(preview.warnings.join(" "), /remote MCP/i);

  const parsed = inspectPlugin(join(market, "plugins", "memory"));
  assert.equal(parsed.name, "memory");
  assert.equal(parsed.manifestPath, "plugin.json");
  assert.equal(parsed.config[0].secret, true);

  // A source change after review must not alter a pinned materialization.
  await writeFile(join(market, "plugins", "memory", "recall.mjs"), "console.log('changed')\n");
  await assert.rejects(catalog.materialize("memory@test-market", preview.revision), /changed after revision.*preview it again/i);
  const changedPreview = await catalog.preview("memory@test-market");
  const materialized = await catalog.materialize("memory@test-market", changedPreview.revision);
  assert.equal(materialized.revision, changedPreview.revision);
  assert.equal(await readFile(join(materialized.folder, "recall.mjs"), "utf8"), "console.log('changed')\n");
  await assert.rejects(catalog.materialize("memory@test-market", "0".repeat(64)), /preview it again/);
  t.diagnostic(`snapshot=${materialized.folder}`);
});

test("folder plugins have stable IDs, immutable snapshots, and reject symlinks", async (t) => {
  const { root, plugin } = await fixture(t);
  const catalog = new PluginCatalog(join(root, "host-data"));
  const first = await catalog.addFolder(plugin);
  const second = await catalog.addFolder(plugin);
  assert.equal(first.preview.id, second.preview.id);
  assert.equal(first.revision, second.revision);
  assert.equal(first.folder, second.folder);
  assert.equal((await catalog.browse({ marketplace: "folder" })).plugins[0].installed, true);
  await catalog.forgetFolder(first.preview.id);
  assert.deepEqual((await catalog.browse({ marketplace: "folder" })).plugins, []);

  const symlinked = join(root, "symlinked");
  await mkdir(symlinked, { recursive: true });
  await symlink(plugin, join(symlinked, "plugin-link"));
  await assert.rejects(new PluginCatalog(join(root, "other-host")).addFolder(join(symlinked, "plugin-link")), /real directory|symlink/i);
});

test("path traversal in a catalog entry is refused at preview", async (t) => {
  const { root, market } = await fixture(t);
  await writeFile(join(market, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: "unsafe-market",
    plugins: [{ name: "escape", source: "../outside" }],
  }));
  const catalog = new PluginCatalog(join(root, "host-data"));
  await catalog.addMarketplace(market);
  await assert.rejects(catalog.preview("escape@unsafe-market"), /escape its source folder|safe relative path/i);
});

test("a marketplace cannot follow a linked plugin folder outside its root", async t => {
  const { root, market, plugin } = await fixture(t);
  const catalog = new PluginCatalog(join(root, "host-data"));
  const alias = join(market, "elsewhere");
  await symlink(plugin, alias);
  await writeFile(join(market, ".github/plugin/marketplace.json"), JSON.stringify({
    name: "linked", plugins: [{ name: "memory", source: "elsewhere" }]
  }));
  await catalog.addMarketplace(market);
  await assert.rejects(catalog.preview("memory@linked"), /symlink/);
});

test("live awesome-copilot smoke is opt-in", { skip: !process.env.PLUGIN_CATALOG_LIVE }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "botkins-plugin-catalog-live-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  const catalog = new PluginCatalog(root);
  const page = await catalog.browse({ marketplace: "awesome-copilot", query: "project-planning" });
  assert.ok(page.plugins.length > 0);
  const item = page.plugins[0];
  const preview = await catalog.preview(item.id);
  assert.ok(preview.contents.skills.length > 0);
  assert.ok(preview.contents.agents.length > 0);
  const materialized = await catalog.materialize(item.id, preview.revision);
  assert.equal(materialized.revision, preview.revision);
  assert.ok(materialized.folder.startsWith(join(await realpath(root), "plugins")));
  assert.equal((await readFile(join(materialized.folder, "skills", "breakdown-epic-arch", "SKILL.md"))).length > 0, true);
});

test("a preview shows each environment value as written, says which names are not set, and lists only the files that go on", async (t) => {
  const { plugin } = await fixture(t);
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
    mcpServers: { local: { command: "node", args: ["--port", 3000], env: { MODE: "fast", GIT_SSH_COMMAND: "sh -c x" }, cwd: "server" } },
  }));
  await mkdir(join(plugin, "agents"), { recursive: true });
  await writeFile(join(plugin, "agents", "a.md"), "A");
  await writeFile(join(plugin, "agents", "notes.txt"), "not Markdown");
  const parsed = inspectPlugin(plugin);
  assert.deepEqual(parsed.contents.mcpServers, [{
    name: "local", kind: "local", command: "node", args: ["--port", "3000"],
    env: [{ name: "MODE", value: "fast" }], envNotSet: ["GIT_SSH_COMMAND"], cwd: "server",
  }]);
  assert.equal(parsed.warnings.filter((line) => /does not set some environment names/.test(line)).length, 1);
  assert.deepEqual(parsed.contents.agents, ["agents/a.md"]);
});
