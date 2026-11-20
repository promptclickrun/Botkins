// The computers this phone is paired with: a list, and which one is in use. The phone follows one
// computer at a time; the others stay paired and are a tap away. This is the plain logic, with no
// React Native imports, so the tests run it. src/state/link.ts keeps the list and acts on it.
import type { Pairing } from "@/link/client";

/** What the phone keeps: every pairing, in the order they were made, and the id of the computer in use. */
export type Kept = { current: string | null; list: Pairing[] };
export const NO_COMPUTERS: Kept = { current: null, list: [] };
/** More than this is refused: each one is a full-trust pairing the person should be able to keep in mind. */
export const MAX_COMPUTERS = 8;
export const TOO_MANY = "This phone is paired with " + MAX_COMPUTERS + " computers, which is the most it keeps. Unpair one first.";

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
/** Whether a saved value has everything a pairing needs. A damaged one is left out, and the person pairs again. */
export function isPairing(value: unknown): value is Pairing {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return text(item.serverId) && text(item.serverKey) && text(item.deviceId) && text(item.secretKey) && typeof item.name === "string" && Array.isArray(item.hosts) && item.hosts.every((host) => typeof host === "string");
}

/** The pairing in use, or null when the phone is paired with nothing. */
export const currentOf = (kept: Kept): Pairing | null => kept.list.find((pairing) => pairing.serverId === kept.current) ?? null;

/** A list that is whole: one entry for each computer, and a computer in use whenever there is one. */
export function tidy(list: Pairing[], current: string | null): Kept {
  const seen = new Set<string>();
  const kept = list.filter((pairing) => isPairing(pairing) && !seen.has(pairing.serverId) && !!seen.add(pairing.serverId)).slice(0, MAX_COMPUTERS);
  return { list: kept, current: kept.some((pairing) => pairing.serverId === current) ? current : (kept[0]?.serverId ?? null) };
}

/** A new pairing: added, or put in place of the one this phone already had with that computer. It becomes the one in use. */
export function withPairing(kept: Kept, pairing: Pairing): Kept {
  const known = kept.list.some((item) => item.serverId === pairing.serverId);
  return { current: pairing.serverId, list: known ? kept.list.map((item) => (item.serverId === pairing.serverId ? pairing : item)) : [...kept.list, pairing] };
}

/** Whether one more computer can be paired. Pairing again with a computer the phone already has is always allowed. */
export const hasRoom = (kept: Kept, serverId?: string) => kept.list.length < MAX_COMPUTERS || (!!serverId && kept.list.some((item) => item.serverId === serverId));

/** The same list with one pairing's details changed (the computer's addresses). A computer that is no longer kept stays out. */
export const withDetails = (kept: Kept, pairing: Pairing): Kept => ({ ...kept, list: kept.list.map((item) => (item.serverId === pairing.serverId ? pairing : item)) });

/** Using another kept computer. Naming one that is not kept changes nothing. */
export const using = (kept: Kept, serverId: string): Kept => (kept.list.some((item) => item.serverId === serverId) ? { ...kept, current: serverId } : kept);

/** Without one computer. When it was the one in use, the first of the rest is used next. */
export function without(kept: Kept, serverId: string): Kept {
  const list = kept.list.filter((item) => item.serverId !== serverId);
  return { list, current: kept.current === serverId ? (list[0]?.serverId ?? null) : kept.current };
}

/** The keychain entry one pairing is kept in. A keychain value is small, so each pairing has its own. */
export const pairingKey = (serverId: string) => "botkins.computer." + serverId.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * What was saved, read back. `index` is the list of computers and the one in use; `read` gives one
 * pairing's saved text. `single` is what a version before several computers saved: one pairing,
 * which becomes a list of one.
 */
export function readKeptComputers(index: string | null, read: (serverId: string) => string | null, single: string | null): Kept {
  const parse = (value: string | null): unknown => {
    try {
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  };
  const saved = parse(index) as { current?: unknown; ids?: unknown } | null;
  if (saved && Array.isArray(saved.ids)) {
    const list = saved.ids.filter(text).map((id) => parse(read(id))).filter(isPairing);
    return tidy(list, text(saved.current) ? saved.current : null);
  }
  const old = parse(single);
  return isPairing(old) ? { current: old.serverId, list: [old] } : NO_COMPUTERS;
}

/** The ids a saved index names, so their pairings can be read. None when there is no index or it is damaged. */
export function savedIds(index: string | null): string[] {
  try {
    const saved = index ? (JSON.parse(index) as { ids?: unknown }) : null;
    return saved && Array.isArray(saved.ids) ? saved.ids.filter(text) : [];
  } catch {
    return [];
  }
}

/** The index as it is saved: ids only. The pairings themselves are saved one by one. */
export const indexOf = (kept: Kept) => JSON.stringify({ current: kept.current, ids: kept.list.map((pairing) => pairing.serverId) });

/** The switcher's menu: each paired computer (the one in use is ticked), then a way to pair one more. */
export function computerActions(list: Pairing[], current: string | null | undefined): { id: string; title: string; state?: "on" | "off"; image?: string }[] {
  return [...list.map((pairing) => ({ id: "use:" + pairing.serverId, title: pairing.name || "Computer", state: pairing.serverId === current ? ("on" as const) : ("off" as const) })), { id: "add", title: "Add a computer…", image: "plus" }];
}
/** What a tap in that menu asks for: use a computer, add one, or nothing. */
export function computerChoice(event: string): { use: string } | "add" | null {
  if (event === "add") return "add";
  return event.startsWith("use:") && event.length > 4 ? { use: event.slice(4) } : null;
}
