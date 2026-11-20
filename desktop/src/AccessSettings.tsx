import { ChevronRight, ShieldCheck } from "lucide-react";
import { BotAvatar } from "./Avatar";
import { globalAccess, grantOf, grantSummary, openBotPage } from "./access";
import type { State } from "./types";
import "./records.css";
import "./access.css";

/** Settings › Access: whether every bot can use every project, and if not, who can use what. */
export default function AccessSettings({ state }: { state: State }) {
  const everyone = globalAccess(state);
  const projects = state.projects?.length ?? 0;
  return (
    <div className="access-settings">
      <label className="switch-row">
        <span>
          <strong>All bots can use every project</strong>
          <small>
            {everyone
              ? "Any bot can chat in any project and keep its to-do list."
              : "Each bot uses only the projects granted on its page."}
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-label="All bots can use every project"
          checked={everyone}
          onChange={(e) => void window.botkins.setPreferences({ access: { allBots: e.target.checked } }).catch(() => {})}
        />
      </label>
      {!everyone && (
        <section className="access-overview" aria-label="Access by bot">
          <div className="access-overview-head">
            <strong>Access by bot</strong>
            <small>
              {projects} {projects === 1 ? "project" : "projects"}
            </small>
          </div>
          <ul className="edit-list">
            {state.bots.map((b) => {
              const g = grantOf(b);
              const none = !g.all && !g.projects.length;
              return (
                <li key={b.id}>
                  <button className="access-bot" onClick={() => openBotPage(b.id)} aria-label={b.name + ": " + grantSummary(state, b) + ". Open bot page"}>
                    <BotAvatar bot={b} size={30} />
                    <span className="grow">
                      <strong>{b.name}</strong>
                      <small className={none ? "no-access" : ""}>{grantSummary(state, b)}</small>
                    </span>
                    {g.all && (
                      <span className="primary-badge">
                        <ShieldCheck size={12} /> All
                      </span>
                    )}
                    <ChevronRight size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
          <small className="access-foot">Choose a bot to change what it can use.</small>
        </section>
      )}
    </div>
  );
}
