// Settings › Credentials, the part phones share: password managers (1Password, Bitwarden, Proton
// Pass) and the saved credentials a bot's question can be answered with, on this computer or on a
// paired phone. The MCP servers' own vault is listed under it, as before (CredentialsSettings).
//
// Nothing here ever holds a saved value: the list has names and where each comes from, Check says
// only whether it can be read, a value typed in goes once to the computer and the field empties,
// and a master password goes to its manager and is dropped.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  Clock,
  Copy,
  ExternalLink,
  History,
  KeyRound,
  Lock,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  StickyNote,
  Trash2,
  User,
  Vault,
  type LucideIcon,
} from "lucide-react";
import type {
  CredentialAuditEntry,
  CredentialGrant,
  CredentialKind,
  PasswordManagerId,
  PasswordManagerItem,
  PasswordManagerStatus,
  PasswordManagerVault,
  SavedCredential,
  SavedCredentialInput,
} from "./types";
import { useAsk } from "./Pages";
import { Group, Sheet, errorText } from "./SettingsRows";
import { ProtonManagerRow, ProtonPassSheet, protonCalls } from "./ProtonPassSetup";
import { isUnsharedProtonVault, useProtonSetup } from "./proton-pass";
import "./savedcredentials.css";

const api = window.botkins;

export const MANAGER_NAMES: Record<PasswordManagerId, string> = { onepassword: "1Password", bitwarden: "Bitwarden", protonpass: "Proton Pass" };
// Simple glyphs of our own, never the companies' logos.
const MANAGER_ICON: Record<PasswordManagerId, LucideIcon> = { onepassword: Vault, bitwarden: ShieldCheck, protonpass: LockKeyhole };
const KIND_ICON: Record<CredentialKind, LucideIcon> = { "api-key": KeyRound, login: User, note: StickyNote, totp: Clock };
const KIND_LABEL: Record<CredentialKind, string> = { "api-key": "API key", login: "Login", note: "Note", totp: "2FA / TOTP" };
const VALUE_LABEL: Record<CredentialKind, string> = { "api-key": "Key", login: "Password", note: "Note", totp: "2FA secret (Base32 or otpauth://)" };
const GRANT_LABEL: Record<string, { label: string; tone: string }> = {
  always: { label: "Always allow", tone: "ok" },
  today: { label: "Allow for today", tone: "warn" },
  deny: { label: "Always deny", tone: "bad" },
  ask: { label: "Ask every time", tone: "" },
};
const OUTCOME_TONE: Record<string, string> = {
  used: "ok",
  denied: "warn",
  blocked: "bad",
  rate_limited: "warn",
  locked: "warn",
  error: "bad",
};
function formatWhen(ms?: number | null): string {
  if (!ms) return "Never used";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
const managerName = (id: string) => MANAGER_NAMES[id as PasswordManagerId] ?? id;

/** The state of a manager in a few words, and how it looks. */
function badge(status: PasswordManagerStatus | undefined): { label: string; tone: string } {
  switch (status?.state) {
    case "ready":
      return { label: "Ready", tone: "ok" };
    case "locked":
      return { label: "Locked", tone: "warn" };
    case "signed-out":
      return { label: "Signed out", tone: "warn" };
    case "missing":
      return { label: "Not installed", tone: "" };
    case "error":
      return { label: "Problem", tone: "bad" };
    default:
      return { label: "Checking…", tone: "" };
  }
}

/** A sentence where `command` is set in code type. */
function Words({ text }: { text: string }) {
  const parts = text.split("`");
  return <>{parts.map((part, i) => (i % 2 ? <code key={i} className="int-mono">{part}</code> : part))}</>;
}

const hostOf = (url: string | undefined) => (url ? (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url) : undefined);

/** The one line at the top of the tab: what these are for. */
export function CredentialsIntro() {
  return (
    <p className="scred-intro">
      Save a password or key here once, or link one from your password manager. When a bot asks for a secret, on this computer or on a paired phone,
      choose it by name. It is kept on this computer and never sent to a phone.
    </p>
  );
}

export default function SavedCredentials() {
  const [managers, setManagers] = useState<PasswordManagerStatus[]>();
  const [checking, setChecking] = useState(false);
  const [list, setList] = useState<{ locked?: boolean; entries: SavedCredential[] }>();
  const [grants, setGrants] = useState<CredentialGrant[]>();
  const [audit, setAudit] = useState<CredentialAuditEntry[]>();
  const [checks, setChecks] = useState<Record<string, { ok: boolean; message?: string } | "checking">>({});
  const [unlockedHere, setUnlockedHere] = useState<PasswordManagerId[]>([]);
  const [editing, setEditing] = useState<SavedCredential | "new">();
  const [browsing, setBrowsing] = useState<PasswordManagerStatus>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const dialogs = useAsk();
  const load = () =>
    api
      .savedCredentials()
      .then((v) => setList({ locked: v.locked, entries: [...v.entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })) }))
      .catch((e) => setError(errorText(e)));
  const loadGrants = () =>
    api
      .credentialGrants?.()
      .then((rows) => setGrants(rows))
      .catch((e) => setError(errorText(e)));
  const loadAudit = () =>
    api
      .credentialAudit?.({ limit: 50 })
      .then((rows) => setAudit(rows))
      .catch((e) => setError(errorText(e)));
  const loadManagers = async (refresh = false) => {
    setChecking(true);
    try {
      setManagers(await api.passwordManagers(refresh));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void load();
    void loadManagers();
    void loadGrants();
    void loadAudit();
  }, []);
  const put = (status: PasswordManagerStatus) => setManagers((now) => now?.map((m) => (m.id === status.id ? status : m)) ?? [status]);
  const proton = useProtonSetup(protonCalls, (status) => {
    put(status);
    setChecks({});
  });
  async function check(c: SavedCredential) {
    setChecks((now) => ({ ...now, [c.id]: "checking" }));
    try {
      const result = await api.checkSavedCredential(c.id);
      setChecks((now) => ({ ...now, [c.id]: result }));
    } catch (e) {
      setChecks((now) => ({ ...now, [c.id]: { ok: false, message: errorText(e) } }));
    }
  }
  async function remove(c: SavedCredential) {
    const ok = await dialogs.ask({
      title: "Remove " + c.name + "?",
      body:
        c.source === "vault"
          ? "Its value is deleted from this computer. Bots and your phones can't use it any more."
          : "Only the link is removed. The item stays in " + managerName(c.source) + ".",
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    setNote("");
    setError("");
    try {
      await api.removeSavedCredential(c.id);
      setNote("Removed " + c.name + ".");
    } catch (e) {
      setError(errorText(e));
    }
    await load();
    void loadGrants();
  }
  async function revokeGrant(g: CredentialGrant) {
    setNote("");
    setError("");
    try {
      await api.revokeCredentialGrant(g.id);
      setNote(`Revoked ${g.botName || g.botId} access to ${g.credentialName || g.credentialId} on ${g.destination}.`);
      await loadGrants();
      void loadAudit();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function lock(m: PasswordManagerStatus) {
    try {
      put(await api.lockPasswordManager(m.id));
      setUnlockedHere((now) => now.filter((id) => id !== m.id));
    } catch (e) {
      setError(errorText(e));
    }
  }
  const locked = !!list?.locked;
  return (
    <>
      <Group
        title="Password managers"
        footer="Botkins reads a linked field from your password manager each time it is used, through the manager's command-line tool on this computer."
        actions={
          <button type="button" className="set-button" disabled={checking} onClick={() => void loadManagers(true)}>
            <RefreshCw size={14} aria-hidden="true" className={checking ? "spin" : undefined} />
            {checking ? "Checking…" : "Check again"}
          </button>
        }
      >
        {!managers
          ? (["onepassword", "bitwarden", "protonpass"] as PasswordManagerId[]).map((id) => (
              <ManagerRow key={id} id={id} />
            ))
          : managers.map((m) => m.id === "protonpass" && m.setup ? (
              <ProtonManagerRow key={m.id} status={m} setup={proton} browse={() => setBrowsing(m)} locked={locked} />
            ) : (
              <ManagerRow
                key={m.id}
                id={m.id}
                status={m}
                unlockedHere={unlockedHere.includes(m.id)}
                browse={() => setBrowsing(m)}
                lock={() => void lock(m)}
                unlocked={(next) => {
                  put(next);
                  if (next.state === "ready") setUnlockedHere((now) => [...now.filter((id) => id !== m.id), m.id]);
                }}
                locked={locked}
              />
            ))}
      </Group>
      {locked && (
        <div className="cred-lost" role="status">
          <LockKeyhole size={15} aria-hidden="true" />
          <span>The saved credentials are locked on this computer. They are listed, but can't be used, changed or added to until Botkins opens them again. Quit and reopen Botkins, and allow it to use the keychain when it asks.</span>
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
      <Group
        title="Saved credentials"
        footer="A value is never shown again once it is saved. Check reads it on this computer and only says whether it works."
        actions={
          <button type="button" className="set-button" disabled={!list || locked} onClick={() => setEditing("new")}>
            <Plus size={14} aria-hidden="true" />
            Add credential
          </button>
        }
      >
        {!list ? (
          <div className="set-row">
            <small>Loading…</small>
          </div>
        ) : !list.entries.length ? (
          <div className="int-empty">
            <span className="int-empty-icon" aria-hidden="true">
              <KeyRound size={20} />
            </span>
            <strong>Nothing saved yet</strong>
            <p>Add a key or a password, or link one from a password manager above.</p>
          </div>
        ) : (
          list.entries.map((c) => {
            const Glyph = c.source === "vault" ? (KIND_ICON[c.kind] ?? KeyRound) : (MANAGER_ICON[c.source] ?? KeyRound);
            const aliasHosts = (c.aliases ?? []).map((a) => hostOf(a)).filter(Boolean);
            const facts =
              c.source === "vault"
                ? [c.username, hostOf(c.website), aliasHosts.length ? `+${aliasHosts.length} alias${aliasHosts.length > 1 ? "es" : ""}` : undefined].filter(Boolean).join(" · ")
                : [c.reference, c.username, hostOf(c.website)].filter(Boolean).join(" · ");
            const state = checks[c.id];
            const originText =
              c.source === "vault"
                ? c.copied && c.copiedFrom
                  ? `${KIND_LABEL[c.kind]} · Copied from ${managerName(c.copiedFrom.manager)}`
                  : `${KIND_LABEL[c.kind]} · Typed in here`
                : "From " + managerName(c.source);
            return (
              <div className="set-row int-item scred-item" key={c.id} aria-label={c.name}>
                <span className="int-glyph" aria-hidden="true">
                  <Glyph size={14} />
                </span>
                <div className="set-label">
                  <span className="int-title">
                    <span className="set-name">{c.name}</span>
                    <span className="int-origin">{originText}</span>
                    {c.hasTotp && <span className="set-pill ok">2FA</span>}
                    {c.copied && <span className="set-pill warn">Copy</span>}
                  </span>
                  {facts && <small className="int-line">{facts}</small>}
                  {state && (
                    <small className={"scred-check" + (state !== "checking" ? (state.ok ? " ok" : " bad") : "")} role="status">
                      {state === "checking" ? "Checking…" : state.ok ? "Can be read now." : (state.message ?? "It can't be read right now.")}
                    </small>
                  )}
                </div>
                <div className="set-control int-trailing">
                  {state && state !== "checking" && !state.ok && c.source === "protonpass" && isUnsharedProtonVault(state.message) && (
                    <button type="button" className="set-button scred-small" disabled={locked} onClick={() => proton.begin("sign-in", true)}>Share more vaults</button>
                  )}
                  <button type="button" className="set-button scred-small" aria-label={"Check " + c.name} disabled={state === "checking"} onClick={() => void check(c)}>
                    Check
                  </button>
                  <button type="button" className="int-icon" aria-label={"Edit " + c.name} title="Edit" disabled={locked} onClick={() => setEditing(c)}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="int-icon danger" aria-label={"Remove " + c.name} title="Remove…" disabled={locked} onClick={() => void remove(c)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </Group>
      <Group
        title="Standing bot grants"
        footer="Standing grants pin one bot, one credential, one destination origin or command, and one operation. Default is Ask every time. Group chats and non-owner members never get standing grants."
        actions={
          <button type="button" className="set-button" onClick={() => void loadGrants()}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        }
      >
        {grants === undefined ? (
          <div className="set-row">
            <small>Loading…</small>
          </div>
        ) : !grants.length ? (
          <div className="int-empty">
            <span className="int-empty-icon" aria-hidden="true">
              <ShieldCheck size={20} />
            </span>
            <strong>No standing grants</strong>
            <p>Bots ask for your approval every time they need a saved credential until you pick Allow for today, Always allow for this site, or Always deny.</p>
          </div>
        ) : (
          grants.map((g) => {
            const pill = GRANT_LABEL[g.level] ?? { label: g.level, tone: "" };
            return (
              <div className="set-row int-item scred-grant-row" key={g.id} aria-label={`${g.botName || g.botId} — ${g.credentialName || g.credentialId}`}>
                <span className="int-glyph" aria-hidden="true">
                  {g.level === "deny" ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                </span>
                <div className="set-label">
                  <span className="int-title">
                    <span className="set-name">{g.botName || g.botId}</span>
                    <span className="int-origin">{g.credentialName || g.credentialId}</span>
                    <span className={"set-pill " + pill.tone}>{pill.label}</span>
                  </span>
                  <small className="int-line">
                    <code className="int-mono">{g.destination}</code> · <code className="int-mono">{g.operation}</code> · Last used: {formatWhen(g.lastUsedAt)}
                    {g.expiresAt ? ` · Expires ${new Date(g.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ""}
                  </small>
                </div>
                <div className="set-control int-trailing">
                  <button type="button" className="set-button scred-small danger" aria-label={`Revoke ${g.botName || g.botId} grant for ${g.credentialName || g.credentialId}`} onClick={() => void revokeGrant(g)}>
                    Revoke
                  </button>
                </div>
              </div>
            );
          })
        )}
      </Group>
      <Group
        title="Credential audit log"
        footer="Records who requested a credential, which item, where it went, when, and the outcome. Secret values are never logged."
        actions={
          <button type="button" className="set-button" onClick={() => void loadAudit()}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        }
      >
        {audit === undefined ? (
          <div className="set-row">
            <small>Loading…</small>
          </div>
        ) : !audit.length ? (
          <div className="int-empty">
            <span className="int-empty-icon" aria-hidden="true">
              <History size={20} />
            </span>
            <strong>No credential activity yet</strong>
            <p>Every credential use, denial, and blocked attempt appears here.</p>
          </div>
        ) : (
          audit.slice(0, 25).map((entry) => (
            <div className="set-row int-item scred-audit-row" key={entry.id}>
              <span className="int-glyph" aria-hidden="true">
                <History size={14} />
              </span>
              <div className="set-label">
                <span className="int-title">
                  <span className="set-name">{entry.botName || entry.botId}</span>
                  <span className="int-origin">
                    {entry.credentialName || entry.credentialId || "Credential"}
                    {entry.source ? ` (${entry.source === "vault" ? "Botkins vault" : managerName(entry.source)})` : ""}
                  </span>
                  <span className={"set-pill " + (OUTCOME_TONE[entry.outcome] ?? "")}>{entry.outcome}</span>
                </span>
                <small className="int-line">
                  {entry.destination ? <code className="int-mono">{entry.destination}</code> : "—"} · <code className="int-mono">{entry.operation}</code> · {formatWhen(entry.at)}
                  {entry.reason ? ` · ${entry.reason}` : ""}
                </small>
              </div>
            </div>
          ))
        )}
      </Group>
      {editing && (
        <CredentialSheet
          credential={editing === "new" ? undefined : editing}
          close={() => setEditing(undefined)}
          saved={(name, added) => {
            setEditing(undefined);
            setError("");
            setNote((added ? "Saved " : "Changed ") + name + ".");
            void load();
          }}
        />
      )}
      {browsing && (
        <BrowseSheet
          status={browsing}
          close={() => setBrowsing(undefined)}
          linked={(name, copied) => {
            setBrowsing(undefined);
            setError("");
            setNote(
              copied
                ? `Copied ${name} into the Botkins vault (marked as a copy from ${browsing.name}).`
                : `Saved ${name}. It is read from ${browsing.name} each time it is used.`,
            );
            void load();
          }}
        />
      )}
      {dialogs.node}
      {proton.view && <ProtonPassSheet setup={proton} />}
    </>
  );
}

/** One password manager: its state in plain words and the one next step. */
function ManagerRow({
  id,
  status,
  unlockedHere,
  browse,
  lock,
  unlocked,
  locked,
}: {
  id: PasswordManagerId;
  status?: PasswordManagerStatus;
  unlockedHere?: boolean;
  browse?: () => void;
  lock?: () => void;
  unlocked?: (next: PasswordManagerStatus) => void;
  locked?: boolean;
}) {
  const Icon = MANAGER_ICON[id];
  const name = status?.name ?? MANAGER_NAMES[id];
  const b = badge(status);
  const facts = status?.state === "ready" ? [status.account, status.version && "Version " + status.version].filter(Boolean).join(" · ") : "";
  return (
    <div className="set-row scred-manager" role="group" aria-label={name}>
      <span className="scred-mark" aria-hidden="true">
        <Icon size={17} />
      </span>
      <div className="set-label">
        <span className="int-title">
          <span className="set-name">{name}</span>
          <span className={"set-pill " + b.tone}>{b.label}</span>
        </span>
        {status?.state === "ready" ? (
          <small>{facts || "Signed in on this computer."}</small>
        ) : (
          status?.message && (
            <small>
              <Words text={status.message} />
            </small>
          )
        )}
        {status?.state === "missing" && status.install && <Install name={name} install={status.install} />}
        {status?.state === "locked" && status.canUnlock && unlocked && <Unlock status={status} unlocked={unlocked} />}
      </div>
      <div className="set-control">
        {status?.state === "ready" && (
          <>
            {unlockedHere && (
              <button type="button" className="set-button" onClick={lock}>
                <Lock size={14} aria-hidden="true" />
                Lock
              </button>
            )}
            <button type="button" className="set-button primary" aria-label={"Browse " + name} disabled={locked} onClick={browse}>
              Browse…
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** How to install a manager's command-line tool: the command to copy, and its guide. */
function Install({ name, install }: { name: string; install: NonNullable<PasswordManagerStatus["install"]> }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="scred-install">
      {install.command && (
        <span className="int-copy">
          <code aria-label={"Install command for " + name}>{install.command}</code>
          <button
            type="button"
            className="set-button scred-small"
            aria-label={"Copy the install command for " + name}
            onClick={() =>
              void api.copyText(install.command!).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              })
            }
          >
            <Copy size={13} aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      )}
      <button type="button" className="set-link scred-guide" onClick={() => void api.openLink(install.url)}>
        <ExternalLink size={12} aria-hidden="true" />
        {install.command ? "Install guide" : "How to install it"}
      </button>
    </span>
  );
}

/** Bitwarden's master password: sent to its tool once, never kept. */
function Unlock({ status, unlocked }: { status: PasswordManagerStatus; unlocked: (next: PasswordManagerStatus) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    if (!password || busy) return;
    const typed = password;
    // The field empties at once; the password only lives for the length of the call.
    setPassword("");
    setBusy(true);
    setError("");
    try {
      unlocked(await api.unlockPasswordManager(status.id, typed));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="scred-unlock"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <input
        type="password"
        aria-label={status.name + " master password"}
        placeholder={busy ? "Unlocking…" : "Master password"}
        autoComplete="off"
        spellCheck={false}
        value={password}
        disabled={busy}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="set-button primary" disabled={busy || !password}>
        {busy ? "Unlocking…" : "Unlock"}
      </button>
      {error ? (
        <small className="error-text" role="alert">
          {error}
        </small>
      ) : (
        <small>Sent to Bitwarden on this computer, never saved.</small>
      )}
    </form>
  );
}

/** Add one typed in by hand, or change one: name, kind, username, website, notes, and its value. */
function CredentialSheet({ credential, close, saved }: { credential?: SavedCredential; close: () => void; saved: (name: string, added: boolean) => void }) {
  const linked = !!credential && credential.source !== "vault";
  const [name, setName] = useState(credential?.name ?? "");
  const [kind, setKind] = useState<CredentialKind>(credential?.kind ?? "api-key");
  const [username, setUsername] = useState(credential?.username ?? "");
  const [website, setWebsite] = useState(credential?.website ?? "");
  const [aliasesText, setAliasesText] = useState((credential?.aliases ?? []).join(", "));
  const [notes, setNotes] = useState(credential?.notes ?? "");
  const [value, setValue] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [replacingTotp, setReplacingTotp] = useState(false);
  const [replacing, setReplacing] = useState(!credential);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valueId = useRef("scred-value-" + Math.random().toString(36).slice(2)).current;
  async function submit() {
    if (busy) return;
    if (!name.trim()) return setError("Give it a name.");
    if (!credential && !value.trim()) return setError("Enter the " + VALUE_LABEL[kind].toLowerCase() + " to save.");
    const aliases = aliasesText
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const input: SavedCredentialInput = {
      ...(credential && { id: credential.id }),
      name: name.trim(),
      ...(!linked && { kind }),
      username: username.trim(),
      website: website.trim(),
      aliases,
      notes: notes.trim(),
      value: !linked && replacing && value ? value : null,
      ...(!linked && kind !== "totp" && (replacingTotp || (!credential?.hasTotp && totpSecret.trim())) ? { totpSecret: totpSecret.trim() || "" } : {}),
    };
    // The value leaves the field as soon as it is on its way, and is never shown again.
    setValue("");
    setTotpSecret("");
    setBusy(true);
    setError("");
    try {
      await api.saveSavedCredential(input);
      input.value = null;
      input.totpSecret = null;
      saved(name.trim(), !credential);
    } catch (e) {
      input.value = null;
      input.totpSecret = null;
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={credential ? "Edit " + credential.name : "Add credential"}
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
            {busy ? "Saving…" : credential ? "Save changes" : "Save credential"}
          </button>
        </>
      }
    >
      <label>
        Name
        <input required autoFocus maxLength={80} placeholder="GitHub token" value={name} onChange={(e) => setName(e.target.value)} />
        <small className="int-hint">Bots and your phones show it by this name.</small>
      </label>
      {!linked && (
        <div className="int-field">
          <span className="int-field-label" id="scred-kind">
            Kind
          </span>
          <div className="int-kind">
            <div className="segmented" role="radiogroup" aria-labelledby="scred-kind">
              {(Object.keys(KIND_LABEL) as CredentialKind[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <label>
        Username <span className="int-hint">(optional)</span>
        <input maxLength={200} spellCheck={false} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label>
        Website <span className="int-hint">(optional)</span>
        <input maxLength={300} spellCheck={false} placeholder="https://github.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </label>
      <label>
        Other domains / aliases <span className="int-hint">(optional, comma-separated)</span>
        <input maxLength={600} spellCheck={false} placeholder="login.example.com, app.example.com" value={aliasesText} onChange={(e) => setAliasesText(e.target.value)} />
        <small className="int-hint">Matches subdomains and saved aliases when a bot looks up logins for a site.</small>
      </label>
      <label>
        Notes <span className="int-hint">(optional)</span>
        <textarea maxLength={2000} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {!linked && kind !== "totp" && (
        credential?.hasTotp && !replacingTotp ? (
          <div className="int-field">
            <span className="int-field-label">2FA / TOTP secret</span>
            <span className="scred-kept">
              <small className="int-hint">Saved for 2FA codes. It isn't shown.</small>
              <button type="button" className="set-button scred-small" onClick={() => setReplacingTotp(true)}>
                Replace 2FA secret
              </button>
            </span>
          </div>
        ) : (
          <label>
            2FA / TOTP secret <span className="int-hint">(optional)</span>
            <input
              type="password"
              spellCheck={false}
              autoComplete="off"
              maxLength={512}
              placeholder="Base32 key or otpauth://totp/…"
              value={totpSecret}
              onChange={(e) => setTotpSecret(e.target.value)}
            />
            <small className="int-hint">Generates 6-digit 2FA codes on demand under the same approval rules.</small>
          </label>
        )
      )}
      {linked ? (
        <p className="int-hint scred-linked">
          Read from {managerName(credential.source)}
          {credential.reference ? ": " + credential.reference : ""}. Change the value there.
        </p>
      ) : replacing ? (
        <label htmlFor={valueId}>
          {credential ? "New " + VALUE_LABEL[kind].toLowerCase() : VALUE_LABEL[kind]}
          {kind === "note" ? (
            <textarea id={valueId} className="scred-masked" rows={3} spellCheck={false} autoComplete="off" maxLength={16000} value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input id={valueId} type="password" spellCheck={false} autoComplete="off" maxLength={16000} value={value} onChange={(e) => setValue(e.target.value)} />
          )}
          <small className="int-hint">
            {credential ? "Leave it empty to keep the saved one. " : ""}Kept encrypted on this computer. It is never shown again and never sent to a phone.
          </small>
        </label>
      ) : (
        <div className="int-field">
          <span className="int-field-label">{VALUE_LABEL[kind]}</span>
          <span className="scred-kept">
            <small className="int-hint">Saved on this computer. It isn't shown.</small>
            <button type="button" className="set-button scred-small" onClick={() => setReplacing(true)}>
              Replace value
            </button>
          </span>
        </div>
      )}
    </Sheet>
  );
}

type ItemField = NonNullable<PasswordManagerItem["fields"]>[number];

/** Pick a vault, an item and one of its fields, name it, and link (recommended) or explicitly copy into Botkins. */
function BrowseSheet({ status, close, linked }: { status: PasswordManagerStatus; close: () => void; linked: (name: string, copied?: boolean) => void }) {
  const manager = status.id;
  const [vaults, setVaults] = useState<PasswordManagerVault[] | null>();
  const [vault, setVault] = useState<PasswordManagerVault>();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PasswordManagerItem[] | null>();
  const [item, setItem] = useState<PasswordManagerItem>();
  const [detail, setDetail] = useState<PasswordManagerItem | null>();
  const [field, setField] = useState<ItemField>();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"link" | "copy">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .passwordManagerVaults(manager)
      .then((list) => {
        if (!live) return;
        setVaults(list);
        // One vault: straight to its items.
        if (list.length === 1) setVault(list[0]);
      })
      .catch((e) => {
        if (!live) return;
        setVaults(null);
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [manager, round]);
  // Items are searched on the computer, a moment after typing stops.
  useEffect(() => {
    if (!vault) return;
    let live = true;
    const text = query.trim();
    const timer = setTimeout(
      () =>
        void api
          .passwordManagerItems(manager, vault.id, text || undefined)
          .then((list) => live && setItems(list))
          .catch((e) => {
            if (!live) return;
            setItems(null);
            setError(errorText(e));
          }),
      text ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [manager, vault, query, round]);
  useEffect(() => {
    if (!vault || !item) return;
    let live = true;
    api
      .passwordManagerItem(manager, vault.id, item.id)
      .then((full) => {
        if (!live) return;
        setDetail(full);
        // The usual choice is the one hidden field (a password or a token): picked already.
        const secret = (full.fields ?? []).filter((f) => f.secret);
        if (secret.length === 1) choose(secret[0], full);
      })
      .catch((e) => {
        if (!live) return;
        setDetail(null);
        setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [manager, vault, item, round]);
  function choose(next: ItemField, of = detail) {
    setField(next);
    setName(((of?.title ?? item?.title ?? "") + " " + next.label).trim().slice(0, 80));
  }
  const toVaults = () => {
    setVault(undefined);
    setItems(undefined);
    setQuery("");
    toItems();
  };
  function toItems() {
    setItem(undefined);
    setDetail(undefined);
    setField(undefined);
    setName("");
  }
  async function submit() {
    if (!vault || !item || !field || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const payload = { manager, vaultId: vault.id, itemId: item.id, fieldId: field.id, name: name.trim() };
      if (mode === "copy") {
        await api.copyPasswordManagerField(payload);
        linked(name.trim(), true);
      } else {
        await api.linkPasswordManagerField(payload);
        linked(name.trim(), false);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  const step: ReactNode = !vault ? (
    vaults === undefined ? (
      <p className="int-hint">Loading vaults…</p>
    ) : (
      <div className="scred-list" role="list" aria-label="Vaults">
        {(vaults ?? []).map((v) => (
          <button type="button" role="listitem" key={v.id} className="scred-choice" onClick={() => setVault(v)}>
            <span>{v.name}</span>
            {v.count !== undefined && <small>{v.count}</small>}
          </button>
        ))}
        {vaults?.length === 0 && <p className="int-hint">No vaults.</p>}
        {vaults === null && (
          <button type="button" className="set-button" onClick={() => setRound(round + 1)}>
            Try again
          </button>
        )}
      </div>
    )
  ) : !item ? (
    <>
      <span className="int-filter scred-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label={"Search " + vault.name}
          placeholder={"Search " + vault.name}
          autoFocus
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        />
      </span>
      {items === undefined ? (
        <p className="int-hint">Loading items…</p>
      ) : (
        <div className="scred-list" role="list" aria-label="Items">
          {(items ?? []).map((i) => (
            <button
              type="button"
              role="listitem"
              key={i.id}
              className="scred-choice"
              onClick={() => {
                setDetail(undefined);
                setField(undefined);
                setItem(i);
              }}
            >
              <span>{i.title}</span>
              {i.subtitle && <small>{i.subtitle}</small>}
            </button>
          ))}
          {items?.length === 0 && <p className="int-hint">{query.trim() ? "Nothing matches." : "No items."}</p>}
          {items === null && (
            <button type="button" className="set-button" onClick={() => setRound(round + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
    </>
  ) : detail === undefined ? (
    <p className="int-hint">Loading {item.title}…</p>
  ) : (
    <>
      <div className="int-field">
        <span className="int-field-label" id="scred-fields">
          Which field?
        </span>
        <div className="scred-list" role="radiogroup" aria-labelledby="scred-fields">
          {(detail?.fields ?? []).map((f) => (
            <button type="button" role="radio" aria-checked={field?.id === f.id} key={f.id} className="scred-choice" onClick={() => choose(f)}>
              <span>{f.label}</span>
              {f.secret && <Lock size={13} aria-label="Hidden" />}
            </button>
          ))}
          {detail?.fields?.length === 0 && <p className="int-hint">This item has no fields to link.</p>}
          {detail === null && (
            <button type="button" className="set-button" onClick={() => setRound(round + 1)}>
              Try again
            </button>
          )}
        </div>
      </div>
      {field && (
        <>
          <label>
            Name
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="int-field">
            <span className="int-field-label" id="scred-storage-mode">
              How to store it
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="scred-storage-mode">
              <button type="button" role="radio" aria-checked={mode === "link"} onClick={() => setMode("link")}>
                Link (read on demand)
              </button>
              <button type="button" role="radio" aria-checked={mode === "copy"} onClick={() => setMode("copy")}>
                Copy into Botkins vault
              </button>
            </div>
            <small className="int-hint">
              {mode === "link"
                ? `Recommended: Botkins saves only where to find it. The value stays in ${status.name} and is read on demand.`
                : `Explicit copy: the current value is encrypted in Botkins' local vault and marked as a copy. Future changes in ${status.name} will not sync.`}
            </small>
          </div>
        </>
      )}
    </>
  );
  return (
    <Sheet
      title={"Browse " + status.name}
      wide
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
          <button className="set-button primary" disabled={busy || !field || !name.trim()}>
            {busy ? "Saving…" : "Save credential"}
          </button>
        </>
      }
    >
      {vault && (
        <nav className="scred-crumbs" aria-label="Where you are">
          <button type="button" className="int-icon" aria-label={item ? "Back to " + vault.name : "Back to vaults"} onClick={item ? toItems : toVaults}>
            <ChevronLeft size={15} />
          </button>
          {item ? (
            <>
              <button type="button" className="set-link" onClick={toItems}>
                {vault.name}
              </button>
              <span aria-hidden="true">/</span>
              <strong>{item.title}</strong>
            </>
          ) : (
            <strong>{vault.name}</strong>
          )}
        </nav>
      )}
      {step}
    </Sheet>
  );
}
