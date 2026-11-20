// Reading what a person scans or types to pair with a computer.
import { isRelayHost } from "./relay";

export const DEFAULT_PORT = 47610;

/** Where and how to pair: from a QR code (which carries the computer's key) or typed in by hand. */
export type PairTarget = {
  hosts: string[];
  code: string;
  /** The computer's public key, when the QR code gave it. Typed pairing reads it from the computer. */
  serverKey?: string;
  serverId?: string;
  name?: string;
};

/**
 * "192.168.1.20" → "192.168.1.20:47610". Accepts a pasted http:// address too. Null when it isn't a host.
 * A relay entry (`relay!<room>@<authority>`) is kept exactly as it is; a malformed one is null.
 */
export function normalizeHost(input: string, port = DEFAULT_PORT): string | null {
  if (/^relay!/.test(input.trim())) return isRelayHost(input.trim()) ? input.trim() : null;
  const text = input.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  if (!text || /\s/.test(text)) return null;
  const match = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) return null;
  const chosen = match[2] ? Number(match[2]) : port;
  if (chosen < 1 || chosen > 65535) return null;
  return match[1].toLowerCase() + ":" + chosen;
}

function query(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const key = at < 0 ? pair : pair.slice(0, at);
    try {
      out[decodeURIComponent(key)] = at < 0 ? "" : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, " "));
    } catch {
      // A badly escaped part is skipped.
    }
  }
  return out;
}

/** The pairing link a computer shows as a QR code: botkins://pair?v=1&s=…&k=…&c=…&h=…&n=… */
export function parsePairingUrl(text: string): PairTarget | null {
  const match = /^botkins:\/\/pair\/?\?(.+)$/i.exec(text.trim());
  if (!match) return null;
  const q = query(match[1].replace(/#.*$/, ""));
  if (q.v && q.v !== "1") return null;
  const hosts = (q.h ?? "").split(",").map((host) => normalizeHost(host)).filter((host): host is string => !!host);
  const code = (q.c ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!hosts.length || code.length < 8 || !/^[A-Za-z0-9_-]{43}$/.test(q.k ?? "")) return null;
  return { hosts, code, serverKey: q.k, ...(q.s && { serverId: q.s }), ...(q.n && { name: q.n.slice(0, 60) }) };
}

/** An invite as typed: Crockford aliases are accepted, with spaces and dashes ignored. */
export const normalizeCode = (code: string) => String(code ?? "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0").replace(/[\s-]/g, "");

/** A pairing code in groups of four, or a ten-character invite in groups of five. */
export const formatCode = (code: string) => {
  const clean = normalizeCode(code);
  return clean.length === 10 ? clean.slice(0, 5) + "-" + clean.slice(5) : clean.replace(/(.{4})(?=.)/g, "$1-");
};

/** A join link as an app or web URL. It has only the invite code and the host's pinned key. */
export function parseJoinUrl(text: string): { code: string; serverKey: string } | null {
  const input = String(text ?? "").trim();
  let values = "";
  let app = false;
  const own = /^botkins:\/\/join\/?\?(.+)$/i.exec(input);
  if (own) {
    values = own[1].replace(/#.*$/, "");
    app = true;
  } else {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.pathname !== "/join" || !url.hash) return null;
      values = url.hash.slice(1);
    } catch {
      return null;
    }
  }
  const q = query(values);
  const code = normalizeCode(q.c ?? "");
  if ((!app && !code) || code.length !== 10 || !/^[A-Za-z0-9_-]{43}$/.test(q.k ?? "")) return null;
  return { code, serverKey: q.k };
}
