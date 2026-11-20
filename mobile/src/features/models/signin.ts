// Signing a model provider in, and installing one, from the phone ("provider-signin-v1"). The
// computer runs the provider's own sign-in or install command, with no browser of its own; the
// phone shows what it says: a page to open here and a code to type there, the tool's own lines,
// and a question it waits on. A pasted token is the other way in. Plain logic with no React
// Native imports: tests/provider-signin.test.ts runs it.
import type { ProviderSignInEvent, ProviderSignInView, ProviderStatus } from "@/link/types";

export const SIGNIN_CAPABILITY = "provider-signin-v1";
/** How many of the tool's lines the sheet keeps. */
export const MAX_LINES = 40;

/** What the provider's page offers. */
export type ProviderAction =
  | { kind: "install" } // the computer can install its tool
  | { kind: "install-guide" } // only a guide: install it on the computer
  | { kind: "signin"; token: boolean } // its own sign-in, run on the computer, finished on the phone
  | { kind: "token" } // a pasted token is the only way from here
  | { kind: "computer" } // a computer without the capability: finish on the computer
  | { kind: "services" } // its model services, one by one
  | { kind: "none" };

export function providerAction(provider: ProviderStatus, capable: boolean): ProviderAction {
  if (!provider.installed) return capable && provider.install?.command ? { kind: "install" } : { kind: "install-guide" };
  if (provider.signIn === "services") return { kind: "services" };
  if (provider.connected) return { kind: "none" };
  const ways = capable ? provider.signInWays : undefined;
  if (ways?.guided) return { kind: "signin", token: ways.token };
  if (ways?.token) return { kind: "token" };
  return provider.signIn === "browser" ? { kind: "computer" } : { kind: "none" };
}

/** A page the phone may open: a web address over https, and nothing else. */
export function safePage(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** The host of a page, to name it on its button ("github.com"). */
export const pageHost = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A sign-in or an install as the sheet shows it, built from every event read so far. */
export type RunState = {
  /** A page and the code to type there (GitHub's device sign-in). */
  code?: { url: string; code: string };
  /** The newest page to open, when there is no code card. */
  page?: string;
  /** The tool's own lines, newest last. */
  lines: string[];
  /** The tool waits for a line: what it asked ("" when it asked in its own lines). */
  prompt?: string;
  next: number;
  done: boolean;
  error?: string;
  result?: ProviderSignInView["result"];
};

export const startState = (): RunState => ({ lines: [], next: 0, done: false });

/** Adds what one read brought. Events already seen (a number not past `next`) are skipped. */
export function applyView(state: RunState, view: ProviderSignInView): RunState {
  let next: RunState = { ...state, lines: state.lines };
  for (const event of view.events) {
    if (event.n <= next.next) continue;
    next = applyEvent(next, event);
  }
  next.next = Math.max(next.next, view.next);
  next.done = view.done;
  if (view.error) next.error = view.error;
  if (view.result) next.result = view.result;
  // A question stands while the tool waits; it goes once the tool moves on.
  if (!view.wantsInput || view.done) delete next.prompt;
  else next.prompt ??= "";
  return next;
}

function applyEvent(state: RunState, event: ProviderSignInEvent): RunState {
  const next: RunState = { ...state, next: event.n };
  if (event.type === "code") {
    const url = safePage(event.url);
    if (url && event.code) next.code = { url, code: event.code.slice(0, 64) };
  } else if (event.type === "open") {
    const url = safePage(event.url);
    if (url) next.page = url;
  } else if (event.type === "output") {
    const text = event.text.replace(/\s+$/, "");
    if (text) next.lines = [...state.lines, text.slice(0, 500)].slice(-MAX_LINES);
  } else if (event.type === "prompt") next.prompt = event.text.slice(0, 500);
  return next;
}

/**
 * A code the tool printed in its own lines ("Enter this one-time code: 4F7K-LQ2P"), for a tool
 * that has no code event of its own (Codex, an ACP agent). The newest one wins.
 */
export function codeInLines(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /\bcode\b[^:]*:\s*([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){0,3})\s*$/i.exec(lines[i]);
    if (match && /\d|-/.test(match[1])) return match[1].toUpperCase();
  }
  return null;
}

/** The line that says how it ended, for the finished sheet. */
export function finishedLine(result: RunState["result"], name: string): string {
  if (result?.installed) return name + " is installed" + (result.version ? " (" + result.version + ")" : "") + ".";
  if (result?.account) return "Signed in as " + result.account + ".";
  return "Signed in to " + name + ".";
}
