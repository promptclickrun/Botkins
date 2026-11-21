// Share, on a space's page: who can open it. Four choices (only the maker, members the maker picks,
// all members, anyone with the link), what the picked members may do, the link, and the person's
// own "Notify me". Every change goes to the computer at once; a refusal is shown in its own words
// and the choice goes back.
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "lucide-react";
import { useAsk } from "./Pages";
import { memberTeam } from "./teamAccess";
import { initial, type SpaceAccess, type SpaceGrant, type SpaceNotify, type SpaceShareInput, type SpaceSummary } from "./spaces";
import type { State, TeamPerson } from "./types";

const api = window.botkins;
const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Whether the person looking is the computer's owner (on its own computer, or paired as the owner). */
export const isOwner = (state: State) => !memberTeam(state) && state.remote?.using?.member !== true;

export default function SharePopover({ state, space, name, close }: { state: State; space: SpaceSummary; name: string; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const dialogs = useAsk();
  const ids = useId();
  const owner = isOwner(state);
  const me = memberTeam(state)?.me.memberId ?? "owner";
  const people: TeamPerson[] = state.team && "people" in state.team ? state.team.people ?? [] : [];
  const others = people.filter((p) => p.id !== me);
  const grantsOf = (s: SpaceSummary): SpaceGrant[] => (s.access === "members" ? s.people?.map((p) => ({ id: p.id, can: p.can })) ?? [] : []);
  const [access, setAccess] = useState<SpaceAccess>(space.access);
  const [grants, setGrants] = useState<SpaceGrant[]>(grantsOf(space));
  const [everyone, setEveryone] = useState<"view" | "edit">(space.teamCan ?? "edit");
  const [link, setLink] = useState(space.link);
  const [notify, setNotify] = useState<SpaceNotify>(space.notify);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [computer, setComputer] = useState(state.remote?.using?.name ?? "");
  // The computer's name, for "5 on Studio Mac": the paired one's, or this one's as phones see it.
  useEffect(() => {
    if (!state.remote?.using) void api.phoneLink().then((l) => setComputer(l.name)).catch(() => {});
  }, []);
  // The summary is what counts: follow it when it changes and nothing is on its way.
  const said = JSON.stringify([space.access, space.people, space.teamCan, space.link, space.notify]);
  useEffect(() => {
    if (busy) return;
    setAccess(space.access);
    setGrants(grantsOf(space));
    setEveryone(space.teamCan ?? "edit");
    setLink(space.link);
    setNotify(space.notify);
  }, [said]);
  // Closes on Escape, and on a click outside it (not in a dialog it opened, nor on Share itself).
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const at = e.target as Element;
      if (box.current?.parentElement?.contains(at) || at.closest?.("dialog")) return;
      close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("dialog[open]") && close();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [close]);

  async function share(next: SpaceShareInput) {
    const before = { access, grants, everyone };
    setAccess(next.access);
    if (next.grants) setGrants(next.grants);
    if (next.teamCan) setEveryone(next.teamCan);
    setBusy(true);
    setError("");
    try {
      const answer = await api["link.spaces.share"](space.id, next);
      if (answer && "link" in answer) setLink(answer.link);
    } catch (e) {
      setAccess(before.access);
      setGrants(before.grants);
      setEveryone(before.everyone);
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  }
  async function choose(next: SpaceAccess) {
    if (next === access) return;
    if (next === "private") return share({ access: "private" });
    // Picking members waits for the first tick; with people already picked, it is sent as it is.
    if (next === "members") return grants.length ? share({ access: "members", grants }) : (setError(""), setAccess("members"));
    if (next === "team") return share({ access: "team", teamCan: everyone });
    const ok = await dialogs.ask({
      title: "Anyone with the link",
      body: "Anyone with the link can see everything on this space. They can't change it.",
      confirm: "Share",
    });
    if (ok) await share({ access: "link", teamCan: everyone });
  }
  function tick(person: TeamPerson, on: boolean) {
    const next = on ? [...grants.filter((g) => g.id !== person.id), { id: person.id, can: "edit" as const }] : grants.filter((g) => g.id !== person.id);
    void share({ access: "members", grants: next });
  }
  async function renew() {
    setBusy(true);
    setError("");
    try {
      setLink((await api["link.spaces.newLink"](space.id)).link);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  }
  async function notifyMe(mode: SpaceNotify) {
    const before = notify;
    setNotify(mode);
    setError("");
    try {
      await api["link.spaces.notify"](space.id, mode);
    } catch (e) {
      setNotify(before);
      setError(clean(e));
    }
  }

  const here = new Set(space.here.map((p) => p.id));
  const choices: { id: SpaceAccess; label: string; line: string }[] = [
    { id: "private", label: "Only you", line: owner ? "Private" : "The owner can open it too" },
    { id: "members", label: "Members you pick", line: access === "members" && grants.length ? grants.length + " picked" : "" },
    { id: "team", label: "All members", line: computer ? people.length + " on " + computer : "" },
    { id: "link", label: "Anyone with the link", line: "View only" },
  ];
  return (
    <div ref={box} className="space-share" role="dialog" aria-label={"Who can open " + name}>
      <h2>Who can open {name}</h2>
      <div className="space-choices" role="radiogroup" aria-label="Who can open it">
        {choices.map((c) => (
          <label key={c.id} className={"space-choice" + (access === c.id ? " on" : "")}>
            <input
              type="radio"
              name={ids + "-access"}
              aria-label={c.label}
              aria-describedby={c.line ? ids + "-" + c.id : undefined}
              checked={access === c.id}
              disabled={busy}
              onChange={() => void choose(c.id)}
            />
            <span className="grow">{c.label}</span>
            {c.line && <small id={ids + "-" + c.id}>{c.line}</small>}
          </label>
        ))}
      </div>
      {error && (
        <p className="space-share-error" role="alert">
          {error}
        </p>
      )}
      {access === "members" && others.length > 0 && (
        <>
          <hr />
          <ul className="space-members" aria-label="Members">
            {others.map((p) => {
              const grant = grants.find((g) => g.id === p.id);
              return (
                <li key={p.id}>
                  <input type="checkbox" aria-label={p.name} checked={!!grant} disabled={busy} onChange={(e) => tick(p, e.target.checked)} />
                  <span className={"space-person" + (here.has(p.id) ? " live" : "")} aria-hidden="true">
                    {initial(p.name)}
                  </span>
                  <span className="grow">{p.name}</span>
                  {grant && (
                    <select
                      aria-label={"What " + p.name + " can do"}
                      value={grant.can}
                      disabled={busy}
                      onChange={(e) => void share({ access: "members", grants: grants.map((g) => (g.id === p.id ? { ...g, can: e.target.value as "view" | "edit" } : g)) })}
                    >
                      <option value="edit">Can edit</option>
                      <option value="view">Can view</option>
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(access === "team" || access === "link") && (
        <>
          <hr />
          <div className="space-share-row">
            <span className="grow">All members</span>
            <select aria-label="What all members can do" value={everyone} disabled={busy} onChange={(e) => void share({ access, teamCan: e.target.value as "view" | "edit" })}>
              <option value="edit">Can edit</option>
              <option value="view">Can view</option>
            </select>
          </div>
        </>
      )}
      <hr />
      <div className="space-share-row">
        <span className="grow">Notify me</span>
        <select aria-label="Notify me" value={notify} onChange={(e) => void notifyMe(e.target.value as SpaceNotify)}>
          <option value="off">Off</option>
          <option value="daily">Once a day</option>
          <option value="all">Every change</option>
        </select>
      </div>
      {access === "link" && !link && <p className="space-share-note">Links are off while the relay is off.</p>}
      <hr />
      <div className="space-share-foot">
        {access === "link" && link && (
          <>
            <button
              type="button"
              className="space-link"
              onClick={() =>
                void api
                  .copyText(link)
                  .then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)))
                  .catch((e) => setError(clean(e)))
              }
            >
              <Link size={16} />
              {copied ? "Copied" : "Copy link"}
            </button>
            <button type="button" className="space-link" disabled={busy} onClick={() => void renew()}>
              New link
            </button>
          </>
        )}
        <button type="button" className="primary space-done" onClick={close}>
          Done
        </button>
      </div>
      {dialogs.node}
    </div>
  );
}
