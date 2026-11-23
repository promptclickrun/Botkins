import type { PullRequest } from "./types";

/** A Markdown link in the message itself, so every harness receives the same reference. */
export function pullReference(pull: PullRequest) {
  const label = ("#" + pull.number + " " + pull.title).replace(/[[\]\\]/g, (char) => "\\" + char);
  return "[" + label + "](" + pull.url + ")";
}

/** The picked links still present in a draft, including after switching back to its chat. */
export function draftPulls(text: string) {
  const links = new Map<string, string>();
  for (const match of text.matchAll(/\[(#\d+ (?:\\.|[^\]\\\n])+)\]\((https:\/\/github\.com\/[\w-]+\/[\w.-]+\/pull\/[1-9]\d*)\)/gi)) {
    links.set(match[2], match[1].replace(/\\([[\]\\])/g, "$1"));
  }
  return [...links].map(([url, label]) => ({ url, label }));
}
