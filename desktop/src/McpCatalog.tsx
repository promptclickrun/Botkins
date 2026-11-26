import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Loader2, Search, SquareTerminal, TriangleAlert } from "lucide-react";
import { Group, Sheet, errorText } from "./SettingsRows";
import { BrandIcon, brandColor } from "./BrandIcon";
import { appBadge, appChips, appsBlocks, connectsLines } from "./marketLogic";
import { teamCan } from "./teamAccess";
import type { McpCatalog, McpCatalogEntry, State } from "./types";
import "./plugins.css";
import "./marketapps.css";

// The direct apps catalog ("mcp-catalog-v1", desktop/mcp-catalog.mjs): tool servers a person adds
// with one click, a browser sign-in or a key, without typing an address. Marketplace › Apps leads
// with it, and Settings › MCP servers offers it as "Add from catalog".
//
// A key is typed into a password field that React does not hold (an uncontrolled input), read once
// on Save, sent once with mcpCatalog.add and cleared. It is never put in state, a toast or a log.
// A program this computer starts (stdio) shows the exact line and needs the person's yes.

const api = window.botkins;
export const MCP_CATALOG = "mcp-catalog-v1";

export function supportsMcpCatalog(state: State) {
  const using = state.remote?.using;
  return (!using || using.capabilities.includes(MCP_CATALOG)) && typeof api["mcpCatalog.list"] === "function";
}

// ── The list, kept while the view is closed, read again when the tools change ─────────────────

const cache = new Map<string, McpCatalog>();
const reloads = new Set<() => void>();
/** Reads the catalog again in every view that shows it (the Marketplace's refresh). */
export function reloadMcpCatalog() {
  for (const reload of reloads) reload();
}

export function useMcpCatalog(state: State) {
  const supported = supportsMcpCatalog(state);
  const where = state.remote?.using?.id ?? "here";
  const [catalog, setCatalog] = useState<McpCatalog | undefined>(() => cache.get(where));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  // The window is told when a tool server changes; that is when an entry's state can change.
  const stamp = JSON.stringify(state.mcpServers ?? []);
  useEffect(() => {
    const reload = () => setRevision((n) => n + 1);
    reloads.add(reload);
    return () => void reloads.delete(reload);
  }, []);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    setCatalog(cache.get(where));
    api["mcpCatalog.list"]().then(
      (next) => {
        if (!live) return;
        cache.set(where, next);
        setCatalog(next);
        setError("");
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [supported, where, stamp, revision]);
  return { supported, catalog, error, reload: () => setRevision((n) => n + 1) };
}

// ── Pieces ────────────────────────────────────────────────────────────────────────────────────

/** Where an entry stands, in one or two words, or nothing when it isn't added. */
export function entryStatus(entry: McpCatalogEntry): { text: string; tone: "ok" | "warn" | "" } | undefined {
  if (!entry.added) return undefined;
  if (entry.auth === "oauth" && entry.signingIn) return { text: "Signing in…", tone: "" };
  if (entry.auth === "oauth" && !entry.signedIn) return { text: "Needs sign-in", tone: "warn" };
  if (entry.keys.length > 0 && entry.keysSet === false) return { text: "Needs a key", tone: "warn" };
  if (entry.enabled === false) return { text: "Off", tone: "" };
  return { text: "Added", tone: "ok" };
}

/** How big the Featured cards are, the category cards, and how many apps a carousel shows before "See all". */
const FEATURED_WIDTH = 300;
const CARD_WIDTH = 160;
const FEATURED_ICON = 56;
const CARD_ICON = 48;
const SHELF_APPS = 12;
const HERO_ICON = 72;

/** What an app's card ends with: its status chip once it is added, else a button to add it. */
function CardAction({ entry, open }: { entry: McpCatalogEntry; open: (id: string) => void }) {
  const badge = appBadge(entry);
  if (badge) return <span className={"app-badge " + badge.tone}>{badge.label}</span>;
  return (
    <button type="button" className="set-button app-card-add" aria-label={(entry.auth === "oauth" ? "Connect " : "Add ") + entry.name} onClick={() => open(entry.id)}>
      {entry.auth === "oauth" ? "Connect" : "Add"}
    </button>
  );
}

export function AppCard({ entry, open }: { entry: McpCatalogEntry; open: (id: string) => void }) {
  const badge = appBadge(entry);
  return (
    <div className="app-card" style={{ "--card-width": CARD_WIDTH + "px" } as React.CSSProperties}>
      <button type="button" className="app-card-open" onClick={() => open(entry.id)} aria-label={entry.name + (badge ? ", " + badge.label : "")}>
        <BrandIcon id={entry.id} name={entry.name} letter={entry.icon.letter} size={CARD_ICON} />
        <strong>{entry.name}</strong>
        <small>{entry.description}</small>
      </button>
      <CardAction entry={entry} open={open} />
    </div>
  );
}

export function FeaturedCard({ entry, open }: { entry: McpCatalogEntry; open: (id: string) => void }) {
  const badge = appBadge(entry);
  const style = { "--card-width": FEATURED_WIDTH + "px", "--brand": brandColor(entry.id, entry.name) } as React.CSSProperties;
  return (
    <div className="app-card app-featured-card" style={style}>
      <button type="button" className="app-card-open" onClick={() => open(entry.id)} aria-label={entry.name + (badge ? ", " + badge.label : "")}>
        <BrandIcon id={entry.id} name={entry.name} letter={entry.icon.letter} size={FEATURED_ICON} />
        <strong>{entry.name}</strong>
        <small>{entry.description}</small>
      </button>
      <CardAction entry={entry} open={open} />
    </div>
  );
}

/**
 * The catalog as cards: a search field, category chips, then the Featured apps and each category as
 * a carousel with "See all" (one grid once a category is chosen or a search is typed). `after`
 * follows the cards (the Composio row).
 */
export function CatalogBrowser({ catalog, error, retry, open, after, label = "Search apps" }: { catalog?: McpCatalog; error: string; retry: () => void; open: (id: string) => void; after?: React.ReactNode; label?: string }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const entries = catalog?.entries ?? [];
  const chips = useMemo(() => appChips(entries), [catalog]);
  const blocks = useMemo(() => appsBlocks(entries, { query, category }), [catalog, query, category]);
  const narrowed = !!query.trim() || category !== "all";
  return (
    <>
      <div className="set-toolbar int-toolbar plugin-toolbar">
        <label className="int-filter">
          <Search size={14} aria-hidden="true" />
          <input type="search" aria-label={label} placeholder={label} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {catalog && chips.length > 2 && (
        <div className="plugin-market-chips" role="group" aria-label="Categories">
          {chips.map((chip) => (
            <button type="button" key={chip.key} className={category === chip.key ? "selected" : ""} aria-pressed={category === chip.key} onClick={() => setCategory(chip.key)}>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      {error && !catalog && (
        <p className="set-status error-text plugin-error" role="alert">
          <span>{error}</span>
          <button type="button" className="set-link" onClick={retry}>
            Retry
          </button>
        </p>
      )}
      {!catalog ? (
        !error && <p className="set-status">Loading apps…</p>
      ) : blocks.length === 0 ? (
        <div className="app-none">
          <p className="set-status">No apps match</p>
          <button
            type="button"
            className="set-button"
            onClick={() => {
              setQuery("");
              setCategory("all");
            }}
          >
            Clear
          </button>
        </div>
      ) : (
        blocks.map((block) =>
          block.kind === "featured" ? (
            <section className="app-section" key="featured">
              <h3 className="app-section-title">Featured</h3>
              <div className="app-carousel">
                {block.entries.map((entry) => (
                  <FeaturedCard key={entry.id} entry={entry} open={open} />
                ))}
              </div>
            </section>
          ) : (
            <section className="app-section" key={block.id}>
              <div className="app-section-head">
                <h3 className="app-section-title">{block.name}</h3>
                {!narrowed && block.entries.length > 0 && (
                  <button type="button" className="set-link" onClick={() => setCategory(block.id)}>
                    See all
                  </button>
                )}
              </div>
              <div className={narrowed ? "app-card-grid" : "app-carousel"}>
                {(narrowed ? block.entries : block.entries.slice(0, SHELF_APPS)).map((entry) => (
                  <AppCard key={entry.id} entry={entry} open={open} />
                ))}
              </div>
            </section>
          ),
        )
      )}
      {after}
    </>
  );
}

/** Opens a web page in the person's browser, the way the window opens every link. */
function OutLink({ url, children, failed }: { url: string; children: React.ReactNode; failed: (text: string) => void }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="app-out-link"
      onClick={(event) => {
        event.preventDefault();
        void api.openLink(url).catch((e) => failed(errorText(e)));
      }}
    >
      {children} <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/** The key fields of an entry: one password field per label, held only by the field itself. */
function KeyFields({ entry, fields, submit }: { entry: McpCatalogEntry; fields: React.MutableRefObject<Record<string, HTMLInputElement | null>>; submit: () => void }) {
  return (
    <Group title={entry.keys.length === 1 ? "Key" : "Keys"} footer="Kept encrypted on your computer. Never shown again.">
      {entry.keys.map((key, index) => (
        <div className="set-row" key={key.id}>
          <div className="set-label">
            <label className="set-name" htmlFor={"catalog-key-" + entry.id + "-" + key.id}>
              {key.label}
            </label>
            {key.hint && <small>{key.hint}</small>}
          </div>
          <div className="set-control">
            <input
              id={"catalog-key-" + entry.id + "-" + key.id}
              ref={(node) => {
                fields.current[key.id] = node;
              }}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="int-mono"
              autoFocus={index === 0}
              placeholder={entry.added && entry.keysSet ? "Leave empty to keep" : "Paste it here"}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </div>
      ))}
    </Group>
  );
}

/** What a program entry starts on this computer: the line, its values, version and license. */
function WhatRuns({ entry }: { entry: McpCatalogEntry }) {
  return (
    <Group title="Runs on your computer">
      <div className="set-row stacked">
        <dl className="plugin-facts">
          <dt>Command</dt>
          <dd>
            <pre className="plugin-command">{entry.command}</pre>
          </dd>
          {!!entry.env?.length && (
            <>
              <dt>Values it gets</dt>
              <dd>
                <span className="plugin-words">
                  {entry.env.map((name) => (
                    <span key={name}>{name}</span>
                  ))}
                </span>
              </dd>
            </>
          )}
          {entry.package && (
            <>
              <dt>Package</dt>
              <dd>
                <code className="plugin-value">{entry.package + (entry.version ? "@" + entry.version : "")}</code>
              </dd>
            </>
          )}
          {entry.license && (
            <>
              <dt>License</dt>
              <dd>
                <span className="plugin-plain">{entry.license}</span>
              </dd>
            </>
          )}
        </dl>
      </div>
    </Group>
  );
}

/**
 * One app of the catalog: what it is, and its one action by how it signs in. Added, it shows how it
 * stands (on or off, signed in, key saved) and links to the server in Settings › MCP servers.
 */
export function CatalogEntryPage({ state, catalog, id, back, backLabel = "Back to apps", inSettings, reload }: { state: State; catalog?: McpCatalog; id: string; back: () => void; backLabel?: string; /** Shown inside Settings › MCP servers: no link back to it. */ inSettings?: boolean; reload: () => void }) {
  const entry = catalog?.entries.find((item) => item.id === id);
  const allowed = teamCan(state, "mcp", "create");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [waiting, setWaiting] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [changingKey, setChangingKey] = useState(false);
  const fields = useRef<Record<string, HTMLInputElement | null>>({});
  // Leaving the page empties every key field; nothing typed outlives it.
  useEffect(
    () => () => {
      for (const node of Object.values(fields.current)) if (node) node.value = "";
    },
    [],
  );

  const backLink = (
    <button type="button" className="set-link plugin-back" onClick={back}>
      <ArrowLeft size={14} /> {backLabel}
    </button>
  );
  if (!entry)
    return (
      <div className="plugin-detail market-apps">
        {backLink}
        <p className="set-status">{catalog ? "This app isn't in the catalog." : "Loading apps…"}</p>
      </div>
    );

  const keyed = entry.keys.length > 0;
  const stdio = entry.transport === "stdio";
  const status = entryStatus(entry);
  const keysNeeded = keyed && (!entry.added || entry.keysSet === false || entry.commandChanged === true || changingKey);

  /** Reads the key fields once, then empties them. Undefined when a needed key is missing. */
  function takeKeys(): Record<string, string> | undefined {
    if (!keyed) return {};
    const keys: Record<string, string> = {};
    for (const key of entry!.keys) {
      const value = fields.current[key.id]?.value ?? "";
      if (value) keys[key.id] = value;
    }
    const required = !entry!.added || entry!.commandChanged === true;
    const missing = entry!.keys.find((key) => !keys[key.id]);
    if (required && missing) {
      setError("Enter the " + missing.label + ".");
      fields.current[missing.id]?.focus();
      return undefined;
    }
    if (!Object.keys(keys).length && entry!.added) {
      setError("Enter the " + entry!.keys[0].label + ".");
      return undefined;
    }
    return keys;
  }
  const clearFields = () => {
    for (const node of Object.values(fields.current)) if (node) node.value = "";
  };

  async function signIn(serverId: string) {
    setWaiting(serverId);
    try {
      await api.signInMcpServer(serverId);
      setNote("Signed in to " + entry!.name);
    } catch (e) {
      const text = errorText(e);
      if (!/cancel/i.test(text)) setError(text || "Couldn't sign in. Try again.");
    } finally {
      setWaiting(undefined);
      reload();
    }
  }

  async function add(confirm?: string) {
    if (busy || !allowed) return;
    setError("");
    setNote("");
    const keys = keysNeeded ? takeKeys() : {};
    if (!keys) return;
    setBusy(true);
    try {
      const options = { ...(Object.keys(keys).length && { keys }), ...(confirm && { confirm }) };
      const added = await api["mcpCatalog.add"](entry!.id, options);
      clearFields();
      setConfirming(false);
      setChangingKey(false);
      setNote(keyed && Object.keys(keys).length ? "Key saved" : entry!.name + " added");
      reload();
      if (added.next === "sign-in") void signIn(added.serverId);
    } catch (e) {
      // The computer's errors never repeat a key.
      setError(errorText(e) || "Couldn't add " + entry!.name + ". Try again.");
    } finally {
      setBusy(false);
    }
  }

  const start = () => {
    if (stdio) {
      // A program on this computer: the yes comes first, with the line it starts.
      if (keysTyped()) setConfirming(true);
      return;
    }
    void add();
  };
  /** Checks the keys are typed before the yes, without reading them out of their fields. */
  function keysTyped() {
    if (!keysNeeded) return true;
    const empty = entry!.keys.filter((key) => !fields.current[key.id]?.value);
    const missing = entry!.added ? (empty.length === entry!.keys.length ? empty[0] : undefined) : empty[0];
    if (missing) {
      setError("Enter the " + missing.label + ".");
      fields.current[missing.id]?.focus();
      return false;
    }
    setError("");
    return true;
  }

  const label = entry.auth === "oauth" ? "Connect" : keyed && !stdio ? "Save" : "Add";
  const signingIn = !!waiting || !!entry.signingIn;
  const openSettings = () => window.dispatchEvent(new CustomEvent("botkins-open-settings", { detail: "MCP servers" }));

  return (
    <div className="plugin-detail market-apps">
      {backLink}
      <div className="app-hero" style={{ "--brand": brandColor(entry.id, entry.name) } as React.CSSProperties}>
        <BrandIcon id={entry.id} name={entry.name} letter={entry.icon.letter} size={HERO_ICON} />
        <div>
          <h3>{entry.name}</h3>
          <small>
            {entry.categoryName}
            {status ? " · " + status.text : ""}
          </small>
        </div>
      </div>
      <p className="app-description">{entry.description}</p>
      <p className="app-description app-docs">
        <OutLink url={entry.docs} failed={setError}>
          Docs
        </OutLink>
      </p>
      <Group title="How it connects">
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Runs</span>
          </div>
          <div className="set-control app-connect-value">{connectsLines(entry).how}</div>
        </div>
        <div className="set-row">
          <div className="set-label">
            <span className="set-name">Sign-in</span>
          </div>
          <div className="set-control app-connect-value">{connectsLines(entry).auth}</div>
        </div>
      </Group>
      {entry.local && (
        <p className="plugin-held" role="note">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{entry.local}</span>
        </p>
      )}
      {note && (
        <p className="set-status app-told" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}

      {entry.added && entry.serverId && (
        <Group>
          <div className="set-row">
            <div className="set-label">
              <span className="set-name">{entry.serverName ?? entry.name}</span>
              <small>{entry.enabled === false ? "Off" : "On · every bot can use it"}</small>
            </div>
            <div className="set-control">
              <input
                type="checkbox"
                role="switch"
                className="switch set-switch"
                aria-label={entry.name}
                checked={entry.enabled !== false}
                disabled={!allowed}
                onChange={(e) =>
                  void api
                    .setMcpServerEnabled(entry.serverId!, e.target.checked)
                    .then(reload)
                    .catch((err) => setError(errorText(err)))
                }
              />
            </div>
          </div>
          {entry.auth === "oauth" && (
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">{signingIn ? "Waiting for your browser…" : entry.signedIn ? "Signed in" : "Not signed in"}</span>
              </div>
              <div className="set-control">
                {signingIn ? (
                  <button type="button" className="set-button" onClick={() => void api.cancelMcpSignIn(entry.serverId!).catch(() => {})}>
                    Cancel
                  </button>
                ) : (
                  !entry.signedIn && (
                    <button type="button" className="set-button primary" disabled={!allowed} onClick={() => void signIn(entry.serverId!)}>
                      Sign in
                    </button>
                  )
                )}
              </div>
            </div>
          )}
          {keyed && entry.keysSet && !changingKey && (
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">Key saved</span>
              </div>
              <div className="set-control">
                <button type="button" className="set-button" disabled={!allowed} onClick={() => { setNote(""); setChangingKey(true); }}>
                  Change key
                </button>
              </div>
            </div>
          )}
          {!inSettings && (
            <div className="set-row">
              <button type="button" className="set-link" onClick={openSettings}>
                Open in MCP servers
              </button>
            </div>
          )}
        </Group>
      )}

      {stdio && <WhatRuns entry={entry} />}
      {keysNeeded && <KeyFields entry={entry} fields={fields} submit={start} />}

      {!allowed ? (
        <p className="set-status">Only the person who runs this computer adds apps.</p>
      ) : confirming && stdio ? (
        <div className="app-confirm" role="group" aria-label={"Start " + entry.name + " on your computer"}>
          <span className="app-confirm-head">
            <SquareTerminal size={16} aria-hidden="true" />
            <strong>Botkins will run this on your computer</strong>
          </span>
          <pre className="plugin-command">{entry.command}</pre>
          <div className="plugin-detail-actions">
            <button type="button" className="set-button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="set-button primary" disabled={busy} onClick={() => void add(entry.command)}>
              {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
              Start on this computer
            </button>
          </div>
        </div>
      ) : !entry.added ? (
        <div className="plugin-detail-actions">
          <button type="button" className="set-button primary" disabled={busy || signingIn} onClick={start}>
            {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
            {signingIn ? "Finish signing in in your browser…" : label}
          </button>
        </div>
      ) : (
        keysNeeded && (
          <div className="plugin-detail-actions">
            {changingKey && (
              <button type="button" className="set-button" disabled={busy} onClick={() => { clearFields(); setChangingKey(false); setError(""); }}>
                Cancel
              </button>
            )}
            <button type="button" className="set-button primary" disabled={busy} onClick={start}>
              {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
              Save
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** Settings › MCP servers › Add from catalog: the same grid and pages, in a sheet. */
export function CatalogSheet({ state, close }: { state: State; close: () => void }) {
  const { catalog, error, reload } = useMcpCatalog(state);
  const [open, setOpen] = useState<string>();
  return (
    <Sheet
      wide
      title="Add from catalog"
      close={close}
      submit={() => {}}
      footer={
        <button type="button" className="set-button" onClick={close}>
          Done
        </button>
      }
    >
      <div className="app-catalog-sheet">
        {open ? (
          <CatalogEntryPage state={state} catalog={catalog} id={open} back={() => setOpen(undefined)} backLabel="Back to catalog" inSettings reload={reload} />
        ) : (
          <CatalogBrowser catalog={catalog} error={error} retry={reload} open={setOpen} />
        )}
      </div>
    </Sheet>
  );
}
