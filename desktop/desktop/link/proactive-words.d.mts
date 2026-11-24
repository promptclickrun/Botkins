// Types for proactive-words.mjs and proactive-rules.mjs, for the two apps' screens.
export const PROACTIVE_TEAM: "proactive-team-v1";

export type WizardStep = "people" | "notify" | "matters" | "often";
export const WIZARD_STEPS: WizardStep[];
export const WIZARD: {
  title: Record<WizardStep, (bot: string) => string>;
  note: Record<WizardStep, string>;
  rules: string;
  rulesPlaceholder: string;
  lookAround: string;
  lookAroundNote: string;
  every: string;
  cap: string;
  setUp: string;
  next: string;
  back: string;
  finish: string;
  needsOne: string;
  waiting: string;
};
export const ALERT: { take: string; later: string; taken: string; held: string };

/** One person's entry: their own check, and whether they are notified of an alert. */
export type ProactivePerson = { on: boolean; notify: boolean };
/** Who is looking: "owner" or a member's id, and whether their role manages the bot. */
export type ProactiveViewer = { id: string; name?: string; manages: boolean };
export type WizardPerson = { id: string; name: string; you: boolean };
export type WizardDraft = {
  people: Record<string, ProactivePerson>;
  watch: string[];
  instructions: string;
  sweepHours: number;
  every: number;
  maxPerDay: number;
};
export type WizardPatch = {
  setUp: true;
  enabled: true;
  people: Record<string, ProactivePerson | null>;
  watch: string[];
  instructions: string;
  every: number;
  maxPerDay: number;
  sweepHours?: number;
};
type Entry = { setUp?: boolean; enabled?: boolean; people?: Record<string, ProactivePerson | undefined>; watch?: string[]; instructions?: string; sweepHours?: number; every?: number; maxPerDay?: number } | undefined;
type Team = { members?: { id: string; name: string; groupId?: string }[]; groups?: { id: string; roleId: string }[]; roles?: { id: string; perms?: Record<string, string[]>; bots?: "all" | string[] }[]; people?: { id: string; name: string }[] } | null | undefined;

export function wizardPeople(team: Team, botId: string, viewer: ProactiveViewer, ownerName?: string): WizardPerson[];
export function wizardStart(entry: Entry, viewer: ProactiveViewer, people: WizardPerson[]): WizardDraft;
export function wizardReady(draft: WizardDraft): boolean;
export function wizardPatch(draft: WizardDraft, entry: Entry, viewer: ProactiveViewer): WizardPatch;
export function proactiveStanding(part: { enabled?: boolean } | undefined, entry: Entry, viewerId: string): "setup" | "paused" | "off" | "out" | "mine-off" | "on";
export function personLine(person: ProactivePerson): string;
