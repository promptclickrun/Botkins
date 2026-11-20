// Where a bot asks for a secret: a masked field, and the saved credentials to answer with instead.
// Choosing one answers with its reference ({ $credential: id }); this computer puts the value in
// after the answer leaves the page, so the page never holds it.
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type { CredentialRef, FormField, SavedCredential } from "./types";
import "./savedcredentials.css";

const SECRET =
  /\b(password|passwd|passcode|passphrase|secret|token|api ?key|access ?key|private ?key|key|pin|otp|2fa|mfa|one ?time ?code|verification ?code)s?\b/;
const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/]+/g, " ")
    .toLowerCase();
/** Whether a question or a field name asks for a secret ("API key", "password", "otp_code"). */
export const looksSecret = (...texts: (string | undefined)[]) => texts.some((text) => !!text && SECRET.test(words(text)));
/** A form field that holds a secret: marked as a password, or named like one. */
export const isSecretField = (name: string, field: FormField) =>
  field.type === "string" && (field.format === "password" || looksSecret(name, field.title));

export type Picked = { ref: CredentialRef; name: string };

/** The saved credentials, by name, loaded once a secret is asked for. null when they can't be listed. */
export function useSavedCredentials(wanted: boolean) {
  const [list, setList] = useState<SavedCredential[] | null>();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    window.botkins
      .savedCredentials()
      .then((v) => live && setList([...v.entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, [wanted]);
  return list;
}

const openCredentials = () => window.dispatchEvent(new CustomEvent("botkins-open-settings", { detail: "Credentials" }));

/**
 * "Use a saved credential": a choice of saved credentials, or, when there are none, a link to
 * Settings › Credentials. `label` names what is asked for ("Your answer", a field's title).
 */
export function CredentialChoice({
  label,
  saved,
  picked,
  pick,
  disabled,
}: {
  label: string;
  saved: SavedCredential[] | null | undefined;
  picked?: Picked;
  pick: (next: Picked | undefined) => void;
  disabled?: boolean;
}) {
  if (saved === undefined) return null;
  if (!saved?.length)
    return (
      <small className="scred-pick-none">
        <KeyRound size={12} aria-hidden="true" />
        <button type="button" className="set-link" onClick={openCredentials}>
          Save a credential in Settings › Credentials
        </button>{" "}
        to answer with it next time.
      </small>
    );
  return (
    <span className="scred-pick">
      <KeyRound size={13} aria-hidden="true" />
      <select
        aria-label={"Use a saved credential for " + label}
        value={picked?.ref.$credential ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const entry = saved.find((c) => c.id === e.target.value);
          pick(entry ? { ref: { $credential: entry.id }, name: entry.name } : undefined);
        }}
      >
        <option value="">Use a saved credential…</option>
        {saved.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {picked && <small>Botkins puts it in on this computer. It isn't shown here.</small>}
    </span>
  );
}
