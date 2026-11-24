// The direct apps catalog ("mcp-catalog-v1"): tool servers (MCP) a person can add with one tap,
// a sign-in or a key, without typing an address or JSON. It is defined here once, and the window
// and every paired phone read it through `mcpCatalog.list` (desktop/link/CONTRACT.md).
//
// What an entry is, and what a client may see of it:
//   id, name, category    one word, the name shown, and one of CATEGORIES
//   description           one line in Botkins' own words
//   transport             "http" (a web address) or "stdio" (a program this computer starts)
//   url                   http: the server's address
//   package, version      stdio: the npm package and the exact version that runs (`npx -y <package>@<version>`)
//   auth                  "none", "oauth" (the browser sign-in of desktop/oauth.mjs: discovery and
//                         dynamic client registration) or "key" (a key the person types once, kept in the vault)
//   keys                  key and stdio: the fields asked for, by label only. Where each goes (a header or
//                         an environment value) is the computer's own and is shown only as its name.
//   docs                  the vendor's page about the server
//   local                 a server on this computer that another app runs (Figma's desktop app)
//
// Every web address here was checked on 2026-11-24 with requests that carry nothing of a person's
// (`verdict`): an MCP initialize that answers for "none", a 401 with protected-resource metadata
// and a registration endpoint for "oauth", and a 401 without either for "key". Each npm version is
// published, older than two weeks on that day, and its license is recorded. test/mcp-catalog.test.mjs
// checks the shape of the table.
//
// A key is typed once, sent once with `mcpCatalog.add`, sealed into the vault by
// Integrations.saveServer, and never shown, logged or sent back: a client sees only whether it is set.
// A stdio entry starts a program, so it is added only with `confirm` equal to the exact line shown.

import { MCP_CATALOG_METHODS } from "./link/methods.mjs";

export const MCP_CATALOG_CAPABILITY = "mcp-catalog-v1";
export { MCP_CATALOG_METHODS };

/** The categories, in the order a client shows them. */
export const CATEGORIES = Object.freeze({
  research: "Search and research",
  notes: "Notes and docs",
  work: "Plans and tasks",
  mail: "Mail and calendar",
  money: "Money",
  code: "Code and deploys",
  data: "Data and monitoring",
  design: "Design and media",
});

const WHEN = "2026-11-24";
const bearer = { header: "Authorization", prefix: "Bearer " };
const apiKey = (go) => [{ id: "key", label: "API key", ...go }];

/** @type {ReadonlyArray<Record<string, any>>} */
export const CATALOG = Object.freeze(
  [
    // ── No sign-in: one tap ──
    { id: "context7", name: "Context7", category: "code", description: "Current docs and code examples for the libraries you build with.", transport: "http", url: "https://mcp.context7.com/mcp", auth: "none", docs: "https://github.com/upstash/context7", verdict: "initialize answered" },
    { id: "deepwiki", name: "DeepWiki", category: "research", description: "Ask questions about any public GitHub repository and get answers from its code.", transport: "http", url: "https://mcp.deepwiki.com/mcp", auth: "none", docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp", verdict: "initialize answered" },
    { id: "exa", name: "Exa", category: "research", description: "Web search built for bots, with clean page text in the results.", transport: "http", url: "https://mcp.exa.ai/mcp", auth: "none", docs: "https://exa.ai/docs/get-started/exa-mcp", verdict: "initialize answered" },
    { id: "excalidraw", name: "Excalidraw", category: "design", description: "Sketch diagrams and whiteboard drawings from a conversation.", transport: "http", url: "https://mcp.excalidraw.com/mcp", auth: "none", docs: "https://github.com/excalidraw/excalidraw-mcp", verdict: "initialize answered" },
    { id: "huggingface", name: "Hugging Face", category: "research", description: "Find models, datasets, papers and Spaces on the Hugging Face Hub.", transport: "http", url: "https://huggingface.co/mcp", auth: "none", docs: "https://huggingface.co/docs/hub/agents-mcp", verdict: "initialize answered" },
    { id: "aws-knowledge", name: "AWS Knowledge", category: "code", description: "Search AWS documentation, guides and regional availability.", transport: "http", url: "https://knowledge-mcp.global.api.aws", auth: "none", docs: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server", verdict: "initialize answered" },
    { id: "coingecko", name: "CoinGecko", category: "money", description: "Live and historical prices for crypto coins and markets.", transport: "http", url: "https://mcp.api.coingecko.com/mcp", auth: "none", docs: "https://docs.coingecko.com/ai-integration/mcp-server", verdict: "initialize answered" },
    { id: "clerk", name: "Clerk", category: "code", description: "Clerk's docs and SDK snippets for adding sign-in to an app.", transport: "http", url: "https://mcp.clerk.com/mcp", auth: "none", docs: "https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server", verdict: "initialize answered without a sign-in (listed as OAuth)" },

    // ── Sign in with your browser ──
    { id: "notion", name: "Notion", category: "notes", description: "Read, search and update pages and databases in your workspace.", transport: "http", url: "https://mcp.notion.com/mcp", auth: "oauth", docs: "https://developers.notion.com/guides/mcp/overview", verdict: "401, metadata, registration" },
    { id: "linear", name: "Linear", category: "work", description: "Find, file and update issues and projects.", transport: "http", url: "https://mcp.linear.app/mcp", auth: "oauth", docs: "https://linear.app/docs/mcp", verdict: "401, metadata, registration" },
    { id: "atlassian", name: "Atlassian", category: "work", description: "Jira issues and Confluence pages in one place.", transport: "http", url: "https://mcp.atlassian.com/v2/mcp", auth: "oauth", docs: "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/", verdict: "401, metadata, registration" },
    { id: "todoist", name: "Todoist", category: "work", description: "See today's tasks, add new ones and check them off.", transport: "http", url: "https://ai.todoist.net/mcp", auth: "oauth", docs: "https://github.com/todoist/todoist-mcp", verdict: "401, metadata, registration" },
    { id: "clickup", name: "ClickUp", category: "work", description: "Tasks, docs and lists from your ClickUp spaces.", transport: "http", url: "https://mcp.clickup.com/mcp", auth: "oauth", docs: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server", verdict: "401, metadata, registration" },
    { id: "trello", name: "Trello", category: "work", description: "Boards, lists and cards: move work along.", transport: "http", url: "https://mcp.trello.com/v1", auth: "oauth", docs: "https://developer.atlassian.com/cloud/trello/", verdict: "401, metadata, registration" },
    { id: "dropbox", name: "Dropbox", category: "notes", description: "Find and read the files you keep in Dropbox.", transport: "http", url: "https://mcp.dropbox.com/mcp", auth: "oauth", docs: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", verdict: "401, metadata, registration" },
    { id: "coda", name: "Coda", category: "notes", description: "Docs, tables and packs from your Coda workspace.", transport: "http", url: "https://coda.io/apis/mcp", auth: "oauth", docs: "https://coda.io/developers/apis/v1", verdict: "401, metadata, registration" },
    { id: "granola", name: "Granola", category: "notes", description: "Your meeting notes and transcripts, ready to search.", transport: "http", url: "https://mcp.granola.ai/mcp", auth: "oauth", docs: "https://docs.granola.ai/help-center/sharing/integrations/mcp", verdict: "401, metadata, registration" },
    { id: "calendly", name: "Calendly", category: "mail", description: "Upcoming bookings, event types and scheduling links.", transport: "http", url: "https://mcp.calendly.com", auth: "oauth", docs: "https://developer.calendly.com/docs/getting-started/overview", verdict: "401, metadata, registration" },
    { id: "fastmail", name: "Fastmail", category: "mail", description: "Search and read your mail, contacts and calendar.", transport: "http", url: "https://api.fastmail.com/mcp", auth: "oauth", docs: "https://www.fastmail.com/dev/", verdict: "401, metadata, registration" },
    { id: "readwise", name: "Readwise", category: "notes", description: "Highlights and saved articles from Readwise and Reader.", transport: "http", url: "https://mcp2.readwise.io/mcp", auth: "oauth", docs: "https://docs.readwise.io/", verdict: "401, metadata, registration" },
    { id: "ynab", name: "YNAB", category: "money", description: "Budgets, balances and recent spending from You Need A Budget.", transport: "http", url: "https://api.ynab.com/mcp", auth: "oauth", docs: "https://api.ynab.com/", verdict: "401, metadata, registration" },
    { id: "gitlab", name: "GitLab", category: "code", description: "Issues, merge requests and pipelines on GitLab.com.", transport: "http", url: "https://gitlab.com/api/v4/mcp", auth: "oauth", docs: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/", verdict: "401, metadata, registration" },
    { id: "sentry", name: "Sentry", category: "data", description: "Look into errors and issues, with their stack traces.", transport: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth", docs: "https://mcp.sentry.dev/", verdict: "401, metadata, registration" },
    { id: "vercel", name: "Vercel", category: "code", description: "Projects, deployments and build logs.", transport: "http", url: "https://mcp.vercel.com", auth: "oauth", docs: "https://vercel.com/docs/agent-resources/vercel-mcp", verdict: "401, metadata, registration" },
    { id: "cloudflare", name: "Cloudflare", category: "code", description: "Workers, DNS and the rest of your Cloudflare account.", transport: "http", url: "https://mcp.cloudflare.com/mcp", auth: "oauth", docs: "https://developers.cloudflare.com/agents/model-context-protocol/", verdict: "401, metadata, registration" },
    { id: "supabase", name: "Supabase", category: "code", description: "Databases, tables and logs of your Supabase projects.", transport: "http", url: "https://mcp.supabase.com/mcp", auth: "oauth", docs: "https://supabase.com/docs/guides/ai-tools/mcp", verdict: "401, metadata, registration" },
    { id: "neon", name: "Neon", category: "code", description: "Postgres projects, branches and queries on Neon.", transport: "http", url: "https://mcp.neon.tech/mcp", auth: "oauth", docs: "https://neon.com/docs/ai/neon-mcp-server", verdict: "401, metadata, registration" },
    { id: "prisma", name: "Prisma", category: "code", description: "Prisma Postgres databases, schemas and migrations.", transport: "http", url: "https://mcp.prisma.io/mcp", auth: "oauth", docs: "https://www.prisma.io/docs/ai/tools/mcp-server", verdict: "401, metadata, registration" },
    { id: "stripe", name: "Stripe", category: "money", description: "Customers, payments and invoices in your Stripe account.", transport: "http", url: "https://mcp.stripe.com", auth: "oauth", docs: "https://docs.stripe.com/mcp", verdict: "401, metadata, registration" },
    { id: "datadog", name: "Datadog", category: "data", description: "Metrics, logs, monitors and incidents.", transport: "http", url: "https://mcp.datadoghq.com/v1/mcp", auth: "oauth", docs: "https://docs.datadoghq.com/mcp_server/", verdict: "401, metadata, registration" },
    { id: "grafana", name: "Grafana Cloud", category: "data", description: "Dashboards, queries and alerts in Grafana Cloud.", transport: "http", url: "https://mcp.grafana.com/mcp", auth: "oauth", docs: "https://grafana.com/docs/grafana-cloud/", verdict: "401, metadata, registration" },
    { id: "sanity", name: "Sanity", category: "notes", description: "Content and schemas in your Sanity projects.", transport: "http", url: "https://mcp.sanity.io", auth: "oauth", docs: "https://www.sanity.io/docs/ai/mcp-server", verdict: "401, metadata, registration" },
    { id: "postman", name: "Postman", category: "code", description: "Collections, requests and API docs in Postman.", transport: "http", url: "https://mcp.postman.com/mcp", auth: "oauth", docs: "https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/overview", verdict: "401, metadata, registration" },
    { id: "mixpanel", name: "Mixpanel", category: "data", description: "Ask questions of your product analytics.", transport: "http", url: "https://mcp.mixpanel.com/mcp", auth: "oauth", docs: "https://docs.mixpanel.com/docs/mcp", verdict: "401, metadata, registration" },
    { id: "posthog", name: "PostHog", category: "data", description: "Product analytics, feature flags and error tracking.", transport: "http", url: "https://mcp.posthog.com/mcp", auth: "oauth", docs: "https://posthog.com/docs/model-context-protocol", verdict: "401, metadata, registration (listed as a key)" },
    { id: "revenuecat", name: "RevenueCat", category: "money", description: "Subscriptions, products and offerings of your apps.", transport: "http", url: "https://mcp.revenuecat.ai/mcp", auth: "oauth", docs: "https://www.revenuecat.com/docs/tools/mcp", verdict: "401, metadata, registration (listed as a key)" },
    { id: "tavily", name: "Tavily", category: "research", description: "Search the web and pull clean text from pages.", transport: "http", url: "https://mcp.tavily.com/mcp", auth: "oauth", docs: "https://docs.tavily.com/documentation/mcp", verdict: "401, metadata, registration (listed as a key)" },
    { id: "canva", name: "Canva", category: "design", description: "Find, make and export designs in your Canva account.", transport: "http", url: "https://mcp.canva.com/mcp", auth: "oauth", docs: "https://www.canva.com/help/mcp-agent-setup/", verdict: "401, metadata, registration" },
    { id: "miro", name: "Miro", category: "design", description: "Read and add to your Miro boards.", transport: "http", url: "https://mcp.miro.com/", auth: "oauth", docs: "https://developers.miro.com/docs/miro-mcp", verdict: "401, metadata, registration" },
    { id: "webflow", name: "Webflow", category: "design", description: "Pages, CMS items and site settings in Webflow.", transport: "http", url: "https://mcp.webflow.com/mcp", auth: "oauth", docs: "https://developers.webflow.com/mcp/reference/overview", verdict: "401, metadata, registration" },
    { id: "fal", name: "fal", category: "design", description: "Make images, video and audio with fal's models.", transport: "http", url: "https://mcp.fal.ai/mcp-relay", auth: "oauth", docs: "https://fal.ai/docs/documentation", verdict: "401, metadata, registration" },

    // ── A key, typed once ──
    { id: "render", name: "Render", category: "code", description: "Services, deploys and logs on Render.", transport: "http", url: "https://mcp.render.com/mcp", auth: "key", keys: apiKey(bearer), docs: "https://render.com/docs/mcp-server", verdict: "401; its sign-in has no registration, so it takes an API key" },

    // ── On this computer: another app runs it ──
    { id: "figma", name: "Figma", category: "design", description: "Frames, components and styles from the file open in Figma.", transport: "http", url: "http://127.0.0.1:3845/mcp", auth: "none", local: "Needs Figma's desktop app, with its MCP server turned on.", docs: "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server", verdict: "not checked: it runs inside Figma's desktop app" },

    // ── Programs this computer starts ──
    { id: "obsidian", name: "Obsidian", category: "notes", description: "Search and edit the notes in your Obsidian vault.", transport: "stdio", package: "obsidian-mcp-server", version: "3.7.2", license: "Apache-2.0", auth: "key", keys: apiKey({ env: "OBSIDIAN_API_KEY", hint: "From Obsidian's Local REST API plugin" }), docs: "https://github.com/cyanheads/obsidian-mcp-server", verdict: "published 2026-10-26" },
    { id: "firecrawl", name: "Firecrawl", category: "research", description: "Turn web pages and whole sites into clean text.", transport: "stdio", package: "firecrawl-mcp", version: "3.38.0", license: "MIT", auth: "key", keys: apiKey({ env: "FIRECRAWL_API_KEY" }), docs: "https://docs.firecrawl.dev/mcp-server", verdict: "published 2026-11-06" },
    { id: "brave-search", name: "Brave Search", category: "research", description: "Private web, news and image search from Brave.", transport: "stdio", package: "@brave/brave-search-mcp-server", version: "2.1.4", license: "MIT", auth: "key", keys: apiKey({ env: "BRAVE_API_KEY" }), docs: "https://github.com/brave/brave-search-mcp-server", verdict: "published 2026-09-17" },
    { id: "airtable", name: "Airtable", category: "data", description: "Read and update the bases and tables you keep in Airtable.", transport: "stdio", package: "airtable-mcp-server", version: "1.14.0", license: "MIT", auth: "key", keys: [{ id: "key", label: "Personal access token", env: "AIRTABLE_API_KEY" }], docs: "https://github.com/domdomegg/airtable-mcp-server", verdict: "published 2026-07-27" },
    { id: "resend", name: "Resend", category: "mail", description: "Send email from your own domain, after you approve each one.", transport: "stdio", package: "resend-mcp", version: "2.28.0", license: "MIT", auth: "key", keys: apiKey({ env: "RESEND_API_KEY" }), docs: "https://github.com/resend/resend-mcp", verdict: "published 2026-11-03" },
    { id: "hubspot", name: "HubSpot", category: "work", description: "Contacts, companies and deals in your HubSpot CRM.", transport: "stdio", package: "@hubspot/mcp-server", version: "0.4.0", license: "MIT", auth: "key", keys: [{ id: "key", label: "Private app access token", env: "PRIVATE_APP_ACCESS_TOKEN" }], docs: "https://developers.hubspot.com/ai-tools/mcp", verdict: "published 2025-06-18" },
  ].map((entry) => Object.freeze({ ...entry, checked: WHEN })),
);

const byId = new Map(CATALOG.map((entry) => [entry.id, entry]));
const MAX_KEY = 8000;

/** What a stdio entry runs, word by word: `npx -y <package>@<version>`. */
export const programOf = (entry) => ({ command: "npx", args: ["-y", entry.package + "@" + entry.version] });
/** The line shown before a stdio entry is added, and the line `confirm` must repeat. */
export const commandLine = (entry) => {
  const { command, args } = programOf(entry);
  return [command, ...args].join(" ");
};

const sameUrl = (a, b) => {
  try {
    return new URL(a).href.replace(/\/+$/, "").toLowerCase() === new URL(b).href.replace(/\/+$/, "").toLowerCase();
  } catch {
    return false;
  }
};
/** The package an `npx` server runs, without its version ("@brave/brave-search-mcp-server"). */
const packageOf = (server) => {
  if (server.type !== "stdio" || server.command !== "npx") return null;
  const spec = (server.args ?? []).find((arg) => !arg.startsWith("-"));
  if (!spec) return null;
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
};

/** The server a person already has for this entry, added here or by hand: the same address, or the same package. */
export function serverFor(entry, servers) {
  return servers.find((server) => (entry.transport === "stdio" ? packageOf(server) === entry.package : server.type !== "stdio" && sameUrl(server.url, entry.url)));
}

/** An entry as a client sees it: no header or environment mapping, no value, ever. */
export function publicEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    categoryName: CATEGORIES[entry.category],
    description: entry.description,
    transport: entry.transport,
    auth: entry.auth,
    ...(entry.transport === "http" ? { url: entry.url } : { package: entry.package, version: entry.version, license: entry.license, command: commandLine(entry), env: entry.keys.map((key) => key.env) }),
    keys: (entry.keys ?? []).map((key) => ({ id: key.id, label: key.label, ...(key.hint && { hint: key.hint }) })),
    docs: entry.docs,
    icon: { letter: entry.name.charAt(0).toUpperCase() },
    ...(entry.local && { local: entry.local }),
  };
}

/** A stdio server that holds this entry's keys but runs another command than the catalog's: the vault will not carry a key to a changed command. */
const moves = (entry, server) => {
  if (entry.transport !== "stdio" || !entry.keys?.length || !server) return false;
  const { command, args } = programOf(entry);
  return server.command !== command || JSON.stringify(server.args ?? []) !== JSON.stringify(args);
};

/** Where a server added from an entry stands: added, on, signed in, and which keys are set. */
function stateOf(entry, server) {
  if (!server) return { added: false };
  const auth = server.auth;
  const needs = new Set(server.needs ?? []);
  const named = new Set([...(server.headers ?? []), ...(server.env ?? [])]);
  const keysSet = (entry.keys ?? []).every((key) => named.has(key.env ?? key.header) && !needs.has(key.env ?? key.header));
  return {
    added: true,
    serverId: server.id,
    serverName: server.name,
    enabled: server.enabled,
    ...(entry.auth === "oauth" && { signedIn: auth?.type === "oauth" ? auth.signedIn && !auth.needsSignIn : false, signingIn: auth?.type === "oauth" && auth.signingIn }),
    ...(entry.keys && { keysSet }),
    ...(moves(entry, server) && { commandChanged: true }),
  };
}

/** The keys a person typed, checked: each a non-empty line no longer than MAX_KEY. Errors never repeat a value. */
function keyValues(entry, given, { required }) {
  if (given != null && (typeof given !== "object" || Array.isArray(given))) throw new Error("Invalid keys.");
  for (const name of Object.keys(given ?? {})) if (!(entry.keys ?? []).some((key) => key.id === name)) throw new Error(entry.name + " doesn't take that field.");
  const out = {};
  for (const key of entry.keys ?? []) {
    const value = given?.[key.id];
    if (value == null || value === "") {
      if (required) throw new Error("Enter the " + key.label + " for " + entry.name + ".");
      continue;
    }
    if (typeof value !== "string" || value.length > MAX_KEY || /[\0\r\n]/.test(value) || !value.trim()) throw new Error("That " + key.label + " can't be used. Paste it again.");
    out[key.id] = value.trim();
  }
  return out;
}

/** A server name for a new entry that no other server has. */
function freeName(entry, servers) {
  const taken = new Set(servers.map((server) => server.name.toLowerCase()));
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? entry.id : entry.id + "-" + n;
    if (!taken.has(name)) return name;
  }
  throw new Error("Rename one of your tools named " + entry.id + " first.");
}

/**
 * The calls. `getIntegrations()` is the workspace's Integrations (desktop/integrations.mjs): its
 * `saveServer` seals every header and environment value into the vault, and `publicServers` shows
 * names only.
 */
export function mcpCatalog(getIntegrations) {
  return {
    /** Every entry with its state on this computer, and the categories in order. */
    list() {
      const servers = getIntegrations().publicServers();
      return {
        entries: CATALOG.map((entry) => ({ ...publicEntry(entry), ...stateOf(entry, serverFor(entry, servers)) })),
        categories: Object.entries(CATEGORIES).map(([id, name]) => ({ id, name, count: CATALOG.filter((entry) => entry.category === id).length })),
      };
    },
    /**
     * Adds an entry as a tool server, or sets its keys again ("Configure"). `keys` maps each key's id
     * to the value typed; on an entry already added, a key left out keeps the stored one. A stdio
     * entry needs `confirm` to be its exact command line, the one shown to the person.
     * Answers { serverId, next }: "sign-in" when the server still needs the browser sign-in
     * (`signInMcpServer`), else "done".
     */
    add(id, options = {}) {
      if (typeof id !== "string") throw new Error("Choose an app from the catalog.");
      const entry = byId.get(id);
      if (!entry) throw new Error("That app isn't in the catalog.");
      if (options == null || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid options.");
      const integrations = getIntegrations();
      const servers = integrations.publicServers();
      const existing = serverFor(entry, servers);
      if (entry.transport === "stdio" && options.confirm !== commandLine(entry)) throw new Error("Botkins starts " + commandLine(entry) + " on this computer. Confirm it to add " + entry.name + ".");
      // An older version that holds a key is moved to the catalog's command; the vault refuses to carry the key there, so it is asked for again before anything changes.
      const moved = moves(entry, existing);
      if (moved) {
        try {
          keyValues(entry, options.keys, { required: true });
        } catch (error) {
          if (/^Enter the /.test(error.message)) throw new Error(error.message.replace(/\.$/, "") + " again. Botkins is moving it to a newer version, and a saved key only goes to the command it was saved for.");
          throw error;
        }
      }
      const keys = keyValues(entry, options.keys, { required: !existing });
      const where = (key) => key.env ?? key.header;
      const valueOf = (key) => (Object.hasOwn(keys, key.id) ? (key.prefix ?? "") + keys[key.id] : null);
      const pairsFor = (kind, kept = []) => {
        const out = Object.fromEntries(kept.map((name) => [name, null]));
        for (const key of entry.keys ?? []) if (key[kind]) out[where(key)] = valueOf(key);
        return out;
      };
      let data;
      if (entry.transport === "stdio") {
        // A server added by hand with another version is moved to the catalog's version, which the person just confirmed.
        data = { ...(existing && { id: existing.id }), name: existing?.name ?? freeName(entry, servers), type: "stdio", enabled: true, ...programOf(entry), env: pairsFor("env", moved ? [] : existing?.env), ...(existing?.cwd && { cwd: existing.cwd }) };
      } else {
        data = {
          ...(existing && { id: existing.id }),
          name: existing?.name ?? freeName(entry, servers),
          type: existing?.type ?? "http",
          enabled: true,
          url: existing?.url ?? entry.url,
          headers: pairsFor("header", existing?.headers),
          // Sign-in is turned on for an OAuth entry; a server that already has it keeps its own settings.
          ...(entry.auth === "oauth" && !(existing?.auth?.type === "oauth") && { oauth: {} }),
        };
      }
      const serverId = integrations.saveServer(data);
      const after = integrations.publicServers().find((server) => server.id === serverId);
      const signedIn = after?.auth?.type === "oauth" && after.auth.signedIn && !after.auth.needsSignIn;
      return { serverId, next: entry.auth === "oauth" && !signedIn ? "sign-in" : "done" };
    },
  };
}
