// Every wire name of plugins ("plugins-v1", docs/plugins.md) on the phone, in one place: the
// capability, the part and the calls. The screens use only what is here, so a rename on the
// computer is a change in this file and in src/link/types.ts.
import type { Href } from "expo-router";
import { create } from "zustand";
import type { PluginConfigValue, PluginMarketplace, PluginPreview } from "@/link/types";
import { useCapability, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { setPrefs, usePrefs } from "@/state/prefs";
import { onComputerChange, useApp } from "@/state/store";

export const PLUGINS_CAPABILITY = "plugins-v1";
export const usePluginsReady = () => useCapability(PLUGINS_CAPABILITY);
/**
 * "plugin-starts-v1": the computer's app describes everything a plugin starts. It is only for the
 * sentence "Update the app on your computer to see everything a plugin runs."; whether one
 * description is whole is decided from that description's own mark (`showsAll` in logic.ts).
 */
export const STARTS_CAPABILITY = "plugin-starts-v1";
export const useOlderComputer = () => !useCapability(STARTS_CAPABILITY);

/** The computer in use, as the key of what the phone told the person once. */
export const useComputerKey = () => useApp((state) => state.pairing?.serverId ?? "");
export const useToldNotices = () => usePrefs((prefs) => prefs.toldNotices);
/** The person closed these notices: they are not shown again. */
export function markTold(keys: string[]) {
  const told = usePrefs.getState().toldNotices;
  const fresh = keys.filter((key) => !told.includes(key));
  if (fresh.length) setPrefs({ toldNotices: [...told, ...fresh].slice(-400) });
}
export const useInstalledPlugins = () => usePart("plugins");
export const useInstalledPlugin = (id: string | undefined) => usePart("plugins")?.find((plugin) => plugin.id === id);

export const pluginCalls = {
  marketplaces: () => api["plugins.marketplaces"](),
  addMarketplace: (source: string) => api["plugins.addMarketplace"](source),
  removeMarketplace: (id: string) => api["plugins.removeMarketplace"](id),
  browse: (query: { marketplace?: string; query?: string; cursor?: string }) => api["plugins.browse"](query),
  preview: (id: string) => api["plugins.preview"](id),
  install: (id: string, options: { bots?: "all" | string[]; config?: Record<string, PluginConfigValue>; revision?: string }) => api["plugins.install"](id, options),
  addFolder: (path: string) => api["plugins.addFolder"](path),
  configure: (id: string, values: Record<string, PluginConfigValue>) => api["plugins.configure"](id, values),
  // `revision`: the installed plugin's, as it was on the screen when the person chose. The computer refuses another one.
  setBots: (id: string, bots: "all" | string[], revision?: string) => (revision === undefined ? api["plugins.setBots"](id, bots) : api["plugins.setBots"](id, bots, { revision })),
  setEnabled: (id: string, on: boolean, revision?: string) => (revision === undefined ? api["plugins.setEnabled"](id, on) : api["plugins.setEnabled"](id, on, { revision })),
  update: (id: string, revision?: string) => api["plugins.update"](id, revision === undefined ? {} : { revision }),
  uninstall: (id: string) => api["plugins.uninstall"](id),
};

// Routes. An id is opaque and may hold any character, so it travels as a query parameter.
export const pluginHref = (id: string) => ("/market/plugin?id=" + encodeURIComponent(id)) as unknown as Href;
export const installHref = (id: string) => ("/market/plugin-install?id=" + encodeURIComponent(id)) as unknown as Href;
export const updateHref = (id: string) => ("/market/plugin-update?id=" + encodeURIComponent(id)) as unknown as Href;
export const addMarketplaceHref = "/market/add-marketplace" as unknown as Href;
export const addFolderHref = "/folders?use=plugin" as unknown as Href;

/**
 * The preview a person is looking at, by plugin id. Install sends its `revision`, so what is
 * installed is what was reviewed; the install sheet reads it from here rather than asking again.
 */
type Previews = { items: Record<string, { preview?: PluginPreview; error?: string; at: number }> };
export const usePluginPreviews = create<Previews>(() => ({ items: {} }));
onComputerChange(() => usePluginPreviews.setState({ items: {} }, true));

/** Reads a plugin's preview again and keeps it. Resolves to it, or undefined with the error kept. */
export async function loadPreview(id: string): Promise<PluginPreview | undefined> {
  try {
    const preview = await pluginCalls.preview(id);
    usePluginPreviews.setState((state) => ({ items: { ...state.items, [id]: { preview, at: Date.now() } } }));
    return preview;
  } catch (error) {
    const message = error instanceof Error ? error.message : "This plugin couldn't be read.";
    usePluginPreviews.setState((state) => ({ items: { ...state.items, [id]: { error: message, at: Date.now() } } }));
    return undefined;
  }
}
export const usePreview = (id: string | undefined) => usePluginPreviews((state) => (id ? state.items[id] : undefined));

/** The marketplaces, as the computer last listed them. Undefined until the first answer. */
type Markets = { list?: PluginMarketplace[]; error?: string };
export const usePluginMarketplaces = create<Markets>(() => ({}));
onComputerChange(() => usePluginMarketplaces.setState({ list: undefined, error: undefined }, true));
export async function loadMarketplaces() {
  try {
    usePluginMarketplaces.setState({ list: await pluginCalls.marketplaces(), error: undefined });
  } catch (error) {
    usePluginMarketplaces.setState({ error: error instanceof Error ? error.message : "The marketplaces didn't load." });
  }
}
