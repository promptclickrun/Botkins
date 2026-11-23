// Apple Music as an on-device capability. MusicKit searches and writes stay on the phone; only
// bounded IDs and display metadata leave it.
import { BotkinsMusic, type MusicAuthorization, type MusicItem, type MusicKind, type MusicNowPlaying, type MusicSource } from "../../modules/botkins-music";
import type { Access } from "./access";
import { type Args, checkArgs, DeviceError, limitOf, optBool, optString, optStringList, reqString } from "./args";
import { argsOf } from "./tools";
import { compact, fit } from "./shape";
import type { DeviceLevel } from "@/link/types";
import { loadDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";

const KINDS = ["song", "album", "playlist", "artist"] as const;
const PLURALS: Record<string, MusicKind> = { songs: "song", albums: "album", playlists: "playlist", artists: "artist" };
const DEFAULT_KINDS: MusicKind[] = ["song", "album", "playlist"];
const SOURCES = ["catalog", "library"] as const;
const CONTROLS = ["pause", "resume", "next", "previous", "stop"] as const;

let grantRevision = 0;
let sentLevel: DeviceLevel | undefined;

function syncGrant() {
  const level = useDevicePrefs.getState().sources.music ?? "off";
  if (!BotkinsMusic || sentLevel === level) return grantRevision;
  sentLevel = level;
  grantRevision += 1;
  BotkinsMusic.setGrant(grantRevision, level);
  return grantRevision;
}

void loadDevicePrefs().then(syncGrant, () => {});
useDevicePrefs.subscribe((state, before) => {
  if (state.sources.music !== before.sources.music) syncGrant();
});

function accessOf(status: MusicAuthorization): Access {
  switch (status) {
    case "authorized":
      return { state: "granted" };
    case "notDetermined":
      return { state: "undetermined" };
    case "restricted":
      return { state: "unavailable", reason: "Apple Music access is restricted on this phone." };
    default:
      return { state: "denied" };
  }
}

export async function musicAccess(): Promise<Access> {
  if (!BotkinsMusic) return { state: "unavailable", reason: "This Botkins build needs an update to use Apple Music." };
  try {
    return accessOf(await BotkinsMusic.authorization());
  } catch {
    return { state: "unavailable", reason: "Apple Music could not be checked just now." };
  }
}

export async function askMusic(): Promise<Access> {
  if (!BotkinsMusic) return { state: "unavailable", reason: "This Botkins build needs an update to use Apple Music." };
  try {
    const current = await BotkinsMusic.authorization();
    return accessOf(current === "notDetermined" ? await BotkinsMusic.requestAuthorization() : current);
  } catch {
    return { state: "unavailable", reason: "Apple Music could not be opened just now." };
  }
}

function printable(value: string | undefined, max: number): string | undefined {
  const text = value?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, max) : undefined;
}

function itemOf(item: MusicItem) {
  return compact({
    id: item.id,
    type: item.type,
    title: printable(item.title, 200) ?? "(untitled)",
    artist: printable(item.artist, 200),
    album: printable(item.album, 200),
    source: item.source,
  });
}

function playingOf(value: MusicNowPlaying) {
  const item = value.item;
  return compact({
    state: value.state,
    positionSeconds: Math.max(0, Math.min(value.positionSeconds, 1_000_000)),
    item: item && compact({
      id: item.id,
      title: printable(item.title, 200) ?? "(untitled)",
      artist: printable(item.artist, 200),
      album: printable(item.album, 200),
      durationSeconds: item.durationSeconds,
    }),
  });
}

function safeError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/subscription_required|subscription/i.test(text)) return new DeviceError("Apple Music needs an active subscription to use that catalog item.");
  if (/not_found|not found|no item/i.test(text)) return new DeviceError("That Apple Music item was not found. Search again for a current ID.");
  if (/service_unavailable|service unavailable|developer token|network|unavailable just now/i.test(text)) return new DeviceError("Apple Music is unavailable just now. Check the connection and try again.");
  if (/permission|authorization|grant/i.test(text)) return new DeviceError("Apple Music access is off for Botkins or in iOS Settings.");
  return new DeviceError("Apple Music couldn't do that just now.");
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw safeError(error);
  }
}

async function ready(needs: Exclude<DeviceLevel, "off">) {
  if (!BotkinsMusic) throw new DeviceError("This needs the newest Botkins app on the phone.");
  await loadDevicePrefs();
  const level = useDevicePrefs.getState().sources.music ?? "off";
  if (level === "off" || (needs === "interact" && level !== "interact")) throw new DeviceError("Apple Music is " + (level === "off" ? "off on this phone." : "set to read only on this phone."));
  const grant = syncGrant();
  const access = accessOf(await BotkinsMusic.authorization());
  if (access.state !== "granted") {
    if (access.state === "unavailable") throw new DeviceError(access.reason ?? "Apple Music is unavailable on this phone.");
    if (access.state === "denied") throw new DeviceError("Apple Music access is off in iOS Settings.");
    throw new DeviceError("Apple Music access isn't set up yet. Turn Apple Music on again in Botkins.");
  }
  return { Music: BotkinsMusic, grant };
}

function kindOf(value: string | undefined, allowArtist = true): MusicKind {
  const kind = PLURALS[value ?? ""] ?? (value as MusicKind);
  if (!KINDS.includes(kind) || (!allowArtist && kind === "artist")) throw new DeviceError("`type` must name a music item type.");
  return kind;
}

function sourceOf(value: string | undefined): MusicSource | undefined {
  if (value === undefined) return undefined;
  if (!SOURCES.includes(value as MusicSource)) throw new DeviceError("`source` must be catalog or library.");
  return value as MusicSource;
}

function identifier(args: Args, key: string) {
  const value = reqString(args, key, 512).trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new DeviceError("`" + key + "` is not a valid Music ID.");
  return value;
}

function kindsOf(args: Args) {
  const given = optStringList(args, "types", 4, 20);
  if (!given) return DEFAULT_KINDS;
  const kinds = [...new Set(given.map((value) => kindOf(value)))];
  if (!kinds.length) throw new DeviceError("`types` needs at least one music item type.");
  return kinds;
}

function idsOf(args: Args, key: string, minimum = 0) {
  const ids = optStringList(args, key, 100, 512);
  if (!ids) {
    if (minimum > 0) throw new DeviceError("`" + key + "` is needed.");
    return [];
  }
  if (ids.length < minimum) throw new DeviceError("`" + key + "` needs at least " + minimum + " item.");
  if (ids.some((id) => /[\u0000-\u001f\u007f]/.test(id))) throw new DeviceError("`" + key + "` contains an invalid Music ID.");
  return ids;
}

function catalogCheck(canPlayCatalog: boolean, source: MusicSource) {
  if (source === "catalog" && !canPlayCatalog) throw new DeviceError("Apple Music needs an active subscription to use the catalog.");
}

async function nowPlaying(raw: unknown) {
  checkArgs(raw, argsOf("phone_music_now_playing"));
  const { Music, grant } = await ready("read");
  return playingOf(await call(() => Music.nowPlaying(grant)));
}

async function search(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_search"));
  const query = reqString(args, "query", 200).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!query) throw new DeviceError("`query` must contain searchable text.");
  const kinds = kindsOf(args);
  const limit = limitOf(args, 10, 25);
  const { Music, grant } = await ready("read");
  const canPlayCatalog = await call(() => Music.canPlayCatalog(grant));
  const source = sourceOf(optString(args, "source", 20)) ?? (canPlayCatalog ? "catalog" : "library");
  catalogCheck(canPlayCatalog, source);
  const items = await call(() => Music.search(query, kinds, source, limit, grant));
  const queues = kinds.map((kind) => items.filter((item) => item.type === kind));
  const results: ReturnType<typeof itemOf>[] = [];
  while (results.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const item = queue.shift();
      if (item) results.push(itemOf(item));
      if (results.length >= limit) break;
    }
  }
  return fit({ results, source, subscription: { canPlayCatalog } }, "results");
}

async function library(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_library"));
  const value = optString(args, "type", 20) ?? "playlists";
  if (value !== "playlists" && value !== "recent") throw new DeviceError("`type` must be playlists or recent.");
  const limit = limitOf(args, 25, 50);
  const { Music, grant } = await ready("read");
  const items = await call(() => Music.library(value, limit, grant));
  return fit({ items: items.slice(0, limit).map(itemOf) }, "items");
}

async function play(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_play"));
  const shuffle = optBool(args, "shuffle") ?? null;
  const query = optString(args, "query", 200)?.trim();
  const id = args.id === undefined ? undefined : identifier(args, "id");
  const type = optString(args, "type", 20);
  const wantedSource = sourceOf(optString(args, "source", 20));
  const { Music, grant } = await ready("interact");
  const canCatalog = await call(() => Music.canPlayCatalog(grant));
  let targetId: string;
  let targetKind: MusicKind;
  let targetSource: MusicSource;
  if (query) {
    if (id || type || wantedSource) throw new DeviceError("Use a query by itself, or use id, type and source together.");
    targetSource = canCatalog ? "catalog" : "library";
    const results = await call(() => Music.search(query, ["song"], targetSource, 1, grant));
    const found = results.find((item) => item.type === "song");
    if (!found) throw new DeviceError("No Apple Music song matched that query.");
    targetId = found.id;
    targetKind = "song";
  } else {
    targetId = id ?? "";
    if (!targetId || !type) throw new DeviceError("Give a query, or both an id and type.");
    targetKind = kindOf(type);
    targetSource = wantedSource ?? (canCatalog ? "catalog" : "library");
  }
  catalogCheck(canCatalog, targetSource);
  return playingOf(await call(() => Music.play(targetId, targetKind, targetSource, shuffle, grant)));
}

async function control(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_control"));
  const action = reqString(args, "action", 20) as (typeof CONTROLS)[number];
  if (!CONTROLS.includes(action)) throw new DeviceError("`action` must be pause, resume, next, previous or stop.");
  const { Music, grant } = await ready("interact");
  return playingOf(await call(() => Music.control(action, grant)));
}

async function createPlaylist(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_create_playlist"));
  const name = reqString(args, "name", 100).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) throw new DeviceError("`name` must contain text.");
  const description = optString(args, "description", 300);
  const songIds = idsOf(args, "songIds");
  const { Music, grant } = await ready("interact");
  return call(() => Music.createPlaylist(name, description?.trim() || null, songIds, grant));
}

async function addToPlaylist(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_add_playlist"));
  const playlistId = identifier(args, "playlistId");
  const songIds = idsOf(args, "songIds", 1);
  const { Music, grant } = await ready("interact");
  return call(() => Music.addToPlaylist(playlistId, songIds, grant));
}

async function addToLibrary(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_music_add_library"));
  const id = identifier(args, "id");
  const kind = kindOf(reqString(args, "type", 20), false) as Exclude<MusicKind, "artist">;
  const { Music, grant } = await ready("interact");
  return call(() => Music.addToLibrary(id, kind, grant));
}

export const musicTools = {
  phone_music_now_playing: nowPlaying,
  phone_music_search: search,
  phone_music_library: library,
  phone_music_play: play,
  phone_music_control: control,
  phone_music_create_playlist: createPlaylist,
  phone_music_add_playlist: addToPlaylist,
  phone_music_add_library: addToLibrary,
};
