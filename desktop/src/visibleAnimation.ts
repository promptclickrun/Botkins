// Runs a looping CSS animation only while someone can see it, the way T3 Code does
// (apps/web/src/lib/visibleAnimation.ts). An element handed to `observeVisibleAnimation` gets
// `--visible-animation-state`, which its CSS reads as `animation-play-state`: "running" while the
// element is on screen, the window is visible and the person has not asked for less motion, and
// "paused" otherwise. `--visible-animation-will-change` promotes it to its own layer only while it
// runs. One IntersectionObserver serves every element, and it goes away with the last one.
//
// Use it as a ref callback: `ref={on ? observeVisibleAnimation : undefined}`. React 19 calls the
// cleanup it returns when the element leaves.

interface Observed {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
  playback?: (state: "running" | "paused" | "reduced") => void;
}

const observed = new Map<Element, Observed>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function update(item: Observed) {
  const visible = item.intersecting && document.visibilityState === "visible";
  const state = reducedMotion?.matches ? "reduced" : visible ? "running" : "paused";
  if (item.playback) item.playback(state);
  else {
    item.element.style.setProperty("--visible-animation-state", state === "running" ? "running" : "paused");
    item.element.style.setProperty("--visible-animation-will-change", state === "running" ? "transform" : "auto");
  }
}

function updateAll() {
  for (const item of observed.values()) update(item);
}

/** A playback callback gives Web Animations the same visibility and motion policy as CSS. */
export function observeVisibleAnimation(element: HTMLElement | SVGElement | null, playback?: Observed["playback"]) {
  if (element === null) return;
  const item: Observed = { element, intersecting: false, playback };
  update(item);
  if (typeof IntersectionObserver === "undefined") return;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAll);
    document.addEventListener("visibilitychange", updateAll);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const item = observed.get(entry.target);
        if (!item) continue;
        item.intersecting = entry.isIntersecting;
        update(item);
      }
    });
  }

  observed.set(element, item);
  observer.observe(element);

  return () => {
    if (observed.get(element) !== item) return;
    observed.delete(element);
    observer?.unobserve(element);
    item.intersecting = false;
    update(item);
    if (observed.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAll);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAll);
    }
  };
}
