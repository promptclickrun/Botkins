// A color picker: a saturation and brightness square, a hue slider and a hex field.
// The color math is the phone app's (src/data/lookTemplates.ts in the phone repo), so both apps
// read and write a color the same way.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export type Hsv = { h: number; s: number; v: number };

const clamp = (value: number, min: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min);

/** Reads what a person typed ("C75E35", "#c75e35", "#c5e" or "c5e") as "#rrggbb", or null. */
export function parseHex(text: string): string | null {
  const raw = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) return "#" + [...raw].map((char) => char + char).join("");
  if (/^[0-9a-f]{6}$/.test(raw)) return "#" + raw;
  return null;
}

/** HSV to "#rrggbb". Any input gives a valid color: values are clamped and the hue wraps. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((((Number.isFinite(h) ? h : 0) % 360) + 360) % 360) / 60;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = val - chroma;
  const sector = Math.floor(hue) % 6;
  const [r, g, b] = sector === 0 ? [chroma, x, 0] : sector === 1 ? [x, chroma, 0] : sector === 2 ? [0, chroma, x] : sector === 3 ? [0, x, chroma] : sector === 4 ? [x, 0, chroma] : [chroma, 0, x];
  return "#" + [r, g, b].map((unit) => Math.round(clamp((unit + m) * 255, 0, 255)).toString(16).padStart(2, "0")).join("");
}

/**
 * "#rrggbb" to HSV. A gray has no hue of its own and black no saturation, so `keep` (the hue
 * and saturation the picker had) stays where the color can't say.
 */
export function hexToHsv(hex: string, keep?: Partial<Hsv>): Hsv {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  const s = max === 0 ? (keep?.s ?? 0) : delta / max;
  let h = keep?.h ?? 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h, s, v: max };
}

const percent = (unit: number) => Math.round(unit * 100) + "%";

/**
 * Picks one color. `value` is "#rrggbb"; `onChange` gets a new one on every move, so what shows
 * it can follow along while the person drags.
 */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (hex: string) => void; /** What the color is for, such as "Shell". */ label: string }) {
  const id = useId();
  // The hue and saturation are kept beside the color, so dragging through gray or black doesn't lose them.
  const [color, setColor] = useState(() => ({ hsv: hexToHsv(value), hex: value }));
  if (color.hex !== value) setColor({ hsv: hexToHsv(value, color.hsv), hex: value });
  const { h, s, v } = color.hsv;
  const pick = (next: Hsv) => {
    const hex = hsvToHex(next);
    setColor({ hsv: next, hex });
    if (hex !== value) onChange(hex);
  };

  const square = useRef<HTMLDivElement>(null);
  const moveTo = (e: PointerEvent<HTMLDivElement>) => {
    const box = square.current!.getBoundingClientRect();
    pick({ h, s: clamp((e.clientX - box.left) / box.width, 0, 1), v: clamp(1 - (e.clientY - box.top) / box.height, 0, 1) });
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step], PageUp: [0, 0.1], PageDown: [0, -0.1] };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    pick({ h, s: clamp(s + move[0], 0, 1), v: clamp(v + move[1], 0, 1) });
  };

  // The hex field shows what was typed until it is a color, then follows the color again.
  const [text, setText] = useState(value);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(value);
  }, [value]);

  return (
    <div className="color-picker">
      <div
        ref={square}
        className="color-square"
        role="slider"
        tabIndex={0}
        aria-label={label + " saturation and brightness"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(s * 100)}
        aria-valuetext={"Saturation " + percent(s) + ", brightness " + percent(v)}
        style={{ backgroundColor: hsvToHex({ h, s: 1, v: 1 }) }}
        onKeyDown={keys}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
          moveTo(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) moveTo(e);
        }}
      >
        <span className="color-thumb" style={{ left: percent(s), top: percent(1 - v), backgroundColor: value }} aria-hidden="true" />
      </div>
      <input
        type="range"
        className="color-hue"
        aria-label={label + " hue"}
        min={0}
        max={359}
        step={1}
        value={Math.round(h) % 360}
        onChange={(e) => pick({ h: Number(e.target.value), s, v })}
      />
      <div className="color-hex">
        <span className="color-now" style={{ backgroundColor: value }} aria-hidden="true" />
        <label htmlFor={id}>Hex</label>
        <input
          id={id}
          value={text}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-invalid={parseHex(text) ? undefined : true}
          onFocus={() => (typing.current = true)}
          onBlur={() => {
            typing.current = false;
            setText(value);
          }}
          onChange={(e) => {
            setText(e.target.value);
            const hex = parseHex(e.target.value);
            if (hex && hex !== value) onChange(hex);
          }}
        />
      </div>
    </div>
  );
}
