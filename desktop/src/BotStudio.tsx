import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Shuffle, X } from "lucide-react";
import { BotAvatar, type AvatarState } from "./Avatar";
import { CUSTOM, EYES, HEADS, PALETTES, TEMPLATES, colorsOf, eyesOf, headName, paletteName, randomLook, sameLook, type FourColors, type Head } from "./botkins";
import { ColorPicker } from "./ColorPicker";
import type { BotLook, LookEyes } from "./types";
import "./botpage.css";

export { randomLook };

/** States the preview acts out when it is clicked, in turn. */
const SHOWS: AvatarState[] = ["like", "thinking", "coding", "love", "browsing", "laugh", "completed"];

/** The color slots of a look, in the order of its four colors. */
const SLOTS = ["Shell", "Accent", "Face", "Eyes"];

/** A look with these eyes. Oval is the character's own, so it is left out. */
function withEyes(look: BotLook, eyes: LookEyes): BotLook {
  const { eyes: _, ...rest } = look;
  return eyes === "oval" ? rest : { ...rest, eyes };
}
/** A look in a kit palette: its colors go, its eyes stay. */
function inPalette(look: BotLook, palette: string): BotLook {
  const { colors: _, ...rest } = look;
  return { ...rest, palette };
}
const inColors = (look: BotLook, colors: FourColors): BotLook => ({ ...look, palette: CUSTOM, colors });

/** Arrow keys move through a radio group laid out as a grid with `columns` columns; Home and End jump. */
function rove(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const columns = Math.max(1, items.filter((item) => item.offsetTop === items[0].offsetTop).length);
  const next =
    e.key === "ArrowRight" ? at + 1
    : e.key === "ArrowLeft" ? at - 1
    : e.key === "ArrowDown" ? at + columns
    : e.key === "ArrowUp" ? at - columns
    : e.key === "Home" ? 0
    : e.key === "End" ? items.length - 1
    : -1;
  if (next < 0 || next >= items.length) return;
  e.preventDefault();
  items[next].focus();
  items[next].click();
}

/**
 * Chooses a bot's look: a character, a palette or template, its eyes and its own
 * colors, with a live preview.
 */
export default function LookPicker({ value, onChange, previewSize = 132, characters = HEADS }: { value: BotLook; onChange: (look: BotLook) => void; previewSize?: number; characters?: Head[] }) {
  const id = useId();
  // The preview follows every move of the color picker; the grids of small avatars catch up after.
  const settled = useDeferredValue(value);
  const slots = colorsOf(value);
  const template = value.palette === CUSTOM ? TEMPLATES.find((t) => t.colors.every((color, i) => color === slots[i])) : undefined;
  const [show, setShow] = useState<{ state: AvatarState; n: number }>({ state: "idle", n: 0 });
  // A reaction plays, then the preview goes back to idle.
  useEffect(() => {
    if (show.state === "idle") return;
    const timer = setTimeout(() => setShow((s) => ({ state: "idle", n: s.n })), 2600);
    return () => clearTimeout(timer);
  }, [show]);
  const grid = useRef<HTMLDivElement>(null);
  // Surprise me can pick any character: bring it into view.
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>("[aria-checked=true]")?.scrollIntoView({ block: "nearest" });
  }, [value.head]);
  const name = headName(value.head);
  return (
    <div className="look-picker">
      <div className="look-stage">
        <button
          type="button"
          className="look-preview"
          aria-label={"Preview: " + name + " in " + paletteName(value.palette) + ". Click to see it move."}
          onClick={() => setShow((s) => ({ state: SHOWS[s.n % SHOWS.length], n: s.n + 1 }))}
        >
          <BotAvatar key={show.n} look={value} state={show.state} size={previewSize} animated badge />
        </button>
        <strong className="look-name">{name}</strong>
        <button
          type="button"
          className="look-surprise"
          onClick={() => {
            // A new look every time, never the one already showing.
            let next = randomLook(characters);
            while (sameLook(next, value)) next = randomLook(characters);
            onChange(next);
            setShow((s) => ({ state: "like", n: s.n + 1 }));
          }}
        >
          <Shuffle size={15} />
          Surprise me
        </button>
      </div>

      <span className="look-label" id={id + "head"}>
        Character
      </span>
      <div className="look-heads" ref={grid} role="radiogroup" aria-labelledby={id + "head"} onKeyDown={rove}>
        {characters.map((head) => {
          const on = head.id === value.head;
          return (
            <button key={head.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={on ? "on" : ""} onClick={() => onChange({ ...value, head: head.id })}>
              <BotAvatar look={{ ...settled, head: head.id }} size={52} animated={false} badge={false} />
              <span>{head.name}</span>
            </button>
          );
        })}
      </div>

      <span className="look-label" id={id + "palette"}>
        Palette
      </span>
      <div className="look-palettes" role="radiogroup" aria-labelledby={id + "palette"} onKeyDown={rove}>
        {PALETTES.map((palette) => {
          const on = palette.id === value.palette;
          return (
            <button key={palette.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={on ? "on" : ""} onClick={() => onChange(inPalette(value, palette.id))}>
              <i className={palette.swatch ? "" : "own"} style={palette.swatch ? { background: palette.swatch } : undefined} aria-hidden="true" />
              {palette.name}
            </button>
          );
        })}
        {/* The phone's templates are custom colors with a name. Your own colors match none, and then the first chip takes the focus. */}
        {TEMPLATES.map((t) => {
          const on = t === template;
          return (
            <button key={t.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={on ? "on" : ""} onClick={() => onChange(inColors(value, [...t.colors]))}>
              <i style={{ background: t.colors[0] }} aria-hidden="true" />
              {t.name}
            </button>
          );
        })}
      </div>

      <span className="look-label" id={id + "eyes"}>
        Eyes
      </span>
      <div className="look-heads look-eyes" role="radiogroup" aria-labelledby={id + "eyes"} onKeyDown={rove}>
        {EYES.map((eyes) => {
          const on = eyes.id === eyesOf(value);
          return (
            <button key={eyes.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={on ? "on" : ""} onClick={() => onChange(withEyes(value, eyes.id))}>
              <BotAvatar look={withEyes(settled, eyes.id)} size={44} animated={false} badge={false} />
              <span>{eyes.name}</span>
            </button>
          );
        })}
      </div>

      <span className="look-label" id={id + "colors"}>
        Custom colors
      </span>
      <ColorSlots labelledBy={id + "colors"} colors={slots} onChange={(colors) => onChange(inColors(value, colors))} />
    </div>
  );
}

/**
 * One swatch for each of a look's four colors. Each opens a color picker in a popover; a change
 * to any of them makes the look custom.
 */
function ColorSlots({ colors, onChange, labelledBy }: { colors: FourColors; onChange: (colors: FourColors) => void; labelledBy: string }) {
  const id = useId();
  const [open, setOpen] = useState<number | null>(null);
  const pops = useRef<(HTMLDivElement | null)[]>([]);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const cleanups = pops.current.map((pop, slot) => {
      if (!pop) return () => {};
      // It opens unseen, is measured and placed, then shows: no flash in the middle of the window.
      const opening = (e: Event) => {
        if ((e as ToggleEvent).newState === "open") pop.classList.remove("placed");
      };
      const toggled = (e: Event) => {
        if ((e as ToggleEvent).newState !== "open") {
          setOpen((now) => (now === slot ? null : now));
          return;
        }
        setOpen(slot);
        // Under its swatch, or above it when there is no room below, and inside the window.
        const at = swatches.current[slot]!.getBoundingClientRect();
        const { width, height } = pop.getBoundingClientRect();
        const below = at.bottom + 8 + height <= innerHeight - 8;
        pop.style.left = Math.max(8, Math.min(at.left, innerWidth - width - 8)) + "px";
        pop.style.top = Math.max(8, below ? at.bottom + 8 : at.top - 8 - height) + "px";
        pop.classList.add("placed");
        pop.querySelector<HTMLElement>(".color-square")?.focus();
      };
      pop.addEventListener("beforetoggle", opening);
      pop.addEventListener("toggle", toggled);
      return () => {
        pop.removeEventListener("beforetoggle", opening);
        pop.removeEventListener("toggle", toggled);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);
  // A popover stays where it opened, so it closes when the page under it scrolls or the window changes size.
  useEffect(() => {
    if (open === null) return;
    const close = (e: Event) => {
      if (!pops.current[open]?.contains(e.target as Node)) pops.current[open]?.hidePopover();
    };
    addEventListener("scroll", close, true);
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", close, true);
      removeEventListener("resize", close);
    };
  }, [open]);
  return (
    <div className="look-colors" role="group" aria-labelledby={labelledBy}>
      {SLOTS.map((name, slot) => (
        <div key={name} className="look-color">
          <button
            type="button"
            ref={(el) => {
              swatches.current[slot] = el;
            }}
            popoverTarget={id + slot}
            aria-label={name + " color, " + colors[slot]}
            className={open === slot ? "on" : ""}
          >
            <i style={{ background: colors[slot] }} aria-hidden="true" />
            <span aria-hidden="true">{name}</span>
          </button>
          <div
            id={id + slot}
            ref={(el) => {
              pops.current[slot] = el;
            }}
            popover="auto"
            className="color-pop"
            role="dialog"
            aria-label={name + " color"}
          >
            <ColorPicker label={name} value={colors[slot]} onChange={(hex) => onChange(colors.map((color, i) => (i === slot ? hex : color)) as FourColors)} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Bot Studio: the look picker in its own sheet over whatever opened it.
 * Edits a draft; Save hands the look back and Cancel (or Escape) discards it.
 */
export function BotStudio({ value, save, cancel, saving, characters }: { value: BotLook; save: (look: BotLook) => void; cancel: () => void; /** Disables Save while the caller stores the look. */ saving?: boolean; characters?: Head[] }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="bot-studio"
      aria-labelledby={id}
      onCancel={(e) => {
        // Escape closes only the studio, never the sheet under it.
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }}
    >
      <div className="studio-head">
        <h2 id={id}>Bot Studio</h2>
        <button type="button" className="studio-close" aria-label="Close Bot Studio" onClick={cancel}>
          <X size={17} />
        </button>
      </div>
      <LookPicker value={draft} onChange={setDraft} characters={characters} />
      <footer className="studio-foot">
        <button type="button" className="set-button" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="set-button primary" disabled={saving} onClick={() => save(draft)}>
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
