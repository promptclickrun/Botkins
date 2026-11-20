// Which addresses a phone can reach this computer on, and which callers count as nearby.
import { networkInterfaces } from "node:os";

const octets = (address) => {
  const parts = String(address).split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
};

/** "lan" for a private address, "tailnet" for a carrier-grade NAT one (Tailscale), "loopback", "link", or null. */
export function addressKind(address) {
  const o = octets(address);
  if (!o) return null;
  const [a, b] = o;
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "lan";
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  if (a === 169 && b === 254) return "link";
  return null;
}

/** True for a caller on this computer, the local network or a tailnet. Anything else is refused. */
export function isNear(remote) {
  let address = String(remote ?? "");
  if (address === "::1") return true;
  if (address.startsWith("::ffff:")) address = address.slice(7);
  return addressKind(address) !== null;
}

// Interfaces that belong to virtual machines and containers, which a phone can't reach.
const VIRTUAL = /^(bridge|vmnet|vmenet|vboxnet|docker|br-|veth|virbr|llw|awdl|anpi|ap\d)/i;

/**
 * Addresses to offer a phone, best first: the local network (Wi-Fi and Ethernet before anything
 * else), then a tailnet. Each is { address, kind, interface }.
 */
export function reachable(interfaces = networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) continue;
      const kind = addressKind(entry.address);
      if (kind !== "lan" && kind !== "tailnet") continue;
      found.push({ address: entry.address, kind, interface: name, virtual: VIRTUAL.test(name) });
    }
  }
  const rank = (entry) => (entry.kind === "lan" ? 0 : 2) + (entry.virtual ? 1 : 0) + (/^en\d/.test(entry.interface) ? 0 : 0.5);
  return found
    .sort((a, b) => rank(a) - rank(b))
    .filter((entry, index, all) => all.findIndex((other) => other.address === entry.address) === index)
    .map(({ virtual: _virtual, ...entry }) => entry)
    .slice(0, 6);
}
