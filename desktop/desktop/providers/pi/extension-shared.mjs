import { readFileSync } from "node:fs";

export const ASK = "botkins:permission";
/** Botkins' answer when the call goes on changed or is refused with a reason (a plugin's hook): the extension then asks for the detail. */
export const MORE = "more";
export const DETAIL = "botkins:detail";
/** The extension's question after a tool ran, when a plugin has a postToolUse or postToolUseFailure hook. Botkins answers the result to use, or cancels. */
export const RESULT = "botkins:result";
const MAX_RESULT = 200_000;
export const INVENTORY = "botkins:inventory";
const OWN = "mcp__botkins__";
const OMP_OWN = "mcp__botkins_";
const INVENTORY_POLL_MS = 150;
const INVENTORY_WATCH_MS = 10000;

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
    let lastInventory = "";
    let watch = null;
    const publishInventory = (ctx) => {
      if (typeof ctx?.ui?.setStatus !== "function" || typeof pi.getAllTools !== "function") return;
      try {
        const all = pi.getAllTools() ?? [];
        const active = typeof pi.getActiveTools === "function" ? new Set(pi.getActiveTools() ?? []) : null;
        const servers = typeof pi.getMcpServers === "function"
          ? (pi.getMcpServers() ?? []).map((s) => ({
            name: String(s?.name ?? ""),
            enabled: s?.config?.enabled !== false,
            ...(s?.config?.exposure && { exposure: s.config.exposure }),
          })).filter((s) => s.name)
          : undefined;
        const payload = JSON.stringify({
          tools: all.map((t) => ({
            name: String(t?.name ?? ""),
            description: String(t?.description ?? "").split("\n")[0].slice(0, 300),
            active: active ? active.has(t?.name) : true,
            ...(t?.exposure && { exposure: t.exposure }),
            ...(t?.mcpServerName && { mcpServerName: t.mcpServerName }),
            ...(t?.mcpToolName && { mcpToolName: t.mcpToolName }),
            ...(t?.sourceInfo?.path && { source: t.sourceInfo.path }),
          })).filter((t) => t.name),
          ...(servers && { servers }),
        });
        if (payload === lastInventory) return;
        lastInventory = payload;
        ctx.ui.setStatus(INVENTORY, payload);
      } catch {
        // Telemetry never interrupts the harness.
      }
    };
    const startWatch = (ctx) => {
      publishInventory(ctx);
      clearInterval(watch);
      const stopAt = Date.now() + INVENTORY_WATCH_MS;
      watch = setInterval(() => {
        publishInventory(ctx);
        if (Date.now() >= stopAt) {
          clearInterval(watch);
          watch = null;
        }
      }, INVENTORY_POLL_MS);
      watch.unref?.();
    };
    pi.on("session_start", (_event, ctx) => startWatch(ctx));
    pi.on("session_shutdown", () => { clearInterval(watch); watch = null; });
    for (const hook of ["turn_start", "turn_end", "agent_end", "tool_execution_end"])
      pi.on(hook, (_event, ctx) => publishInventory(ctx));
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
      pi.on("before_agent_start", async (event, ctx) => {
        const now = read() ?? first;
        register(now.servers);
        publishInventory(ctx);
        return { systemPrompt: botkinsPrompt(event.systemPrompt, String(now.prompt ?? "")) };
      });
    } else {
      pi.on("before_agent_start", async (event, ctx) => {
        const now = read() ?? first;
        publishInventory(ctx);
        return { systemPrompt: botkinsPrompt(event.systemPrompt, String(now.prompt ?? "")) };
      });
    }
    pi.on("tool_call", async (event, ctx) => {
      const name = String(event.toolName);
      const info = typeof pi.getAllTools === "function" ? pi.getAllTools().find((tool) => tool.name === name) : undefined;
      const mcpServerName = info?.mcpServerName ?? event.mcpServerName;
      const mcpToolName = info?.mcpToolName ?? event.mcpToolName;
      // Botkins' own tools never ask, unless a plugin's hook is to see each tool call first.
      const own = mcp
        ? (mcpServerName ? mcpServerName === "botkins" : name.startsWith(OWN))
        : mcpServerName === "botkins" || name.startsWith(OWN) || name.startsWith(OMP_OWN);
      if (own && !(read() ?? first).preToolUse) return undefined;
      const call = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        ...(mcpServerName && { mcpServerName }),
        ...(mcpToolName && { mcpToolName }),
      };
      const answer = await ctx.ui.select(ASK + " " + JSON.stringify(call), ["allow", "deny", MORE]);
      if (answer === "allow") return undefined;
      if (answer !== MORE) return { block: true, reason: "The person didn't allow this." };
      let detail = null;
      try {
        detail = JSON.parse(String(await ctx.ui.input(DETAIL + " " + JSON.stringify(String(event.toolCallId)))));
      } catch {
        // No detail: the call does not run.
      }
      if (detail?.deny) return { block: true, reason: String(detail.reason || "A plugin's hook didn't allow this.") };
      const next = detail?.input;
      if (!next || typeof next !== "object" || Array.isArray(next)) return { block: true, reason: "Botkins couldn't apply the changed arguments." };
      // Pi runs the input it passed in (changed in place); OMP runs the `input` a handler returns.
      if (event.input && typeof event.input === "object") {
        for (const key of Object.keys(event.input)) delete event.input[key];
        Object.assign(event.input, next);
      }
      return { input: next };
    });
    // A plugin's postToolUse / postToolUseFailure hook sees every tool's result, and may change
    // what the model is told. Botkins runs the hook and answers the text to use (desktop/providers/pi/index.mjs).
    pi.on("tool_result", async (event, ctx) => {
      if (!(read() ?? first).postToolUse) return undefined;
      const text = (Array.isArray(event.content) ? event.content : []).map((part) => (part?.type === "text" ? String(part.text ?? "") : "")).filter(Boolean).join("\n");
      const name = String(event.toolName);
      const info = typeof pi.getAllTools === "function" ? pi.getAllTools().find((tool) => tool.name === name) : undefined;
      const call = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        isError: !!event.isError,
        text: text.slice(0, MAX_RESULT),
        ...((info?.mcpServerName ?? event.mcpServerName) && { mcpServerName: info?.mcpServerName ?? event.mcpServerName }),
        ...((info?.mcpToolName ?? event.mcpToolName) && { mcpToolName: info?.mcpToolName ?? event.mcpToolName }),
      };
      let answer = null;
      try {
        answer = JSON.parse(String(await ctx.ui.input(RESULT + " " + JSON.stringify(call))));
      } catch {
        return undefined;
      }
      if (!answer || typeof answer.text !== "string") return undefined;
      return { content: [{ type: "text", text: answer.text }], ...(typeof answer.isError === "boolean" && { isError: answer.isError }) };
    });
  };
}
