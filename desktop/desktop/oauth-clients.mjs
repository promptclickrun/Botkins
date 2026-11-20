// Public native-client registrations installed by the administrator of this computer.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

function defaultFile() {
  if (process.platform === "darwin") return "/Library/Application Support/Botkins/mcp-oauth-clients.json";
  if (process.platform === "win32") return join(process.env.ProgramData || "C:\\ProgramData", "Botkins", "mcp-oauth-clients.json");
  return "/etc/botkins/mcp-oauth-clients.json";
}

const invalid = () => new Error("Ask your administrator to check the MCP OAuth client configuration.");
const address = (value) => {
  try { return new URL(value).href; } catch { return null; }
};

export async function approvedClient(serverUrl, issuer) {
  const override = process.env.BOTKINS_MCP_OAUTH_CLIENTS_FILE;
  const file = override || defaultFile();
  if (!isAbsolute(file)) throw invalid();
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (!override && error.code === "ENOENT") return null;
    throw invalid();
  }
  if (!Array.isArray(config?.clients)) throw invalid();
  const matches = config.clients.filter((item) =>
    address(item?.serverUrl) === address(serverUrl) && address(item?.issuer) === address(issuer));
  if (!matches.length) return null;
  if (matches.length !== 1) throw invalid();
  const { clientId, redirectUri, scopes } = matches[0];
  if (typeof clientId !== "string" || !clientId.trim() || /[\x00-\x1f\x7f]/.test(clientId) ||
      !Array.isArray(scopes) || !scopes.every((s) => typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))) throw invalid();
  // Keep the registered spelling for both legs of the code exchange. Bind only a loopback socket.
  const href = address(redirectUri);
  if (!href || typeof redirectUri !== "string") throw invalid();
  const callback = new URL(href);
  if (callback.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(callback.hostname) ||
      callback.username || callback.password || redirectUri.includes("?") || redirectUri.includes("#") ||
      callback.port === "0") throw invalid();
  return { clientId, redirectUri, callback, scope: [...new Set(scopes)].join(" ") };
}
