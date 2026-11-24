// The account service handles device enrollment and a directory of public host addresses.
// Pairing secrets live on the installation and never go through this client.
import { sha256 } from "@noble/hashes/sha2.js";
import { b64u, randomBytes, utf8 } from "./crypto";

export const PROFILE_ORIGIN = "https://profile.botkins.app";
export type ProfileAttempt = { id: string; verifier: string; url: string; code: string };
export type ProfileSession = { token: string; profileId: string; deviceId: string; name: string; email: string };
export type ProfileHost = { serverId: string; serverKey: string; name: string; hosts: string[]; member?: boolean };
export type ProfileHome = {
  profile: { id: string; name: string; email: string; avatar?: string };
  hosts: ProfileHost[];
  devices: { id: string; label: string; current: boolean }[];
  pending: { id: string; label: string; code: string }[];
};

export class ProfileError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, body: object, token?: string): Promise<T> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(PROFILE_ORIGIN + "/v1/" + path, {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: "Bearer " + token }) },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProfileError(response.status, typeof data?.error === "string" ? data.error : "The profile service is unavailable.");
    return data as T;
  } finally { clearTimeout(timeout); }
}

export const profileApi = {
  async start(label: string): Promise<ProfileAttempt> {
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(sha256(utf8(verifier)));
    const { id, code } = await request<{ id: string; code: string }>("enroll/start", { label, challenge });
    if (!/^[a-zA-Z0-9_-]{32}$/.test(id) || !/^\d{6}$/.test(code)) throw new Error("Botkins received an invalid sign-in request.");
    return { id, code, verifier, url: PROFILE_ORIGIN + "/#" + id };
  },
  async finish(attempt: ProfileAttempt): Promise<ProfileSession | null> {
    const { session } = await request<{session: ProfileSession | null}>("enroll/finish", { id: attempt.id, verifier: attempt.verifier });
    return session;
  },
  home: (token: string) => request<ProfileHome>("home", {}, token),
  update: (token: string, name: string, avatar?: string) => request("profile/update", { name, avatar }, token),
  deleteAccount: (token: string, confirmationEmail: string) => request("profile/delete", { confirmationEmail }, token),
  approve: (token: string, id: string, code: string) => request("devices/approve", { id, code }, token),
  revoke: (token: string, deviceId: string) => request("devices/revoke", { deviceId }, token),
  putHost: (token: string, host: ProfileHost) => request("hosts/put", { serverId: host.serverId, serverKey: host.serverKey, name: host.name, hosts: host.hosts, member: host.member === true }, token),
  removeHost: (token: string, serverId: string) => request("hosts/remove", { serverId }, token),
  async proof(token: string, purpose: "bind" | "connect", serverId: string, serverKey: string, publicKey?: string): Promise<string> {
    const { ticket } = await request<{ticket: string}>("proofs/issue", {purpose, serverId, serverKey, publicKey}, token);
    return ticket;
  },
};
