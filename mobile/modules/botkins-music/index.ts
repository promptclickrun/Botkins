// Apple Music access for device tools. Search, playback and library changes stay on the phone;
// agents receive only stable identifiers and bounded metadata.
import { type EventSubscription, requireOptionalNativeModule } from "expo-modules-core";

export type MusicAuthorization = "notDetermined" | "denied" | "restricted" | "authorized";
export type MusicKind = "song" | "album" | "playlist" | "artist";
export type MusicSource = "catalog" | "library";
export type MusicItem = { id: string; type: MusicKind; title: string; artist?: string; album?: string; source: MusicSource };
export type MusicNowPlaying = { state: "playing" | "paused" | "stopped"; positionSeconds: number; item?: { id: string; title: string; artist?: string; album?: string; durationSeconds?: number } };

type Native = {
  authorization(): Promise<MusicAuthorization>;
  requestAuthorization(): Promise<MusicAuthorization>;
  canPlayCatalog(grant: number): Promise<boolean>;
  setGrant(revision: number, level: "off" | "read" | "interact"): void;
  search(query: string, kinds: MusicKind[], source: MusicSource, limit: number, grant: number): Promise<MusicItem[]>;
  library(type: "playlists" | "recent", limit: number, grant: number): Promise<MusicItem[]>;
  nowPlaying(grant: number): Promise<MusicNowPlaying>;
  play(id: string, kind: MusicKind, source: MusicSource, shuffle: boolean | null, grant: number): Promise<MusicNowPlaying>;
  control(action: "pause" | "resume" | "next" | "previous" | "stop", grant: number): Promise<MusicNowPlaying>;
  createPlaylist(name: string, description: string | null, songIds: string[], grant: number): Promise<{ id: string }>;
  addToPlaylist(playlistId: string, songIds: string[], grant: number): Promise<{ id: string }>;
  addToLibrary(id: string, kind: Exclude<MusicKind, "artist">, grant: number): Promise<{ id: string }>;
  addListener(name: "changed", listener: (event: { state: MusicNowPlaying["state"] }) => void): EventSubscription;
};

export const BotkinsMusic = requireOptionalNativeModule<Native>("BotkinsMusic");
