// Botkins' extension inside Pi (desktop/providers/pi/index.mjs loads it with `-e`).
//
// Pi reads BOTKINS_PI_SESSION, the path of a file Botkins writes for this session (mode 0600, in
// Botkins' own data folder), and does four things with it:
//   - registers the plan connections the turn's model answers on (the gateway, desktop/harness);
//   - registers the session's MCP servers, Botkins' own tools among them, as direct tools;
//   - writes the system prompt for each run: Pi's own, less its section on Pi's documentation,
//     with the bot's instructions after it, read again each time, so a change of memory or
//     instructions needs no restart (botkinsPrompt);
//   - asks Botkins before a tool runs, through Pi's extension dialog (`select`), so Botkins'
//     approval rules and the person decide. Botkins' own tools never ask.
// The file's path is taken out of the environment once read, so the commands the model runs
// don't inherit it.
import { readFileSync } from "node:fs";

export const ASK = "botkins:permission";
const OWN = "mcp__botkins__";

const file = process.env.BOTKINS_PI_SESSION;
delete process.env.BOTKINS_PI_SESSION;

/**
 * The system prompt a run is sent: Pi's, without the section that points the model at Pi's own
 * documentation (its themes, TUI, extensions and SDK), which a Botkins bot has no use for, and with
 * the bot's instructions after it. It also matters for a Claude plan: Claude bills a request that
 * carries that section as extra usage, never as part of the plan (measured, Pi 1.0.0 and Claude
 * Code 2.1.325), although Anthropic counts a third-party app's requests through Claude Code
 * against the plan. Pi's tool list, rules and working folder are kept.
 */
export function botkinsPrompt(system, extra = "") {
  const own = String(system ?? "")
    .replace(/(?:\n\n)?<docs>\n[\s\S]*?\n<\/docs>/g, "")
    .trim();
  return extra ? own + "\n\n" + extra : own;
}

function read() {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export default function botkins(pi) {
  const first = read();
  if (!first) return;
  for (const provider of first.providers ?? []) pi.registerProvider(provider.name, provider.config);
  let servers = "";
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

  pi.on("tool_call", async (event, ctx) => {
    if (String(event.toolName).startsWith(OWN)) return undefined;
    const answer = await ctx.ui.select(ASK + " " + JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }), ["allow", "deny"]);
    return answer === "allow" ? undefined : { block: true, reason: "The person didn't allow this." };
  });
}
