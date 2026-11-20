// The plain logic of a secure input ("secure-input-v1"), with no React Native imports so
// `tests/requests.test.ts` can run it. A bot asks for a password, a one-time code, a secret or a
// user name; what is typed goes to the computer only, and the bot gets a handle it can pass to its
// tools, never the value. These functions see a value only while it is being sent (`cleanValue`,
// `hasValue`, `secureContent`); nothing here keeps one. Every word a person or a screen reader is
// shown comes from the request's title and labels, never from a value.
import type { AgentRequest, CredentialRef, SecureField } from "@/link/types";

/** The kinds of request this phone knows how to answer. Anything else is shown, never guessed at. */
const KNOWN_KINDS = ["permission", "question", "form", "secure"];
export const isKnownKind = (kind: string) => KNOWN_KINDS.includes(kind);
/** The line on a request of a kind this phone doesn't know. */
export const UNKNOWN_LINE = "Update the app on this phone to answer this, or answer it on your computer.";

/** What a failed send says: nothing about what was typed. */
export const SEND_FAILED = "That didn't send. Try again.";

/** The most fields one secure input shows. */
const MAX_FIELDS = 8;
const FIELD_KINDS: SecureField["kind"][] = ["password", "code", "secret", "text"];

/** The request's fields that can be shown: a key and a label each, every key once, at most 8. A kind this phone doesn't know is kept masked, as a secret. */
export function secureFieldsOf(request: AgentRequest): SecureField[] {
  const seen = new Set<string>();
  const fields: SecureField[] = [];
  for (const field of request.fields ?? []) {
    if (!field || typeof field.key !== "string" || !field.key || typeof field.label !== "string" || !field.label.trim() || seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push({ ...field, kind: FIELD_KINDS.includes(field.kind) ? field.kind : "secret" });
    if (fields.length === MAX_FIELDS) break;
  }
  return fields;
}

/** The promise under the title: where the value goes, and that it stays out of the chat. */
export function promiseLine(bot: string | undefined, count: number): string {
  const name = bot?.trim() || "Your bot";
  return count > 1
    ? "Only your computer gets these. " + name + " can use them but never sees them, and they stay out of the chat."
    : "Only your computer gets this. " + name + " can use it but never sees it, and it stays out of the chat.";
}

/** The labels, for a line that names what is asked for. */
export const labelsLine = (fields: SecureField[]) => fields.map((field) => field.label.trim()).join(", ");

/** What a screen reader says for a field: its label, never its value. */
export const fieldLabel = (field: SecureField) => field.label.trim() + (field.optional ? ", optional" : "");

/** The show and hide control beside a masked field. */
export const toggleLabel = (shown: boolean, label: string) => (shown ? "Hide " : "Show ") + label.trim();

export type FieldProps = {
  masked: boolean;
  textContentType: "password" | "oneTimeCode" | "none" | "username";
  autoComplete: "current-password" | "one-time-code" | "off" | "username";
  keyboardType: "ascii-capable" | "default";
  importantForAutofill: "yes" | "no";
};

/**
 * A field's keyboard, autofill and masking, by kind. Every field also turns off autocorrect, spell
 * check, capitals and smart punctuation, and keeps paste (`SecureInput.tsx`).
 */
export function fieldProps(kind: SecureField["kind"]): FieldProps {
  switch (kind) {
    case "password":
      return { masked: true, textContentType: "password", autoComplete: "current-password", keyboardType: "ascii-capable", importantForAutofill: "yes" };
    case "code":
      return { masked: false, textContentType: "oneTimeCode", autoComplete: "one-time-code", keyboardType: "ascii-capable", importantForAutofill: "yes" };
    case "text":
      return { masked: false, textContentType: "username", autoComplete: "username", keyboardType: "default", importantForAutofill: "yes" };
    default:
      return { masked: true, textContentType: "none", autoComplete: "off", keyboardType: "ascii-capable", importantForAutofill: "no" };
  }
}

/** A value as it is sent: a user name without spaces around it, a code without any, a password or secret exactly as typed. */
export function cleanValue(kind: SecureField["kind"], raw: string): string {
  if (kind === "code") return raw.replace(/\s+/g, "");
  if (kind === "text") return raw.trim();
  return raw;
}

/** Whether a field has something in it worth sending (spaces alone are not). */
export const hasValue = (kind: SecureField["kind"], raw: string) => cleanValue(kind, raw).trim() !== "";

/** Whether every field that is not optional has a value or a saved credential. */
export const secureReady = (fields: SecureField[], filled: string[]) => fields.length > 0 && fields.every((field) => field.optional || filled.includes(field.key));

/**
 * The `content` of the answer: each field's value under its key, or a saved credential by its
 * reference (the computer fills that in, so its value is never on the phone). An empty field is
 * left out. `read` asks each field's own input; nothing is kept here.
 */
export function secureContent(fields: SecureField[], read: (key: string) => string | CredentialRef | undefined): Record<string, string | CredentialRef> {
  const content: Record<string, string | CredentialRef> = {};
  for (const field of fields) {
    const value = read(field.key);
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (hasValue(field.kind, value)) content[field.key] = cleanValue(field.kind, value);
    } else content[field.key] = value;
  }
  return content;
}

/** The return key: on to the next field, and send from the last. */
export const returnKeyOf = (index: number, count: number): "next" | "send" => (index < count - 1 ? "next" : "send");
