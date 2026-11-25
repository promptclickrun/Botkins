// What fingers on the picture mean. One state machine reads raw touches (from a manual gesture
// in Stage.tsx) and turns them into pointer events for the computer, zoom and pan. It writes the
// viewport and pointer into shared values that the UI thread draws.
//
// Trackpad mode (the default): one finger slides the pointer (relative, with gentle acceleration);
// a tap clicks at the pointer; a second tap soon after double-clicks; tap, then hold or slide,
// drags; a long press or a two-finger tap right-clicks; a two-finger drag scrolls.
// Touch mode: a tap clicks under the finger; a long press right-clicks; a one-finger drag drags;
// a two-finger drag scrolls.
// Both: pinch zooms 1x to 5x, three fingers pan and a two-finger double tap resets the zoom.
import type { GestureTouchEvent } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import type { ScreenInput } from "@/link/types";

/** How far a finger may wander and still count as a tap, in points. */
export const TAP_SLOP = 10;
/** A finger held this long without moving is a long press (right-click). */
export const HOLD_MS = 500;
/** The second tap of a double tap comes within this long of the first. */
export const DOUBLE_TAP_MS = 300;
/** In trackpad mode, a tap followed by a touch held this long starts a drag. */
export const DRAG_HOLD_MS = 180;
/** How far apart the two taps of a double tap may land, in points. */
export const DOUBLE_TAP_REACH = 44;
/** How much two fingers must spread or close before they count as a pinch, in points. */
export const PINCH_SLOP = 24;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** Trackpad pointer speed: screen points of pointer per point of finger, before acceleration. */
export const POINTER_SPEED = 1;
/** Finger speed (points per ms) above which the pointer speeds up. */
export const ACCEL_FROM = 0.15;
/** Extra pointer speed per point/ms of finger speed above ACCEL_FROM. */
export const ACCEL_RATE = 1.2;
/** The most extra speed acceleration adds. */
export const ACCEL_MAX = 2;
/** While zoomed, the picture pans to keep the pointer at least this far inside the edges. */
export const POINTER_MARGIN = 28;

export type PointerMode = "trackpad" | "touch";
type Point = { x: number; y: number };

/** Where the picture lies inside the stage (the area the fingers touch), at 1x. */
export type Fit = { width: number; height: number; left: number; top: number; imageWidth: number; imageHeight: number };
export const NO_FIT: Fit = { width: 0, height: 0, left: 0, top: 0, imageWidth: 0, imageHeight: 0 };

/** The picture fitted (contain) and centered in a box. */
export function fitPicture(box: { width: number; height: number }, picture: { width: number; height: number } | null): Fit {
  if (!picture || box.width <= 0 || box.height <= 0 || picture.width <= 0 || picture.height <= 0) return { ...NO_FIT, width: box.width, height: box.height };
  const scale = Math.min(box.width / picture.width, box.height / picture.height);
  const imageWidth = picture.width * scale;
  const imageHeight = picture.height * scale;
  return { width: box.width, height: box.height, left: (box.width - imageWidth) / 2, top: (box.height - imageHeight) / 2, imageWidth, imageHeight };
}

/** The shared values the UI thread draws from. */
export type GestureValues = {
  scale: SharedValue<number>;
  x: SharedValue<number>;
  y: SharedValue<number>;
  /** The pointer, as fractions of the display. */
  pointerX: SharedValue<number>;
  pointerY: SharedValue<number>;
};

export type GestureOutput = {
  send: (event: ScreenInput) => void;
  /** A click or right-click went out (for a haptic). */
  clicked: () => void;
  /** A drag started (for a haptic). */
  grabbed: () => void;
};

type Phase =
  | "idle"
  /** One finger, not yet a tap, a slide or a hold. */
  | "one"
  /** Direct touch began in the letterbox. A second finger can still start a pinch. */
  | "outside"
  /** Trackpad: sliding the pointer. */
  | "pointer"
  /** The mouse button is down. */
  | "drag"
  /** View only and zoomed: one finger pans the picture. */
  | "pan"
  /** Two fingers, not yet a tap, a scroll or a pinch. */
  | "two"
  | "scroll"
  /** Two fingers zoom and pan the picture. */
  | "zoom"
  /** Three fingers move the viewport, including while a pointer is available. */
  | "three"
  /** Ignore the rest of this touch (a long press fired, or fingers came and went). */
  | "spent";

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export class ScreenGestures {
  private mode: PointerMode = "trackpad";
  private control = false;
  private fit: Fit = NO_FIT;
  private display = { width: 1, height: 1 };
  private view = { scale: 1, x: 0, y: 0 };
  private pointer: Point = { x: 0.5, y: 0.5 };
  private selected?: string;
  private pointers = new Map<string, Point>();

  private touches = new Map<number, Point>();
  private phase: Phase = "idle";
  private start = { x: 0, y: 0, t: 0 };
  private last = { x: 0, y: 0, t: 0 };
  private most = 0;
  /** This touch follows a tap closely: a double tap, or (trackpad) the start of a drag. */
  private second = false;
  private lastTap: { x: number; y: number; t: number } | null = null;
  private lastTwoTap = 0;
  private two = { distance: 0, center: { x: 0, y: 0 }, last: { x: 0, y: 0 }, scale: 1, x: 0, y: 0, t: 0 };

  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private dragTimer: ReturnType<typeof setTimeout> | undefined;
  private rightTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private values: GestureValues,
    private out: GestureOutput,
  ) {}

  configure(options: { mode: PointerMode; control: boolean; out: GestureOutput }) {
    if (options.mode !== this.mode || options.control !== this.control) this.abandon();
    this.mode = options.mode;
    this.control = options.control;
    this.out = options.out;
  }

  /** Start at the host cursor when known and keep each display's position through a switch. */
  selectDisplay(id: string, initial?: Point) {
    if (id === this.selected) return;
    this.abandon();
    if (this.selected) this.pointers.set(this.selected, this.pointer);
    this.selected = id;
    const at = this.pointers.get(id) ?? initial;
    this.pointer = at && Number.isFinite(at.x) && Number.isFinite(at.y)
      ? { x: clamp(at.x, 0, 1), y: clamp(at.y, 0, 1) } : { x: 0.5, y: 0.5 };
    this.values.pointerX.value = this.pointer.x;
    this.values.pointerY.value = this.pointer.y;
    this.resetZoom();
  }

  /** The stage and the picture changed size. `display` is the computer's display in pixels. */
  layout(fit: Fit, display: { width: number; height: number }) {
    this.fit = fit;
    this.display = { width: Math.max(1, display.width), height: Math.max(1, display.height) };
    this.setView(this.view);
  }

  /** Back to 1x, centered. */
  resetZoom() {
    this.setView({ scale: 1, x: 0, y: 0 });
  }

  /** VoiceOver and TalkBack provide the same viewport and pointer without raw multi-touch. */
  accessibilityAction(name: string) {
    if (name === "increment" || name === "decrement") {
      this.setView({ ...this.view, scale: this.view.scale * (name === "increment" ? 1.5 : 1 / 1.5) });
      return;
    }
    if (!this.control) return;
    if (name === "activate" || name === "rightClick") {
      this.out.send({ type: name === "activate" ? "click" : "rightClick", ...this.pointer });
      this.out.clicked();
      return;
    }
    const step = 0.05 / this.view.scale;
    let { x, y } = this.pointer;
    switch (name) {
      case "moveLeft": x -= step; break;
      case "moveRight": x += step; break;
      case "moveUp": y -= step; break;
      case "moveDown": y += step; break;
      default: return;
    }
    this.movePointer(x, y);
  }

  /** Lets go of everything: timers, and a held mouse button. */
  dispose() {
    this.abandon();
  }

  // Touches.

  down(event: GestureTouchEvent) {
    const now = Date.now();
    for (const touch of event.changedTouches) this.touches.set(touch.id, { x: touch.x, y: touch.y });
    const count = this.touches.size;
    this.most = this.phase === "idle" ? count : Math.max(this.most, count);

    if (count === 1 && (this.phase === "idle" || this.phase === "spent")) {
      const p = this.touches.values().next().value as Point;
      this.phase = "one";
      this.most = 1;
      this.start = { x: p.x, y: p.y, t: now };
      this.last = { ...this.start };
      if (this.control && this.mode === "touch" && !this.insidePicture(p)) {
        this.phase = "outside";
        this.lastTap = null;
        return;
      }
      const tap = this.lastTap;
      this.second = !!tap && now - tap.t < DOUBLE_TAP_MS && distance(tap, p) < DOUBLE_TAP_REACH * (this.mode === "trackpad" ? 2 : 1);
      if (this.control) {
        if (this.second && this.mode === "trackpad") this.dragTimer = setTimeout(() => this.dragHeld(), DRAG_HOLD_MS);
        else this.holdTimer = setTimeout(() => this.held(), HOLD_MS);
      }
      return;
    }

    if (count === 2) {
      this.clearOneTimers();
      if (this.phase === "drag") this.release();
      if (this.phase === "idle" || this.phase === "one" || this.phase === "outside" || this.phase === "pointer" || this.phase === "pan" || this.phase === "drag") this.beginTwo(now);
      else this.phase = "spent";
      return;
    }

    if (count >= 3) {
      this.clearOneTimers();
      if (this.phase === "drag") this.release();
      this.phase = count === 3 ? "three" : "spent";
      this.last = { ...this.centroid(), t: now };
    }
  }

  move(event: GestureTouchEvent) {
    const now = Date.now();
    for (const touch of event.allTouches) if (this.touches.has(touch.id)) this.touches.set(touch.id, { x: touch.x, y: touch.y });
    for (const touch of event.changedTouches) if (this.touches.has(touch.id)) this.touches.set(touch.id, { x: touch.x, y: touch.y });

    switch (this.phase) {
      case "one": {
        const p = this.first();
        if (!p || distance(p, this.start) <= TAP_SLOP) return;
        this.clearOneTimers();
        if (!this.control) {
          this.phase = this.view.scale > 1.01 ? "pan" : "spent";
          if (this.phase === "pan") this.pan(p);
          return;
        }
        if (this.mode === "trackpad") {
          if (this.second) {
            this.press(this.pointer);
            this.phase = "drag";
          } else this.phase = "pointer";
          this.slide(p, now);
        } else {
          this.press(this.toDisplay(this.start));
          this.phase = "drag";
          this.out.send({ type: "move", ...this.toDisplay(p) });
        }
        this.last = { x: p.x, y: p.y, t: now };
        return;
      }
      case "pointer":
      case "drag": {
        const p = this.first();
        if (!p) return;
        if (this.mode === "trackpad") this.slide(p, now);
        else this.out.send({ type: "move", ...this.toDisplay(p) });
        this.last = { x: p.x, y: p.y, t: now };
        return;
      }
      case "pan": {
        const p = this.first();
        if (p) this.pan(p);
        return;
      }
      case "three": {
        if (this.touches.size === 3) this.pan(this.centroid());
        return;
      }
      case "two": {
        if (this.touches.size < 2) {
          // One of the two lifted; a slide of the other is not a two-finger tap.
          const p = this.first();
          if (p && distance(p, this.two.last) > TAP_SLOP * 2) this.phase = "spent";
          return;
        }
        const [a, b] = this.pair();
        const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const spread = distance(a, b);
        if (Math.abs(spread - this.two.distance) > PINCH_SLOP) {
          this.phase = "zoom";
          this.zoomTo(center, spread);
        } else if (distance(center, this.two.center) > TAP_SLOP) {
          if (this.control) {
            this.phase = "scroll";
            this.scroll(center);
          } else if (this.view.scale > 1.01) {
            this.phase = "zoom";
            this.zoomTo(center, spread);
          } else this.phase = "spent";
        }
        this.two.last = center;
        return;
      }
      case "scroll": {
        if (this.touches.size < 2) return;
        const [a, b] = this.pair();
        this.scroll({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        return;
      }
      case "zoom": {
        if (this.touches.size < 2) return;
        const [a, b] = this.pair();
        this.zoomTo({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance(a, b));
        return;
      }
      default:
        return;
    }
  }

  up(event: GestureTouchEvent) {
    const now = Date.now();
    for (const touch of event.changedTouches) if (this.touches.has(touch.id)) this.touches.set(touch.id, { x: touch.x, y: touch.y });
    const lifted = event.changedTouches.map((touch) => touch.id);
    const lastFinger = this.first();
    for (const id of lifted) this.touches.delete(id);

    if (this.touches.size > 0) {
      if (this.phase === "scroll" || this.phase === "zoom" || this.phase === "three") this.phase = "spent";
      else if (this.phase === "two") this.two.last = this.first()!;
      return;
    }

    this.clearOneTimers();
    const phase = this.phase;
    this.phase = "idle";

    switch (phase) {
      case "one": {
        const p = lastFinger ?? this.start;
        if (!this.control) return;
        const at = this.mode === "trackpad" ? this.pointer : this.toDisplay(this.start);
        if (this.second) {
          this.out.send({ type: "doubleClick", ...at });
          this.lastTap = null;
        } else {
          this.out.send({ type: "click", ...at });
          this.lastTap = { x: p.x, y: p.y, t: now };
        }
        this.out.clicked();
        return;
      }
      case "drag":
        if (lastFinger) this.last = { ...lastFinger, t: now };
        this.release();
        this.lastTap = null;
        return;
      case "two":
        if (this.most === 2 && now - this.two.t < HOLD_MS) this.twoFingerTap(now);
        return;
      default:
        return;
    }
  }

  cancel() {
    this.abandon();
  }

  // What the gestures do.

  private held() {
    this.holdTimer = undefined;
    if (this.phase !== "one" || !this.control) return;
    const at = this.mode === "trackpad" ? this.pointer : this.toDisplay(this.start);
    this.out.send({ type: "rightClick", ...at });
    this.out.clicked();
    this.phase = "spent";
    this.lastTap = null;
  }

  private dragHeld() {
    this.dragTimer = undefined;
    if (this.phase !== "one" || !this.control) return;
    this.press(this.pointer);
    this.phase = "drag";
  }

  private twoFingerTap(now: number) {
    if (this.lastTwoTap && now - this.lastTwoTap < DOUBLE_TAP_MS) {
      // A two-finger double tap: back to 1x, and the first tap's right-click is called off.
      this.lastTwoTap = 0;
      clearTimeout(this.rightTimer);
      this.rightTimer = undefined;
      this.resetZoom();
      return;
    }
    this.lastTwoTap = now;
    if (!this.control || (this.mode === "touch" && !this.insidePicture(this.two.center))) return;
    const at = this.mode === "trackpad" ? this.pointer : this.toDisplay(this.two.center);
    const rightClick = () => {
      this.rightTimer = undefined;
      this.out.send({ type: "rightClick", ...at });
      this.out.clicked();
    };
    // Zoomed, a second two-finger tap may follow to reset the zoom, so the right-click waits for it.
    if (this.view.scale > 1.01) {
      clearTimeout(this.rightTimer);
      this.rightTimer = setTimeout(rightClick, DOUBLE_TAP_MS);
    } else rightClick();
  }

  private press(at: Point) {
    this.out.send({ type: "down", ...at });
    this.out.grabbed();
  }

  private release() {
    const at = this.mode === "trackpad" ? this.pointer : this.toDisplay(this.last);
    this.out.send({ type: "up", ...at });
  }

  /** Trackpad: moves the pointer by the finger's movement since the last event. */
  private slide(p: Point, now: number) {
    const dx = p.x - this.last.x;
    const dy = p.y - this.last.y;
    const dt = Math.max(1, now - this.last.t);
    const speed = Math.hypot(dx, dy) / dt;
    const gain = POINTER_SPEED + Math.min(ACCEL_MAX, Math.max(0, speed - ACCEL_FROM) * ACCEL_RATE);
    const width = Math.max(1, this.fit.imageWidth * this.view.scale);
    const height = Math.max(1, this.fit.imageHeight * this.view.scale);
    this.movePointer(this.pointer.x + (dx * gain) / width, this.pointer.y + (dy * gain) / height);
  }

  private movePointer(x: number, y: number) {
    this.pointer = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    this.values.pointerX.value = this.pointer.x;
    this.values.pointerY.value = this.pointer.y;
    this.followPointer();
    this.out.send({ type: "move", ...this.pointer });
  }

  /** While zoomed, pans the picture so the pointer stays on screen. */
  private followPointer() {
    const { scale } = this.view;
    if (scale <= 1.01) return;
    const f = this.fit;
    const cx = f.width / 2;
    const cy = f.height / 2;
    let { x, y } = this.view;
    const sx = cx + x + scale * (f.left + this.pointer.x * f.imageWidth - cx);
    const sy = cy + y + scale * (f.top + this.pointer.y * f.imageHeight - cy);
    if (sx < POINTER_MARGIN) x += POINTER_MARGIN - sx;
    else if (sx > f.width - POINTER_MARGIN) x -= sx - (f.width - POINTER_MARGIN);
    if (sy < POINTER_MARGIN) y += POINTER_MARGIN - sy;
    else if (sy > f.height - POINTER_MARGIN) y -= sy - (f.height - POINTER_MARGIN);
    if (x !== this.view.x || y !== this.view.y) this.setView({ scale, x, y });
  }

  private pan(p: Point) {
    const { scale, x, y } = this.view;
    this.setView({ scale, x: x + p.x - this.last.x, y: y + p.y - this.last.y });
    this.last = { x: p.x, y: p.y, t: Date.now() };
  }

  private scroll(center: Point) {
    const dx = center.x - this.two.last.x;
    const dy = center.y - this.two.last.y;
    this.two.last = center;
    if (!dx && !dy) return;
    const width = Math.max(1, this.fit.imageWidth * this.view.scale);
    const height = Math.max(1, this.fit.imageHeight * this.view.scale);
    const at = this.mode === "trackpad" ? this.pointer : this.toDisplay(center);
    // dx and dy are in display pixels, positive to scroll right and down (fingers move up to scroll down).
    this.out.send({ type: "scroll", ...at, dx: Math.round((-dx / width) * this.display.width), dy: Math.round((-dy / height) * this.display.height) });
  }

  private beginTwo(now: number) {
    const [a, b] = this.pair();
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.phase = "two";
    this.two = { distance: distance(a, b), center, last: center, scale: this.view.scale, x: this.view.x, y: this.view.y, t: now };
  }

  /** Pinch and pan: the point of the picture under the fingers' center stays under it. */
  private zoomTo(center: Point, spread: number) {
    const f = this.fit;
    const cx = f.width / 2;
    const cy = f.height / 2;
    const base = this.two;
    const scale = clamp((base.scale * spread) / Math.max(1, base.distance), MIN_ZOOM, MAX_ZOOM);
    const qx = (base.center.x - cx - base.x) / base.scale;
    const qy = (base.center.y - cy - base.y) / base.scale;
    this.setView({ scale, x: center.x - cx - qx * scale, y: center.y - cy - qy * scale });
  }

  private setView(view: { scale: number; x: number; y: number }) {
    const f = this.fit;
    const scale = clamp(view.scale, MIN_ZOOM, MAX_ZOOM);
    const maxX = Math.max(0, (f.imageWidth * scale - f.width) / 2);
    const maxY = Math.max(0, (f.imageHeight * scale - f.height) / 2);
    this.view = { scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
    this.values.scale.value = this.view.scale;
    this.values.x.value = this.view.x;
    this.values.y.value = this.view.y;
  }

  /** A point on the stage as fractions of the display, through the zoom. */
  private fractions(p: Point): Point {
    const f = this.fit;
    const cx = f.width / 2;
    const cy = f.height / 2;
    const x = cx + (p.x - cx - this.view.x) / this.view.scale;
    const y = cy + (p.y - cy - this.view.y) / this.view.scale;
    return { x: (x - f.left) / f.imageWidth, y: (y - f.top) / f.imageHeight };
  }

  private insidePicture(p: Point) {
    const at = this.fractions(p);
    return at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1;
  }

  private toDisplay(p: Point): Point {
    if (this.fit.imageWidth <= 0 || this.fit.imageHeight <= 0) return this.pointer;
    const at = this.fractions(p);
    this.pointer = { x: clamp(at.x, 0, 1), y: clamp(at.y, 0, 1) };
    this.values.pointerX.value = this.pointer.x;
    this.values.pointerY.value = this.pointer.y;
    return this.pointer;
  }

  // Bookkeeping.

  private first(): Point | undefined {
    return this.touches.values().next().value;
  }

  private centroid(): Point {
    let x = 0, y = 0;
    for (const point of this.touches.values()) {
      x += point.x;
      y += point.y;
    }
    return { x: x / this.touches.size, y: y / this.touches.size };
  }

  private pair(): [Point, Point] {
    const it = this.touches.values();
    const a = it.next().value as Point;
    const b = (it.next().value as Point | undefined) ?? a;
    return [a, b];
  }

  private clearOneTimers() {
    clearTimeout(this.holdTimer);
    clearTimeout(this.dragTimer);
    this.holdTimer = undefined;
    this.dragTimer = undefined;
  }

  private abandon() {
    this.clearOneTimers();
    clearTimeout(this.rightTimer);
    this.rightTimer = undefined;
    this.lastTwoTap = 0;
    if (this.phase === "drag") this.release();
    this.touches.clear();
    this.phase = "idle";
    this.lastTap = null;
  }
}
