// The ACP agents Botkins offers under Settings › Model providers › Add a provider.
//
// Each is an entry for AcpProvider (desktop/providers/acp/index.mjs): the command that starts the
// agent in ACP mode, and the command the person runs in a terminal to sign in. The commands are
// the ones T3 Code uses for the same agents. To offer another ACP agent, add it here.
export const ACP_AGENTS = [
  {
    id: "grok",
    name: "Grok",
    description: "Your xAI plan, through the Grok CLI.",
    command: "grok",
    args: ["agent", "stdio"],
    signIn: "grok login",
  },
  {
    id: "kiro",
    name: "Kiro",
    description: "Your Kiro plan, through the Kiro CLI.",
    command: "kiro-cli",
    // The CLI keeps the access tokens itself.
    args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
    signIn: "kiro-cli login",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    description: "Your Google account, through the Antigravity CLI.",
    command: "agy",
    args: ["acp"],
  },
  {
    id: "fx",
    name: "fx",
    description: "Your fx plan, through the fx CLI.",
    command: "fx",
    args: ["acp"],
    signIn: "fx login",
  },
];
