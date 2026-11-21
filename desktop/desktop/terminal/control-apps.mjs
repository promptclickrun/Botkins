// Marketplace › Apps: the control socket's calls for the command line (desktop/terminal/control.mjs adds them).
// A call is `"apps.<verb>"([...args], context)`. Each wraps the app's own "composio.*" call
// (desktop/composio.mjs), which does the work through this computer's Composio tool and its sign-in.
// No token passes here: the answers are the apps, their accounts and the page to open.
import { ControlError } from "./socket.mjs";

const SLUG = /^[a-z0-9_]{1,64}$/;
const DEFAULT_LIMIT = 40;

export function appsApi({ handlers }) {
  const catalog = () => handlers["composio.catalog"]();
  /** An app by its slug or its name, from the list Composio publishes. */
  const app = async (ref) => {
    if (typeof ref !== "string" || !ref.trim()) throw new ControlError("Give an app's name or slug (see `botkins apps list`).", "BAD_ARGUMENT");
    const wanted = ref.trim().toLowerCase();
    const { toolkits } = await catalog();
    const found = toolkits.find((kit) => kit.slug === wanted) ?? toolkits.find((kit) => kit.name.toLowerCase() === wanted);
    if (found) return found;
    if (SLUG.test(wanted)) return { slug: wanted, name: wanted, noAuth: false };
    throw new ControlError("No app is called " + ref.trim() + ". See `botkins apps list`.", "NOT_FOUND");
  };
  const named = (toolkits, slug) => toolkits.find((kit) => kit.slug === slug)?.name ?? slug;

  return {
    /** The apps Composio connects, most used first: { categories, apps, total }. A search matches the name, the slug, then the description. */
    "apps.list": async ([options = {}]) => {
      const { categories, toolkits } = await catalog();
      const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
      const category = typeof options.category === "string" ? options.category.trim().toLowerCase() : "";
      if (category && !categories.some((entry) => entry.id === category)) throw new ControlError("There is no category " + options.category + ". These are: " + categories.map((entry) => entry.id).join(", ") + ".", "NOT_FOUND");
      const limit = Math.max(1, Math.min(2000, Number(options.limit) || DEFAULT_LIMIT));
      const base = category ? toolkits.filter((kit) => kit.categories.includes(category)) : toolkits;
      let found = base;
      if (query) {
        const starts = [];
        const names = [];
        const texts = [];
        for (const kit of base) {
          const at = (kit.name + " " + kit.slug).toLowerCase().indexOf(query);
          if (at === 0) starts.push(kit);
          else if (at > 0) names.push(kit);
          else if (kit.description.toLowerCase().includes(query)) texts.push(kit);
        }
        found = [...starts, ...names, ...texts];
      }
      return { categories, apps: found.slice(0, limit), total: found.length };
    },
    /** The apps with an active account. `known: false` when Composio's tool did not say which. */
    "apps.connected": async () => {
      const [{ toolkits }, slugs] = await Promise.all([catalog(), handlers["composio.connected"]()]);
      if (slugs === null) return { known: false, apps: [] };
      const accounts = slugs.length ? await handlers["composio.accounts"](slugs.slice(0, 50)) : {};
      // An app the tool named whose accounts can't be read is shown as connected, as the window does.
      const apps = slugs.filter((slug) => !accounts[slug] || accounts[slug].some((account) => account.status === "active")).map((slug) => ({ slug, name: named(toolkits, slug), accounts: accounts[slug] ?? [] }));
      return { known: true, apps };
    },
    /** Each named app's accounts: { <slug>: { name, accounts } }. */
    "apps.accounts": async ([refs]) => {
      const list = (Array.isArray(refs) ? refs : [refs]).filter((ref) => ref !== undefined);
      if (!list.length) throw new ControlError("Give one app or more.", "BAD_ARGUMENT");
      if (list.length > 50) throw new ControlError("Ask about 50 apps at most.", "BAD_ARGUMENT");
      const apps = await Promise.all(list.map(app));
      const accounts = await handlers["composio.accounts"](apps.map((kit) => kit.slug));
      return Object.fromEntries(apps.map((kit) => [kit.slug, { name: kit.name, accounts: accounts[kit.slug] ?? [] }]));
    },
    /** Starts connecting an app: { slug, name, page, pendingId?, accounts }. The person opens the page; `apps.accounts` shows when the account is active. */
    "apps.connect": async ([ref]) => {
      const kit = await app(ref);
      if (kit.noAuth) throw new ControlError(kit.name + " needs no sign-in: it is ready.", "NOT_NEEDED");
      const started = await handlers["composio.connect"](kit.slug);
      return { slug: kit.slug, name: kit.name, page: started.redirectUrl, ...(started.pendingId && { pendingId: started.pendingId }), accounts: started.accounts };
    },
    /** Removes one account of an app from the person's Composio account. */
    "apps.remove": async ([ref, accountId]) => {
      const kit = await app(ref);
      if (typeof accountId !== "string" || !accountId.trim()) throw new ControlError("Give the account's id (`botkins apps accounts " + kit.slug + "` lists them).", "BAD_ARGUMENT");
      await handlers["composio.removeAccount"](kit.slug, accountId.trim());
      return { slug: kit.slug, name: kit.name, removed: accountId.trim() };
    },
  };
}
