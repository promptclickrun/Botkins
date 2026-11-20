// Artifacts ("artifacts-v1") as the phone reads them: pages of a bot's list, thumbnails, files
// downloaded in pieces into the phone's cache, and which paths in a chat the computer knows. Nothing
// here is kept past the computer in use: `onComputerChange` empties all of it.
import { Directory, File, Paths } from "expo-file-system";
import { type Href, router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { mediaModule } from "@/device/native";
import { detectPaths, type PathSpan } from "@/features/chat/paths";
import { fromUtf8, unb64u } from "@/link/crypto";
import type { Artifact, ArtifactPage } from "@/link/types";
import { cleanFileName } from "@/state/fileText";
import { useCapability, useOnline, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { onComputerChange, useApp } from "@/state/store";
import type { PathLinks } from "@/ui";
import { type Filter, inFilter, type Known, kindOf, linkKey, mediaOf, PathResolver, TEXT_LIMIT, uniquePaths } from "./logic";

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

// ---- Artifacts the phone has seen, so a preview can show its name at once

const seen = new Map<string, Artifact>();
export function remember(artifact: Artifact) {
  seen.delete(artifact.id);
  seen.set(artifact.id, artifact);
  if (seen.size > 300) seen.delete(seen.keys().next().value as string);
}
export const remembered = (id: string) => seen.get(id);

/** A folder's own list. (The routes are new: typed routes learn them the next time Metro starts.) */
export const folderHref = (artifact: Artifact) => ("/artifacts?botId=" + encodeURIComponent(artifact.botId) + "&folder=" + encodeURIComponent(artifact.id) + "&title=" + encodeURIComponent(artifact.name)) as unknown as Href;

/** Opens an artifact: a folder as its list, anything else as its preview. */
export function openArtifact(artifact: Artifact) {
  remember(artifact);
  if (artifact.kind === "folder") router.push(folderHref(artifact));
  else router.push(("/artifacts/view?id=" + encodeURIComponent(artifact.id)) as unknown as Href);
}

/** The list of a bot's artifacts (a folder's, when `folder` is set). */
export function openArtifactList(botId: string) {
  router.push(("/artifacts?botId=" + encodeURIComponent(botId)) as unknown as Href);
}

// ---- Lists

type ListState = { items: Artifact[]; cursor: string | null; loaded: boolean; error?: string; loadingMore: boolean };
const EMPTY: ListState = { items: [], cursor: null, loaded: false, loadingMore: false };

/**
 * A bot's artifacts, newest first, a page at a time. Read again when the index changes on the computer
 * (revs.artifacts), and kept on screen while that happens (a fresh read starts again at the first page).
 * Nothing is asked while `enabled` is false (no "artifacts-v1").
 */
export function useArtifactList({ botId, folder, filter = "all", enabled = true }: { botId: string; folder?: string; filter?: Filter; enabled?: boolean }) {
  const revision = usePart("revs")?.artifacts;
  const online = useOnline();
  const [state, setState] = useState<ListState>(EMPTY);
  const [refreshing, setRefreshing] = useState(false);
  const [tries, setTries] = useState(0);
  // Each first page asked for has a number; an answer to an older one is dropped.
  const asked = useRef(0);
  // Pull to refresh waits for the answer.
  const waiting = useRef<(() => void)[]>([]);
  const key = botId + "\u0000" + (folder ?? "") + "\u0000" + filter;
  const held = useRef(key);

  useEffect(() => {
    if (!enabled || !online || !botId) return;
    const number = ++asked.current;
    // Another list: what was shown for the last one goes, except what still fits the filter.
    if (held.current !== key) {
      const sameFolder = held.current.split("\u0000").slice(0, 2).join("\u0000") === key.split("\u0000").slice(0, 2).join("\u0000");
      held.current = key;
      setState((now) => (sameFolder ? { ...now, items: now.items.filter((item) => inFilter(filter, item)), cursor: null, error: undefined, loaded: false } : EMPTY));
    }
    api["artifacts.list"]({ botId, ...(folder && { folder }), ...(kindOf(filter) && { kind: kindOf(filter) }) }).then(
      (page: ArtifactPage) => {
        if (number !== asked.current) return;
        page.items.forEach(remember);
        setState({ items: page.items, cursor: page.nextCursor, loaded: true, loadingMore: false });
        for (const done of waiting.current.splice(0)) done();
      },
      (error: unknown) => {
        if (number !== asked.current) return;
        setState((now) => ({ ...now, loaded: true, loadingMore: false, error: errorText(error, "Couldn't load the artifacts.") }));
        for (const done of waiting.current.splice(0)) done();
      },
    );
  }, [enabled, online, botId, folder, filter, key, revision, tries]);

  const more = () => {
    const cursor = state.cursor;
    if (!cursor || state.loadingMore || !online) return;
    const number = asked.current;
    setState((now) => ({ ...now, loadingMore: true }));
    api["artifacts.list"]({ botId, ...(folder && { folder }), ...(kindOf(filter) && { kind: kindOf(filter) }), cursor }).then(
      (page: ArtifactPage) => {
        if (number !== asked.current) return;
        page.items.forEach(remember);
        setState((now) => {
          const have = new Set(now.items.map((item) => item.id));
          return { ...now, items: [...now.items, ...page.items.filter((item) => !have.has(item.id))], cursor: page.nextCursor, loadingMore: false };
        });
      },
      () => number === asked.current && setState((now) => ({ ...now, loadingMore: false })),
    );
  };

  const refresh = async () => {
    if (!online) return;
    setRefreshing(true);
    // Done when the answer comes, or after a while if it doesn't.
    await new Promise<void>((done) => {
      waiting.current.push(done);
      setTimeout(done, 15_000);
      setTries((n) => n + 1);
    });
    setRefreshing(false);
  };

  // While the filter's answer is on its way, what is shown already fits it.
  const items = useMemo(() => state.items.filter((item) => inFilter(filter, item)), [state.items, filter]);
  return { items, loaded: state.loaded, error: state.error, end: state.cursor === null, loadingMore: state.loadingMore, more, refresh, refreshing, retry: () => setTries((n) => n + 1) };
}

// ---- Thumbnails, kept in memory (a bounded number)

const THUMBS = 120;
const thumbs = new Map<string, string | null>();
const thumbsAsked = new Map<string, Promise<string | null>>();

function keepThumb(id: string, uri: string | null) {
  thumbs.delete(id);
  thumbs.set(id, uri);
  if (thumbs.size > THUMBS) thumbs.delete(thumbs.keys().next().value as string);
}

/** A picture's or a video's small picture, as a data uri; null when the computer has none. */
export function loadThumbnail(id: string): Promise<string | null> {
  if (thumbs.has(id)) return Promise.resolve(thumbs.get(id) ?? null);
  let asking = thumbsAsked.get(id);
  if (!asking) {
    asking = api["artifacts.thumbnail"](id, { size: 160 })
      .then((thumb) => {
        const uri = thumb && typeof thumb.data === "string" && /^image\/[\w.+-]+$/.test(thumb.mime) ? "data:" + thumb.mime + ";base64," + thumb.data : null;
        keepThumb(id, uri);
        return uri;
      })
      // A failed one is not kept, so it is asked again next time.
      .catch(() => null)
      .finally(() => thumbsAsked.delete(id));
    thumbsAsked.set(id, asking);
  }
  return asking;
}

/** The thumbnail for an artifact that has one (a picture or a video), once it has loaded. */
export function useThumbnail(artifact: Pick<Artifact, "id" | "kind">): string | null {
  const can = useCapability("artifacts-v1");
  const wanted = can && (artifact.kind === "image" || artifact.kind === "video");
  const [loaded, setLoaded] = useState<{ id: string; uri: string | null }>();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void loadThumbnail(artifact.id).then((uri) => live && setLoaded({ id: artifact.id, uri }));
    return () => {
      live = false;
    };
  }, [wanted, artifact.id]);
  if (!wanted) return null;
  return loaded?.id === artifact.id ? loaded.uri : (thumbs.get(artifact.id) ?? null);
}

// ---- Reading

/** The artifact itself, by a first small read. */
export async function readArtifact(id: string): Promise<Artifact> {
  const chunk = await api["artifacts.read"](id, { length: 1 });
  remember(chunk.artifact);
  return chunk.artifact;
}

/** The first 512 KB of a file as text, and whether there is more. */
export async function readText(id: string): Promise<{ text: string; cut: boolean }> {
  const chunk = await api["artifacts.read"](id, { offset: 0, length: TEXT_LIMIT });
  return { text: chunk.data ? fromUtf8(unb64u(chunk.data)) : "", cut: chunk.nextOffset !== null };
}

// ---- Downloads into the phone's cache

type Download = { progress: number; uri?: string; error?: string };
/** Each artifact's download: how far it got, and the local file when it is done. */
export const useDownloads = create<Record<string, Download>>(() => ({}));
const running = new Map<string, { stop: boolean }>();
// The newest downloads are kept on the phone; older ones are deleted.
const KEEP_FILES = 6;
const kept: string[] = [];
const root = () => new Directory(Paths.cache, "botkins-artifacts");
const folderOf = (id: string) => new Directory(root(), id.replace(/[^\w.-]/g, "_").slice(0, 80) || "file");

function forgetFile(id: string) {
  try {
    const folder = folderOf(id);
    if (folder.exists) folder.delete();
  } catch {
    // Already gone.
  }
}

function keepFile(id: string) {
  const at = kept.indexOf(id);
  if (at >= 0) kept.splice(at, 1);
  kept.push(id);
  while (kept.length > KEEP_FILES) {
    const old = kept.shift()!;
    if (running.has(old)) continue;
    forgetFile(old);
    useDownloads.setState((all) => {
      const { [old]: _, ...rest } = all;
      return rest;
    }, true);
  }
}

const setDownload = (id: string, next: Download | undefined) =>
  useDownloads.setState((all) => {
    if (next) return { ...all, [id]: next };
    const { [id]: _, ...rest } = all;
    return rest;
  }, true);

/**
 * Downloads a whole file in pieces into the phone's cache, appending each piece as it comes (a big
 * file is never held in memory). Resolves to its `file://` uri. Asked twice, it downloads once.
 */
export function download(artifact: Artifact): Promise<string> {
  const done = useDownloads.getState()[artifact.id];
  if (done?.uri) {
    try {
      if (new File(done.uri).exists) return Promise.resolve(done.uri);
    } catch {
      // Download it again.
    }
  }
  if (running.has(artifact.id)) {
    return new Promise((resolve, reject) => {
      const stop = useDownloads.subscribe((all) => {
        const now = all[artifact.id];
        if (now?.uri) {
          stop();
          resolve(now.uri);
        } else if (!now || now.error) {
          stop();
          reject(new Error(now?.error ?? "The download stopped."));
        }
      });
    });
  }
  const flag = { stop: false };
  running.set(artifact.id, flag);
  setDownload(artifact.id, { progress: 0 });
  return (async () => {
    const folder = folderOf(artifact.id);
    const file = new File(folder, cleanFileName(artifact.name, "file"));
    try {
      if (folder.exists) folder.delete();
      folder.create({ intermediates: true });
      file.create({ overwrite: true });
      let offset: number | null = 0;
      let got = 0;
      while (offset !== null) {
        const chunk = await api["artifacts.read"](artifact.id, { offset });
        if (flag.stop) throw new Error("Stopped.");
        if (chunk.data) await file.write(chunk.data, { encoding: "base64", append: true });
        got += Math.floor(((chunk.data?.length ?? 0) * 3) / 4);
        // A computer that hands back the same place again would loop: stop instead.
        if (chunk.nextOffset !== null && chunk.nextOffset <= offset) throw new Error("The file couldn't be read.");
        offset = chunk.nextOffset;
        const size = artifact.size ?? 0;
        setDownload(artifact.id, { progress: size > 0 ? Math.min(1, got / size) : 0 });
      }
      setDownload(artifact.id, { progress: 1, uri: file.uri });
      keepFile(artifact.id);
      return file.uri;
    } catch (error) {
      forgetFile(artifact.id);
      const text = errorText(error, "Couldn't download that file.");
      setDownload(artifact.id, flag.stop ? undefined : { progress: 0, error: text });
      throw new Error(text);
    } finally {
      running.delete(artifact.id);
    }
  })();
}

/** Stops a download that is under way (leaving the preview). */
export function stopDownload(id: string) {
  const flag = running.get(id);
  if (flag) flag.stop = true;
}

/** Puts a picture or a video in the photo library, asking only to add. */
export async function saveToPhotos(uri: string): Promise<void> {
  const Media = mediaModule();
  if (!Media) throw new Error("This needs the newest Botkins app.");
  const answer = await Media.requestPermissionsAsync(true);
  if (!answer.granted) throw new Error("Allow Botkins to add photos in Settings.");
  await Media.Asset.create(uri);
}

// ---- Paths in a chat

type Links = { byChat: Record<string, Known> };
export const useArtifactPaths = create<Links>(() => ({ byChat: {} }));
const resolver = new PathResolver(
  (chatId, paths) => api["artifacts.resolve"]({ chatId, paths }).then((answer) => (Array.isArray(answer?.items) ? answer.items : [])),
  (chatId, known) => useArtifactPaths.setState((links) => ({ byChat: { ...links.byChat, [chatId]: known } })),
);

// The index changed on the computer: paths it had nothing for are asked again when shown.
useApp.subscribe((state, before) => {
  const now = state.parts.revs?.artifacts;
  const was = before.parts.revs?.artifacts;
  if (now !== undefined && was !== undefined && now !== was) resolver.forgetMissing();
});

// Another computer: nothing of the last one is shown.
onComputerChange(() => {
  resolver.reset();
  useArtifactPaths.setState({ byChat: {} });
  seen.clear();
  thumbs.clear();
  thumbsAsked.clear();
  for (const flag of running.values()) flag.stop = true;
  kept.length = 0;
  useDownloads.setState({}, true);
  try {
    const folder = root();
    if (folder.exists) folder.delete();
  } catch {
    // Nothing to delete.
  }
});

const NO_SPANS: PathSpan[] = [];
function spansOf(text: string): PathSpan[] {
  try {
    return detectPaths(text);
  } catch {
    // Whatever the text, a message is still shown.
    return NO_SPANS;
  }
}

/**
 * The paths in a message that the computer knows, as links for `Markdown`, and its MEDIA:
 * attachments. Nothing is asked without "artifacts-v1", or while `active` is false (a reply still
 * being written).
 */
export function useMessageLinks(chatId: string, text: string, active: boolean): { paths?: PathLinks; media: Artifact[] } {
  const can = useCapability("artifacts-v1");
  const on = can && active && !!chatId && !!text;
  const spans = useMemo(() => (on ? spansOf(text) : NO_SPANS), [on, text]);
  const wanted = useMemo(() => uniquePaths(spans), [spans]);
  const wantedKey = wanted.join("\u0000");
  useEffect(() => {
    if (wantedKey) resolver.want(chatId, wantedKey.split("\u0000"));
  }, [chatId, wantedKey]);
  // Only a change to what this message's links point at draws it again.
  const key = useArtifactPaths((links) => (spans.length ? linkKey(spans, links.byChat[chatId]) : ""));
  return useMemo(() => {
    if (!key) return { media: [] };
    const known = useArtifactPaths.getState().byChat[chatId];
    const byPath = new Map<string, Artifact>();
    for (const span of spans) {
      const artifact = known?.[span.path];
      if (artifact) byPath.set(span.path, artifact);
    }
    const paths: PathLinks = {
      has: (path) => byPath.has(path),
      find: (part) => spansOf(part).filter((span) => byPath.has(span.path)),
      open: (path) => {
        const artifact = byPath.get(path);
        if (artifact) openArtifact(artifact);
      },
    };
    return { paths, media: mediaOf(spans, known) };
  }, [key, chatId, spans]);
}
