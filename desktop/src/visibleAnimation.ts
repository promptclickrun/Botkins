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
}

const observed = new Map<Element, Observed>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;

function update(item: Observed) {
  const running = item.intersecting && document.visibilityState === "visible" && !reducedMotion?.matches;
  item.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  item.element.style.setProperty("--visible-animation-will-change", running ? "transform" : "auto");
}

function updateAll() {
  for (const item of observed.values()) update(item);
}

export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
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

  const item: Observed = { element, intersecting: false };
  observed.set(element, item);
  observer.observe(element);

  return () => {
    if (observed.get(element) !== item) return;
    observed.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (observed.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAll);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAll);
    }
  };
}
