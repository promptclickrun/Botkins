// The relay's pure helpers: no Cloudflare imports, so Node can load them for unit tests.

export const HOST_PROTOCOL = "botkins.host.v2";
export const HOST_PROTOCOL_V3 = "botkins.host.v3";
export const PHONE_PROTOCOL = "botkins.phone.v1";
/** How far a computer's clock may be from ours, in seconds. */
export const MAX_SKEW = 300;
/** A fresh 32-byte identifier shared by the active/standby sockets of one host runtime/config. */
export const HOST_GROUP_LENGTH = 43;

const text = new TextEncoder();

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(input)));
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decodes base64url of exactly `length` characters; null for anything else. */
export function unbase64url(value: string, length: number): Uint8Array | null {
  if (value.length !== length || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function unhex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** The room of a computer's relay key (the raw 32-byte Ed25519 public key, base64url text). */
export async function roomOf(publicKey: string): Promise<string> {
  return base64url(await sha256("botkins-relay-room-v1:" + publicKey));
}

/** What the computer signs to take its seat. */
export const hostChallenge = (room: string, seconds: string) => "botkins-relay-host-v2:" + room + ":" + seconds;

/** What a v3 computer signs to take its room seat, including its runtime/config group. */
export const hostChallengeV3 = (room: string, group: string, seconds: string) =>
  "botkins-relay-host-v3:" + room + ":" + group + ":" + seconds;

/** Whether a computer's offer (its subprotocols) proves it owns `room` at our time `now` (seconds). */
export async function hostProof(offered: string[], room: string, now: number): Promise<boolean> {
  // Exactly one of each, so nothing can be smuggled past the check in a second entry.
  const one = (prefix: string) => {
    const found = offered.filter((entry) => entry.startsWith(prefix));
    return found.length === 1 ? found[0]!.slice(prefix.length) : null;
  };
  const publicKey = one("k.");
  const seconds = one("t.");
  const signature = one("s.");
  if (!offered.includes(HOST_PROTOCOL) || publicKey === null || seconds === null || signature === null) return false;
  if (!/^\d{1,12}$/.test(seconds) || Math.abs(now - Number(seconds)) > MAX_SKEW) return false;
  if ((await roomOf(publicKey)) !== room) return false;
  return verifyEd25519(publicKey, signature, hostChallenge(room, seconds));
}

/** Whether a v3 computer's offer proves both room ownership and its authenticated runtime group. */
export async function hostProofV3(offered: string[], room: string, now: number): Promise<boolean> {
  const one = (prefix: string) => {
    const found = offered.filter((entry) => entry.startsWith(prefix));
    return found.length === 1 ? found[0]!.slice(prefix.length) : null;
  };
  const publicKey = one("k.");
  const group = one("g.");
  const seconds = one("t.");
  const signature = one("s.");
  if (!offered.includes(HOST_PROTOCOL_V3) || publicKey === null || group === null || seconds === null || signature === null) return false;
  if (!new RegExp(`^[A-Za-z0-9_-]{${HOST_GROUP_LENGTH}}$`).test(group)) return false;
  if (!/^\d{1,12}$/.test(seconds) || Math.abs(now - Number(seconds)) > MAX_SKEW) return false;
  if ((await roomOf(publicKey)) !== room) return false;
  return verifyEd25519(publicKey, signature, hostChallengeV3(room, group, seconds));
}

/**
 * Whether `signature` (base64url, 86 characters) is an Ed25519 signature of the UTF-8 bytes of
 * `message` by `publicKey` (the raw 32 bytes, base64url, 43 characters). False for anything malformed.
 * The host seat and the push route both check their signatures with this.
 */
export async function verifyEd25519(publicKey: string, signature: string, message: string): Promise<boolean> {
  const raw = unbase64url(publicKey, 43);
  const sig = unbase64url(signature, 86);
  if (!raw || !sig) return false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sig, text.encode(message));
  } catch {
    return false;
  }
}

/**
 * The network a client address stands for. IPv4 and "local" stay as they are. IPv6 becomes its /64
 * (the first four groups), because one network can hold billions of addresses and must not look like
 * many sources. An IPv4-mapped IPv6 address is the IPv4 address. A zone suffix (`%eth0`) is dropped.
 * Anything that does not parse is returned unchanged.
 */
export function networkOf(address: string): string {
  const bare = address.split("%")[0]!;
  if (!bare.includes(":")) return address;

  // A dotted ending (::ffff:1.2.3.4) is two more groups.
  let body = bare;
  const quad = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (quad) {
    const [a, b, c, d] = quad.slice(2).map(Number) as [number, number, number, number];
    if (a > 255 || b > 255 || c > 255 || d > 255) return address;
    body = quad[1]! + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }

  const halves = body.split("::");
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return address;
  const strings = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!strings.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return address;
  const groups = strings.map((group) => parseInt(group, 16));

  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return groups.slice(0, 4).map((group) => group.toString(16)).join(":") + "::/64";
}
