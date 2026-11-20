import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  FileUp,
  Globe,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogIn,
  Pencil,
  Plug,
  Plus,
  Server,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import type { Credential, Credentials, McpServer, McpServerInput, State } from "./types";
import { when } from "./wikiModel";
import { useAsk } from "./Pages";
import { Group, Sheet, errorText } from "./SettingsRows";
import { stopCancel } from "./SkillsSettings";
import MacTools from "./MacTools";
import SavedCredentials, { CredentialsIntro } from "./SavedCredentials";
import "./integrations.css";

const api = window.botkins;

/** "a", "a and b", "a, b and c". */
export const listText = (items: string[]) => (items.length < 2 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items.at(-1));

/** One line that says what a server runs or where it is. */
export function serverSummary(s: McpServer) {
  return s.type === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") : (s.url ?? "");
}

export function importText(r: { added: string[]; skipped: string[] }) {
  const added = r.added.length ? "Added " + listText(r.added) + "." : "No servers added.";
  const skipped = r.skipped.length
    ? " Skipped " + listText(r.skipped) + (r.skipped.length === 1 ? " (a server with that name exists)." : " (servers with those names exist).")
    : "";
  return added + skipped;
}

type Test = { busy?: boolean; status?: string; tools?: string[]; error?: string; open?: boolean };
/** A sign-in this page started: waiting for the browser, or how it ended. */
type SignIn = { waiting?: boolean; error?: string };

/** How a remote server signs in, in words for its row. */
export function signInText(s: McpServer) {
  if (s.type === "stdio") return "";
  const a = s.auth;
  if (a?.type === "oauth") return "Browser sign-in";
  if (a?.type === "header") return s.headers?.length === 1 && /^(authorization|x-api-key|api-key|x-auth-token)$/i.test(s.headers[0]) ? "API key" : "Custom headers";
  return "No sign-in";
}

/** Settings › MCP servers: connections every bot can use, with Add server, Import…, Test and Sign in. */
export default function McpSettings({ state, credentials }: { state: State; credentials?: () => void }) {
  const servers = state.mcpServers ?? [];
  const [editing, setEditing] = useState<{ server?: McpServer } | null>(null);
  const [importing, setImporting] = useState(false);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [signIns, setSignIns] = useState<Record<string, SignIn>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const dialogs = useAsk();
  const patch = (id: string, t: Test) => setTests((all) => ({ ...all, [id]: t }));
  const signPatch = (id: string, v: SignIn) => setSignIns((all) => ({ ...all, [id]: v }));
  async function run(fn: () => Promise<unknown>, done?: string) {
    setError("");
    setNote("");
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function test(s: McpServer) {
    patch(s.id, { busy: true });
    try {
      const r = await api.testMcpServer(s.id);
      patch(s.id, { status: r.status, tools: r.tools });
    } catch (e) {
      patch(s.id, { error: errorText(e) });
    }
  }
  async function signIn(s: McpServer) {
    signPatch(s.id, { waiting: true });
    setNote("");
    setError("");
    try {
      await api.signInMcpServer(s.id);
      signPatch(s.id, {});
      setNote("Signed in to " + s.name + ".");
      // A test that asked for a sign-in is out of date now.
      setTests((all) => ({ ...all, [s.id]: {} }));
    } catch (e) {
      const text = errorText(e);
      signPatch(s.id, /cancel/i.test(text) ? {} : { error: text });
    }
  }
  async function cancelSignIn(s: McpServer) {
    signPatch(s.id, {});
    await api.cancelMcpSignIn(s.id).catch(() => {});
  }
  async function signOut(s: McpServer) {
    const ok = await dialogs.ask({
      title: "Sign out of " + s.name + "?",
      body: "Bots can't use " + s.name + " until you sign in again. Its sign-in is removed from this computer.",
      confirm: "Sign out",
      danger: true,
    });
    if (ok) await run(() => api.signOutMcpServer(s.id), "Signed out of " + s.name + ".");
  }
  async function remove(s: McpServer) {
    const ok = await dialogs.ask({
      title: "Remove " + s.name + "?",
      body: "No bot can use this server any more, and its saved keys and sign-in are deleted from this computer.",
      confirm: "Remove",
      danger: true,
    });
    if (ok) await run(() => api.removeMcpServer(s.id), "Removed " + s.name + ".");
  }
  const actions = (
    <span className="int-actions">
      <button type="button" className="set-button" onClick={() => setImporting(true)}>
        <Upload size={14} />
        Import…
      </button>
      <button type="button" className="set-button primary" onClick={() => setEditing({})}>
        <Plus size={14} />
        Add server
      </button>
    </span>
  );
  const on = servers.filter((s) => s.enabled).length;
  const vaultNote = (
    <>
      Keys and sign-ins are encrypted on this computer and never shown again.{" "}
      {credentials && (
        <button type="button" className="set-link" onClick={credentials}>
          See credentials
        </button>
      )}
    </>
  );
  return (
    <div className="int-section" {...stopCancel}>
      <MacTools state={state} />
      {servers.length > 0 && (
        <div className="set-toolbar int-toolbar">
          <span className="int-count">
            {servers.length === 1 ? "1 server" : servers.length + " servers"}
            {on < servers.length ? " · " + (servers.length - on) + " off" : ""}
          </span>
          {actions}
        </div>
      )}
      {note && (
        <p className="set-status" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      {servers.length === 0 ? (
        <Group>
          <div className="int-empty">
            <span className="int-empty-icon" aria-hidden="true">
              <Server size={20} />
            </span>
            <strong>No MCP servers yet</strong>
            <p>
              A server gives every bot more tools, such as a ticket system or a database.
            </p>
            {actions}
          </div>
        </Group>
      ) : (
        <Group
          footer={
            <>
              Every bot can use the servers that are on. {vaultNote}
            </>
          }
        >
          {servers.map((s) => {
            const t = tests[s.id] ?? {};
            const sign = signIns[s.id] ?? {};
            const summary = serverSummary(s);
            const auth = s.auth?.type === "oauth" ? s.auth : undefined;
            const waiting = !!sign.waiting || !!auth?.signingIn;
            const needsAuth = t.status === "needs-auth" || (!!t.status && /auth/i.test(t.status));
            const tone = t.error ? "bad" : t.status === "connected" ? "ok" : t.status ? (needsAuth ? "warn" : "bad") : "";
            const status = t.error
              ? t.error
              : t.status === "connected"
                ? "Connected · " + (t.tools?.length === 1 ? "1 tool" : (t.tools?.length ?? 0) + " tools")
                : t.status
                  ? needsAuth
                    ? s.type === "stdio"
                      ? "Needs a key. Add it in Keys and settings."
                      : "This server needs you to sign in."
                    : "Couldn't connect"
                  : "";
            const Glyph = s.type === "stdio" ? SquareTerminal : Globe;
            const method = signInText(s);
            const signInButton = (label: string) => (
              <button type="button" className="set-link int-more" onClick={() => void signIn(s)}>
                {label}
              </button>
            );
            return (
              <div className={"set-row int-item" + (s.enabled ? "" : " off")} key={s.id}>
                <span className="int-glyph" aria-hidden="true">
                  <Glyph size={15} />
                </span>
                <div className="set-label">
                  <span className="int-title">
                    <span className="set-name">{s.name}</span>
                    <span className="int-origin">
                      {s.type === "stdio" ? "Local" : s.type === "sse" ? "Remote · SSE" : "Remote"}
                      {method && " · " + method}
                    </span>
                  </span>
                  <small className="int-mono int-line" title={summary}>
                    {summary}
                  </small>
                  {auth &&
                    (waiting ? (
                      <small className="int-note int-auth" role="status">
                        <Loader2 size={12} className="spin" aria-hidden="true" />
                        Waiting for your browser…
                        <button type="button" className="set-link int-more" onClick={() => void cancelSignIn(s)}>
                          Cancel
                        </button>
                      </small>
                    ) : (
                      <small className={"int-note int-auth " + (auth.signedIn && !auth.needsSignIn ? "ok" : "warn")}>
                        <i aria-hidden="true" />
                        {auth.needsSignIn ? "Sign-in ended" : auth.signedIn ? "Signed in" : "Not signed in"}
                        {auth.signedIn && !auth.needsSignIn ? (
                          <button type="button" className="set-link int-more" onClick={() => void signOut(s)}>
                            Sign out
                          </button>
                        ) : (
                          signInButton(auth.needsSignIn ? "Sign in again" : "Sign in")
                        )}
                      </small>
                    ))}
                  {sign.error && !waiting && (
                    <small className="int-note bad" role="alert">
                      <i aria-hidden="true" />
                      {sign.error}
                    </small>
                  )}
                  {!!s.needs?.length && (
                    <small className="int-note warn">
                      <i aria-hidden="true" />
                      {listText(s.needs)} {s.needs.length === 1 ? "has" : "have"} no saved value. Enter {s.needs.length === 1 ? "it" : "them"} again.
                      <button type="button" className="set-link int-more" onClick={() => setEditing({ server: s })}>
                        Edit
                      </button>
                    </small>
                  )}
                  {(t.busy || status) && (
                    <small className={"int-note " + (t.busy ? "" : tone)} role="status" title={t.status}>
                      {t.busy ? (
                        "Connecting… this can take a few seconds."
                      ) : (
                        <>
                          <i aria-hidden="true" />
                          {status}
                          {needsAuth && s.type !== "stdio" && !waiting && signInButton("Sign in")}
                          {!!t.tools?.length && (
                            <button
                              type="button"
                              className="set-link int-more"
                              aria-expanded={!!t.open}
                              onClick={() => patch(s.id, { ...t, open: !t.open })}
                            >
                              {t.open ? "Hide tools" : "Show tools"}
                            </button>
                          )}
                        </>
                      )}
                    </small>
                  )}
                  {t.open && !!t.tools?.length && (
                    <ul className="int-tools" aria-label={s.name + " tools"}>
                      {t.tools.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="set-control int-trailing">
                  <button type="button" className="int-icon" aria-label={"Test " + s.name} title="Test connection" disabled={t.busy} onClick={() => void test(s)}>
                    {t.busy ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                  </button>
                  <button type="button" className="int-icon" aria-label={"Edit " + s.name} title="Edit" onClick={() => setEditing({ server: s })}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="int-icon danger" aria-label={"Remove " + s.name} title="Remove…" onClick={() => void remove(s)}>
                    <Trash2 size={14} />
                  </button>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch set-switch"
                    aria-label={s.name}
                    checked={s.enabled}
                    onChange={(e) => void run(() => api.setMcpServerEnabled(s.id, e.target.checked))}
                  />
                </div>
              </div>
            );
          })}
        </Group>
      )}
      {editing && (
        <ServerSheet
          server={editing.server}
          close={() => setEditing(null)}
          saved={(name) => {
            setEditing(null);
            setError("");
            setNote((editing.server ? "Saved " : "Added ") + name + ".");
            if (editing.server) setTests((all) => ({ ...all, [editing.server!.id]: {} }));
          }}
        />
      )}
      {importing && (
        <ImportSheet
          close={() => setImporting(false)}
          done={(r) => {
            setImporting(false);
            setError("");
            setNote(importText(r));
          }}
        />
      )}
      {dialogs.node}
    </div>
  );
}

const KINDS: Record<string, string> = {
  environment: "Environment value",
  header: "Header",
  oauth: "Sign-in",
  "client-secret": "Client secret",
};
/** A credential's kind in plain words. A header that carries a key reads as a key. */
function kindText(c: Credential) {
  if (c.kind === "header" && /authorization|api[-_ ]?key|token/i.test(c.label)) return "Key";
  return KINDS[c.kind] ?? "Key";
}

/** Why a vault can't be opened, in words. */
const LOCKED: Record<string, string> = {
  "installed-app": "These credentials belong to the installed Botkins, so this development copy can't open them. Use the installed app, or reset to start an empty vault here.",
  key: "The system keychain didn't give the key that unlocks your credentials. This happens on another computer or after the keychain was reset.",
  damaged: "The file that holds your credentials can't be read.",
};

/** Settings › Credentials: what the vault holds, without any value, and Remove. */
export function CredentialsSettings({ state, mcp }: { state: State; mcp?: () => void }) {
  const [vault, setVault] = useState<Credentials>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const dialogs = useAsk();
  const stamp = JSON.stringify(state.mcpServers ?? []);
  const load = () =>
    api
      .credentials()
      .then((v) => {
        setVault(v);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, [stamp]);
  async function remove(c: Credential) {
    const server = c.usedBy ?? "its server";
    const ok = await dialogs.ask({
      title: "Remove " + c.label + "?",
      body:
        c.kind === "oauth"
          ? "You are signed out of " + server + ". Sign in again to use it."
          : server + " can't use this " + kindText(c).toLowerCase() + " until you enter it again in MCP servers.",
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    setNote("");
    try {
      await api.removeCredential(c.id);
      setNote("Removed " + c.label + ".");
    } catch (e) {
      setError(errorText(e));
    }
    await load();
  }
  async function reset() {
    const ok = await dialogs.ask({
      title: "Reset the vault?",
      body: "The saved credentials are set aside, not deleted, and an empty vault starts. You then enter each key and sign in to each server again.",
      confirm: "Reset vault",
      danger: true,
    });
    if (!ok) return;
    setNote("");
    try {
      await api.resetVault();
      setNote("The vault was reset. Enter keys and sign in again in MCP servers.");
    } catch (e) {
      setError(errorText(e));
    }
    await load();
  }
  const keychain = vault?.protection !== "file";
  return (
    <div className="int-section" {...stopCancel}>
      <CredentialsIntro />
      <Group>
        <div className="set-row cred-protection">
          <span className={"cred-shield" + (keychain ? " on" : "")} aria-hidden="true">
            <ShieldCheck size={18} />
          </span>
          <div className="set-label">
            <span className="set-name">Encrypted on this computer</span>
            <small>
              {!vault
                ? "Checking…"
                : keychain
                  ? "The key that unlocks them is kept by your system keychain, so they can't be read on another computer or by another app."
                  : "This is a development build: the key that unlocks them is kept in a file next to your data, not in the system keychain."}
            </small>
          </div>
          <div className="set-control">
            <span className={"set-pill" + (keychain ? " ok" : "")}>{!vault ? "…" : keychain ? "Keychain" : "Development"}</span>
          </div>
        </div>
      </Group>
      {/* Password managers and the credentials phones share (src/SavedCredentials.tsx). */}
      <SavedCredentials />
      {vault?.locked && (
        <div className="cred-lost" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>
            {LOCKED[vault.locked] ?? LOCKED.damaged} Servers that need a key or a sign-in can't connect until it opens again or you reset it.
            <span className="cred-lost-actions">
              <button type="button" className="set-button danger" onClick={() => void reset()}>
                Reset vault…
              </button>
            </span>
          </span>
        </div>
      )}
      {note && (
        <p className="set-status" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="set-status error-text" role="alert">
          {error}
        </p>
      )}
      {vault?.locked && !vault.entries.length ? null : vault && !vault.entries.length ? (
        <Group title="Saved for MCP servers">
          <div className="int-empty">
            <span className="int-empty-icon" aria-hidden="true">
              <LockKeyhole size={20} />
            </span>
            <strong>No saved credentials</strong>
            <p>Keys and sign-ins you add to MCP servers are kept here, encrypted.</p>
            {mcp && (
              <span className="int-actions">
                <button type="button" className="set-button" onClick={mcp}>
                  Open MCP servers
                </button>
              </span>
            )}
          </div>
        </Group>
      ) : (
        vault && (
          <Group
            title="Saved for MCP servers"
            footer="Values are never shown and can't be revealed. Edit the server to change one."
          >
            {vault.entries.map((c) => {
              const Glyph = c.kind === "oauth" ? LogIn : KeyRound;
              return (
                <div className="set-row int-item compact" key={c.id}>
                  <span className="int-glyph" aria-hidden="true">
                    <Glyph size={14} />
                  </span>
                  <div className="set-label">
                    <span className="int-title">
                      <span className="set-name">{c.label}</span>
                      <span className="int-origin">{kindText(c)}</span>
                    </span>
                    <small className="int-line">
                      {(c.usedBy ? "Used by " + c.usedBy : "Not used by a server") + " · Changed " + when(c.updatedAt || c.createdAt)}
                    </small>
                  </div>
                  <div className="set-control int-trailing">
                    <button
                      type="button"
                      className="int-icon danger"
                      aria-label={"Remove " + c.label}
                      title="Remove…"
                      disabled={!!vault.locked}
                      onClick={() => void remove(c)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </Group>
        )
      )}
      {dialogs.node}
    </div>
  );
}

type Pair = { key: number; name: string; value: string; saved: boolean };
let nextKey = 1;
const pairsOf = (names?: string[]): Pair[] => (names ?? []).map((name) => ({ key: nextKey++, name, value: "", saved: true }));
/** Rows as the backend wants them: an untouched saved value is null, which keeps it. */
function record(rows: Pair[]) {
  const out: Record<string, string | null> = {};
  for (const r of rows) if (r.name.trim()) out[r.name.trim()] = r.saved && r.value === "" ? null : r.value;
  return out;
}

/** Name and value rows for environment variables or headers. Saved values are never shown; leaving one empty keeps it. */
function Pairs({ rows, set, noun, placeholder }: { rows: Pair[]; set: (rows: Pair[]) => void; noun: string; placeholder: string }) {
  const change = (key: number, patch: Partial<Pair>) => set(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const Noun = noun[0].toUpperCase() + noun.slice(1);
  return (
    <div className="int-pairs" role="group" aria-label={Noun + "s"}>
      {rows.map((r, i) => (
        <div className="int-pair" key={r.key}>
          <input
            aria-label={Noun + " " + (i + 1) + " name"}
            className="int-mono"
            spellCheck={false}
            placeholder={placeholder}
            value={r.name}
            readOnly={r.saved}
            title={r.saved ? "Remove this row and add a new one to rename it." : undefined}
            onChange={(e) => change(r.key, { name: e.target.value })}
          />
          <input
            aria-label={Noun + " " + (i + 1) + " value"}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={r.saved ? "Saved · leave empty to keep" : "Value"}
            value={r.value}
            onChange={(e) => change(r.key, { value: e.target.value })}
          />
          <button type="button" className="int-icon" aria-label={"Remove " + noun + " " + (i + 1)} title="Remove" onClick={() => set(rows.filter((x) => x.key !== r.key))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="set-button int-add" onClick={() => set([...rows, { key: nextKey++, name: "", value: "", saved: false }])}>
        <Plus size={13} />
        Add {noun}
      </button>
    </div>
  );
}

type Method = "none" | "key" | "oauth" | "headers";
const KEY_HEADER = /^(authorization|x-api-key|api-key|x-auth-token)$/i;
/** How a saved server signs in, as the form's choice. */
function methodOf(server?: McpServer): Method {
  if (!server || server.type === "stdio") return "none";
  if (server.auth?.type === "oauth") return "oauth";
  const names = server.headers ?? [];
  if (!names.length) return "none";
  return names.length === 1 && KEY_HEADER.test(names[0]) ? "key" : "headers";
}
const METHODS: { id: Method; label: string; hint: string }[] = [
  { id: "none", label: "None", hint: "The server is open, or it's on a network you trust." },
  { id: "key", label: "API key or token", hint: "A key from the service's settings, sent with every request." },
  { id: "oauth", label: "Sign in with your browser (OAuth)", hint: "You sign in on the service's own page. Botkins keeps the sign-in and renews it." },
  { id: "headers", label: "Custom headers", hint: "Names and values to send with every request." },
];

/** Add server / Edit server. Secret values are write-only: the form says a value is saved and offers to replace it. */
function ServerSheet({ server, close, saved }: { server?: McpServer; close: () => void; saved: (name: string) => void }) {
  const [name, setName] = useState(server?.name ?? "");
  const [remote, setRemote] = useState(server ? server.type !== "stdio" : false);
  const [transport, setTransport] = useState<"http" | "sse">(server?.type === "sse" ? "sse" : "http");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [env, setEnv] = useState(() => pairsOf(server?.env));
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [method, setMethod] = useState<Method>(() => methodOf(server));
  const [headers, setHeaders] = useState(() => pairsOf(server?.headers));
  // API key: the key, and how to send it. A saved key is kept unless a new one is typed.
  const savedKeyHeader = methodOf(server) === "key" ? server!.headers![0] : "";
  const [key, setKey] = useState("");
  const [replaceKey, setReplaceKey] = useState(!savedKeyHeader);
  const [bearer, setBearer] = useState(!savedKeyHeader || /^authorization$/i.test(savedKeyHeader));
  const [keyHeader, setKeyHeader] = useState(savedKeyHeader && !/^authorization$/i.test(savedKeyHeader) ? savedKeyHeader : "");
  // OAuth: a client entered by hand, for servers that don't let apps register themselves.
  const oauth = server?.auth?.type === "oauth" ? server.auth : undefined;
  const [clientId, setClientId] = useState(oauth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scope, setScope] = useState(oauth?.scope ?? "");
  const [advanced, setAdvanced] = useState(!!(oauth?.clientId || oauth?.scope));
  const [redirect, setRedirect] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (method === "oauth" && advanced && !redirect)
      api
        .credentials()
        .then((c) => setRedirect(c.redirectUrl))
        .catch(() => {});
  }, [method, advanced]);
  const headerName = bearer ? "Authorization" : keyHeader.trim();
  // Sending the key another way needs the key itself: a saved one is never moved unseen.
  const keyField = replaceKey || savedKeyHeader.toLowerCase() !== headerName.toLowerCase();
  /** What the remote form sends for its sign-in. The other methods' secrets are never kept. */
  function remoteAuth(): Pick<McpServerInput, "headers" | "oauth"> {
    if (method === "oauth")
      return {
        headers: {},
        oauth: {
          ...(clientId.trim() && { clientId: clientId.trim() }),
          ...(scope.trim() && { scope: scope.trim() }),
          ...(clientId.trim() && { clientSecret: clientSecret ? clientSecret : oauth?.clientSecret ? null : undefined }),
        },
      };
    if (method === "key") {
      if (!headerName) throw new Error("Enter the name of the header the key goes in, such as X-API-Key.");
      const keep = !keyField;
      if (!keep && !key.trim()) throw new Error(savedKeyHeader ? "Enter the key again. You changed how it's sent." : "Enter the key.");
      return { headers: { [keep ? savedKeyHeader : headerName]: keep ? null : bearer ? "Bearer " + key.trim() : key.trim() }, oauth: null };
    }
    if (method === "headers") return { headers: record(headers), oauth: null };
    return { headers: {}, oauth: null };
  }
  async function submit() {
    setError("");
    let input: McpServerInput;
    try {
      input = {
        ...(server && { id: server.id }),
        name: name.trim(),
        type: remote ? transport : "stdio",
        enabled: server?.enabled ?? true,
        ...(remote
          ? { url: url.trim(), ...remoteAuth() }
          : {
              command: command.trim(),
              args: args
                .split("\n")
                .map((a) => a.trim())
                .filter(Boolean),
              env: record(env),
              cwd: cwd.trim(),
            }),
      };
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setBusy(true);
    try {
      await api.saveMcpServer(input);
      saved(input.name);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  const choice = METHODS.find((m) => m.id === method)!;
  return (
    <Sheet
      title={server ? "Edit " + server.name : "Add MCP server"}
      close={close}
      submit={() => void submit()}
      footer={
        <>
          {error && (
            <span className="int-sheet-error" role="alert">
              {error}
            </span>
          )}
          <button type="button" className="set-button" onClick={close}>
            Cancel
          </button>
          <button className="set-button primary" disabled={busy}>
            {busy ? "Saving…" : server ? "Save server" : "Add server"}
          </button>
        </>
      }
    >
      <label>
        Name
        <input required autoFocus={!server} maxLength={48} spellCheck={false} placeholder="github" value={name} onChange={(e) => setName(e.target.value)} />
        <small className="int-hint">Letters, numbers, dashes and underscores. Bots see this name.</small>
      </label>
      <div className="int-field">
        <span className="int-field-label" id="mcp-kind">
          Type
        </span>
        <div className="int-kind">
          <div className="segmented" role="radiogroup" aria-labelledby="mcp-kind">
            {(
              [
                [false, "Local command"],
                [true, "Remote server"],
              ] as const
            ).map(([value, label]) => (
              <button key={label} type="button" role="radio" aria-checked={remote === value} onClick={() => setRemote(value)}>
                {label}
              </button>
            ))}
          </div>
          {remote && (
            <select aria-label="Connection" value={transport} onChange={(e) => setTransport(e.target.value as "http" | "sse")}>
              <option value="http">HTTP</option>
              <option value="sse">SSE (older servers)</option>
            </select>
          )}
        </div>
        <small className="int-hint">
          {remote ? "A server on the web or your network, reached by its address." : "A program Botkins starts on this computer, such as npx or a script."}
        </small>
      </div>
      {remote ? (
        <>
          <label>
            URL
            <input required className="int-mono" spellCheck={false} placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            Sign in
            <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <small className="int-hint">{choice.hint}</small>
          </label>
          {method === "key" && (
            <div className="int-auth-box">
              {keyField ? (
                <label>
                  Key
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    className="int-mono"
                    autoFocus={!!savedKeyHeader}
                    placeholder="Paste the key or token"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
              ) : (
                <div className="int-field">
                  <span className="int-field-label">Key</span>
                  <div className="int-saved">
                    <Check size={14} aria-hidden="true" />
                    <span>A key is saved.</span>
                    <button type="button" className="set-link" onClick={() => setReplaceKey(true)}>
                      Replace key
                    </button>
                  </div>
                </div>
              )}
              <div className="int-field">
                <span className="int-field-label" id="mcp-send">
                  Send it as
                </span>
                <div className="int-radios" role="radiogroup" aria-labelledby="mcp-send">
                  <label className="int-radio">
                    <input type="radio" name="mcp-send" checked={bearer} onChange={() => setBearer(true)} />
                    <span className="int-mono">Authorization: Bearer &lt;key&gt;</span>
                  </label>
                  <label className="int-radio">
                    <input type="radio" name="mcp-send" checked={!bearer} onChange={() => setBearer(false)} />
                    <span>A header of its own</span>
                  </label>
                  {!bearer && (
                    <input
                      aria-label="Header name"
                      className="int-mono int-header-name"
                      spellCheck={false}
                      placeholder="X-API-Key"
                      value={keyHeader}
                      onChange={(e) => setKeyHeader(e.target.value)}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
          {method === "oauth" && (
            <div className="int-auth-box">
              <p className="int-hint int-auth-line">
                {oauth?.signedIn
                  ? "Signed in. Save, then use Sign out on the server's row to end the sign-in."
                  : "After you save, choose Sign in on the server's row. Your browser opens the service's sign-in page."}
              </p>
              <button type="button" className="int-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                <ChevronRight size={14} aria-hidden="true" />
                Advanced
              </button>
              {advanced && (
                <div className="int-advanced">
                  <small className="int-hint">Enter a client here if your server operator gave you one. Leave these fields empty to use automatic setup.</small>
                  <label>
                    Client ID
                    <input className="int-mono" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} />
                  </label>
                  <label>
                    <span>
                      Client secret <span className="optional">Optional</span>
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      className="int-mono"
                      placeholder={oauth?.clientSecret ? "Saved · leave empty to keep" : ""}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>
                      Scopes <span className="optional">Optional</span>
                    </span>
                    <input className="int-mono" spellCheck={false} placeholder="read write" value={scope} onChange={(e) => setScope(e.target.value)} />
                    <small className="int-hint">Separate them with spaces. Leave empty to use the default scopes.</small>
                  </label>
                  <div className="int-field">
                    <span className="int-field-label">Redirect address</span>
                    <div className="int-copy">
                      <code className="int-mono">{redirect || "…"}</code>
                      <button
                        type="button"
                        className="set-button int-add"
                        disabled={!redirect}
                        onClick={() =>
                          void api.copyText(redirect).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1600);
                          })
                        }
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <small className="int-hint">Register this address with the app you create on the service.</small>
                  </div>
                </div>
              )}
            </div>
          )}
          {method === "headers" && (
            <div className="int-field">
              <span className="int-field-label">Headers</span>
              <Pairs rows={headers} set={setHeaders} noun="header" placeholder="Authorization" />
            </div>
          )}
        </>
      ) : (
        <>
          <label>
            Command
            <input required className="int-mono" spellCheck={false} placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label>
            Arguments
            <textarea className="int-mono-area" rows={3} spellCheck={false} placeholder={"-y\n@modelcontextprotocol/server-filesystem"} value={args} onChange={(e) => setArgs(e.target.value)} />
            <small className="int-hint">One per line.</small>
          </label>
          <div className="int-field">
            <span className="int-field-label">Keys and settings</span>
            <small className="int-hint">Put API keys and tokens here: the variable name the program reads, such as API_KEY, and its value.</small>
            <Pairs rows={env} set={setEnv} noun="variable" placeholder="API_KEY" />
          </div>
          <label>
            <span>
              Working folder <span className="optional">Optional</span>
            </span>
            <input className="int-mono" spellCheck={false} placeholder="/Users/you/projects/tools" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <small className="int-hint">A full path. Leave empty to use the bot's own folder.</small>
          </label>
        </>
      )}
      {(!remote || method === "key" || method === "headers" || method === "oauth") && (
        <p className="int-hint int-secret-note">Keys and sign-ins are encrypted on this computer and never shown again.</p>
      )}
    </Sheet>
  );
}

/** Import…: paste MCP JSON, or choose a JSON file such as one from Claude, VS Code or another agent app. */
function ImportSheet({ close, done }: { close: () => void; done: (r: { added: string[]; skipped: string[] }) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go(fn: () => Promise<{ added: string[]; skipped: string[] } | null>) {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      if (r) done(r);
      else setBusy(false);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Import MCP servers"
      close={close}
      submit={() => void go(() => api.importMcpServers(text))}
      footer={
        <>
          <button type="button" className="set-button int-foot-left" disabled={busy} onClick={() => void go(() => api.importMcpServerFile())}>
            <FileUp size={14} />
            From a file…
          </button>
          {error && (
            <span className="int-sheet-error" role="alert">
              {error}
            </span>
          )}
          <button type="button" className="set-button" onClick={close}>
            Cancel
          </button>
          <button className="set-button primary" disabled={busy || !text.trim()}>
            {busy ? "Importing…" : "Import"}
          </button>
        </>
      }
    >
      <label>
        MCP JSON
        <textarea
          autoFocus
          className="int-mono-area"
          rows={11}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"]\n    }\n  }\n}'}
        />
        <small className="int-hint">Paste the "mcpServers" block from another app's settings. Servers whose names already exist are skipped.</small>
      </label>
    </Sheet>
  );
}
