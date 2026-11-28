// Plain logic for parsing and composing a staged iOS Share Extension payload.
// No React Native imports so unit tests run directly in Node.

export type SharedAttachment = {
  id: string;
  name: string;
  relativePath?: string;
  uri: string;
  mimeType?: string;
  size: number;
  kind: "image" | "video" | "file";
};

export type SharedPayload = {
  id: string;
  createdAt?: number;
  hostId?: string | null;
  botId?: string | null;
  note: string;
  text?: string | null;
  urls: string[];
  attachments: SharedAttachment[];
};

/** Parses the JSON string returned by `Activities.readShare(id)`. Returns null on invalid input. */
export function parseSharedPayload(raw: string | null | undefined): SharedPayload | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return null;
  const note = typeof rec.note === "string" ? rec.note.trim() : "";
  const text = typeof rec.text === "string" && rec.text.trim() ? rec.text.trim() : null;
  const urls = Array.isArray(rec.urls)
    ? rec.urls.filter((u): u is string => typeof u === "string" && !!u.trim()).map((u) => u.trim())
    : [];
  const attachments: SharedAttachment[] = [];
  if (Array.isArray(rec.attachments)) {
    for (const item of rec.attachments) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const a = item as Record<string, unknown>;
      const uri = typeof a.uri === "string" ? a.uri.trim() : "";
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!uri || !name) continue;
      const rawKind = a.kind;
      const kind: SharedAttachment["kind"] = rawKind === "image" || rawKind === "video" ? rawKind : "file";
      attachments.push({
        id: typeof a.id === "string" && a.id ? a.id : `${attachments.length}-${name}`,
        name,
        relativePath: typeof a.relativePath === "string" ? a.relativePath : undefined,
        uri,
        mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
        size: typeof a.size === "number" && Number.isFinite(a.size) ? Math.max(0, a.size) : 0,
        kind,
      });
    }
  }
  return {
    id,
    createdAt: typeof rec.createdAt === "number" ? rec.createdAt : undefined,
    hostId: typeof rec.hostId === "string" && rec.hostId.trim() ? rec.hostId.trim() : null,
    botId: typeof rec.botId === "string" && rec.botId.trim() ? rec.botId.trim() : null,
    note,
    text,
    urls,
    attachments,
  };
}

/**
 * Builds the chat message text from a shared payload's user context, shared links, and shared text.
 * Falls back to a plain attachment note when only files/media were shared with no text.
 */
export function formatSharedMessage(payload: Pick<SharedPayload, "note" | "text" | "urls" | "attachments">, uploadedCount: number): string {
  const parts: string[] = [];
  const note = payload.note.trim();
  if (note) parts.push(note);
  const uniqueUrls = [...new Set(payload.urls.map((u) => u.trim()).filter(Boolean))];
  if (uniqueUrls.length) parts.push(uniqueUrls.join("\n"));
  const sharedText = (payload.text ?? "").trim();
  if (sharedText && !uniqueUrls.includes(sharedText)) parts.push(sharedText);
  if (parts.length) return parts.join("\n\n");
  if (uploadedCount === 1) return "See the shared file.";
  if (uploadedCount > 1) return "See the shared files.";
  return "";
}
