import { useEffect, useRef, useState } from "react";
import { Bot as BotIcon, ChevronRight, CircleAlert, X } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { StepList, duration, useNow } from "./ChatActivity";
import { RichText } from "./RichText";
import type { Bot, Run, TeamAsk } from "./types";
import "./teamwork.css";

type Named = { name: string; bot?: Bot };
const who = (bots: Bot[], id: string): Named => {
  const bot = bots.find((b) => b.id === id);
  return bot ? { name: bot.name, bot } : { name: "a bot" };
};
const teammate = (bots: Bot[], ask: TeamAsk): Named =>
  ask.remote ? { name: ask.remote.botName + " on " + ask.remote.hostName } : who(bots, ask.botId);
const live = (a: TeamAsk) => a.status === "waiting" || a.status === "working";

/** One ask's line in the rail, by its status. */
export function askLabel(ask: Pick<TeamAsk, "status" | "intent">, name: string) {
  switch (ask.status) {
    case "waiting":
      return "Waiting for " + name;
    case "working":
      return ask.intent ? name + ": " + ask.intent : "Asking " + name + "…";
    case "answered":
      return name + " answered";
    case "failed":
      return name + " didn't answer";
    case "stopped":
      return "Ask to " + name + " stopped";
  }
}

/** Consecutive asks from the same bot to the same teammate share one row. */
export function groupAsks(asks: TeamAsk[]) {
  const rows: TeamAsk[][] = [];
  for (const a of asks) {
    const last = rows.at(-1);
    if (last && last[0].botId === a.botId && last[0].fromBotId === a.fromBotId && last[0].remote?.hostId === a.remote?.hostId) last.push(a);
    else rows.push([a]);
  }
  return rows;
}

/** A row's text: one ask's status, or "3 messages with Scout". */
export function rowLabel(row: TeamAsk[], name: string) {
  return row.length > 1 ? row.length + " messages with " + name : askLabel(row[0], name);
}

function Face({ who: w, size = 20 }: { who: Named; size?: number }) {
  // A deleted bot gets a plain, neutral face.
  if (!w.bot)
    return (
      <span className="team-face neutral" style={{ width: size + 4, height: size + 4 }}>
        <BotIcon size={Math.round(size * 0.7)} aria-hidden="true" />
      </span>
    );
  return (
    <span className="team-face">
      <BotAvatar bot={w.bot} size={size} />
    </span>
  );
}

/** Teammates a bot asked for help during a turn, one compact row each, outside the tool fold. */
export function TeamRail({ run, bots }: { run: Run; bots: Bot[] }) {
  const [open, setOpen] = useState(-1);
  const rows = groupAsks(run.teamwork ?? []);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  if (!rows.length) return null;
  return (
    <section className="team-rail" aria-label="Teamwork">
      {rows.map((row, i) => {
        const latest = row.at(-1)!;
        const mate = teammate(bots, latest);
        const asker = who(bots, latest.fromBotId);
        const working = row.some(live);
        const failed = !working && latest.status === "failed";
        const label = rowLabel(row, mate.name);
        // A merged row still says what the teammate is doing right now.
        const now = row.length > 1 && working ? askLabel(latest, mate.name) : "";
        return (
          <button
            key={latest.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            className={"team-row" + (working ? " live" : "") + (failed ? " failed" : "")}
            aria-haspopup="dialog"
            onClick={() => setOpen(i)}
          >
            <span className="team-faces" aria-hidden="true">
              <Face who={asker} />
              <Face who={mate} />
            </span>
            <span className="team-text">
              <strong>{label}</strong>
              {now && <small>{now}</small>}
            </span>
            {working ? (
              <span className="activity-pulse" aria-hidden="true" />
            ) : failed ? (
              <CircleAlert size={14} aria-hidden="true" />
            ) : null}
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        );
      })}
      {rows[open] && (
        <TeamDetail
          row={rows[open]}
          bots={bots}
          close={() => {
            const i = open;
            setOpen(-1);
            requestAnimationFrame(() => buttons.current[i]?.focus());
          }}
        />
      )}
    </section>
  );
}

/** The two bots' short conversation, then what the teammate did and how long it took. */
function TeamDetail({ row, bots, close }: { row: TeamAsk[]; bots: Bot[]; close: () => void }) {
  const box = useRef<HTMLDialogElement>(null);
  const now = useNow(row.some(live));
  useEffect(() => {
    const d = box.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  const mate = teammate(bots, row[0]);
  const asker = who(bots, row[0].fromBotId);
  const titleId = "team-detail-" + row[0].id;
  return (
    <dialog
      ref={box}
      className="team-detail"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === box.current && close()}
    >
      <div className="sectionhead">
        <span className="team-faces" aria-hidden="true">
          <Face who={asker} size={24} />
          <Face who={mate} size={24} />
        </span>
        <h2 id={titleId}>
          {asker.name} asked {mate.name}
        </h2>
        <button aria-label="Close" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <div className="team-thread">
        {row.map((ask, i) => {
          const took = (ask.finished ?? now) - ask.started;
          const steps = ask.steps ?? [];
          return (
            <section className="team-ask" key={ask.id} aria-label={row.length > 1 ? "Message " + (i + 1) + " of " + row.length : undefined}>
              {row.length > 1 && <div className="slash-heading">Message {i + 1} of {row.length}</div>}
              <div className="team-msg">
                <b className="team-speaker">
                  <Face who={asker} />
                  {asker.name}
                </b>
                <p className="team-text-body">{ask.message}</p>
                {ask.expecting && (
                  <p className="team-expect">
                    <strong>What they need back:</strong> {ask.expecting}
                  </p>
                )}
              </div>
              <div className={"team-msg reply" + (ask.status === "failed" ? " failed" : "")}>
                <b className="team-speaker">
                  <Face who={mate} />
                  {mate.name}
                </b>
                {ask.reply ? (
                  <RichText text={ask.reply} />
                ) : ask.error ? (
                  <p className="team-error" role="status">
                    <CircleAlert size={14} aria-hidden="true" />
                    <span>{ask.error}</span>
                  </p>
                ) : (
                  <p className="team-pending">
                    {live(ask) && <span className="activity-pulse" aria-hidden="true" />}
                    {askLabel(ask, mate.name)}
                  </p>
                )}
              </div>
              <div className="team-did">
                <h3>What {mate.name} did</h3>
                {steps.length > 0 && (
                  <div className="tool-trail work-done team-steps">
                    <StepList steps={steps} />
                  </div>
                )}
                <small>
                  {steps.length ? steps.length + (steps.length === 1 ? " step · " : " steps · ") : live(ask) ? "" : "No tools used · "}
                  {live(ask) ? "Working for " + duration(took) : "Took " + duration(took)}
                </small>
              </div>
            </section>
          );
        })}
      </div>
    </dialog>
  );
}
