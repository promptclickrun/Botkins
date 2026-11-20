// The list of apps Composio can connect, from a public catalog. It is kept on disk with its ETag,
// shown at once from there, and checked again at most once an hour.
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";

export const CATALOG_URL = process.env.EXPO_PUBLIC_COMPOSIO_CATALOG_URL || "https://catalog.bighelp.app/v1/composio/catalog.json";
const MAX_AGE = 60 * 60 * 1000;
const SLUG = /^[a-z0-9_]{1,64}$/;

export type Toolkit = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  noAuth: boolean;
  /** Lowercased name and slug, then description, for search. */
  find: { name: string; text: string };
};
export type Category = { id: string; name: string; count: number };
export type Catalog = {
  revision: string;
  /** Largest first. */
  categories: Category[];
  /** Most used first. */
  toolkits: Toolkit[];
  bySlug: Map<string, Toolkit>;
};

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Checks and shapes the catalog. Entries that don't fit are dropped. Throws when the whole thing is wrong. */
export function parseCatalog(raw: unknown): Catalog {
  const body = raw as { schemaVersion?: unknown; revision?: unknown; categories?: unknown; toolkits?: unknown } | null;
  if (!body || body.schemaVersion !== 1 || !Array.isArray(body.toolkits) || !Array.isArray(body.categories)) throw new Error("The app list has a shape this app doesn't know.");

  const names = new Map<string, string>();
  for (const item of body.categories as { id?: unknown; name?: unknown }[]) {
    const id = str(item?.id);
    const name = str(item?.name);
    if (id && id.length <= 64 && name && name.length <= 80) names.set(id, name);
  }

  const toolkits: Toolkit[] = [];
  const bySlug = new Map<string, Toolkit>();
  const counts = new Map<string, number>();
  for (const item of body.toolkits as Record<string, unknown>[]) {
    if (!item || typeof item !== "object") continue;
    const slug = str(item.slug);
    const name = str(item.name);
    if (!SLUG.test(slug) || !name || name.length > 80 || bySlug.has(slug)) continue;
    const logo = str(item.logo);
    const description = str(item.description).slice(0, 280);
    const categories = Array.isArray(item.categories) ? [...new Set((item.categories as unknown[]).map(str).filter((id) => names.has(id)))] : [];
    const toolkit: Toolkit = {
      slug,
      name,
      description,
      logo: /^https:\/\//i.test(logo) ? logo : null,
      categories,
      noAuth: item.noAuth === true,
      find: { name: (name + " " + slug).toLowerCase(), text: description.toLowerCase() },
    };
    toolkits.push(toolkit);
    bySlug.set(slug, toolkit);
    for (const id of categories) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (toolkits.length === 0) throw new Error("The app list is empty.");

  const categories = [...names]
    .map(([id, name]) => ({ id, name, count: counts.get(id) ?? 0 }))
    .filter((category) => category.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { revision: str(body.revision), categories, toolkits, bySlug };
}

/** Apps whose name, slug or description contains the query; name matches first, each in usage order. */
export function searchToolkits(toolkits: Toolkit[], query: string, limit = Infinity): Toolkit[] {
  const q = query.trim().toLowerCase();
  if (!q) return toolkits.slice(0, limit);
  const starts: Toolkit[] = [];
  const names: Toolkit[] = [];
  const texts: Toolkit[] = [];
  for (const toolkit of toolkits) {
    const at = toolkit.find.name.indexOf(q);
    if (at === 0) starts.push(toolkit);
    else if (at > 0) names.push(toolkit);
    else if (toolkit.find.text.includes(q)) texts.push(toolkit);
    if (starts.length >= limit) break;
  }
  return [...starts, ...names, ...texts].slice(0, limit);
}

// ---- Cache --------------------------------------------------------------------------------------

type Meta = { etag?: string; checkedAt: number };
const bodyFile = () => new File(Paths.cache, "composio-catalog.json");
const metaFile = () => new File(Paths.cache, "composio-catalog.meta.json");

let memory: { catalog: Catalog; meta: Meta } | null = null;

/** The catalog kept on the phone, if any. */
export async function cachedCatalog(): Promise<Catalog | null> {
  if (memory) return memory.catalog;
  try {
    const body = bodyFile();
    const meta = metaFile();
    if (!body.exists) return null;
    const catalog = parseCatalog(JSON.parse(await body.text()));
    const saved = meta.exists ? (JSON.parse(await meta.text()) as Partial<Meta>) : {};
    memory = { catalog, meta: { etag: typeof saved.etag === "string" ? saved.etag : undefined, checkedAt: typeof saved.checkedAt === "number" ? saved.checkedAt : 0 } };
    return catalog;
  } catch {
    return null;
  }
}

async function writeCache(text: string | null, meta: Meta) {
  try {
    if (text !== null) {
      const body = bodyFile();
      if (!body.exists) body.create({ intermediates: true });
      await body.write(text);
    }
    const file = metaFile();
    if (!file.exists) file.create({ intermediates: true });
    await file.write(JSON.stringify(meta));
  } catch {
    // The cache is a convenience; the catalog still works from memory.
  }
}

/**
 * Checks the catalog with the server when the copy held is older than an hour (or always, with
 * `force`). Resolves to the new catalog, or null when the held copy is still current.
 */
export async function revalidateCatalog(force = false): Promise<Catalog | null> {
  await cachedCatalog();
  const held = memory;
  if (held && !force && Date.now() - held.meta.checkedAt < MAX_AGE) return null;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (held?.meta.etag) headers["If-None-Match"] = held.meta.etag;
  const response = await fetch(CATALOG_URL, { headers });
  if (response.status === 304 && held) {
    held.meta = { ...held.meta, checkedAt: Date.now() };
    void writeCache(null, held.meta);
    return null;
  }
  if (!response.ok) throw new Error("The app list didn't load.");
  const text = await response.text();
  const catalog = parseCatalog(JSON.parse(text));
  const meta: Meta = { etag: response.headers.get("etag") ?? undefined, checkedAt: Date.now() };
  memory = { catalog, meta };
  void writeCache(text, meta);
  return catalog;
}
