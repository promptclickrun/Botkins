import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
export function createSources(dir) {
  const skills = join(dir, "skills"),
    plugin = join(dir, "sample-plugin"),
    mcp = join(dir, "servers.json");
  const skillProof = randomUUID().slice(0, 12),
    pluginProof = randomUUID().slice(0, 12),
    toolProof = randomUUID().slice(0, 12);
  function skill(root, name, proof) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, "SKILL.md"),
      "---\nname: " +
        name +
        "\ndescription: Return the sample identifier.\n---\nReply with only the following sample identifier: " +
        proof +
        ". Do not use tools.",
    );
  }
  skill(skills, "sample-skill", skillProof);
  skill(join(plugin, "skills"), "plugin-sample", pluginProof);
  writeFileSync(
    join(plugin, "plugin.json"),
    JSON.stringify({
      name: "sample-pack",
      description: "Botkins smoke fixture",
      version: "1.0.0",
      skills: "skills/",
    }),
  );
  const receipt = join(dir, "invocations.log"),
    value = join(dir, "sample.txt");
  writeFileSync(value, toolProof);
  writeFileSync(
    mcp,
    JSON.stringify({
      mcpServers: {
        "botkins-sample": {
          type: "stdio",
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./sample-mcp.mjs", import.meta.url)),
            value,
            receipt,
          ],
          tools: ["read_sample", "review_note"],
        },
      },
    }),
  );
  return { skills, plugin, mcp, skillProof, pluginProof, toolProof, receipt };
}
