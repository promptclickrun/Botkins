import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, Bot, Check, CheckCircle2, ChevronRight, LayoutGrid, Loader2, Search, ShieldAlert } from "lucide-react";
import { SearchField } from "glisse";
import { useAsk } from "./Pages";
import { Group, errorText } from "./SettingsRows";
import type { ComposioAccount, ComposioCatalog, ComposioToolkit, McpServer, State } from "./types";
import MacTools from "./MacTools";
import { CatalogBrowser, CatalogEntryPage, reloadMcpCatalog, useMcpCatalog } from "./McpCatalog";
import "./plugins.css";
import "./marketapps.css";

// Marketplace › Apps: the direct apps catalog first (McpCatalog.tsx), then "More apps through
// Composio": the apps of the person's own Composio account, as the phone shows them
// (mobile/src/features/market). The computer does the work (desktop/composio.mjs) through its own
// Composio tool and that tool's sign-in, so signing in here also gives the bots the apps.

const api = window.botkins;
/** Named by the computer's app when it can read and connect Composio apps. */
export const COMPOSIO_APPS = "composio-apps-v1";
const MCP_URL = "https://connect.composio.dev/mcp";
const LOGOS = "https://logos.composio.dev/";
const RESULTS = 60;
/** How many apps one status load asks about, and how long an app's accounts stay fresh. */
const STATUS_CAP = 50;
const STATUS_FRESH = 60_000;

// ── The Composio tool on the computer ───────────────────────────────────────────────────────

const sameUrl = (url: string | undefined) => !!url && url.replace(/\/+$/, "").toLowerCase() === MCP_URL;
const findServer = (servers: McpServer[] | undefined) => servers?.find((server) => server.type !== "stdio" && sameUrl(server.url));
type Access = "unknown" | "signedOut" | "signingIn" | "off" | "ready";
/** Where the Composio sign-in stands, from the computer's tools. */
function accessOf(servers: McpServer[] | undefined): Access {
  if (!servers) return "unknown";
  const server = findServer(servers);
  if (!server) return "signedOut";
  const auth = server.auth;
  if (auth?.type === "oauth" && auth.signingIn) return "signingIn";
  if (auth?.type !== "oauth" || !auth.signedIn || auth.needsSignIn) return "signedOut";
  return server.enabled ? "ready" : "off";
}

// ── What the view knows, kept while the tab is closed (as the phone's store) ────────────────

type Store = {
  catalog: ComposioCatalog | null;
  catalogStatus: "loading" | "ready" | "error";
  /** Apps with an active account, by slug. */
  connected: Record<string, true>;
  connectedLoaded: boolean;
  accounts: Record<string, ComposioAccount[] | undefined>;
  statusFailed: Record<string, true | undefined>;
  connecting: Record<string, true | undefined>;
  removing: Record<string, true | undefined>;
  /** The last sentence about an app (a failure, or "Gmail connected"). */
  notes: Record<string, { text: string; bad?: boolean } | undefined>;
  /** A failure of the sign-in or of the bots' switch. */
  error: string;
  busy: boolean;
};
const EMPTY = { connected: {}, connectedLoaded: false, accounts: {}, statusFailed: {}, connecting: {}, removing: {}, notes: {} } satisfies Partial<Store>;
let store: Store = { catalog: null, catalogStatus: "loading", ...EMPTY, error: "", busy: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<Store> | ((now: Store) => Partial<Store>)) => {
  store = { ...store, ...(typeof patch === "function" ? patch(store) : patch) };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const useStore = () => useSyncExternalStore(subscribe, () => store);

const isActive = (account: ComposioAccount) => account.status === "active";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let scraped = new Set<string>();
const loadedAt = new Map<string, number>();
const loading = new Set<string>();
let catalogLoad: Promise<void> | null = null;
/** The sign-in the accounts belong to: a change of computer or of sign-in starts them over. */
let owner = "";
/** A connect under way. `wake` ends the current wait (a cancel, or the window coming back to the front). */
type Attempt = { cancelled: boolean; wake: () => void };
const attempts = new Map<string, Attempt>();
const nameOf = (slug: string) => store.catalog?.toolkits.find((kit) => kit.slug === slug)?.name ?? slug;
const note = (slug: string, text: string, bad = false) => set((now) => ({ notes: { ...now.notes, [slug]: { text, bad } } }));

function connectedFrom(accounts: Store["accounts"]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const slug of scraped) if (!accounts[slug]) out[slug] = true;
  for (const [slug, list] of Object.entries(accounts)) if (list?.some(isActive)) out[slug] = true;
  return out;
}
function setAccounts(found: Record<string, ComposioAccount[]>) {
  const now = Date.now();
  for (const slug of Object.keys(found)) loadedAt.set(slug, now);
  set((state) => {
    const accounts = { ...state.accounts, ...found };
    const statusFailed = { ...state.statusFailed };
    for (const slug of Object.keys(found)) delete statusFailed[slug];
    return { accounts, statusFailed, connected: connectedFrom(accounts) };
  });
}
function flag(key: "connecting" | "removing", id: string, on: boolean) {
  set((state) => {
    const next = { ...state[key] };
    if (on) next[id] = true;
    else delete next[id];
    return { [key]: next };
  });
}
function clearAccounts() {
  scraped = new Set();
  loadedAt.clear();
  for (const attempt of attempts.values()) {
    attempt.cancelled = true;
    attempt.wake();
  }
  set({ ...EMPTY });
}

function loadCatalog() {
  catalogLoad ??= (async () => {
    if (!store.catalog) set({ catalogStatus: "loading" });
    try {
      set({ catalog: await api["composio.catalog"](), catalogStatus: "ready" });
    } catch {
      if (!store.catalog) set({ catalogStatus: "error" });
    }
  })().finally(() => {
    catalogLoad = null;
  });
  return catalogLoad;
}

async function loadStatus(slugs: string[], force = false) {
  if (!owner) return;
  const now = Date.now();
  const kits = store.catalog?.toolkits;
  const want = [...new Set(slugs)].filter((slug) => !kits?.find((kit) => kit.slug === slug)?.noAuth && !loading.has(slug) && (force || now - (loadedAt.get(slug) ?? 0) > STATUS_FRESH)).slice(0, STATUS_CAP);
  if (!want.length) return;
  for (const slug of want) loading.add(slug);
  const was = owner;
  try {
    const found = await api["composio.accounts"](want);
    if (owner === was) setAccounts(found);
  } catch {
    set((state) => {
      const statusFailed = { ...state.statusFailed };
      for (const slug of want) if (!state.accounts[slug]) statusFailed[slug] = true;
      return { statusFailed };
    });
  } finally {
    for (const slug of want) loading.delete(slug);
  }
}

async function refreshConnected() {
  if (!owner) return;
  const was = owner;
  try {
    const list = await api["composio.connected"]();
    if (owner !== was) return;
    scraped = new Set(list ?? []);
    set((state) => ({ connected: connectedFrom(state.accounts), connectedLoaded: true, error: "" }));
    // The apps known to be connected get their accounts read, so a change made elsewhere shows.
    const known = new Set([...(list ?? []), ...Object.keys(store.connected)]);
    if (known.size) await loadStatus([...known], true);
  } catch (error) {
    if (owner === was) set({ connectedLoaded: true, error: "Couldn't read your Composio apps. " + errorText(error) });
  }
}

/**
 * The Marketplace's refresh button: the app list asked for again now (the server answers with only
 * what changed), then the person's apps. Throws when the list couldn't be read; the one shown stays.
 */
export async function refreshApps() {
  reloadMcpCatalog();
  if (typeof api["composio.catalog"] !== "function") return;
  const catalog = await api["composio.catalog"]({ fresh: true });
  set({ catalog, catalogStatus: "ready" });
  await refreshConnected();
}

/** Connects an app's account on Composio's page, in the browser. Resolves true when a new account is active. */
async function connect(slug: string): Promise<boolean> {
  if (!owner || store.connecting[slug]) return false;
  const name = nameOf(slug);
  const attempt: Attempt = { cancelled: false, wake: () => {} };
  attempts.set(slug, attempt);
  flag("connecting", slug, true);
  set((state) => ({ notes: { ...state.notes, [slug]: undefined } }));
  // Coming back to the window from the browser looks again at once.
  const onFocus = () => attempt.wake();
  window.addEventListener("focus", onFocus);
  try {
    const before = (await api["composio.accounts"]([slug]))[slug] ?? [];
    setAccounts({ [slug]: before });
    const known = new Set(before.filter(isActive).map((account) => account.id));
    const isNew = (list: ComposioAccount[]) => list.some((account) => isActive(account) && !known.has(account.id));

    const started = await api["composio.connect"](slug);
    if (!started.redirectUrl) {
      if (!isNew(started.accounts)) throw new Error("Composio couldn't start connecting " + name + ".");
      setAccounts({ [slug]: started.accounts });
      note(slug, name + " connected");
      return true;
    }
    await api.openLink(started.redirectUrl);
    const startedAt = Date.now();
    let found = false;
    // Every 3 s for two minutes, then every 10 s for eight more, until a new active account shows.
    while (!attempt.cancelled) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 10 * 60_000) break;
      let next = () => {};
      const again = new Promise<void>((resolve) => (next = resolve));
      attempt.wake = () => next();
      await Promise.race([sleep(elapsed < 120_000 ? 3000 : 10_000), again]);
      if (attempt.cancelled) break;
      let list: ComposioAccount[] | undefined;
      try {
        list = (await api["composio.accounts"]([slug]))[slug];
      } catch {
        // A look that failed is tried again at the next beat.
      }
      if (list && isNew(list)) {
        setAccounts({ [slug]: list });
        found = true;
        break;
      }
    }
    if (found) {
      note(slug, name + " connected");
      return true;
    }
    // Abandoned: the pending account is removed so tries don't pile up.
    if (started.pendingId && owner) await api["composio.removeAccount"](slug, started.pendingId).catch(() => {});
    return false;
  } catch (error) {
    note(slug, errorText(error) || "Couldn't connect " + name + ". Try again.", true);
    return false;
  } finally {
    window.removeEventListener("focus", onFocus);
    attempts.delete(slug);
    flag("connecting", slug, false);
    if (owner) void loadStatus([slug], true);
  }
}

function cancelConnect(slug: string) {
  const attempt = attempts.get(slug);
  if (!attempt) return;
  attempt.cancelled = true;
  attempt.wake();
}

async function removeAccount(slug: string, accountId: string) {
  if (store.removing[accountId]) return;
  flag("removing", accountId, true);
  try {
    await api["composio.removeAccount"](slug, accountId);
    const left = (store.accounts[slug] ?? []).filter((account) => account.id !== accountId);
    scraped.delete(slug);
    setAccounts({ [slug]: left });
  } catch (error) {
    note(slug, errorText(error) || "Couldn't remove that account. Try again.", true);
  } finally {
    flag("removing", accountId, false);
    void loadStatus([slug], true);
  }
}

/** Sign in with Composio: the computer's Composio tool, added when it isn't there, signed in through the browser. */
async function signIn(servers: McpServer[] | undefined): Promise<boolean> {
  if (store.busy) return false;
  set({ busy: true, error: "" });
  try {
    const server = findServer(servers);
    const id = server?.id ?? (await api.saveMcpServer({ name: "composio", type: "http", url: MCP_URL, oauth: {} }));
    await api.signInMcpServer(id);
    return true;
  } catch (error) {
    const text = errorText(error);
    if (!/cancel/i.test(text)) set({ error: text || "Couldn't sign in to Composio. Try again." });
    return false;
  } finally {
    set({ busy: false });
  }
}

/** The apps an app name or description matches: name matches first, each in usage order. */
function searchApps(toolkits: ComposioToolkit[], query: string, limit = Infinity) {
  const q = query.trim().toLowerCase();
  if (!q) return toolkits.slice(0, limit);
  const starts: ComposioToolkit[] = [];
  const names: ComposioToolkit[] = [];
  const texts: ComposioToolkit[] = [];
  for (const kit of toolkits) {
    const at = (kit.name + " " + kit.slug).toLowerCase().indexOf(q);
    if (at === 0) starts.push(kit);
    else if (at > 0) names.push(kit);
    else if (kit.description.toLowerCase().includes(q)) texts.push(kit);
    if (starts.length >= limit) break;
  }
  return [...starts, ...names, ...texts].slice(0, limit);
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────

/** An app's logo, or its first letter on a tile when there is none or it doesn't load. */
export function AppLogo({ app, size = 40 }: { app: Pick<ComposioToolkit, "name" | "logo">; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.24) };
  // The window's policy lets pictures in from Composio's logo address only (index.html); any other is a letter.
  if (!app.logo || !app.logo.startsWith(LOGOS) || broken)
    return (
      <span className="app-logo app-logo-letter" style={{ ...style, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
        {(app.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase()}
      </span>
    );
  return (
    <span className="app-logo" style={style} aria-hidden="true">
      <img src={app.logo} alt="" loading={size >= 48 ? "eager" : "lazy"} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </span>
  );
}
const Tick = () => (
  <span className="app-check" aria-hidden="true">
    <Check size={11} strokeWidth={3.4} />
  </span>
);

function AppTile({ app, connected, open }: { app: ComposioToolkit; connected: boolean; open: (slug: string) => void }) {
  return (
    <button type="button" className="app-tile" onClick={() => open(app.slug)} aria-label={app.name + (connected ? ", connected" : "")} title={app.description || app.name}>
      <span className="app-tile-logo">
        <AppLogo app={app} size={48} />
        {connected && <Tick />}
      </span>
      <span className="app-tile-name">{app.name}</span>
    </button>
  );
}

function AppRow({ app, connected, open }: { app: ComposioToolkit; connected: boolean; open: (slug: string) => void }) {
  return (
    <button type="button" className="plugin-listing app-row" onClick={() => open(app.slug)} aria-label={app.name + (connected ? ", connected" : "") + (app.description ? ", " + app.description : "")}>
      <AppLogo app={app} size={36} />
      <span className="plugin-listing-copy">
        <strong>{app.name}</strong>
        {!!app.description && <small>{app.description}</small>}
      </span>
      {connected && <Tick />}
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}

function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <Group>
      <div className="int-empty">
        <span className="int-empty-icon" aria-hidden="true">{icon}</span>
        <strong>{title}</strong>
        {text && <p>{text}</p>}
        {action}
      </div>
    </Group>
  );
}

function SearchBox({ value, onChange, label = "Search apps" }: { value: string; onChange: (text: string) => void; label?: string }) {
  return (
    <div className="set-toolbar int-toolbar plugin-toolbar">
      <SearchField aria-label={label} placeholder={label} value={value} onValueChange={onChange} />
    </div>
  );
}

function TileSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="app-grid" aria-label="Loading apps">
      {Array.from({ length: rows * 4 }, (_, index) => (
        <span key={index} className="app-tile app-tile-ghost" aria-hidden="true">
          <span className="app-logo" style={{ width: 48, height: 48, borderRadius: 12 }} />
          <span className="app-ghost-line" />
        </span>
      ))}
    </div>
  );
}

const CatalogFailed = () => <Empty icon={<LayoutGrid size={20} />} title="The app list didn't load" action={<button type="button" className="set-button" onClick={() => void loadCatalog()}>Try again</button>} />;

// ── The view ────────────────────────────────────────────────────────────────────────────────

type Place =
  | { kind: "home" }
  | { kind: "entry"; id: string }
  | { kind: "composio" }
  | { kind: "category"; id: string }
  | { kind: "app"; slug: string; from: Exclude<Place, { kind: "app" }> };

/**
 * Marketplace › Apps: on a Mac, Mail and Messages first; then the direct apps catalog
 * (McpCatalog.tsx), which needs no sign-in to browse; then one way to the long tail through Composio,
 * the person's own Composio apps as the phone shows them.
 */
export default function MarketApps({ state }: { state: State }) {
  const using = state.remote?.using;
  const composio = (!using || using.capabilities.includes(COMPOSIO_APPS)) && typeof api["composio.catalog"] === "function";
  const member = !!using?.member;
  const direct = useMcpCatalog(state);
  const [place, setPlace] = useState<Place>({ kind: "home" });

  if (!composio && !direct.supported) return <Empty icon={<ShieldAlert size={20} />} title="Apps need an update" text="Update the app on your computer to use apps here." />;
  if (place.kind === "entry") return <CatalogEntryPage state={state} catalog={direct.catalog} id={place.id} back={() => setPlace({ kind: "home" })} reload={direct.reload} />;
  if (place.kind !== "home")
    return member ? (
      <div className="plugin-detail">
        <button type="button" className="set-link plugin-back" onClick={() => setPlace({ kind: "home" })}>
          <ArrowLeft size={14} /> Back to apps
        </button>
        <Empty icon={<ShieldAlert size={20} />} title="Apps are the owner's" text="Only the person who runs this computer connects its apps." />
      </div>
    ) : (
      <ComposioApps state={state} place={place} setPlace={setPlace} />
    );

  const more = composio && (
    <Group>
      <button type="button" className="plugin-listing app-more" onClick={() => setPlace({ kind: "composio" })}>
        <span className="plugin-listing-icon" aria-hidden="true">
          <LayoutGrid size={18} />
        </span>
        <span className="plugin-listing-copy">
          <strong>More apps through Composio</strong>
          <small>Gmail, Google Workspace, Slack and more</small>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </Group>
  );
  return (
    <div className="market-apps">
      <MacTools state={state} />
      {direct.supported ? <CatalogBrowser catalog={direct.catalog} error={direct.error} retry={direct.reload} open={(id) => setPlace({ kind: "entry", id })} after={more} /> : more}
    </div>
  );
}

type ComposioPlace = Exclude<Place, { kind: "home" } | { kind: "entry" }>;

/** More apps through Composio: the person's Composio apps, behind its sign-in. */
function ComposioApps({ state, place, setPlace }: { state: State; place: ComposioPlace; setPlace: (next: Place | ((now: Place) => Place)) => void }) {
  const using = state.remote?.using;
  const access = accessOf(state.mcpServers);
  const server = findServer(state.mcpServers);
  const signedIn = access === "ready" || access === "off";
  const s = useStore();
  const [query, setQuery] = useState("");
  const dialogs = useAsk();

  useEffect(() => {
    void loadCatalog();
  }, [using?.id]);

  // The accounts belong to one sign-in on one computer: another one starts them over.
  const key = signedIn && server ? (using?.id ?? "here") + " " + server.id : "";
  useEffect(() => {
    if (key === owner) return;
    owner = key;
    clearAccounts();
    if (key) void refreshConnected();
  }, [key]);

  const searching = query.trim().length > 0;
  const results = useMemo(() => (s.catalog && searching ? searchApps(s.catalog.toolkits, query, RESULTS) : []), [s.catalog, query, searching]);
  const popular = useMemo(() => s.catalog?.toolkits.slice(0, 12) ?? [], [s.catalog]);

  // The accounts of the apps on screen, a moment after the list settles.
  const onScreen = place.kind === "composio" ? (searching ? results : popular).map((kit) => kit.slug).join(",") : "";
  useEffect(() => {
    if (!key || !onScreen) return;
    const timer = window.setTimeout(() => void loadStatus(onScreen.split(",")), 450);
    return () => window.clearTimeout(timer);
  }, [onScreen, key]);

  const open = (slug: string) => setPlace((now) => ({ kind: "app", slug, from: now.kind === "app" ? now.from : now.kind === "home" || now.kind === "entry" ? { kind: "composio" } : now }));
  const back = () => setPlace((now) => (now.kind === "app" ? now.from : now.kind === "category" ? { kind: "composio" } : { kind: "home" }));
  const doSignIn = () => void signIn(state.mcpServers);

  if (place.kind === "app") return <AppPage slug={place.slug} s={s} access={access} back={back} signIn={() => signIn(state.mcpServers)} ask={dialogs} />;
  if (place.kind === "category") return <CategoryPage id={place.id} s={s} back={back} open={open} />;

  const failed = !s.catalog && s.catalogStatus === "error";
  return (
    <div className="plugin-detail market-apps">
      <button type="button" className="set-link plugin-back" onClick={() => setPlace({ kind: "home" })}>
        <ArrowLeft size={14} /> Back to apps
      </button>
      <SearchBox value={query} onChange={setQuery} label="Search Composio apps" />
      {searching ? (
        !s.catalog ? (
          failed ? <CatalogFailed /> : <p className="set-status">Loading apps…</p>
        ) : results.length === 0 ? (
          <p className="set-status app-none">No apps match</p>
        ) : (
          <Group>
            {results.map((kit) => (
              <AppRow key={kit.slug} app={kit} connected={!!s.connected[kit.slug]} open={open} />
            ))}
          </Group>
        )
      ) : (
        <>
          {(access === "signedOut" || access === "signingIn") && <Hero apps={s.catalog?.toolkits.filter((kit) => !kit.noAuth).slice(0, 5) ?? []} waiting={access === "signingIn" || s.busy} signIn={doSignIn} cancel={() => server && void api.cancelMcpSignIn(server.id).catch(() => {})} />}
          {s.error && <p className="set-status error-text" role="alert">{s.error}</p>}
          {signedIn && server && <BotsCard on={access === "ready"} turnOn={() => void api.setMcpServerEnabled(server.id, true).catch((error) => set({ error: errorText(error) }))} />}
          {signedIn && <YourApps s={s} open={open} />}

          {failed ? (
            <CatalogFailed />
          ) : (
            <>
              <section className="set-group">
                <div className="int-grouphead">
                  <h3 className="app-head">Popular</h3>
                  {s.catalog && (
                    <button type="button" className="set-link" onClick={() => setPlace({ kind: "category", id: "all" })} aria-label="See all apps">
                      See all
                    </button>
                  )}
                </div>
                {!s.catalog ? (
                  <TileSkeleton />
                ) : (
                  <div className="app-grid">
                    {popular.map((kit) => (
                      <AppTile key={kit.slug} app={kit} connected={!!s.connected[kit.slug]} open={open} />
                    ))}
                  </div>
                )}
              </section>
              {s.catalog && (
                <Group title="Categories">
                  {s.catalog.categories.slice(0, 14).map((category) => (
                    <button type="button" key={category.id} className="set-row app-category" onClick={() => setPlace({ kind: "category", id: category.id })}>
                      <span className="set-name">{category.name}</span>
                      <span className="app-category-count">{category.count}</span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                </Group>
              )}
            </>
          )}

          {signedIn && server && (
            <div className="app-signed-in">
              <small>Signed in to Composio</small>
              <button
                type="button"
                className="set-button"
                onClick={async () => {
                  const ok = await dialogs.ask({ title: "Sign out of Composio?", body: "Your bots stop using these apps until you sign in again. Your apps stay connected in Composio.", confirm: "Sign out", danger: true });
                  if (ok) await api.signOutMcpServer(server.id).catch((error) => set({ error: errorText(error) }));
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </>
      )}
      {dialogs.node}
    </div>
  );
}

/** Signed out: a few of the most used apps, fanned out, and the way in. */
function Hero({ apps, waiting, signIn, cancel }: { apps: ComposioToolkit[]; waiting: boolean; signIn: () => void; cancel: () => void }) {
  return (
    <section className="set-group">
      <div className="set-card app-hero">
        <div className="app-fan" aria-hidden="true">
          {apps.length === 0 && <LayoutGrid size={40} />}
          {apps.map((app, index) => (
            <span key={app.slug} className={"app-fan-item app-fan-" + index}>
              <AppLogo app={app} size={index === 2 ? 58 : 48} />
            </span>
          ))}
        </div>
        <strong className="app-hero-title">Connect your apps</strong>
        <p>Sign in with your own Composio account.</p>
        {waiting ? (
          <div className="app-hero-wait" role="status">
            <span>
              <Loader2 size={14} className="spin" aria-hidden="true" /> Finish signing in in your browser…
            </span>
            <button type="button" className="set-link" onClick={cancel}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="set-button primary app-hero-button" onClick={signIn}>
            Sign in with Composio
          </button>
        )}
        <small>{"You sign in on Composio's own page."}</small>
      </div>
    </section>
  );
}

/** Whether the bots can use these apps: the Composio tool is on, or off with the switch to turn it on. */
function BotsCard({ on, turnOn }: { on: boolean; turnOn: () => void }) {
  if (on)
    return (
      <div className="app-bots ready" role="status">
        <CheckCircle2 size={20} aria-hidden="true" />
        <span>
          <strong>Your bots can use these apps</strong>
          <small>Works in new chats</small>
        </span>
      </div>
    );
  return (
    <div className="app-bots">
      <span className="plugin-listing-icon" aria-hidden="true">
        <Bot size={16} />
      </span>
      <span>
        <strong>Your bots</strong>
        <small>Turned off</small>
      </span>
      <button type="button" className="set-button primary" onClick={turnOn} aria-label="Turn on for my bots">
        Turn on
      </button>
    </div>
  );
}

/** The apps with an active account, as a shelf. */
function YourApps({ s, open }: { s: Store; open: (slug: string) => void }) {
  const apps = useMemo(() => (s.catalog ? s.catalog.toolkits.filter((kit) => s.connected[kit.slug]) : []), [s.catalog, s.connected]);
  return (
    <section className="set-group">
      <h3>Your apps</h3>
      {!s.connectedLoaded || !s.catalog ? (
        <TileSkeleton rows={1} />
      ) : apps.length === 0 ? (
        <p className="set-status">Nothing connected yet</p>
      ) : (
        <div className="app-shelf">
          {apps.map((kit) => (
            <AppTile key={kit.slug} app={kit} connected open={open} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Every app in a category (or every app, for "all"), most used first. */
function CategoryPage({ id, s, back, open }: { id: string; s: Store; back: () => void; open: (slug: string) => void }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(80);
  const all = id === "all";
  const category = s.catalog?.categories.find((entry) => entry.id === id);
  const title = all ? "All apps" : (category?.name ?? "Apps");
  const base = useMemo(() => (!s.catalog ? [] : all ? s.catalog.toolkits : s.catalog.toolkits.filter((kit) => kit.categories.includes(id))), [s.catalog, all, id]);
  const items = useMemo(() => searchApps(base, query), [base, query]);
  const visible = items.slice(0, shown);
  const slugs = visible.map((kit) => kit.slug).join(",");
  useEffect(() => {
    if (!owner || !slugs) return;
    const timer = window.setTimeout(() => void loadStatus(slugs.split(",").slice(-STATUS_CAP)), 500);
    return () => window.clearTimeout(timer);
  }, [slugs]);
  return (
    <div className="plugin-detail market-apps">
      <button type="button" className="set-link plugin-back" onClick={back}>
        <ArrowLeft size={14} /> Back to apps
      </button>
      <div className="plugin-detail-head">
        <div>
          <h3>{title}</h3>
          {s.catalog && <small>{items.length === 1 ? "1 app" : items.length + " apps"}</small>}
        </div>
      </div>
      <SearchBox value={query} onChange={(text) => { setQuery(text); setShown(80); }} label={all ? "Search all apps" : "Search " + title} />
      {!s.catalog ? (
        s.catalogStatus === "error" ? <CatalogFailed /> : <p className="set-status">Loading apps…</p>
      ) : items.length === 0 ? (
        <p className="set-status app-none">{query.trim() ? "No apps match" : "No apps here yet"}</p>
      ) : (
        <Group actions={items.length > shown ? <button type="button" className="set-button" onClick={() => setShown((n) => n + 120)}>More apps</button> : undefined}>
          {visible.map((kit) => (
            <AppRow key={kit.slug} app={kit} connected={!!s.connected[kit.slug]} open={open} />
          ))}
        </Group>
      )}
    </div>
  );
}

function AccountRow({ slug, app, account, removing, ask }: { slug: string; app: string; account: ComposioAccount; removing: boolean; ask: ReturnType<typeof useAsk> }) {
  const active = isActive(account);
  const confirm = async () => {
    const ok = await ask.ask({ title: "Remove this " + app + " account?", body: "Your bots stop using it. You can connect it again.", confirm: "Remove", danger: true });
    if (ok) void removeAccount(slug, account.id);
  };
  return (
    <div className="set-row int-item app-account">
      <span className={"app-account-icon " + (active ? "good" : "warn")} aria-hidden="true">
        {active ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      </span>
      <div className="set-label">
        <span className="set-name">{account.label ?? (active ? "Connected" : "Needs sign-in")}</span>
        {account.label && !active && <small>Needs sign-in</small>}
      </div>
      <div className="set-control">
        {removing ? (
          <Loader2 size={16} className="spin" aria-label="Removing" />
        ) : (
          <button type="button" className="set-button danger" onClick={() => void confirm()} aria-label={"Remove " + (account.label ?? app + " account")}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/** One app: what it is, its accounts, and Connect. */
function AppPage({ slug, s, access, back, signIn, ask }: { slug: string; s: Store; access: Access; back: () => void; signIn: () => Promise<boolean>; ask: ReturnType<typeof useAsk> }) {
  const app = s.catalog?.toolkits.find((kit) => kit.slug === slug);
  const signedIn = access === "ready" || access === "off";
  const accounts = s.accounts[slug];
  const statusFailed = !!s.statusFailed[slug];
  const connecting = !!s.connecting[slug];
  const told = s.notes[slug];
  useEffect(() => {
    if (signedIn) void loadStatus([slug], true);
  }, [signedIn, slug]);

  const backLink = (
    <button type="button" className="set-link plugin-back" onClick={back}>
      <ArrowLeft size={14} /> Back to apps
    </button>
  );
  if (!app)
    return (
      <div className="plugin-detail">
        {backLink}
        {!s.catalog && s.catalogStatus !== "error" ? <p className="set-status">Loading apps…</p> : <Empty icon={<Search size={20} />} title="This app isn't in the list" />}
      </div>
    );

  const categories = app.categories.map((id) => s.catalog?.categories.find((category) => category.id === id)?.name).filter(Boolean) as string[];
  const shown = (accounts ?? []).filter((account) => account.status === "active" || account.status === "failed");
  const hasActive = shown.some(isActive);
  const signInThenConnect = async () => {
    // The sign-in is the computer's own; its accounts are read once the tool says it is signed in.
    if (await signIn()) void connect(app.slug);
  };

  let body: ReactNode;
  if (app.noAuth) {
    body = (
      <div className="app-bots ready" role="status">
        <CheckCircle2 size={20} aria-hidden="true" />
        <span>
          <strong>Ready. No sign-in needed.</strong>
        </span>
      </div>
    );
  } else if (access === "unknown") {
    body = <p className="set-status">Loading…</p>;
  } else if (!signedIn) {
    body = (
      <div className="plugin-detail-actions">
        <button type="button" className="set-button primary" disabled={s.busy || access === "signingIn"} onClick={() => void signInThenConnect()}>
          {s.busy || access === "signingIn" ? "Finish signing in in your browser…" : "Sign in to connect"}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {accounts === undefined ? (
          statusFailed ? (
            <Group>
              <div className="set-row">
                <span className="set-name">Couldn't load your accounts</span>
                <button type="button" className="set-button" onClick={() => void loadStatus([app.slug], true)}>
                  Try again
                </button>
              </div>
            </Group>
          ) : (
            <p className="set-status">
              <Loader2 size={14} className="spin" aria-hidden="true" /> Reading your accounts…
            </p>
          )
        ) : (
          shown.length > 0 && (
            <Group title="Accounts">
              {shown.map((account) => (
                <AccountRow key={account.id} slug={app.slug} app={app.name} account={account} removing={!!s.removing[account.id]} ask={ask} />
              ))}
            </Group>
          )
        )}
        {connecting ? (
          <div className="app-waiting" role="status" aria-live="polite">
            <span>
              <Loader2 size={15} className="spin" aria-hidden="true" /> {"Waiting for " + app.name + "…"}
            </span>
            <button type="button" className="set-button" onClick={() => cancelConnect(app.slug)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="plugin-detail-actions">
            <button type="button" className="set-button primary" disabled={accounts === undefined && !statusFailed} onClick={() => void connect(app.slug)}>
              {hasActive ? "Add another account" : "Connect"}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="plugin-detail market-apps">
      {backLink}
      <div className="app-detail-head">
        <AppLogo app={app} size={56} />
        <div>
          <h3>{app.name}</h3>
          {categories.length > 0 && <small>{categories.join(" · ")}</small>}
        </div>
      </div>
      {!!app.description && <p className="app-description">{app.description}</p>}
      {told && (
        <p className={"set-status" + (told.bad ? " error-text" : " app-told")} role={told.bad ? "alert" : "status"}>
          {told.text}
        </p>
      )}
      {s.error && !signedIn && <p className="set-status error-text" role="alert">{s.error}</p>}
      {body}
      {!app.noAuth && <p className="set-foot app-foot">{"You sign in to " + app.name + " on its own page, through Composio."}</p>}
      {ask.node}
    </div>
  );
}
