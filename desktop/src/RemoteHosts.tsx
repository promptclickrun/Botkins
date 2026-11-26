// Using another computer's Botkins from this window (desktop/remotehosts.mjs): the switcher in the
// side menu, the line across the top that says whose bots these are, the main window's state while
// that computer can't be reached, the pairing and team join forms (also used by the first-run
// steps, src/SetupChoice.tsx) and Settings › Computers and teams.
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Check, ChevronsUpDown, Monitor, MonitorSmartphone, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import type { ProfileHost, RemoteHost, State, TeamJoinState, TeamJoinTarget } from "./types";
import { Group, errorText } from "./SettingsRows";
import "./remotehosts.css";

const api = window.botkins;
const STATES: Record<string, string> = { connecting: "Connecting…", online: "Connected", offline: "Can't be reached", revoked: "No longer paired", idle: "" };
const said = (e: unknown) => errorText(e);
const memberLabel = (team?: string) => (team ? "Member of " + team : "");
/** A paired computer by its name; a team by the team's name. */
const rowName = (host: RemoteHost) => (host.member && host.team) || host.name;

/** How a host in use is doing, in a few words. */
export function hostLine(using: NonNullable<State["remote"]>["using"]) {
  if (!using) return "";
  if (using.state === "online") return using.route === "relay" ? "Connected through the relay" : "Connected";
  return STATES[using.state] ?? "";
}

/** Closes an open menu on a click outside `box` or on Escape. */
function useDismiss(open: boolean, close: () => void, box: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
}

/** The model providers as the side menu's computer row shows them: its quiet line and a row of its menu. */
export type HostModels = { label: string; line: string; on: boolean; icons: ReactNode; open: () => void };

/**
 * The side menu's one bottom row: which computer's bots the window shows, with the model providers
 * on its quiet line. Its menu switches computers, connects another, and opens the model providers
 * and (while it is on) Admin mode. Shown always, so the computer in use is never a guess.
 */
export function HostSwitcher({
  state,
  collapsed,
  connect,
  admin,
  models,
}: {
  state: State;
  collapsed: boolean;
  connect: () => void;
  /** Opens Settings › Team, from the Admin mode row. */
  admin: () => void;
  models: HostModels;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  // Where the menu goes: above the button, measured when it opens, so a narrow side menu doesn't cut it off.
  const [place, setPlace] = useState<{ left: number; bottom: number }>();
  const box = useRef<HTMLDivElement>(null);
  const remote = state.remote;
  const using = remote?.using ?? null;
  useDismiss(open, () => setOpen(false), box);
  const hosts = remote?.hosts ?? [];
  const use = (id: string | null) => {
    setOpen(false);
    setError("");
    void api.useRemoteHost(id).catch((e) => setError(said(e)));
  };
  const name = using ? using.name : "This computer";
  return (
    <div className="host-switch" ref={box}>
      <button
        type="button"
        className={"account host-button" + (using ? " remote" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={"Computer: " + name + (state.adminMode ? ". Admin mode" : "") + (using ? ". " + hostLine(using) : "") + ". Switch computer"}
        title={collapsed ? name : undefined}
        onClick={(e) => {
          const at = e.currentTarget.getBoundingClientRect();
          setPlace({ left: at.left + 4, bottom: window.innerHeight - at.top + 6 });
          setOpen((o) => !o);
        }}
      >
        <span className="host-glyph" aria-hidden="true">
          {using ? <MonitorSmartphone size={16} /> : <Monitor size={16} />}
          <i className="host-dot" data-state={using ? using.state : models.on ? "online" : "offline"} />
        </span>
        <span className="nav-label">
          <span className="host-name">
            {name}
            {/* While Admin mode is on, the computer's name says so. */}
            {state.adminMode && <span className="admin-tag">Admin</span>}
          </span>
          <small>{using ? (using.member ? memberLabel(using.team) : hostLine(using)) : models.line}</small>
        </span>
        <ChevronsUpDown size={14} className="host-chevron" aria-hidden="true" />
      </button>
      {error && (
        <small className="host-error" role="alert">
          {error}
        </small>
      )}
      {open && (
        <div className="host-menu" role="menu" aria-label="Computers" style={place}>
          <button type="button" role="menuitemradio" aria-checked={!using} onClick={() => use(null)}>
            <Monitor size={15} aria-hidden="true" />
            <span>This computer</span>
            {!using && <Check size={14} aria-hidden="true" />}
          </button>
          {hosts.map((host) => (
            <button type="button" role="menuitemradio" aria-checked={host.current} key={host.id} onClick={() => use(host.id)}>
              <MonitorSmartphone size={15} aria-hidden="true" />
              <span>
                {host.name}
                {host.member && host.team ? <small>{memberLabel(host.team)}</small> : host.current && host.state && <small>{STATES[host.state] ?? ""}</small>}
              </span>
              {host.current && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              connect();
            }}
          >
            <Plus size={15} aria-hidden="true" />
            <span>Connect to another computer…</span>
          </button>
          <hr />
          {/* The model providers of the computer in use: the row that stood under this one before. */}
          <button
            type="button"
            role="menuitem"
            aria-label={models.label}
            onClick={() => {
              setOpen(false);
              models.open();
            }}
          >
            <span className="host-menu-icons" aria-hidden="true">
              {models.icons}
            </span>
            <span>
              Model providers
              <small>{models.line}</small>
            </span>
          </button>
          {state.adminMode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                admin();
              }}
            >
              <ShieldCheck size={15} aria-hidden="true" />
              <span>
                Admin mode
                <small>On: you see every member's spaces, bots and chats</small>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The line across the top while another computer is in use: whose bots these are, and the way back. */
export function HostBanner({ state, pairAgain }: { state: State; pairAgain: () => void }) {
  const using = state.remote?.using;
  const [busy, setBusy] = useState(false);
  // While the other computer answers, the side menu's computer row already says whose bots these
  // are, and its menu has "This computer". The line across the top is for trouble only.
  if (!using || using.state === "online") return null;
  const back = () => {
    setBusy(true);
    void api.useRemoteHost(null).finally(() => setBusy(false));
  };
  return (
    <div className="host-banner" data-state={using.state} role="status" aria-label="Computer in use">
      <MonitorSmartphone size={15} aria-hidden="true" />
      <span className="host-banner-text">
        {using.state === "revoked" ? (
          <>
            <strong>{using.name}</strong> no longer knows this computer. Pair again to use it.
          </>
        ) : using.state === "offline" ? (
          <>
            <strong>{using.name}</strong> can't be reached. Botkins keeps trying; what you see may be out of date.
          </>
        ) : (
          <>
            Using <strong>{using.name}</strong>
            <span className="host-banner-state"> · {using.member ? memberLabel(using.team) : hostLine(using)}</span>
          </>
        )}
      </span>
      {using.state === "revoked" && (
        <button type="button" className="secondary" onClick={pairAgain}>
          Pair again
        </button>
      )}
      <button type="button" className="secondary" disabled={busy} onClick={back}>
        Use this computer
      </button>
    </div>
  );
}

/**
 * The main window while the computer in use has sent nothing yet: it can't be reached, a different
 * computer answered at its address, or it no longer knows this one. Shown in place of the page, so
 * nothing (a first bot, a chat) is sent to a computer that isn't there; the switcher stays in the side menu.
 */
export function HostUnreachable({ state, pairAgain }: { state: State; pairAgain: () => void }) {
  const using = state.remote?.using;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!using) return null;
  const go = (id: string | null) => {
    setBusy(true);
    setError("");
    // Choosing the computer in use again makes it try again at once (desktop/remotehosts.mjs `use`).
    void api
      .useRemoteHost(id)
      .catch((e) => setError(said(e)))
      .finally(() => setBusy(false));
  };
  const connecting = using.state === "connecting" || using.state === "idle";
  return (
    <div className="content host-down" data-state={using.state}>
      <div className="host-down-card" role="status" aria-label="Computer in use">
        <span className="host-row-glyph computer" aria-hidden="true">
          <MonitorSmartphone size={22} />
        </span>
        <h1>{connecting ? "Connecting to " + using.name + "…" : using.state === "revoked" ? using.name + " no longer knows this computer" : using.name + " can't be reached"}</h1>
        <p>
          {connecting
            ? "This window shows the bots and chats on " + using.name + ". They appear here once it answers."
            : using.state === "revoked"
              ? "Pair again to use it, or go back to the bots on this computer."
              : "It may be off, asleep or on another network, or a different computer answered at its address. Botkins keeps trying."}
        </p>
        <div className="host-down-actions">
          <button type="button" className="set-button primary" disabled={busy} onClick={() => go(null)}>
            Use this computer instead
          </button>
          {using.state === "revoked" ? (
            <button type="button" className="set-button" onClick={pairAgain}>
              Pair again
            </button>
          ) : (
            !connecting && (
              <button type="button" className="set-button" disabled={busy} onClick={() => go(using.id)}>
                Try again
              </button>
            )
          )}
        </div>
        {error && (
          <small className="host-error" role="alert">
            {error}
          </small>
        )}
        <small className="host-down-foot">You can also switch computers from the side menu.</small>
      </div>
    </div>
  );
}

/**
 * Pairing with another computer: its pairing link, or its address and code. `paired` runs with
 * the new pairing and may say what happens next in its own words; a failure in it shows inline too.
 */
export function PairForm({ paired }: { paired: (host: { id: string; name: string }) => Promise<string | void> | string | void }) {
  const [link, setLink] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const ready = !!link.trim() || (!!address.trim() && !!code.trim());
  const pair = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const host = await api.pairRemoteHost(link.trim() ? { link: link.trim() } : { address: address.trim(), code: code.trim() });
      setLink("");
      setAddress("");
      setCode("");
      setNote((await paired(host)) || "");
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="host-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void pair();
      }}
    >
      <label className="host-form-label" htmlFor="host-pair-link">
        Pairing link or code
      </label>
      <div className="host-form-line">
        <input id="host-pair-link" aria-label="Pairing link" placeholder="Paste the link, or type the address and code below" value={link} spellCheck={false} autoComplete="off" onChange={(e) => setLink(e.target.value)} />
        <button type="submit" className="set-button primary" disabled={!ready || busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      <div className="host-form-line">
        <input aria-label="Address of the other computer" placeholder="Address, like 192.168.1.20" value={address} spellCheck={false} autoComplete="off" disabled={!!link.trim()} onChange={(e) => setAddress(e.target.value)} />
        <input aria-label="Pairing code" placeholder="Code" value={code} spellCheck={false} autoComplete="off" disabled={!!link.trim()} onChange={(e) => setCode(e.target.value)} />
      </div>
      <small className="host-form-help">
        On the other computer, open Settings › Phone, turn on access and choose Pair, or run <code>botkins pair</code> on a server.
      </small>
      {error && (
        <small className="host-error" role="alert">
          {error}
        </small>
      )}
      {note && <small role="status">{note}</small>}
    </form>
  );
}

/**
 * Joining a team with the invite code or link its owner sent: find the team, accept, then wait for
 * the owner's approval (checked every ten seconds while the window is visible, and on focus).
 * `approved` runs once with the team's host id when the owner lets this computer in.
 */
export function TeamJoin({ initialJoin, approved }: { initialJoin?: string; approved?: (hostId: string) => void }) {
  const [teamInput, setTeamInput] = useState("");
  const [teamTarget, setTeamTarget] = useState<TeamJoinTarget>();
  const [teamJoin, setTeamJoin] = useState<TeamJoinState>();
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState("");
  const showTeam = (next: TeamJoinState) => {
    setTeamJoin(next);
    setTeamError("");
  };
  const findTeam = async (input: string) => {
    setTeamBusy(true);
    setTeamError("");
    setTeamInput(input);
    try {
      setTeamTarget(await api.findTeamInvite(input));
    } catch (e) {
      const message = said(e);
      setTeamError(/expired|closed|ten-character|couldn't be opened/i.test(message) ? "This invite has expired or was used." : message);
    } finally {
      setTeamBusy(false);
    }
  };
  const acceptTeam = async () => {
    if (!teamTarget) return;
    setTeamBusy(true);
    setTeamError("");
    try {
      showTeam(await api.startTeamJoin(teamTarget));
    } catch (e) {
      setTeamError(said(e));
    } finally {
      setTeamBusy(false);
    }
  };
  const cancelTeam = async () => {
    if (teamJoin) await api.cancelTeamJoin(teamJoin.id).catch(() => {});
    setTeamJoin(undefined);
    setTeamTarget(undefined);
    setTeamInput("");
    setTeamError("");
  };
  const checkTeam = async () => {
    if (!teamJoin || !["pending", "offline"].includes(teamJoin.status)) return;
    try {
      showTeam(await api.checkTeamJoin(teamJoin.id));
    } catch (e) {
      setTeamError(said(e));
    }
  };
  useEffect(() => {
    if (initialJoin) void findTeam(initialJoin);
  }, [initialJoin]);
  useEffect(() => {
    let live = true;
    api
      .teamJoins()
      .then((items) => {
        if (live && items[0] && !teamJoin) showTeam(items[0]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!teamJoin || !["pending", "offline"].includes(teamJoin.status)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void checkTeam();
    }, 10_000);
    const focus = () => {
      if (document.visibilityState === "visible") void checkTeam();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [teamJoin?.id, teamJoin?.status]);
  // Once per approval: the id of an approved join is the team's host.
  const told = useRef("");
  useEffect(() => {
    if (teamJoin?.status !== "approved" || !approved || told.current === teamJoin.id) return;
    told.current = teamJoin.id;
    approved(teamJoin.id);
  }, [teamJoin?.id, teamJoin?.status]);
  return (
    <div className="host-team">
      {teamJoin?.status === "pending" || teamJoin?.status === "offline" ? (
        <div className="host-join-message" role="status">
          <strong>The request has been sent to the owner of the team.</strong>
          <small>Waiting for {teamJoin.team}.</small>
          {teamJoin.status === "offline" && <small>Can't reach {teamJoin.team} right now. Try again when the owner's computer is on.</small>}
          <div className="host-join-actions">
            <button type="button" className="set-button" disabled={teamBusy} onClick={() => void checkTeam()}>
              Check now
            </button>
            <button type="button" className="set-button" disabled={teamBusy} onClick={() => void cancelTeam()}>
              Cancel
            </button>
          </div>
        </div>
      ) : teamJoin?.status === "approved" ? (
        <div className="host-join-message" role="status">
          <strong>You're in. Welcome to {teamJoin.team}.</strong>
          {!approved && (
            <>
              <small>Press Use beside the team, or choose it in the computer switcher.</small>
              <button type="button" className="set-button" onClick={() => void cancelTeam()}>
                Done
              </button>
            </>
          )}
        </div>
      ) : teamJoin?.status === "denied" ? (
        <div className="host-join-message" role="status">
          <strong>The owner didn't approve this request.</strong>
          <button type="button" className="set-button" onClick={() => void cancelTeam()}>
            Done
          </button>
        </div>
      ) : teamJoin?.status === "closed" ? (
        <div className="host-join-message" role="status">
          <strong>This invite has expired or was used.</strong>
          <button type="button" className="set-button" onClick={() => void cancelTeam()}>
            Try another
          </button>
        </div>
      ) : teamTarget ? (
        <div className="host-join-confirm" role="status">
          <strong>Join {teamTarget.name}?</strong>
          <div className="host-join-actions">
            <button type="button" className="set-button primary" disabled={teamBusy} onClick={() => void acceptTeam()}>
              Accept
            </button>
            <button type="button" className="set-button" disabled={teamBusy} onClick={() => void cancelTeam()}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form
          className="host-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (teamInput.trim() && !teamBusy) void findTeam(teamInput);
          }}
        >
          <label className="host-form-label" htmlFor="host-team-code">
            Invite code or link
          </label>
          <div className="host-form-line">
            <input
              id="host-team-code"
              aria-label="Team invite code or link"
              placeholder="XXXXX-XXXXX or botkins://join?…"
              value={teamInput}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setTeamInput(e.target.value);
                setTeamError("");
              }}
            />
            <button type="submit" className="set-button primary" disabled={!teamInput.trim() || teamBusy}>
              {teamBusy ? "Finding…" : "Join with a code"}
            </button>
          </div>
          <small className="host-form-help">The owner sends it from Settings › Team › Invite.</small>
        </form>
      )}
      {teamError && (
        <small className="host-error" role="alert">
          {teamError}
        </small>
      )}
    </div>
  );
}

/** A row's More menu: Rename and Unpair (or Remove, for a team), opened above or below the button as there is room. */
function MoreMenu({ host, busy, rename, forget }: { host: RemoteHost; busy: boolean; rename: () => void; forget: () => void }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ right: number; top: number }>();
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="host-more" ref={box}>
      <button
        type="button"
        className="set-button host-more-button"
        aria-label={"More for " + host.name}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          const at = e.currentTarget.getBoundingClientRect();
          setPlace({ right: window.innerWidth - at.right, top: at.bottom + 4 });
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="host-menu" role="menu" aria-label={"More for " + host.name} style={place}>
          <button type="button" role="menuitem" onClick={pick(rename)}>
            <Pencil size={15} aria-hidden="true" />
            <span>Rename</span>
          </button>
          <button type="button" role="menuitem" className="danger" aria-label={(host.member ? "Remove " : "Unpair ") + host.name} onClick={pick(forget)}>
            <Trash2 size={15} aria-hidden="true" />
            <span>{host.member ? "Remove from this computer" : "Unpair"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Settings › Computers and teams: whose bots this window shows. This computer, each paired
 * computer and each team this computer is a member of, each with Use; then pairing with one more
 * computer and joining a team. A team invite link opened from outside lands on the join form.
 */
export function ComputersAndTeams({ state, initialJoin }: { state: State; initialJoin?: string }) {
  const hosts: RemoteHost[] = state.remote?.hosts ?? [];
  const profileHosts: ProfileHost[] = state.profile?.hosts ?? [];
  const using = state.remote?.using ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState<"" | "computer" | "team">(initialJoin ? "team" : "");
  // A join request still waiting for its owner keeps the join form open.
  useEffect(() => {
    let live = true;
    api
      .teamJoins()
      .then((items) => live && items.length > 0 && setAdding((now) => now || "team"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const run = async (action: () => Promise<unknown>, done = "") => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await action();
      setNote(done);
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  const inUse = (
    <span className="host-in-use">
      <Check size={15} aria-hidden="true" />
      In use
    </span>
  );
  const bots = state.bots.length;
  const row = (host: RemoteHost) => (
    <div className="set-row host-row" key={host.id}>
      <span className={"host-row-glyph " + (host.member ? "team" : "computer")} aria-hidden="true">
        {host.member ? <Users size={17} /> : <MonitorSmartphone size={17} />}
      </span>
      <div className="set-label">
        {renaming?.id === host.id ? (
          <form
            className="host-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.renameRemoteHost(host.id, renaming.name)).then(() => setRenaming(null));
            }}
          >
            <input aria-label={"Name for " + host.name} value={renaming.name} maxLength={60} autoFocus onChange={(e) => setRenaming({ id: host.id, name: e.target.value })} />
            <button type="submit" className="set-button" disabled={busy || !renaming.name.trim()}>
              Save
            </button>
            <button type="button" className="set-button" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <span className="set-name">{rowName(host)}</span>
        )}
        <small className="int-line">
          {[
            host.member ? "Member" + (host.team && host.team !== host.name ? " · on " + host.name : "") : "",
            host.current ? STATES[host.state ?? ""] : "",
            !host.member && !host.current ? "Paired " + new Date(host.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </div>
      <div className="set-control">
        {host.current ? (
          inUse
        ) : (
          <button type="button" className="set-button" disabled={busy} aria-label={"Use " + rowName(host)} onClick={() => void run(() => api.useRemoteHost(host.id))}>
            Use
          </button>
        )}
        <MoreMenu
          host={host}
          busy={busy}
          rename={() => setRenaming({ id: host.id, name: host.name })}
          forget={() => void run(() => api.forgetRemoteHost(host.id), host.member ? "Removed." : "Unpaired.")}
        />
      </div>
    </div>
  );
  const profileRow = (host: ProfileHost) => (
    <div className="set-row host-row" key={"profile-" + host.serverId}>
      <span className={"host-row-glyph " + (host.member ? "team" : "computer")} aria-hidden="true">
        {host.member ? <Users size={17} /> : <MonitorSmartphone size={17} />}
      </span>
      <div className="set-label">
        <span className="set-name">{host.name}</span>
        <small className="int-line">Profile directory · Offline{host.member ? " · Team member" : ""}</small>
      </div>
      <div className="set-control">
        <button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.profileConnect(host.serverId), "Connected to " + host.name + ".")}>Connect</button>
      </div>
    </div>
  );
  const listedOnly = profileHosts.filter((host) => !hosts.some((paired) => paired.id === host.serverId));
  return (
    <>
      <p className="host-lede">Choose whose bots this window shows. Each one keeps its own bots and chats.</p>
      <Group footer="Using another computer or a team changes nothing in this computer's own workspace. You can switch back at any time, here or in the side menu.">
        <div className="set-row host-row">
          <span className="host-row-glyph" aria-hidden="true">
            <Monitor size={17} />
          </span>
          <div className="set-label">
            <span className="set-name">This computer</span>
            <small className="int-line">{using ? "Its own bots and chats" : bots === 1 ? "1 bot" : bots + " bots"}</small>
          </div>
          <div className="set-control">
            {using ? (
              <button type="button" className="set-button" disabled={busy} aria-label="Use this computer" onClick={() => void run(() => api.useRemoteHost(null))}>
                Use
              </button>
            ) : (
              inUse
            )}
          </div>
        </div>
        {hosts.filter((host) => !host.member).map(row)}
        {hosts.filter((host) => host.member).map(row)}
        {listedOnly.length > 0 && <>
          <div className="set-subhead">Profile directory</div>
          {listedOnly.map(profileRow)}
        </>}
      </Group>
      {error && (
        <small className="host-error host-note" role="alert">
          {error}
        </small>
      )}
      {note && (
        <small className="host-note" role="status">
          {note}
        </small>
      )}
      <div className="host-add">
        <button type="button" className="set-button primary host-add-button" aria-expanded={adding === "computer"} onClick={() => setAdding(adding === "computer" ? "" : "computer")}>
          <Plus size={15} aria-hidden="true" />
          Connect another computer
        </button>
        <button type="button" className="set-button host-add-button" aria-expanded={adding === "team"} onClick={() => setAdding(adding === "team" ? "" : "team")}>
          <UserPlus size={15} aria-hidden="true" />
          Join a team
        </button>
      </div>
      {adding === "computer" && (
        <div className="host-panel">
          <PairForm paired={(host) => "Paired with " + host.name + ". Press Use beside it, or choose it in the side menu."} />
        </div>
      )}
      {adding === "team" && (
        <div className="host-panel">
          <TeamJoin initialJoin={initialJoin} />
        </div>
      )}
    </>
  );
}
