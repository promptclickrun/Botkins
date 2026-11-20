// Using another computer's Botkins from this window (desktop/remotehosts.mjs): the switcher in the
// side menu, the line across the top that says whose bots these are, and the part of Settings
// where a computer is paired, renamed and unpaired.
import { useEffect, useRef, useState } from "react";
import { Check, Monitor, MonitorSmartphone, Plus, Trash2, UserPlus } from "lucide-react";
import type { RemoteHost, State, TeamJoinState, TeamJoinTarget } from "./types";
import { Group, errorText } from "./SettingsRows";
import "./remotehosts.css";

const api = window.botkins;
const STATES: Record<string, string> = { connecting: "Connecting…", online: "Connected", offline: "Can't be reached", revoked: "No longer paired", idle: "" };
const said = (e: unknown) => errorText(e);
const memberLabel = (team?: string) => (team ? "Member of " + team : "");

/** How a host in use is doing, in a few words. */
export function hostLine(using: NonNullable<State["remote"]>["using"]) {
  if (!using) return "";
  if (using.state === "online") return using.route === "relay" ? "Connected through the relay" : "Connected";
  return STATES[using.state] ?? "";
}

/**
 * The side menu's switcher: which computer's bots the window shows, and a menu to change it.
 * Shown once a computer is paired (or when the person asks to connect one from Settings).
 */
export function HostSwitcher({ state, collapsed, connect }: { state: State; collapsed: boolean; connect: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  // Where the menu goes: above the button, measured when it opens, so a narrow side menu doesn't cut it off.
  const [place, setPlace] = useState<{ left: number; bottom: number }>();
  const box = useRef<HTMLDivElement>(null);
  const remote = state.remote;
  const using = remote?.using ?? null;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!remote?.hosts.length) return null;
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
        aria-label={"Computer: " + name + (using ? ". " + hostLine(using) : "") + ". Switch computer"}
        title={collapsed ? name : undefined}
        onClick={(e) => {
          const at = e.currentTarget.getBoundingClientRect();
          setPlace({ left: at.left + 4, bottom: window.innerHeight - at.top + 6 });
          setOpen((o) => !o);
        }}
      >
        <span className="host-glyph" aria-hidden="true">
          {using ? <MonitorSmartphone size={17} /> : <Monitor size={17} />}
          {using && <i className="host-dot" data-state={using.state} />}
        </span>
        <span className="nav-label">
          {name}
          {using && <small>{using.member ? memberLabel(using.team) : hostLine(using)}</small>}
        </span>
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
          {remote.hosts.map((host) => (
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
        </div>
      )}
    </div>
  );
}

/** The line across the top while another computer is in use: whose bots these are, and the way back. */
export function HostBanner({ state, pairAgain }: { state: State; pairAgain: () => void }) {
  const using = state.remote?.using;
  const [busy, setBusy] = useState(false);
  if (!using) return null;
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

/** Settings: the computers this app is paired to, and pairing with one more. */
export function OtherComputers({ state, initialJoin }: { state: State; initialJoin?: string }) {
  const hosts: RemoteHost[] = state.remote?.hosts ?? [];
  const [link, setLink] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
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
  const run = async (action: () => Promise<unknown>, done = "") => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      // An action may say what it did in its own words.
      const told = await action();
      setNote(typeof told === "string" ? told : done);
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  const pair = () =>
    run(async () => {
      const paired = await api.pairRemoteHost(link.trim() ? { link: link.trim() } : { address: address.trim(), code: code.trim() });
      setLink("");
      setAddress("");
      setCode("");
      return "Paired with " + paired.name + ". Choose it in the side menu, or press Use.";
    });
  const ready = !!link.trim() || (!!address.trim() && !!code.trim());
  return (
    <Group title="Other computers" footer="Use the Botkins on another computer from this window: its bots, chats, tasks and Today. This computer's own workspace stays as it is, and you can switch back at any time.">
      {hosts.map((host) => (
        <div className="set-row int-item compact" key={host.id}>
          <span className="int-glyph" aria-hidden="true">
            <MonitorSmartphone size={14} />
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
              <span className="set-name">{host.name}</span>
            )}
            <small className="int-line">
              {host.member && host.team
                ? memberLabel(host.team)
                : host.current
                  ? "In use" + (host.state ? " · " + (STATES[host.state] ?? "") : "")
                  : "Paired " + new Date(host.addedAt).toLocaleDateString()}
            </small>
          </div>
          <div className="set-control">
            <button type="button" className="set-button" disabled={busy} onClick={() => void run(() => api.useRemoteHost(host.current ? null : host.id))}>
              {host.current ? "Use this computer" : "Use"}
            </button>
            <button type="button" className="set-button" disabled={busy} onClick={() => setRenaming({ id: host.id, name: host.name })}>
              Rename
            </button>
            <button type="button" className="set-button danger" disabled={busy} aria-label={"Unpair " + host.name} onClick={() => void run(() => api.forgetRemoteHost(host.id), "Unpaired.")}>
              <Trash2 size={13} aria-hidden="true" />
              Unpair
            </button>
          </div>
        </div>
      ))}
      <div className="set-row stacked host-team-join">
        <div className="set-label">
          <span className="set-name host-team-title">
            <UserPlus size={15} aria-hidden="true" />
            Join a team
          </span>
          <small>Enter an invite code or paste the link the owner sent.</small>
        </div>
        {teamJoin?.status === "pending" || teamJoin?.status === "offline" ? (
          <div className="host-join-message" role="status">
            <strong>The request has been sent to the owner of the team.</strong>
            <small>Waiting for {teamJoin.team}.</small>
            {teamJoin.status === "offline" && (
              <small>Can't reach {teamJoin.team} right now. Try again when the owner's computer is on.</small>
            )}
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
            <small>Choose this team in the computer switcher.</small>
            <button type="button" className="set-button" onClick={() => void cancelTeam()}>
              Done
            </button>
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
            className="host-team-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (teamInput.trim() && !teamBusy) void findTeam(teamInput);
            }}
          >
            <input
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
            <button type="submit" className="set-button" disabled={!teamInput.trim() || teamBusy}>
              {teamBusy ? "Finding…" : "Join with a code"}
            </button>
          </form>
        )}
        {teamError && (
          <small className="host-error" role="alert">
            {teamError}
          </small>
        )}
      </div>
      <div className="set-row host-pair">
        <div className="set-label">
          <span className="set-name">Connect to another computer</span>
          <small>On the other computer, open Settings › Phone, turn on access and choose Pair. Paste the pairing link it shows, or type its address and the code.</small>
          <form
            className="host-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && !busy) void pair();
            }}
          >
            <input aria-label="Pairing link" placeholder="botkins://pair?…" value={link} spellCheck={false} autoComplete="off" onChange={(e) => setLink(e.target.value)} />
            <span className="host-or">or</span>
            <input aria-label="Address of the other computer" placeholder="192.168.1.20" value={address} spellCheck={false} autoComplete="off" disabled={!!link.trim()} onChange={(e) => setAddress(e.target.value)} />
            <input aria-label="Pairing code" placeholder="Code" value={code} spellCheck={false} autoComplete="off" disabled={!!link.trim()} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="set-button" disabled={!ready || busy}>
              {busy ? "Pairing…" : "Pair"}
            </button>
          </form>
          {error && (
            <small className="host-error" role="alert">
              {error}
            </small>
          )}
          {note && <small role="status">{note}</small>}
        </div>
      </div>
    </Group>
  );
}
