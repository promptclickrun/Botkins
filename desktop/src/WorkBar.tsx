// The top of Work's three pages: the title, the tabs Routines · Projects · Tasks, and at the right
// Usage, Activity and the button that makes a new one of what the tab lists. Activity is the list
// of every request a bot was given; it opens as a page of its own with a way back.
import { Activity, ArrowLeft, BarChart3, Plus } from "lucide-react";

export type WorkTab = "Routines" | "Projects" | "Tasks";
export const WORK_TABS: WorkTab[] = ["Routines", "Projects", "Tasks"];

/** How Work's pages reach each other. */
export type WorkNav = {
  /** The tabs this person may open, in order. */
  tabs: WorkTab[];
  go: (tab: WorkTab) => void;
  activity: () => void;
  usage: () => void;
  /** How many tasks wait for the person (to review, or blocked). */
  waiting: number;
};

export function WorkBar({ work, tab, add }: { work: WorkNav; tab: WorkTab; add?: { label: string; run: () => void } }) {
  return (
    <div className="work-bar">
      <div className="titleline">
        <h1>Work</h1>
        <div className="work-tools">
          <button type="button" className="icon-button" aria-label="Usage" title="Usage" onClick={work.usage}>
            <BarChart3 size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="Activity" title="Activity" onClick={work.activity}>
            <Activity size={18} />
          </button>
          {add && (
            <button type="button" className="primary" onClick={add.run}>
              <Plus size={16} />
              {add.label}
            </button>
          )}
        </div>
      </div>
      <div className="segmented work-tabs" role="tablist" aria-label="Work">
        {work.tabs.map((name) => (
          <button key={name} type="button" role="tab" aria-selected={name === tab} onClick={() => name !== tab && work.go(name)}>
            {name}
            {name === "Tasks" && work.waiting > 0 && <span className="count">{work.waiting}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The way back to Work from a page it opens (Activity, Usage). */
export function WorkBack({ back }: { back: () => void }) {
  return (
    <div className="sectionhead work-back">
      <button type="button" className="textbutton" onClick={back}>
        <ArrowLeft size={15} /> Work
      </button>
    </div>
  );
}
