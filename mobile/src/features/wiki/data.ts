// The wiki as the phone last read it. Screens keep showing what they have while a newer copy loads,
// and read again whenever the wiki changes on the computer (revs.wiki).
import { useEffect, useState } from "react";
import { create } from "zustand";
import { onComputerChange } from "@/state/store";
import type { WikiPage, WikiTree, WikiVersion } from "@/link/types";
import { useOnline, usePart } from "@/state/hooks";
import { api } from "@/state/link";
import { message } from "./model";

type Held = {
  tree?: WikiTree;
  /** A page by the path it was asked for. null: there is no such page. */
  pages: Record<string, WikiPage | null>;
  history: Record<string, WikiVersion[]>;
  /** Why a page couldn't be read, when it wasn't because it is gone. */
  errors: Record<string, string>;
};
export const useWiki = create<Held>(() => ({ pages: {}, history: {}, errors: {} }));
// Another computer has another wiki.
onComputerChange(() => useWiki.setState({ tree: undefined, pages: {}, history: {}, errors: {} }));

const GONE = /no wiki page|nothing in the wiki/i;

export async function loadTree(): Promise<WikiTree | undefined> {
  try {
    const tree = await api.wikiTree();
    useWiki.setState({ tree });
    return tree;
  } catch {
    return undefined;
  }
}

export async function loadPage(path: string): Promise<WikiPage | undefined> {
  try {
    const page = await api.wikiPage(path);
    useWiki.setState((held) => {
      const { [path]: _, ...errors } = held.errors;
      return { pages: { ...held.pages, [path]: page }, errors };
    });
    return page;
  } catch (error) {
    const text = message(error);
    if (GONE.test(text)) useWiki.setState((held) => ({ pages: { ...held.pages, [path]: null } }));
    else useWiki.setState((held) => ({ errors: { ...held.errors, [path]: text } }));
    return undefined;
  }
}

export async function loadHistory(path: string) {
  try {
    const versions = await api.wikiHistory(path);
    useWiki.setState((held) => ({ history: { ...held.history, [path]: versions } }));
  } catch {
    // The list on screen stays as it was.
  }
}

/** Keeps what the phone knows of a page under its new path, so the screen doesn't empty while it reloads. */
export function moveCached(from: string, to: string) {
  useWiki.setState((held) => {
    const page = held.pages[from];
    const { [from]: _, ...pages } = held.pages;
    return { pages: page ? { ...pages, [to]: { ...page, path: to } } : pages };
  });
}

/** Forgets a page, after it was moved or removed here. */
export function forgetPage(path: string) {
  useWiki.setState((held) => {
    const { [path]: _, ...pages } = held.pages;
    return { pages };
  });
}

/** The tree, read again when the wiki changes; `refresh` is for pull to refresh. */
export function useWikiTree() {
  const revision = usePart("revs")?.wiki;
  const online = useOnline();
  const tree = useWiki((held) => held.tree);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (online) void loadTree();
  }, [online, revision]);
  const refresh = async () => {
    setRefreshing(true);
    await loadTree();
    setRefreshing(false);
  };
  return { tree, refreshing, refresh };
}

/** One page, read again when the wiki changes. `page` is null when the page is gone. */
export function useWikiPage(path: string) {
  const revision = usePart("revs")?.wiki;
  const online = useOnline();
  const page = useWiki((held) => held.pages[path]);
  const error = useWiki((held) => held.errors[path]);
  const history = useWiki((held) => held.history[path]);
  const versions = page?.versions ?? 0;
  useEffect(() => {
    if (online && path) void loadPage(path);
  }, [online, path, revision]);
  useEffect(() => {
    if (online && path && versions > 0) void loadHistory(path);
  }, [online, path, revision, versions]);
  return { page, error, history: versions > 0 ? history : undefined };
}
