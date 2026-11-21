// Botkins' extension inside Pi (desktop/providers/pi/index.mjs loads it with `-e`).
//
// Pi reads BOTKINS_PI_SESSION, the path of a file Botkins writes for this session (mode 0600, in
// Botkins' own data folder), and does four things with it:
//   - registers the plan connections the turn's model answers on (the gateway, desktop/harness);
//   - registers the session's MCP servers, Botkins' own tools among them, as direct tools;
//   - adds the bot's instructions to Pi's system prompt before each run, read again each time,
//     so a change of memory or instructions needs no restart;
//   - asks Botkins before a tool runs, through Pi's extension dialog (`select`), so Botkins'
//     approval rules and the person decide. Botkins' own tools never ask.
// The file's path is taken out of the environment once read, so the commands the model runs
// don't inherit it.
import { readFileSync } from "node:fs";

export const ASK = "botkins:permission";
const OWN = "mcp__botkins__";

const file = process.env.BOTKINS_PI_SESSION;
delete process.env.BOTKINS_PI_SESSION;

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
    const extra = String(now.prompt ?? "");
    return extra ? { systemPrompt: event.systemPrompt + "\n\n" + extra } : undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (String(event.toolName).startsWith(OWN)) return undefined;
    const answer = await ctx.ui.select(ASK + " " + JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }), ["allow", "deny"]);
    return answer === "allow" ? undefined : { block: true, reason: "The person didn't allow this." };
  });
}
