// Artifacts ("artifacts-v1") as plain logic: the filter, which preview a file gets, a row's second
// line, and which paths in a message become links. No React Native imports, so the tests run it.
import type { PathSpan } from "@/features/chat/paths";
import type { Artifact } from "@/link/types";
import { ago } from "../../state/time";

// ---- The filter: All · Files · Media

export type Filter = "all" | "files" | "media";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "media", label: "Media" },
];
const MEDIA_KINDS: ReadonlySet<Artifact["kind"]> = new Set(["image", "video", "audio"]);

/** Pictures, video and sound. Everything else, folders included, is a file. */
export const isMedia = (artifact: Pick<Artifact, "kind">) => MEDIA_KINDS.has(artifact.kind);
/** What `artifacts.list` is asked for: nothing for All. */
export const kindOf = (filter: Filter): "files" | "media" | undefined => (filter === "all" ? undefined : filter);
/** Whether an artifact belongs under a filter (so a list can narrow at once while the computer answers). */
export const inFilter = (filter: Filter, artifact: Pick<Artifact, "kind">) => filter === "all" || (filter === "media") === isMedia(artifact);

// ---- Which preview a file gets

export type PreviewKind = "image" | "video" | "audio" | "text" | "markdown" | "code" | "pdf" | "folder" | "other";

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx", "mdown"]);
const TEXT_EXT = new Set(["txt", "log", "csv", "tsv", "text", "rtf"]);
const CODE_EXT = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "jsonc", "json5", "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "m", "mm", "c", "h", "cc", "cpp", "hpp", "cs",
  "php", "pl", "lua", "r", "scala", "dart", "sh", "bash", "zsh", "fish", "ps1", "sql", "html", "htm", "css", "scss", "sass", "less", "xml", "svg", "yaml", "yml", "toml", "ini", "cfg",
  "conf", "env", "graphql", "gql", "vue", "svelte", "astro", "dockerfile", "makefile", "gradle", "proto", "tf", "ex", "exs", "erl", "hs", "clj", "elm", "zig", "nim", "vim", "diff", "patch",
]);
const CODE_MIME = /^(application\/(json|ld\+json|javascript|x-javascript|typescript|x-typescript|xml|x-sh|x-yaml|yaml|toml|sql|x-python|graphql)|text\/(javascript|typescript|x-[\w+-]+|html|css|xml|yaml))$/i;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "avif"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "aif", "aiff", "caf", "flac", "ogg", "opus"]);

/** The name's ending in lower case, without the dot ("" when there is none). A name like "Dockerfile" is its own ending. */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return /^(dockerfile|makefile)$/i.test(base) ? base.toLowerCase() : "";
  return base.slice(dot + 1).toLowerCase();
}

/** Which preview an artifact gets, from its kind, its type and the ending of its name. Anything unknown is "other". */
export function previewKind(artifact: Pick<Artifact, "kind" | "mime" | "name">): PreviewKind {
  const mime = (artifact.mime || "").toLowerCase().split(";")[0]!.trim();
  const ext = extOf(artifact.name || "");
  if (artifact.kind === "folder" || mime === "inode/directory") return "folder";
  // A drawing in SVG is code: it is text, and a picture viewer won't draw it.
  if (mime === "image/svg+xml" || ext === "svg") return "code";
  if (artifact.kind === "image" || mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (artifact.kind === "video" || mime.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
  if (artifact.kind === "audio" || mime.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  // The ending says more than a generic type: a .md sent as text/plain is Markdown.
  if (MARKDOWN_EXT.has(ext) || mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (CODE_EXT.has(ext)) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  if (CODE_MIME.test(mime)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

/** Previews that read the file as text, at most `TEXT_LIMIT` of it. */
export const isTextPreview = (kind: PreviewKind) => kind === "text" || kind === "markdown" || kind === "code";
/** Text previews show the first 512 KB (one piece). */
export const TEXT_LIMIT = 512 * 1024;
/** Only pictures and video can go to the photo library. */
export const canSaveToPhotos = (kind: PreviewKind) => kind === "image" || kind === "video";
/** A download bigger than this waits for the person to ask for it. */
export const BIG_DOWNLOAD = 25 * 1024 * 1024;
export const isBig = (artifact: Pick<Artifact, "size">) => (artifact.size ?? 0) > BIG_DOWNLOAD;

// ---- A row's second line

/** A size in words: "512 bytes", "12 KB", "3.4 MB", "1.2 GB". */
export function sizeWords(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes === 1 ? "1 byte" : Math.round(bytes) + " bytes";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal under 10 ("3.4 MB"), whole numbers above ("12 KB"); never "10.0".
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  if (rounded >= 1024 && unit < units.length - 1) return "1 " + units[unit + 1];
  return (rounded < 10 && rounded % 1 !== 0 ? rounded.toFixed(1) : String(rounded)) + " " + units[unit];
}

/**
 * How an artifact came to be, in one word, as both apps say it. The same file can be listed twice
 * (a bot wrote it, and later sent it): the word tells the rows apart.
 */
export const SOURCE_WORDS: Record<Artifact["source"], string> = { tool: "Written", media: "Sent", upload: "Uploaded", export: "Exported" };
export const sourceWord = (source: Artifact["source"] | undefined): string => (source && Object.hasOwn(SOURCE_WORDS, source) ? SOURCE_WORDS[source] : "");

/**
 * "Written · 12 KB · 2h · Launch plan": how it came to be, the size (none for a folder), when, and
 * the chat it came from. The source is first, so it stays in view when a narrow row cuts the line.
 * A row's accessibility label is its name and this line.
 */
export function rowLine(artifact: Pick<Artifact, "kind" | "size" | "time" | "chatTitle"> & { source?: Artifact["source"] }, now = Date.now()): string {
  const size = artifact.kind === "folder" ? "" : sizeWords(artifact.size);
  return [sourceWord(artifact.source), size, ago(artifact.time, now), artifact.chatTitle?.trim() ?? ""].filter(Boolean).join(" · ");
}

// ---- Paths in a chat

/** What the phone knows of a chat's paths: an artifact, or null when the computer has none for it. Missing: not asked yet. */
export type Known = Readonly<Record<string, Artifact | null>>;

/** The spans that become links: those whose path the computer resolved. */
export function linkedSpans(spans: readonly PathSpan[], known: Known | undefined): { span: PathSpan; artifact: Artifact }[] {
  if (!known) return [];
  const out: { span: PathSpan; artifact: Artifact }[] = [];
  for (const span of spans) {
    const artifact = known[span.path];
    if (artifact) out.push({ span, artifact });
  }
  return out;
}

/** The MEDIA: attachments that resolved, once each, in order. */
export function mediaOf(spans: readonly PathSpan[], known: Known | undefined): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const { span, artifact } of linkedSpans(spans, known)) {
    if (!span.media || seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    out.push(artifact);
  }
  return out;
}

/** A short text that changes only when what a message's links point at changes (a screen re-draws on it). */
export function linkKey(spans: readonly PathSpan[], known: Known | undefined): string {
  return linkedSpans(spans, known)
    .map(({ span, artifact }) => span.path + "\u0000" + artifact.id)
    .join("\u0001");
}

/** The different paths in some spans, at most `limit`, in order. */
export function uniquePaths(spans: readonly PathSpan[], limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.path)) continue;
    seen.add(span.path);
    out.push(span.path);
    if (out.length >= limit) break;
  }
  return out;
}

/** Splits paths into calls of at most `size` (the link takes 20 a call). */
export function batches<T>(items: readonly T[], size = 20): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

type Ask = (chatId: string, paths: string[]) => Promise<(Artifact | null)[]>;

/**
 * Asks the computer which paths in a chat are artifacts, without asking twice for the same chat and
 * path. What many messages want at once is gathered and sent 20 paths a call. A call that fails is
 * forgotten, so the paths are asked again the next time a message wants them; a path the computer
 * had nothing for is asked again only after `forgetMissing` (the index changed).
 */
export class PathResolver {
  /** Per chat: what is known, and what is waiting or asked. The oldest chat is dropped past `maxChats`. */
  private chats = new Map<string, { known: Record<string, Artifact | null>; pending: Set<string>; asked: Set<string> }>();
  private scheduled = false;
  private generation = 0;

  constructor(
    private readonly ask: Ask,
    private readonly onKnown: (chatId: string, known: Known) => void,
    private readonly schedule: (run: () => void) => void = (run) => void setTimeout(run, 40),
    private readonly maxChats = 30,
  ) {}

  private chat(chatId: string) {
    let held = this.chats.get(chatId);
    if (held) {
      // Most recently used last.
      this.chats.delete(chatId);
      this.chats.set(chatId, held);
      return held;
    }
    held = { known: {}, pending: new Set(), asked: new Set() };
    this.chats.set(chatId, held);
    while (this.chats.size > this.maxChats) {
      const oldest = this.chats.keys().next().value as string;
      this.chats.delete(oldest);
    }
    return held;
  }

  /** What is known about a chat's paths now. */
  known(chatId: string): Known | undefined {
    return this.chats.get(chatId)?.known;
  }

  /** Paths a message holds: those never asked about are asked soon, with whatever else is waiting. */
  want(chatId: string, paths: readonly string[]) {
    if (!chatId || paths.length === 0) return;
    const held = this.chat(chatId);
    let added = false;
    for (const path of paths) {
      if (path in held.known || held.pending.has(path) || held.asked.has(path)) continue;
      held.pending.add(path);
      added = true;
    }
    if (added && !this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Sends what is waiting, 20 paths a call. */
  flush() {
    this.scheduled = false;
    const generation = this.generation;
    for (const [chatId, held] of this.chats) {
      if (held.pending.size === 0) continue;
      const paths = [...held.pending];
      held.pending.clear();
      for (const group of batches(paths, 20)) {
        for (const path of group) held.asked.add(path);
        this.ask(chatId, group).then(
          (items) => {
            if (generation !== this.generation) return;
            const now = this.chats.get(chatId);
            if (!now) return;
            const known = { ...now.known };
            group.forEach((path, index) => {
              now.asked.delete(path);
              const item = items[index];
              known[path] = item && typeof item === "object" && typeof item.id === "string" ? item : null;
            });
            now.known = known;
            this.onKnown(chatId, known);
          },
          () => {
            if (generation !== this.generation) return;
            for (const path of group) this.chats.get(chatId)?.asked.delete(path);
          },
        );
      }
    }
  }

  /** The index changed: paths the computer had nothing for may have something now. */
  forgetMissing() {
    for (const [chatId, held] of this.chats) {
      const known: Record<string, Artifact | null> = {};
      let dropped = false;
      for (const [path, item] of Object.entries(held.known)) {
        if (item) known[path] = item;
        else dropped = true;
      }
      if (!dropped) continue;
      held.known = known;
      this.onKnown(chatId, known);
    }
  }

  /** Another computer: nothing known is kept, and answers still on their way are dropped. */
  reset() {
    this.generation++;
    this.chats.clear();
    this.scheduled = false;
  }
}
