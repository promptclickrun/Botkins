// The demo computer's direct apps catalog ("mcp-catalog-v1") and featured skills ("skills-featured-v1"):
// a few entries in the shape the desktop app sends (its desktop/mcp-catalog.mjs and
// desktop/skills-featured.mjs), so each kind of entry can be tried: one tap, a browser sign-in,
// a key, a program that needs a yes, and an app on the computer.

const KEY = [{ id: "key", label: "API key" }];
export const DEMO_CATALOG = [
  { id: "context7", name: "Context7", category: "code", description: "Current docs and code examples for the libraries you build with.", transport: "http", url: "https://mcp.context7.com/mcp", auth: "none", keys: [], docs: "https://github.com/upstash/context7" },
  { id: "deepwiki", name: "DeepWiki", category: "research", description: "Ask questions about any public GitHub repository and get answers from its code.", transport: "http", url: "https://mcp.deepwiki.com/mcp", auth: "none", keys: [], docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp" },
  { id: "notion", name: "Notion", category: "notes", description: "Read, search and update pages and databases in your workspace.", transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth", keys: [], docs: "https://developers.notion.com/guides/mcp/overview" },
  { id: "linear", name: "Linear", category: "work", description: "Find, file and update issues and projects.", transport: "http", url: "https://mcp.linear.app/mcp", auth: "oauth", keys: [], docs: "https://linear.app/docs/mcp" },
  { id: "todoist", name: "Todoist", category: "work", description: "See today's tasks, add new ones and check them off.", transport: "http", url: "https://ai.todoist.net/mcp", auth: "oauth", keys: [], docs: "https://github.com/todoist/todoist-mcp" },
  { id: "render", name: "Render", category: "code", description: "Services, deploys and logs on Render.", transport: "http", url: "https://mcp.render.com/mcp", auth: "key", keys: KEY, docs: "https://render.com/docs/mcp-server" },
  { id: "brave-search", name: "Brave Search", category: "research", description: "Private web, news and image search from Brave.", transport: "stdio", package: "@brave/brave-search-mcp-server", version: "2.1.4", license: "MIT", command: "npx -y @brave/brave-search-mcp-server@2.1.4", env: ["BRAVE_API_KEY"], auth: "key", keys: KEY, docs: "https://github.com/brave/brave-search-mcp-server" },
  { id: "figma", name: "Figma", category: "design", description: "Frames, components and styles from the file open in Figma.", transport: "http", url: "http://127.0.0.1:3845/mcp", auth: "none", keys: [], local: "Needs Figma's desktop app, with its MCP server turned on.", docs: "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server" },
  { id: "stripe", name: "Stripe", category: "money", description: "Customers, payments and invoices in your Stripe account.", transport: "http", url: "https://mcp.stripe.com", auth: "oauth", keys: [], docs: "https://docs.stripe.com/mcp" },
  { id: "sentry", name: "Sentry", category: "data", description: "Look into errors and issues, with their stack traces.", transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth", keys: [], docs: "https://mcp.sentry.dev/" },
  { id: "vercel", name: "Vercel", category: "code", description: "Projects, deployments and build logs.", transport: "http", url: "https://mcp.vercel.com", auth: "oauth", keys: [], docs: "https://vercel.com/docs/agent-resources/vercel-mcp" },
  { id: "supabase", name: "Supabase", category: "code", description: "Databases, tables and logs of your Supabase projects.", transport: "http", url: "https://mcp.supabase.com/mcp", auth: "oauth", keys: [], docs: "https://supabase.com/docs/guides/ai-tools/mcp" },
  { id: "calendly", name: "Calendly", category: "mail", description: "Upcoming bookings, event types and scheduling links.", transport: "http", url: "https://mcp.calendly.com", auth: "oauth", keys: [], docs: "https://developer.calendly.com/docs/getting-started/overview" },
  { id: "atlassian", name: "Atlassian", category: "work", description: "Jira issues and Confluence pages in one place.", transport: "http", url: "https://mcp.atlassian.com/v2/mcp", auth: "oauth", keys: [], docs: "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/" },
  { id: "posthog", name: "PostHog", category: "data", description: "Product analytics, feature flags and error tracking.", transport: "http", url: "https://mcp.posthog.com/mcp", auth: "oauth", keys: [], docs: "https://posthog.com/docs/model-context-protocol" },
  { id: "canva", name: "Canva", category: "design", description: "Find, make and export designs in your Canva account.", transport: "http", url: "https://mcp.canva.com/mcp", auth: "oauth", keys: [], docs: "https://www.canva.com/help/mcp-agent-setup/" },
  { id: "excalidraw", name: "Excalidraw", category: "design", description: "Sketch diagrams and whiteboard drawings from a conversation.", transport: "http", url: "https://mcp.excalidraw.com/mcp", auth: "none", keys: [], docs: "https://github.com/excalidraw/excalidraw-mcp" },
  { id: "huggingface", name: "Hugging Face", category: "research", description: "Find models, datasets, papers and Spaces on the Hugging Face Hub.", transport: "http", url: "https://huggingface.co/mcp", auth: "none", keys: [], docs: "https://huggingface.co/docs/hub/agents-mcp" },
  { id: "cloudflare", name: "Cloudflare", category: "code", description: "Workers, DNS and the rest of your Cloudflare account.", transport: "http", url: "https://mcp.cloudflare.com/mcp", auth: "oauth", keys: [], docs: "https://developers.cloudflare.com/agents/model-context-protocol/" },
  { id: "datadog", name: "Datadog", category: "data", description: "Metrics, logs, monitors and incidents.", transport: "http", url: "https://mcp.datadoghq.com/v1/mcp", auth: "oauth", keys: [], docs: "https://docs.datadoghq.com/mcp_server/" },
];
const NAMES = { research: "Search and research", notes: "Notes and docs", work: "Plans and tasks", mail: "Mail and calendar", money: "Money", code: "Code and deploys", data: "Data and monitoring", design: "Design and media" };

const sameUrl = (a, b) => !!a && !!b && a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
const serverFor = (entry, servers) => servers.find((s) => (entry.transport === "stdio" ? (s.args ?? []).some((arg) => arg.startsWith(entry.package + "@")) : sameUrl(s.url, entry.url)));

/** The list as the computer answers it, with each entry's state from the demo's tool servers. */
export function demoCatalogList(servers) {
  return {
    entries: DEMO_CATALOG.map((entry) => {
      const server = serverFor(entry, servers);
      const base = { ...entry, categoryName: NAMES[entry.category], icon: { letter: entry.name.charAt(0) } };
      if (!server) return { ...base, added: false };
      const named = new Set([...(server.env ?? []), ...(server.headers ?? [])]);
      return {
        ...base,
        added: true,
        serverId: server.id,
        serverName: server.name,
        enabled: server.enabled,
        ...(entry.auth === "oauth" && { signedIn: server.auth?.type === "oauth" && server.auth.signedIn, signingIn: server.auth?.type === "oauth" && server.auth.signingIn }),
        ...(entry.keys.length && { keysSet: named.size > 0 }),
      };
    }),
    categories: Object.entries(NAMES).map(([id, name]) => ({ id, name, count: DEMO_CATALOG.filter((e) => e.category === id).length })),
  };
}

/** Adds an entry through the demo's own saveMcpServer. A key is only ever "set"; a program needs its exact line. */
export function demoCatalogAdd(backend, id, options = {}) {
  const entry = DEMO_CATALOG.find((e) => e.id === id);
  if (!entry) throw new Error("That app isn't in the catalog.");
  const existing = serverFor(entry, backend.state.mcpServers);
  if (entry.transport === "stdio" && options.confirm !== entry.command) throw new Error("Botkins starts " + entry.command + " on this computer. Confirm it to add " + entry.name + ".");
  const key = options.keys?.key;
  if (entry.keys.length && !existing && !key) throw new Error("Enter the API key for " + entry.name + ".");
  const name = existing?.name ?? entry.id;
  const serverId =
    entry.transport === "stdio"
      ? backend.handlers.saveMcpServer.call(backend, { ...(existing && { id: existing.id }), name, type: "stdio", command: "npx", args: ["-y", entry.package + "@" + entry.version], env: { BRAVE_API_KEY: key ?? null } })
      : backend.handlers.saveMcpServer.call(backend, { ...(existing && { id: existing.id }), name, type: "http", url: entry.url, ...(entry.auth === "key" && { headers: { Authorization: key ? "Bearer " + key : null } }), ...(entry.auth === "oauth" && !existing && { oauth: {} }) });
  const server = backend.server(serverId);
  server.enabled = true;
  const signedIn = server.auth?.type === "oauth" && server.auth.signedIn;
  return { serverId, next: entry.auth === "oauth" && !signedIn ? "sign-in" : "done" };
}

const pin = { openai: ["openai/skills", "49f948faa9258a0c61caceaf225e179651397431", "Apache-2.0", "OpenAI"], anthropic: ["anthropics/skills", "3b3fad96af16a10759d930941b4520ba0c40edae", "Apache-2.0", "Anthropic"], pstack: ["cursor/plugins", "792440e8a560a4a3f63748cdee70491ecd412982", "MIT", "Lauren Tan"] };
const featured = (from, name, path, summary, group) => {
  const [repo, commit, license, author] = pin[from];
  return { id: repo + "/" + name + "@" + commit.slice(0, 7), name, summary, group, author, license, repo, commit, path, url: "https://github.com/" + repo + "/tree/" + commit + "/" + path, ...(from === "pstack" && { pack: "pstack" }) };
};
/** A few featured skills, as the desktop app lists them. */
export const DEMO_FEATURED = [
  featured("openai", "security-threat-model", "skills/.curated/security-threat-model", "Maps a repository's trust boundaries and abuse paths, and writes a short threat model.", "Security"),
  featured("anthropic", "frontend-design", "skills/frontend-design", "Helps a bot pick a clear visual direction for a new screen instead of a template look.", "Writing and design"),
  featured("pstack", "tdd", "pstack/skills/tdd", "Writes the failing test first when the test target is cheap and clear.", "Engineering habits"),
  featured("pstack", "unslop", "pstack/skills/unslop", "Cuts filler and stock phrasing from writing.", "Engineering habits"),
];
