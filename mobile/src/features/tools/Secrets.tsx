// Named secrets in a form: environment variables and headers. A stored value never comes back from
// the computer, so it shows as "Saved" with a way to replace it. A value can also be a saved
// credential, which the computer fills in.
import { Lock, Plus, X } from "lucide-react-native";
import { View } from "react-native";
import { CredentialPicker, PickedCredential } from "@/features/credentials/CredentialPicker";
import type { CredentialRef } from "@/link/types";
import { Button, Field, IconButton, radius, space, T, Tap, useTheme } from "@/ui";

/** A saved credential picked in place of a typed value. */
export type PickedRef = { id: string; name: string };
export type Secret = { id: string; name: string; value: string; /** The computer holds a value for this name. */ stored: boolean; replace: boolean; ref?: PickedRef };

/** A credential reference where the input type says string: the computer swaps in the value before the desktop sees it. */
/** A picked credential as it goes to the computer. `prefix` is the scheme an Authorization header needs ("Bearer "). */
export const refValue = (ref: PickedRef, prefix?: string) => ({ $credential: ref.id, ...(prefix && { prefix }) }) satisfies CredentialRef as unknown as string;

export const newSecret = (): Secret => ({ id: Math.random().toString(36).slice(2), name: "", value: "", stored: false, replace: false });
export const storedSecret = (name: string, stored = true): Secret => ({ id: "s:" + name, name, value: "", stored, replace: false });

/** The record to send: a stored value that was not replaced is sent as null, which keeps it. */
export function secretRecord(secrets: Secret[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const secret of secrets) {
    const name = secret.name.trim();
    if (name) out[name] = secret.stored && !secret.replace ? null : secret.ref ? refValue(secret.ref) : secret.value;
  }
  return out;
}

/** Stands in for a secret field whose value is kept on the computer. */
export function SavedValue({ label, onReplace }: { label: string; onReplace: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={{ minHeight: 50, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
      <Lock size={15} color={colors.muted} strokeWidth={2.3} />
      <T variant="callout" color="muted" style={{ flex: 1 }} accessibilityLabel={label + ": saved"}>
        Saved
      </T>
      <Tap onPress={onReplace} feel="select" accessibilityLabel={"Replace " + label} style={{ minHeight: 44, paddingHorizontal: space.md, justifyContent: "center" }}>
        <T variant="subhead" weight="600" color="accentText">
          Replace
        </T>
      </Tap>
    </View>
  );
}

export function SecretList({ secrets, onChange, namePlaceholder, addLabel, upper, disabled }: { secrets: Secret[]; onChange: (next: Secret[]) => void; namePlaceholder: string; addLabel: string; upper?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  const update = (id: string, patch: Partial<Secret>) => onChange(secrets.map((secret) => (secret.id === id ? { ...secret, ...patch } : secret)));
  return (
    <View style={{ gap: space.md }}>
      {secrets.map((secret) => {
        const label = secret.name.trim() || namePlaceholder;
        return (
          <View key={secret.id} style={{ gap: space.sm, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              {secret.stored ? (
                <View style={{ flex: 1, minHeight: 44, justifyContent: "center", paddingHorizontal: space.xs }}>
                  <T variant="mono" weight="600" numberOfLines={1}>
                    {secret.name}
                  </T>
                </View>
              ) : (
                <Field
                  containerStyle={{ flex: 1 }}
                  placeholder={namePlaceholder}
                  accessibilityLabel="Name"
                  value={secret.name}
                  onChangeText={(name) => update(secret.id, { name: upper ? name.toUpperCase().replace(/[^A-Z0-9_]/g, "_") : name })}
                  autoCapitalize={upper ? "characters" : "none"}
                  autoCorrect={false}
                  mono
                  editable={!disabled}
                />
              )}
              <IconButton icon={X} label={"Remove " + label} size={44} color={colors.muted} onPress={() => onChange(secrets.filter((item) => item.id !== secret.id))} disabled={disabled} />
            </View>
            {secret.stored && !secret.replace ? (
              <SavedValue label={label} onReplace={() => update(secret.id, { replace: true })} />
            ) : secret.ref ? (
              <PickedCredential name={secret.ref.name} onClear={() => update(secret.id, { ref: undefined })} disabled={disabled} />
            ) : (
              <>
                <Field placeholder="Value" accessibilityLabel={label + " value"} value={secret.value} onChangeText={(value) => update(secret.id, { value })} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!disabled} />
                <CredentialPicker disabled={disabled} onPick={(ref, picked) => update(secret.id, { ref: { id: ref.$credential, name: picked }, value: "" })} />
              </>
            )}
          </View>
        );
      })}
      <Button title={addLabel} icon={Plus} variant="secondary" size="sm" onPress={() => onChange([...secrets, newSecret()])} disabled={disabled} />
    </View>
  );
}
