// The top of Work's three pages: the title, the tabs Routines · Projects · Tasks, and at the right
// Usage, Activity and the button that makes a new one of what the tab lists. Activity is the list
// of every request a bot was given; it opens as a page of its own with a way back.
import { Activity, ArrowLeft, BarChart3, Plus } from "lucide-react";
import { Button } from "glisse";
import { GlassTabBar } from "./GlisseUI";

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
          <Button variant="glass" icon={<BarChart3 size={17} />} aria-label="Usage" title="Usage" onClick={work.usage} />
          <Button variant="glass" icon={<Activity size={17} />} aria-label="Activity" title="Activity" onClick={work.activity} />
          {add && (
            <Button variant="filled" icon={<Plus size={16} />} onClick={add.run}>
              {add.label}
            </Button>
          )}
        </div>
      </div>
      <GlassTabBar
        className="work-tabs-glass"
        aria-label="Work"
        value={tab}
        labelTexts={work.tabs.map((name) => (name === "Tasks" && work.waiting > 0 ? `${name} ${work.waiting}` : name))}
        items={work.tabs.map((name) => ({
          value: name,
          label: (
            <>
              {name}
              {name === "Tasks" && work.waiting > 0 && <span className="count">{work.waiting}</span>}
            </>
          ),
        }))}
        onValueChange={(next) => {
          const picked = next as WorkTab;
          if (picked !== tab) work.go(picked);
        }}
      />
    </div>
  );
}

/** The way back to Work from a page it opens (Activity, Usage). */
export function WorkBack({ back }: { back: () => void }) {
  return (
    <div className="sectionhead work-back">
      <Button variant="glass" className="lg-compact" icon={<ArrowLeft size={15} />} onClick={back}>
        Work
      </Button>
    </div>
  );
}
