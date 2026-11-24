// Market's lists from the computer: the direct apps catalog (shared by the landing, the Apps page and
// an app's sheet, and asked again when the computer's tools change), the featured skills and the
// templates. Nothing polls: a list is asked when a screen needs it and when what is behind it changed.
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { FeaturedSkill, MarketAgent, McpCatalog } from "@/link/types";
import { useCan, useCapability, useOnline, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { useApp } from "@/state/store";
import { AGENTS_CAPABILITY } from "./agents/logic";
import { CATALOG_CAPABILITY, FEATURED_CAPABILITY } from "./catalog";

type CatalogSlot = { host?: string; catalog?: McpCatalog; error?: string };
const useCatalogStore = create<CatalogSlot>(() => ({}));
const EMPTY: CatalogSlot = {};

let running: Promise<void> | undefined;
let again = false;

/** Asks the computer for the apps catalog. A call while one runs asks once more after it. */
export function loadMcpCatalog(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  const host = useApp.getState().pairing?.serverId;
  running = api["mcpCatalog.list"]()
    .then(
      (catalog) => {
        if (useApp.getState().pairing?.serverId === host) useCatalogStore.setState({ host, catalog, error: undefined });
      },
      (error: unknown) => {
        if (useApp.getState().pairing?.serverId !== host) return;
        const message = error instanceof Error ? error.message : "The apps didn't load.";
        useCatalogStore.setState((was) => (was.host === host ? { ...was, error: message } : { host, error: message }));
      },
    )
    .finally(() => {
      running = undefined;
      if (again) {
        again = false;
        void loadMcpCatalog();
      }
    });
  return running;
}

/** The apps catalog on this computer, asked again when its tools change. */
export function useMcpCatalog() {
  const supported = useCapability(CATALOG_CAPABILITY);
  const allowed = useCan("mcp", "view");
  const online = useOnline();
  const host = useApp((state) => state.pairing?.serverId);
  const tools = usePart("mcp");
  const ready = supported && allowed && online && !!host;
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => void loadMcpCatalog(), 120);
    return () => clearTimeout(timer);
  }, [ready, host, tools]);
  const slot = useCatalogStore((state) => (state.host === host ? state : EMPTY));
  return { supported, allowed, catalog: slot.catalog, error: slot.error };
}

/** One list asked of the computer, again when `key` changes or on `retry`. */
function useAsked<T>(key: string | undefined, load: () => Promise<T>) {
  const [slot, setSlot] = useState<{ key: string; value?: T; error?: string }>();
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    load().then(
      (value) => live && setSlot({ key, value }),
      (error: unknown) => live && setSlot((was) => ({ key, value: was?.value, error: error instanceof Error ? error.message : "That didn't load." })),
    );
    return () => {
      live = false;
    };
    // `load` is a call by name; `key` says when to ask again.
  }, [key, tries]);
  // A list from another computer is never shown.
  const shown = slot && key && slot.key.split("|")[0] === key.split("|")[0] ? slot : undefined;
  return { value: shown?.value, error: shown && shown.key === key ? shown.error : undefined, loading: !!key && shown?.key !== key, retry: () => setTries((n) => n + 1) };
}

// A number for each version of a part, so a key can say "the skills changed".
const versions = new WeakMap<object, number>();
let lastVersion = 0;
const versionOf = (part: object | undefined) => {
  if (!part) return 0;
  if (!versions.has(part)) versions.set(part, ++lastVersion);
  return versions.get(part)!;
};

/** The featured skills (skills-featured-v1), asked again when the skills change (to show Installed). */
export function useFeaturedSkills() {
  const supported = useCapability(FEATURED_CAPABILITY);
  const allowed = useCan("skills", "read");
  const online = useOnline();
  const host = useApp((state) => state.pairing?.serverId);
  const skills = usePart("skills");
  const key = supported && allowed && online && host ? host + "|" + versionOf(skills) : undefined;
  const asked = useAsked<FeaturedSkill[]>(key, () => api["skillsCatalog.featured"]());
  return { supported, allowed, ...asked };
}

/** Every template the computer's marketplaces offer (agents.browse with nothing narrowed). */
export function useTemplates() {
  const supported = useCapability(AGENTS_CAPABILITY);
  const allowed = useCan("agents", "create");
  const online = useOnline();
  const host = useApp((state) => state.pairing?.serverId);
  const [tick, setTick] = useState(0);
  const key = supported && allowed && online && host ? host + "|" + tick : undefined;
  const asked = useAsked<MarketAgent[]>(key, () => api["agents.browse"]({}).then((page) => page.agents));
  return { supported, allowed, ...asked, reload: () => setTick((n) => n + 1) };
}
