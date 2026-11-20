// Where the wiki's screens go.
import { type Href, router } from "expo-router";

export const openPage = (path: string) => router.push({ pathname: "/wiki/page", params: { path } });
export const editPage = (path: string) => router.push({ pathname: "/wiki/edit", params: { path } });
export const newPageIn = (folder: string) => router.push({ pathname: "/wiki/edit", params: { folder } });
/** Export…: the whole wiki, or starting from one page. */
export const exportWiki = (start?: string) => router.push({ pathname: "/wiki/export", params: start ? { start } : {} } as unknown as Href);
