// Reading an MCP server for display.
import type { McpServer } from "@/link/types";

/** "https://mcp.linear.app/mcp" → "mcp.linear.app". */
export const hostOf = (url: string | undefined) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url ?? "")?.[1] ?? url ?? "";

/** Where a server runs, in one line: its address on the web, or the command on the computer. */
export const whereOf = (server: McpServer) => (server.type === "stdio" ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") : hostOf(server.url));

/** What a person has to do before the server works, if anything. */
export function attentionOf(server: McpServer): string | undefined {
  if (server.auth?.type === "oauth" && !server.auth.signedIn) return "Sign in";
  if (server.needs?.length) return "Needs a key";
  return undefined;
}

/** Header names that carry an API key on their own (the desktop's KEY_HEADER). */
const KEY_HEADER = /^(authorization|x-api-key|api-key|x-auth-token)$/i;

/**
 * The header a saved server sends its key in, if it signs in with a key: Authorization, or a
 * single header that carries a key by its name (X-API-Key). Other headers stay "other headers".
 */
export function keyHeaderOf(names: string[]): string | undefined {
  return names.find((name) => name.toLowerCase() === "authorization") ?? (names.length === 1 && KEY_HEADER.test(names[0]) ? names[0] : undefined);
}

/** "a", "a and b", "a, b and c". */
export const listText = (items: string[]) => (items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items.at(-1));

/** What an import did, in the desktop's words. */
export function importText(result: { added: string[]; skipped: string[] }) {
  const added = result.added.length ? "Added " + listText(result.added) + "." : "No servers added.";
  const skipped = result.skipped.length ? " Skipped " + listText(result.skipped) + (result.skipped.length === 1 ? " (a server with that name exists)." : " (servers with those names exist).") : "";
  return added + skipped;
}
