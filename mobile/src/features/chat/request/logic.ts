// The plain logic of what a bot asks of the person (an approval, a question or a form), with no
// React Native imports so `tests/requests.test.ts` can run it. The words are the desktop app's
// (desktop/src/RequestPanel.tsx), so both apps say the same thing.
import type { AgentRequest, FormField } from "@/link/types";

// --- What a request looks like -------------------------------------------------------------

const SECRET = /\b(password|passwd|passcode|passphrase|secret|token|api ?key|access ?key|private ?key|key|pin|otp|2fa|mfa|one ?time ?code|verification ?code)s?\b/;
const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/]+/g, " ")
    .toLowerCase();
/** Whether a name or title asks for a secret ("API key", "password", "otp_code"). */
export const looksSecret = (...texts: (string | undefined)[]) => texts.some((text) => !!text && SECRET.test(words(text)));
/** Whether a form's field is a secret: a password format, or a name or title that says so. */
export const isSecretField = (key: string, field: FormField) => field.format === "password" || looksSecret(key, field.title);

const DANGER = /\brm\s+(-\w*r\w*f|-\w*f\w*r|--recursive\s+--force|--force\s+--recursive)\b|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|\bpush\b[^\n]*(\s-f\b|--force)|\bforce[- ]push|\bdelete\b|\bformat\b|\bmkfs\b|\bdd\s+if=|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-\w*f/i;
/** Whether a request's command or words look destructive. */
export const looksDangerous = (request: AgentRequest) => DANGER.test([request.preview, request.label, request.title].filter(Boolean).join("\n"));

/** The host of a web address, without a user name; null for anything but http and https. */
export function hostOf(url: string): string | null {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1].replace(/^[^@]*@/, "") : null;
}

// --- A choice as a label and a description ----------------------------------------------------

export type ChoiceParts = { label: string; description?: string };

/** Past this a dash or a line break does not start a description: the first part is a sentence. */
const LABEL_MAX = 80;
/** A colon ends a label only after a few words ("Production: what people use"). */
const COLON_LABEL_MAX = 48;
const unbold = (text: string) => text.replace(/^(\*\*|__)(.+)\1$/, "$2").trim();

/**
 * A choice as a bot wrote it, read as a label and, when it carries one, a description: after the
 * first line break, a spaced dash ("Staging — safe to break") or a colon after a short label
 * ("Production: what people use"). The first of these wins. A hyphen inside a word, an address
 * and a parenthesis are part of the label. Only for showing: the answer sent is the whole choice.
 */
export function splitChoice(choice: string): ChoiceParts {
  const text = choice.trim();
  const cuts: { at: number; end: number }[] = [];
  const line = /\s*\n\s*/.exec(text);
  if (line) cuts.push({ at: line.index, end: line.index + line[0].length });
  const dash = /\s+[—–-]\s+/.exec(text);
  if (dash && dash.index <= LABEL_MAX) cuts.push({ at: dash.index, end: dash.index + dash[0].length });
  const colon = /:\s+/.exec(text);
  if (colon && colon.index <= COLON_LABEL_MAX) cuts.push({ at: colon.index, end: colon.index + colon[0].length });
  const cut = cuts.filter(({ at, end }) => text.slice(0, at).trim() && text.slice(end).trim()).sort((a, b) => a.at - b.at)[0];
  if (!cut) return { label: unbold(text) };
  return { label: unbold(text.slice(0, cut.at)), description: text.slice(cut.end).trim() };
}

/** What a screen reader says for a choice. */
export const choiceLabel = ({ label, description }: ChoiceParts) => (description ? label + ", " + description : label);

// --- Words ---------------------------------------------------------------------------------

/** The card's heading, and its line when folded: who asks, and what kind of thing it is. */
export function heading(kind: AgentRequest["kind"], bot?: string, danger?: boolean): string {
  const name = bot?.trim() || "Your bot";
  switch (kind) {
    case "permission":
      return name + (danger ? " wants to do something risky" : " needs approval");
    case "question":
    case "form":
      return name + " has a question";
    case "secure":
      return name + " needs a secure input";
    default:
      // A kind from a newer computer: nothing is guessed about it.
      return name + " needs you";
  }
}

/** "1 of 3" when more than one request waits in the chat. */
export const countLabel = (count?: number) => (count && count > 1 ? "1 of " + count : undefined);

/** What a screen reader says for the heading, which folds and opens the card. */
export function headerLabel(request: AgentRequest, { bot, danger, count }: { bot?: string; danger?: boolean; count?: number }): string {
  const of = countLabel(count);
  return heading(request.kind, bot, danger) + (of ? ", " + of : "");
}

export const foldHint = (open: boolean) => (open ? "Folds the request so you can read the chat" : "Opens the request");

/** The buttons' words. `quiet` is Deny or Dismiss, `main` the card's one main action. */
export function wordsFor(kind: AgentRequest["kind"]): { quiet: string; main: string; remember?: string } {
  if (kind === "permission") return { quiet: "Deny", main: "Allow once", remember: "Allow for this chat" };
  if (kind === "secure") return { quiet: "Decline", main: "Send securely" };
  return { quiet: "Dismiss", main: "Send answer" };
}

/** The line on a question whose turn went on without an answer (the desktop app says the same in src/RequestPanel.tsx). */
export const DETACHED_LINE = "Waiting for your answer. Your reply starts a new turn.";

/** The line under an approval that can be remembered. */
export const rememberNote = (remember: string) => "Remembering this approval allows " + remember + " for this conversation.";

// --- What is shown ---------------------------------------------------------------------------

/** The full request is folded under "Full request" when there is a preview, and shown without one. */
export function detailMode(request: AgentRequest): "none" | "folded" | "open" {
  if (!request.detail) return "none";
  return request.preview ? "folded" : "open";
}

/** A question takes a typed answer when the bot allows one, or when it gives no choices to pick. */
export const freeAnswerShown = (request: AgentRequest) => request.kind === "question" && (!!request.freeform || !request.choices?.length);

/** The answer a question sends: the typed text when there is any, else the chosen choice, whole. */
export function answerOf(choice: string | undefined, typed: string): string | null {
  const free = typed.trim();
  if (free) return free;
  return choice ? choice : null;
}

// --- Forms -----------------------------------------------------------------------------------

/** A field's choices, from `oneOf` or `enum`, each with the words to show. */
export const choicesOf = (field: FormField) =>
  field.oneOf?.map((option) => ({ value: option.const, label: option.title ?? option.const })) ?? field.enum?.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));

/** A field's starting value. A secret always starts empty. */
export function initialValue(field: FormField, secret: boolean): unknown {
  if (secret) return "";
  if (field.default !== undefined) return field.default;
  if (field.type === "boolean") return false;
  return field.type === "number" || field.type === "integer" ? undefined : "";
}

/** Whether every required field has a value, or a saved credential picked in its place. */
export const formReady = (required: string[], values: Record<string, unknown>, picked: string[]) =>
  required.every((key) => picked.includes(key) || (values[key] !== undefined && values[key] !== ""));

// --- Layout ----------------------------------------------------------------------------------

/** A character's width in ems for a face, roughly, in semibold: mono and serif faces run wider. */
export function emFor(family: string | undefined): number {
  const name = (family ?? "").toLowerCase();
  if (name.includes("mono")) return 0.62;
  if (/serif|georgia|lora/.test(name) && !name.includes("sans")) return 0.6;
  return 0.57;
}

/** A button's padding on each side (Button, size md). */
const BUTTON_PAD = 20;

/**
 * Whether buttons fit side by side in `width` without cutting a label. A label's width is guessed
 * from its length: `em` is a character's width in ems, about 0.57 for the proportional faces in
 * semibold and 0.62 for SF Mono. `extra` is an icon or ring beside the label. Before the row is
 * measured (`width` 0) they sit side by side, as most cards do.
 */
export function fitsSideBySide(width: number, buttons: { label: string; extra?: number }[], fontSize: number, em = 0.57, gap = 8): boolean {
  if (width <= 0) return true;
  const each = (width - gap * (buttons.length - 1)) / buttons.length;
  return buttons.every(({ label, extra = 0 }) => Math.ceil(label.length * fontSize * em) + BUTTON_PAD * 2 + extra <= each);
}
