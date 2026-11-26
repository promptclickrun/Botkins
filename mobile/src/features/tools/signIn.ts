// A tool's browser sign-in (OAuth), started from the phone. When the computer can hand the sign-in
// to the phone ("startMcpSignIn"), the page opens in the phone's browser and the address it comes
// back to goes to the computer, which trades it for tokens itself. A computer with no browser (a
// server) can only sign in this way. An older computer opens the page in its own browser.
import * as WebBrowser from "expo-web-browser";
import type { McpAuth } from "@/link/types";
import { api } from "@/state/link";
import { useApp } from "@/state/store";

export const PHONE_SIGN_IN = "startMcpSignIn";

/** Whether the paired computer lets the phone's browser do a tool's sign-in. */
export const phoneSignIn = (capabilities: string[] | undefined) => !!capabilities?.includes(PHONE_SIGN_IN);

/** The page's answer, when it came back to the address the computer named. null when the person closed the page. */
export function answerOf(result: WebBrowser.WebBrowserAuthSessionResult, redirect: string): string | null {
  if (result.type !== "success") return null;
  const base = redirect.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + base + "/?[?#]").test(result.url) ? result.url : null;
}

/** Signs a tool in. Resolves the tool's sign-in state once it is done, or undefined when it was cancelled. Throws what went wrong. */
export async function signInTool(id: string): Promise<McpAuth | undefined> {
  const capabilities = (useApp.getState().parts.meta as { capabilities?: string[] } | undefined)?.capabilities;
  if (!phoneSignIn(capabilities)) return await api.signInMcpServer(id);
  const { url, redirect } = await api["link.startMcpSignIn"](id);
  if (!/^https:\/\//i.test(url)) {
    void api.cancelMcpSignIn(id).catch(() => {});
    throw new Error("That sign-in page can't be opened.");
  }
  const result = await WebBrowser.openAuthSessionAsync(url, redirect);
  const answer = answerOf(result, redirect);
  if (!answer) {
    void api.cancelMcpSignIn(id).catch(() => {});
    return undefined;
  }
  return await api["link.finishMcpSignIn"](id, answer);
}
