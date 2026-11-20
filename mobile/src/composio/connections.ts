// Which apps the person connected in Composio, and connecting or removing an app's account.
import { callTool, McpError, rpc, type ToolResult } from "./mcp";

const SLUG = /^[a-z0-9_]{1,64}$/;
const BATCH = 25;

export type AccountStatus = "active" | "pending" | "failed" | "other";
export type Account = { id: string; status: AccountStatus; /** The account's email, or its alias. */ label?: string };

function statusOf(value: unknown): AccountStatus {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (status === "active") return "active";
  if (status === "initiated" || status === "initializing" || status === "pending") return "pending";
  if (status === "failed" || status === "expired") return "failed";
  return "other";
}

function accountsOf(value: unknown): Account[] {
  if (!Array.isArray(value)) return [];
  const out: Account[] = [];
  for (const item of value as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : typeof item.account_id === "string" ? item.account_id : "";
    if (!id) continue;
    const info = item.user_info as { email?: unknown } | undefined;
    const email = typeof info?.email === "string" ? info.email : undefined;
    const alias = typeof item.alias === "string" ? item.alias : undefined;
    const label = (email || alias)?.slice(0, 120) || undefined;
    out.push({ id, status: statusOf(item.status), label });
  }
  return out;
}

/** The JSON the tool answered with: { successful, data, error }. */
function payloadOf(result: ToolResult): Record<string, unknown> {
  const text = result.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;
  let body: Record<string, unknown> | undefined;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : (result.structuredContent as Record<string, unknown> | undefined);
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object") throw new McpError("Composio answered in a way the app doesn't know.");
  if (result.isError || body.successful === false) throw new McpError(typeof body.error === "string" && body.error.length < 160 ? body.error : "Composio couldn't do that.");
  return (body.data as Record<string, unknown>) ?? {};
}

/** One app's entry in data.results (an object by slug; an array is accepted too). */
function resultFor(data: Record<string, unknown>, slug: string): Record<string, unknown> | undefined {
  const results = data.results as unknown;
  if (Array.isArray(results)) return (results as Record<string, unknown>[]).find((entry) => entry && (entry.toolkit === slug || entry.name === slug));
  if (results && typeof results === "object") return (results as Record<string, Record<string, unknown>>)[slug];
  return undefined;
}

const manage = (toolkits: { name: string; action: "list" | "add" | "remove"; account_id?: string }[]) => callTool("COMPOSIO_MANAGE_CONNECTIONS", { toolkits }).then(payloadOf);

/**
 * The apps the person connected, read from the description of Composio's search tool
 * ("User has manually connected the apps: gmail, github."). null when the sentence isn't there.
 */
export async function connectedFromTools(): Promise<string[] | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await rpc<{ tools?: { name?: string; description?: string }[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : undefined);
    const tool = result.tools?.find((t) => t.name === "COMPOSIO_SEARCH_TOOLS");
    if (tool) {
      const found = /connected the apps:\s*([^.]*)\./i.exec(tool.description ?? "");
      if (!found) return null;
      return [
        ...new Set(
          found[1]
            .split(",")
            .map((slug) => slug.trim().toLowerCase())
            .filter((slug) => SLUG.test(slug)),
        ),
      ];
    }
    if (!result.nextCursor) return null;
    cursor = result.nextCursor;
  }
  return null;
}

/** The accounts of each app, by slug. An app with none maps to []. */
export async function listAccounts(slugs: string[]): Promise<Record<string, Account[]>> {
  const out: Record<string, Account[]> = {};
  const valid = slugs.filter((slug) => SLUG.test(slug));
  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const data = await manage(batch.map((name) => ({ name, action: "list" as const })));
    for (const slug of batch) out[slug] = accountsOf(resultFor(data, slug)?.accounts);
  }
  return out;
}

/** Starts connecting an app: the page the person signs in on, and the account it will become. */
export async function addAccount(slug: string): Promise<{ redirectUrl: string | null; pendingId?: string; accounts: Account[] }> {
  const data = await manage([{ name: slug, action: "add" }]);
  const entry = resultFor(data, slug) ?? {};
  const url = typeof entry.redirect_url === "string" ? entry.redirect_url : typeof entry.redirectUrl === "string" ? entry.redirectUrl : null;
  const accounts = accountsOf(entry.accounts);
  const pending = accounts.find((account) => account.status === "pending")?.id ?? (typeof entry.connected_account_id === "string" ? entry.connected_account_id : undefined);
  return { redirectUrl: url && /^https:\/\//i.test(url) ? url : null, pendingId: pending, accounts };
}

export async function removeAccount(slug: string, accountId: string): Promise<void> {
  await manage([{ name: slug, action: "remove", account_id: accountId }]);
}
