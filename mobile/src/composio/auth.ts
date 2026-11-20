// Signing in to the person's own Composio account: OAuth 2.1 with PKCE and a public client that is
// registered for each sign-in. The tokens stay in the phone's secure store and are never logged.
import * as Crypto from "expo-crypto";
import { fetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

export const MCP_URL = "https://connect.composio.dev/mcp";
const AUTHORIZE_URL = "https://connect.composio.dev/oauth/authorize";
const TOKEN_URL = "https://login.composio.dev/oauth2/token";
const REGISTER_URL = "https://login.composio.dev/oauth2/register";
const SCOPE = "openid profile email offline_access";
export const REDIRECT_URI = "botkins://composio-auth";
const KEY = "botkins.composio.v1";
/** Hosts the credentials may be sent to. */
const HOSTS = new Set(["connect.composio.dev", "login.composio.dev"]);
const EARLY = 60_000;

export type Session = { clientId: string; accessToken: string; refreshToken?: string; expiresAt: number; email?: string };
/** A sign-in handed to the computer. It is never stored on the phone. */
export type Grant = { clientId: string; accessToken: string; refreshToken?: string; expiresIn: number; scope: string; redirectUri: string };

/** The sign-in is over (revoked, expired, or signed out): the person signs in again. */
export class SignInEnded extends Error {
  constructor() {
    super("Your Composio sign-in ended.");
    this.name = "SignInEnded";
  }
}

// ---- Encoding -------------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}
function fromBase64url(text: string): Uint8Array {
  const clean = text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64.indexOf(char);
    if (value < 0) throw new Error("bad base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}
/** encodeURIComponent, with !'()* escaped as well (RFC 3986). */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
const form = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([key, value]) => encode(key) + "=" + encode(value))
    .join("&");

/** Reads the query (and fragment) of a URL without relying on the URL polyfill. */
function queryOf(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const start = url.search(/[?#]/);
  if (start < 0) return out;
  for (const part of url.slice(start + 1).split(/[&#?]/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : part.slice(eq + 1);
    try {
      const name = decodeURIComponent(key.replace(/\+/g, " "));
      if (!(name in out)) out[name] = decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      // A malformed pair is skipped.
    }
  }
  return out;
}

/** The `email` claim of an ID token. The token's signature isn't checked: it only labels the account. */
function emailOf(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split(".")[1] ?? ""))) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.length <= 254 ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

// ---- Requests -------------------------------------------------------------------------------

/** fetch, only to Composio's own https hosts. Everything that carries a credential goes through it. */
export function composioFetch(url: string, init: Parameters<typeof fetch>[1]) {
  const match = /^https:\/\/([^/?#:]+)(?:[/?#]|$)/i.exec(url);
  if (!match || !HOSTS.has(match[1].toLowerCase())) return Promise.reject(new Error("Blocked a request to an unknown host."));
  return fetch(url, init);
}

async function readJson(response: Awaited<ReturnType<typeof fetch>>): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function register(): Promise<string> {
  const response = await composioFetch(REGISTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Botkins",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  const body = await readJson(response);
  if ((response.status !== 200 && response.status !== 201) || typeof body.client_id !== "string" || !body.client_id) throw new Error("Composio didn't accept the sign-in. Try again.");
  return body.client_id;
}

type Tokens = { accessToken: string; refreshToken?: string; expiresIn: number; scope: string; email?: string };

async function tokenRequest(fields: Record<string, string>): Promise<{ status: number; tokens?: Tokens }> {
  const response = await composioFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form(fields),
  });
  const body = await readJson(response);
  if (!response.ok) return { status: response.status };
  const type = typeof body.token_type === "string" ? body.token_type.toLowerCase() : "bearer";
  if (typeof body.access_token !== "string" || !body.access_token || type !== "bearer") return { status: 502 };
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
  return {
    status: response.status,
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined,
      expiresIn,
      scope: typeof body.scope === "string" ? body.scope : SCOPE,
      email: emailOf(body.id_token),
    },
  };
}

/** Registers a client, shows Composio's sign-in page and trades the code for tokens. null when the person cancelled. */
async function authorize(): Promise<(Tokens & { clientId: string }) | null> {
  const clientId = await register();
  const verifier = base64url(Crypto.getRandomBytes(48));
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
  const challenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const state = base64url(Crypto.getRandomBytes(24));
  const url =
    AUTHORIZE_URL +
    "?" +
    form({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", resource: MCP_URL });

  // Shares the system browser's cookies, so a person already signed in to Composio taps once.
  const result = await WebBrowser.openAuthSessionAsync(url, REDIRECT_URI);
  if (result.type !== "success") return null;
  if (!/^botkins:\/\/composio-auth\/?(?:[?#]|$)/.test(result.url)) throw new Error("Composio sent back something unexpected. Try again.");
  const query = queryOf(result.url);
  if (query.state !== state) throw new Error("That sign-in didn't match. Try again.");
  if (query.error) return null;
  if (!query.code) throw new Error("Composio didn't finish the sign-in. Try again.");

  const { tokens } = await tokenRequest({ grant_type: "authorization_code", code: query.code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: MCP_URL });
  if (!tokens) throw new Error("Couldn't finish signing in to Composio. Try again.");
  return { ...tokens, clientId };
}

// ---- The phone's session ----------------------------------------------------------------------

let session: Session | null = null;
let loaded: Promise<Session | null> | null = null;
let refreshing: Promise<Session> | null = null;
const endedListeners = new Set<() => void>();

/** Called when the sign-in ends by itself (a refresh was refused). */
export function onSignInEnded(listener: () => void) {
  endedListeners.add(listener);
  return () => void endedListeners.delete(listener);
}

function isSession(value: unknown): value is Session {
  const v = value as Session | null;
  return !!v && typeof v.clientId === "string" && typeof v.accessToken === "string" && typeof v.expiresAt === "number";
}

/** The saved sign-in, read once. */
export function loadSession(): Promise<Session | null> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((saved) => {
      const value = saved ? (JSON.parse(saved) as unknown) : null;
      session = isSession(value) ? value : null;
      return session;
    })
    .catch(() => null);
  return loaded;
}

async function save(next: Session | null) {
  session = next;
  loaded = Promise.resolve(next);
  if (next) await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  else await SecureStore.deleteItemAsync(KEY).catch(() => {});
}

/** Signs in on Composio's page and keeps the sign-in. null when the person cancelled. */
export async function signIn(): Promise<Session | null> {
  const result = await authorize();
  if (!result) return null;
  const next: Session = { clientId: result.clientId, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: Date.now() + result.expiresIn * 1000, email: result.email };
  refreshing = null;
  await save(next);
  return next;
}

export async function signOut() {
  refreshing = null;
  await save(null);
}

/**
 * Runs the same sign-in again for the computer and returns its tokens without keeping them.
 * Refresh tokens rotate, so the phone and the computer each need their own grant. null when cancelled.
 */
export async function grantForComputer(): Promise<Grant | null> {
  const result = await authorize();
  if (!result) return null;
  return { clientId: result.clientId, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresIn: result.expiresIn, scope: result.scope, redirectUri: REDIRECT_URI };
}

async function ended(): Promise<never> {
  await save(null);
  for (const listener of endedListeners) listener();
  throw new SignInEnded();
}

/** Renews the access token. One renewal at a time; everyone waiting shares it. */
function refresh(from: Session): Promise<Session> {
  refreshing ??= (async () => {
    if (!from.refreshToken) return ended();
    const { status, tokens } = await tokenRequest({ grant_type: "refresh_token", refresh_token: from.refreshToken, client_id: from.clientId, resource: MCP_URL });
    // Signed out (or in again) while this ran: its answer no longer applies.
    if (session?.clientId !== from.clientId) throw new SignInEnded();
    if (status >= 400 && status < 500) return ended();
    if (!tokens) throw new Error("Couldn't reach Composio. Try again.");
    const next: Session = { ...from, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? from.refreshToken, expiresAt: Date.now() + tokens.expiresIn * 1000, email: tokens.email ?? from.email };
    await save(next);
    return next;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** A usable access token, renewed first when less than a minute is left. Throws SignInEnded when signed out. */
export async function accessToken(): Promise<string> {
  const current = session ?? (await loadSession());
  if (!current) throw new SignInEnded();
  if (current.expiresAt - Date.now() > EARLY) return current.accessToken;
  return (await refresh(current)).accessToken;
}

/** Renews the token after the server refused it (a 401), unless another call already did. */
export async function renewAfterRefusal(refused: string): Promise<string> {
  const current = session ?? (await loadSession());
  if (!current) throw new SignInEnded();
  if (current.accessToken !== refused) return current.accessToken;
  return (await refresh(current)).accessToken;
}
