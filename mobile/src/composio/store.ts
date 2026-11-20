// What the Marketplace knows: the Composio sign-in, the app catalog, which apps are connected and
// their accounts. Screens read it with useComposio and call its actions; no network code lives in them.
import * as WebBrowser from "expo-web-browser";
import { create } from "zustand";
import type { McpServer } from "@/link/types";
import { api } from "@/state/link";
import { showToast, useApp } from "@/state/store";
import { signIn as authSignIn, signOut as authSignOut, grantForComputer, loadSession, MCP_URL, onSignInEnded, REDIRECT_URI, SignInEnded } from "./auth";
import { type Catalog, cachedCatalog, revalidateCatalog } from "./catalog";
import { type Account, addAccount, connectedFromTools, listAccounts, removeAccount as removeOne } from "./connections";
import { resetMcp } from "./mcp";

export type { Account } from "./connections";
export type { Catalog, Category, Toolkit } from "./catalog";

/** How many apps one status load asks about. */
const STATUS_CAP = 50;
/** An app's accounts are asked for again after this long. */
const STATUS_FRESH = 60_000;

export type ComposioState = {
  /** The saved sign-in has been read. */
  authReady: boolean;
  account: { email?: string } | null;
  signingIn: boolean;
  catalog: Catalog | null;
  catalogStatus: "loading" | "ready" | "error";
  /** Apps with an active account, by slug. */
  connected: Record<string, true>;
  /** The connected list was read at least once since signing in. */
  connectedLoaded: boolean;
  /** Each app's accounts, once asked for. */
  accounts: Record<string, Account[] | undefined>;
  /** Apps whose accounts couldn't be read the last time. */
  statusFailed: Record<string, true | undefined>;
  /** An app being connected. */
  connecting: Record<string, true | undefined>;
  /** Accounts being removed, by account id. */
  removing: Record<string, true | undefined>;
  /** Turning the apps on for the bots on the computer. */
  botsBusy: boolean;

  boot(): void;
  loadCatalog(force?: boolean): Promise<void>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  refreshConnected(): Promise<void>;
  loadStatus(slugs: string[], force?: boolean): Promise<void>;
  /** Connects an app's account through Composio's page. Resolves true when a new account is active. */
  connect(slug: string): Promise<boolean>;
  cancelConnect(slug: string): void;
  removeAccount(slug: string, accountId: string): Promise<void>;
  enableForBots(): Promise<void>;
};

const isActive = (account: Account) => account.status === "active";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What the store derives from: apps named by the search tool, and when each app's accounts were read.
let scraped = new Set<string>();
const loadedAt = new Map<string, number>();
const loading = new Set<string>();
let sessionBoot: Promise<void> | null = null;
let catalogLoad: Promise<void> | null = null;
type Attempt = { cancelled: boolean; wake: () => void; woken: Promise<void> };
const attempts = new Map<string, Attempt>();

function connectedFrom(accounts: Record<string, Account[] | undefined>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const slug of scraped) if (!accounts[slug]) out[slug] = true;
  for (const [slug, list] of Object.entries(accounts)) if (list?.some(isActive)) out[slug] = true;
  return out;
}

function setAccounts(found: Record<string, Account[]>) {
  const now = Date.now();
  for (const slug of Object.keys(found)) loadedAt.set(slug, now);
  useComposio.setState((state) => {
    const accounts = { ...state.accounts, ...found };
    const statusFailed = { ...state.statusFailed };
    for (const slug of Object.keys(found)) delete statusFailed[slug];
    return { accounts, statusFailed, connected: connectedFrom(accounts) };
  });
}

function patch<K extends "connecting" | "removing">(key: K, id: string, on: boolean) {
  useComposio.setState((state) => {
    const next: Record<string, true | undefined> = { ...state[key] };
    if (on) next[id] = true;
    else delete next[id];
    return { [key]: next } as Pick<ComposioState, K>;
  });
}

/** A failure as one short sentence. A sign-in that ended was already said. */
function complain(error: unknown, fallback = "That didn't work. Try again.") {
  if (error instanceof SignInEnded) return;
  const text = error instanceof Error && error.message && error.message.length < 120 && !/network|fetch|json/i.test(error.message) ? error.message : fallback;
  showToast(text, "error");
}

function clearLocal() {
  resetMcp();
  scraped = new Set();
  loadedAt.clear();
  for (const attempt of attempts.values()) {
    attempt.cancelled = true;
    attempt.wake();
  }
  useComposio.setState({ account: null, connected: {}, connectedLoaded: false, accounts: {}, statusFailed: {}, connecting: {}, removing: {} });
}

onSignInEnded(() => {
  clearLocal();
  showToast("Your Composio sign-in ended.", "error");
});

function dismissBrowser() {
  try {
    WebBrowser.dismissAuthSession();
  } catch {
    // Not every platform can close it; the person closes it.
  }
}

const nameOf = (slug: string) => useComposio.getState().catalog?.bySlug.get(slug)?.name ?? slug;

export const useComposio = create<ComposioState>((set, get) => ({
  authReady: false,
  account: null,
  signingIn: false,
  catalog: null,
  catalogStatus: "loading",
  connected: {},
  connectedLoaded: false,
  accounts: {},
  statusFailed: {},
  connecting: {},
  removing: {},
  botsBusy: false,

  boot() {
    sessionBoot ??= loadSession().then((session) => {
      set({ authReady: true, account: session ? { email: session.email } : null });
      if (session) void get().refreshConnected();
    });
    void get().loadCatalog();
  },

  loadCatalog(force = false) {
    catalogLoad ??= (async () => {
      if (!get().catalog) {
        const cached = await cachedCatalog();
        set(cached ? { catalog: cached, catalogStatus: "ready" } : { catalogStatus: "loading" });
      }
      try {
        const fresh = await revalidateCatalog(force);
        if (fresh) set({ catalog: fresh, catalogStatus: "ready" });
      } catch {
        if (!get().catalog) set({ catalogStatus: "error" });
      }
    })().finally(() => {
      catalogLoad = null;
    });
    return catalogLoad;
  },

  async signIn() {
    if (get().signingIn) return false;
    set({ signingIn: true });
    try {
      const session = await authSignIn();
      if (!session) return false;
      clearLocal();
      set({ account: { email: session.email } });
      void get().refreshConnected();
      return true;
    } catch (error) {
      complain(error, "Couldn't sign in to Composio. Try again.");
      return false;
    } finally {
      set({ signingIn: false });
    }
  },

  async signOut() {
    await authSignOut();
    clearLocal();
  },

  async refreshConnected() {
    if (!get().account) return;
    try {
      const list = await connectedFromTools();
      scraped = new Set(list ?? []);
      set((state) => ({ connected: connectedFrom(state.accounts), connectedLoaded: true }));
      // The apps known to be connected get their accounts read, so a change made elsewhere shows.
      const known = new Set([...(list ?? []), ...Object.keys(get().connected)]);
      if (known.size) await get().loadStatus([...known], true);
    } catch (error) {
      if (get().account) set({ connectedLoaded: true });
      if (!(error instanceof SignInEnded)) showToast("Couldn't read your Composio apps.", "error");
    }
  },

  async loadStatus(slugs, force = false) {
    if (!get().account) return;
    const catalog = get().catalog;
    const now = Date.now();
    const want = [...new Set(slugs)]
      .filter((slug) => !catalog?.bySlug.get(slug)?.noAuth && !loading.has(slug) && (force || now - (loadedAt.get(slug) ?? 0) > STATUS_FRESH))
      .slice(0, STATUS_CAP);
    if (want.length === 0) return;
    for (const slug of want) loading.add(slug);
    try {
      setAccounts(await listAccounts(want));
    } catch {
      set((state) => {
        const statusFailed = { ...state.statusFailed };
        for (const slug of want) if (!state.accounts[slug]) statusFailed[slug] = true;
        return { statusFailed };
      });
    } finally {
      for (const slug of want) loading.delete(slug);
    }
  },

  async connect(slug) {
    if (!get().account || get().connecting[slug]) return false;
    const name = nameOf(slug);
    let wake = () => {};
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const attempt: Attempt = { cancelled: false, wake, woken };
    attempts.set(slug, attempt);
    patch("connecting", slug, true);
    try {
      const before = (await listAccounts([slug]))[slug] ?? [];
      setAccounts({ [slug]: before });
      const known = new Set(before.filter(isActive).map((account) => account.id));
      const isNew = (list: Account[]) => list.some((account) => isActive(account) && !known.has(account.id));

      const started = await addAccount(slug);
      if (!started.redirectUrl) {
        if (!isNew(started.accounts)) throw new Error("Composio couldn't start connecting " + name + ".");
        setAccounts({ [slug]: started.accounts });
        showToast(name + " connected", "success");
        return true;
      }

      let closed = false;
      const browser = WebBrowser.openAuthSessionAsync(started.redirectUrl, REDIRECT_URI)
        .catch(() => undefined)
        .then(() => {
          closed = true;
        });
      const startedAt = Date.now();
      let found = false;
      let checksAfterClose = 0;
      // Every 3 s for two minutes, then every 10 s for eight more, until a new active account shows.
      while (!attempt.cancelled) {
        const elapsed = Date.now() - startedAt;
        if (elapsed > 10 * 60_000) break;
        await Promise.race([sleep(closed ? 800 : elapsed < 120_000 ? 3000 : 10_000), closed ? sleep(800) : browser, attempt.woken]);
        if (attempt.cancelled) break;
        const wasClosed = closed;
        let list: Account[] | undefined;
        try {
          list = (await listAccounts([slug]))[slug];
        } catch (error) {
          if (error instanceof SignInEnded) throw error;
        }
        if (list && isNew(list)) {
          setAccounts({ [slug]: list });
          found = true;
          break;
        }
        // After the page closes, look twice more, in case Composio is a moment behind.
        if (wasClosed && ++checksAfterClose >= 2) break;
      }
      if (!closed) dismissBrowser();
      if (found) {
        showToast(name + " connected", "success");
        return true;
      }
      // Abandoned: the pending account is removed so tries don't pile up.
      if (started.pendingId && get().account) await removeOne(slug, started.pendingId).catch(() => {});
      return false;
    } catch (error) {
      complain(error, "Couldn't connect " + name + ". Try again.");
      return false;
    } finally {
      attempts.delete(slug);
      patch("connecting", slug, false);
      if (get().account) void get().loadStatus([slug], true);
    }
  },

  cancelConnect(slug) {
    const attempt = attempts.get(slug);
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.wake();
    dismissBrowser();
  },

  async removeAccount(slug, accountId) {
    if (get().removing[accountId]) return;
    patch("removing", accountId, true);
    try {
      await removeOne(slug, accountId);
      const left = (get().accounts[slug] ?? []).filter((account) => account.id !== accountId);
      scraped.delete(slug);
      setAccounts({ [slug]: left });
    } catch (error) {
      complain(error, "Couldn't remove that account. Try again.");
    } finally {
      patch("removing", accountId, false);
      void get().loadStatus([slug], true);
    }
  },

  async enableForBots() {
    if (get().botsBusy) return;
    set({ botsBusy: true });
    try {
      const parts = useApp.getState().parts;
      const server = findServer(parts.mcp);
      const id = server?.id ?? (await api.saveMcpServer({ name: "composio", type: "http", url: MCP_URL, oauth: {} }));
      if (server && !server.enabled) await api.setMcpServerEnabled(id, true);
      const auth = server?.auth;
      const signedIn = !!server && (auth?.type !== "oauth" || (auth.signedIn && !auth.needsSignIn));
      if (signedIn) {
        showToast("Your bots can use these apps", "success");
        return;
      }
      if (parts.meta?.capabilities.includes("adoptMcpSignIn")) {
        // The computer gets a grant of its own: refresh tokens rotate, so one can't be shared.
        const grant = await grantForComputer();
        if (!grant) return;
        await api["link.adoptMcpSignIn"](id, grant);
        showToast("Your bots can use these apps", "success");
      } else {
        await api.signInMcpServer(id);
        showToast("Finish signing in on your computer");
      }
    } catch (error) {
      complain(error, "Couldn't turn on your apps for your bots.");
    } finally {
      set({ botsBusy: false });
    }
  },
}));

const sameUrl = (url: string | undefined) => !!url && url.replace(/\/+$/, "").toLowerCase() === MCP_URL;
export const findServer = (servers: McpServer[] | undefined) => servers?.find((server) => sameUrl(server.url));

export type BotsAccess = "unknown" | "setup" | "off" | "signin" | "signingIn" | "ready";
/** Whether the bots on the computer can use the Composio apps. "unknown" until the computer's tools arrive. */
export function botsAccess(servers: McpServer[] | undefined): BotsAccess {
  if (!servers) return "unknown";
  const server = findServer(servers);
  if (!server) return "setup";
  if (!server.enabled) return "off";
  const auth = server.auth;
  if (auth?.type === "oauth") {
    if (auth.signingIn) return "signingIn";
    if (!auth.signedIn || auth.needsSignIn) return "signin";
  }
  return "ready";
}
export const useBotsAccess = (): BotsAccess => useApp((state) => botsAccess(state.parts.mcp));

/** Whether an app has an active account (as far as is known). */
export const useIsConnected = (slug: string) => useComposio((state) => !!state.connected[slug]);
