import { readFileSync } from "node:fs";

export const ASK = "botkins:permission";

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
    if (mcp) {
      // A server is registered again only when its settings changed (a renewed sign-in token), and
      // one a turn doesn't list stays registered: taking its tools away and bringing them back
      // would change the tool list the model is sent, and with it everything a model caches after
      // it. Botkins turns down a call to a server that isn't the turn's (PiSession.permission).
      const registered = new Map();
      const register = (list) => {
        for (const [name, config] of Object.entries(list ?? {})) {
          const next = JSON.stringify(config);
          if (registered.get(name) === next) continue;
          pi.registerMcpServer(name, config);
          registered.set(name, next);
        }
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
      // Pi publishes the original server as the sole namespace alias, but may sanitize the
      // tool name. Do not use a display name in place of the original identity for a grant.
      const source = info?.sourceInfo;
      const namespace = info?.namespace;
      const piMcp = source?.path === "builtin:mcp" && source.source === "builtin";
      const ompMcp = source?.path === `<mcp:${name}>` && source.source === "mcp";
      const piMcpServer = piMcp && Array.isArray(namespace?.aliases) && namespace.aliases.length === 1
        ? namespace.aliases[0] : undefined;
      const registryServer = ((piMcp || ompMcp) ? info.mcpServerName : undefined) ?? piMcpServer;
      const mcpServerName = registryServer ?? info?.mcpServerName ?? event.mcpServerName;
      const mcpToolName = info?.mcpToolName ?? event.mcpToolName;
      const managed = !!(info?.managedApprovalRequired || event.managedApprovalRequired || event.managedSettingsEnabled);
      const sandboxEscape = !!(event.requestSandboxBypass || event.requestSandboxPermissive || event.sandboxPathGrant);
      const readOnly = registryServer && (info.mcpToolName || piMcpServer) && (ompMcp
        ? info.mcpReadOnlyHint === true
        : info.annotations?.readOnlyHint === true &&
          (info.annotations.destructiveHint === undefined || info.annotations.destructiveHint === false));
      const call = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(source?.source === "builtin" && source.path === (mcp ? `builtin:${name}` : `<builtin:${name}>`) && { native: true }),
        ...(mcpServerName && { mcpServerName }),
        ...(mcpToolName && { mcpToolName }),
        ...(registryServer && { registryServer }),
        ...(registryServer && info.mcpServerName === registryServer && info.mcpToolName && { registryTool: info.mcpToolName }),
        ...(readOnly && { readOnly: true }),
        ...(managed && { managed: true }),
        ...(sandboxEscape && { sandboxEscape: true }),
      };
      const answer = await ctx.ui.select(ASK + " " + JSON.stringify(call), ["allow", "deny"]);
      return answer === "allow" ? undefined : { block: true, reason: "The person didn't allow this." };
    });
  };
}
