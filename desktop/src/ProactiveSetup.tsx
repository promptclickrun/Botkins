// The setup steps of a bot's Proactive agent ("proactive-team-v1"): who the bot looks out for, who is notified,
// what matters most, and how often. Nothing runs, and no model is used, until they are finished. The phone has the
// same steps (mobile/src/features/bots/ProactiveSetup.tsx); the steps, their words and what they save are
// desktop/link/proactive-words.mjs, which both apps read. The bot's Proactive card opens it ("Set up"), and the
// shell opens it on a bot's page with `actions.proactiveSetup(botId)`.
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WIZARD, WIZARD_STEPS, wizardPatch, wizardPeople, wizardReady, wizardStart, type ProactiveViewer, type WizardDraft } from "../desktop/link/proactive-words.mjs";
import { errorText } from "./SettingsRows";
import type { Bot, ProactiveBot, ProactivePatch, ProactiveWatch, State } from "./types";

const EVERY = [15, 30, 60, 120];
const SWEEP = [0, 1, 2, 3, 6, 12];
const CAP = [3, 6, 10, 20];
const minutes = (m: number) => (m < 60 ? m + " minutes" : m / 60 + (m === 60 ? " hour" : " hours"));

export default function ProactiveSetup({
  state,
  bot,
  entry,
  viewer,
  watches,
  close,
}: {
  state: State;
  bot: Bot;
  entry?: ProactiveBot;
  viewer: ProactiveViewer;
  /** The watches this person may choose, in the words of the bot's Proactive card. */
  watches: { id: ProactiveWatch; label: string; help: string }[];
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  const people = wizardPeople(state.team && "members" in state.team ? state.team : undefined, bot.id, viewer);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WizardDraft>(() => wizardStart(entry, viewer, people));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const change = (patch: Partial<WizardDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const person = (id: string, patch: Partial<WizardDraft["people"][string]>) => setDraft((d) => ({ ...d, people: { ...d.people, [id]: { ...d.people[id], ...patch } } }));
  const name = WIZARD_STEPS[step];
  const last = step === WIZARD_STEPS.length - 1;
  const ready = wizardReady(draft);
  const owner = viewer.id === "owner";
  async function finish() {
    setSaving(true);
    setError("");
    try {
      await window.botkins.setBotProactive(bot.id, wizardPatch(draft, entry, viewer) as ProactivePatch);
      close();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  }
  return (
    <dialog ref={ref} className="task-dialog pick-dialog people-dialog" aria-label={WIZARD.setUp} onCancel={close} onClose={close}>
      <div className="sectionhead">
        <h2>{WIZARD.title[name](bot.name)}</h2>
        <button type="button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <p className="muted">{ready ? WIZARD.note[name] : WIZARD.needsOne}</p>
      {name === "people" && (
        <fieldset className="checklist">
          <legend className="sr-only">{WIZARD.title.people(bot.name)}</legend>
          {people.map((who) => (
            <label key={who.id}>
              <input type="checkbox" checked={draft.people[who.id]?.on === true} onChange={(e) => person(who.id, { on: e.target.checked })} />
              <span>
                {who.name} {who.you && <small>You</small>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {name === "notify" &&
        people
          .filter((who) => draft.people[who.id]?.on)
          .map((who) => (
            <label key={who.id} className="switch-row compact">
              <span>
                <strong>{who.name}</strong>
                {who.you && <small>You</small>}
              </span>
              <input type="checkbox" role="switch" className="switch" aria-label={"Notify " + who.name} checked={draft.people[who.id]?.notify !== false} onChange={(e) => person(who.id, { notify: e.target.checked })} />
            </label>
          ))}
      {name === "matters" && (
        <>
          <fieldset className="checklist">
            <legend className="sr-only">{WIZARD.title.matters(bot.name)}</legend>
            {watches.map((w) => (
              <label key={w.id}>
                <input type="checkbox" aria-label={w.label} checked={draft.watch.includes(w.id)} onChange={(e) => change({ watch: e.target.checked ? [...draft.watch, w.id] : draft.watch.filter((x) => x !== w.id) })} />
                <span>
                  {w.label} <small>{w.help}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            {WIZARD.rules}
            <input type="text" maxLength={2000} value={draft.instructions} placeholder={WIZARD.rulesPlaceholder} onChange={(e) => change({ instructions: e.target.value })} />
          </label>
          {owner && (
            <label>
              {WIZARD.lookAround}
              <select value={draft.sweepHours} onChange={(e) => change({ sweepHours: Number(e.target.value) })}>
                {SWEEP.map((h) => (
                  <option key={h} value={h}>
                    {h ? "Every " + minutes(h * 60) : "Never"}
                  </option>
                ))}
              </select>
              <small>{WIZARD.lookAroundNote}</small>
            </label>
          )}
        </>
      )}
      {name === "often" && (
        <>
          <label>
            {WIZARD.every}
            <select value={draft.every} onChange={(e) => change({ every: Number(e.target.value) })}>
              {EVERY.map((m) => (
                <option key={m} value={m}>
                  Every {minutes(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {WIZARD.cap}
            <select value={draft.maxPerDay} onChange={(e) => change({ maxPerDay: Number(e.target.value) })}>
              {CAP.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="profile-save">
        {step > 0 && (
          <button type="button" className="textbutton" onClick={() => setStep(step - 1)}>
            {WIZARD.back}
          </button>
        )}
        <button type="button" className="primary" disabled={!ready || saving} onClick={() => (last ? void finish() : setStep(step + 1))}>
          {last ? WIZARD.finish : WIZARD.next}
        </button>
      </div>
    </dialog>
  );
}
