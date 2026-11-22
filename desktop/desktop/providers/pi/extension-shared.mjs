import { readFileSync } from "node:fs";

export const ASK = "botkins:permission";
const OWN = "mcp__botkins__";
const OMP_OWN = "mcp__botkins_";

/** Keep Botkins' prompt while leaving out a harness section that only describes the harness itself. */
export function botkinsPrompt(system, extra = "") {
  const own = (Array.isArray(system) ? system : [String(system ?? "")])
    .map((section) => String(section)
      .replace(/(?:\n\n)?<docs>\n[\s\S]*?\n<\/docs>/g, "")
      .replace(/^\s*-\s+omp:\/\/:\s*harness docs[^\n]*(?:\n|$)/gim, "")
      .trim())
    .filter(Boolean)
    .join("\n\n");
  return extra ? own + "\n\n" + extra : own;
}

function sessionReader(file) {
  return () => {
    if (!file) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
}

/** The same Botkins extension contract for Pi and for OMP, which owns its MCP connections. */
export function makeBotkinsExtension(file, { mcp = true } = {}) {
  const read = sessionReader(file);
  return function botkins(pi) {
    const first = read();
    if (!first) return;
    for (const provider of first.providers ?? []) pi.registerProvider(provider.name, provider.config);
    let servers = "";
    if (mcp) {
      const register = (list) => {
        const next = JSON.stringify(list ?? {});
        if (next === servers) return;
        for (const name of Object.keys(JSON.parse(servers || "{}"))) if (!(name in (list ?? {}))) pi.unregisterMcpServer(name);
        for (const [name, config] of Object.entries(list ?? {})) pi.registerMcpServer(name, config);
        servers = next;
      };
      register(first.servers);
      pi.on("before_agent_start", async (event) => {
        const now = read() ?? first;
        register(now.servers);
        return { systemPrompt: botkinsPrompt(event.systemPrompt, String(now.prompt ?? "")) };
      });
    } else {
      pi.on("before_agent_start", async (event) => {
        const now = read() ?? first;
        return { systemPrompt: botkinsPrompt(event.systemPrompt, String(now.prompt ?? "")) };
      });
    }
    pi.on("tool_call", async (event, ctx) => {
      const name = String(event.toolName);
      const info = typeof pi.getAllTools === "function" ? pi.getAllTools().find((tool) => tool.name === name) : undefined;
      const mcpServerName = info?.mcpServerName ?? event.mcpServerName;
      const mcpToolName = info?.mcpToolName ?? event.mcpToolName;
      if (mcpServerName === "botkins" || name.startsWith(OWN) || name.startsWith(OMP_OWN)) return undefined;
      const call = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(mcpServerName && { mcpServerName }),
        ...(mcpToolName && { mcpToolName }),
      };
      const answer = await ctx.ui.select(ASK + " " + JSON.stringify(call), ["allow", "deny"]);
      return answer === "allow" ? undefined : { block: true, reason: "The person didn't allow this." };
    });
  };
}
