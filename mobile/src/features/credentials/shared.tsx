// What the credentials screens share: the owner check, the password manager list, marks and badges,
// and the masked field a secret is typed into. A value is never read back from the computer.
import type * as LocalAuth from "expo-local-authentication";
import { Eye, EyeOff, KeyRound, Lock, LockKeyhole, type LucideIcon, ShieldCheck, StickyNote, User, Vault } from "lucide-react-native";
import { useEffect, useState } from "react";
import { TextInput, type TextInputProps, View } from "react-native";
import { create } from "zustand";
import type { Credential, CredentialKind, CredentialSource, PasswordManagerId, PasswordManagerStatus } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { onComputerChange, useApp } from "@/state/store";
import { brand, EmptyState, IconButton, IconTile, Loading, radius, space, T, type Tone, useTheme } from "@/ui";

export const CAPABILITY = "credentials-v1";
export const MANAGER_IDS: PasswordManagerId[] = ["onepassword", "bitwarden", "protonpass"];
export const isManagerId = (id: string | undefined): id is PasswordManagerId => !!id && (MANAGER_IDS as string[]).includes(id);

const MANAGER_NAMES: Record<PasswordManagerId, string> = { onepassword: "1Password", bitwarden: "Bitwarden", protonpass: "Proton Pass" };
export const managerName = (id: CredentialSource) => (id === "vault" ? "Built-in vault" : MANAGER_NAMES[id]);

/** The computer's name, as the person knows it. */
export const useComputerName = () => {
  const paired = useApp((state) => state.pairing?.name);
  const meta = usePart("meta");
  return paired ?? meta?.name ?? "your computer";
};

// The owner check: once per app session, when the phone has a passcode or biometrics.

type Owner = "unknown" | "checking" | "open" | "locked";
const useOwner = create<{ owner: Owner }>(() => ({ owner: "unknown" }));

/** The phone's own sign-in, or null when this app binary was built without it. */
function localAuth(): typeof LocalAuth | null {
  try {
    // A static import throws when the native module isn't in the binary yet.
    return require("expo-local-authentication") as typeof LocalAuth;
  } catch {
    return null;
  }
}

async function verifyOwner(reason: string): Promise<boolean> {
  const auth = localAuth();
  if (!auth) return true;
  try {
    const level = await auth.getEnrolledLevelAsync();
    if (level === auth.SecurityLevel.NONE) return true;
    const result = await auth.authenticateAsync({ promptMessage: reason, cancelLabel: "Cancel" });
    if (result.success) return true;
    // A phone with nothing to check with can't lock anyone out.
    return result.error === "not_enrolled" || result.error === "passcode_not_set" || result.error === "not_available";
  } catch {
    return false;
  }
}

/**
 * Asks the phone's owner to confirm it is them: once per app session, for everything that uses this
 * check. `reason` is what the phone's question says. Resolves true when they are confirmed (a check
 * that is already running resolves false; follow it with `useOwnerCheck`).
 */
export async function checkOwner(reason = "Open your credentials"): Promise<boolean> {
  const { owner } = useOwner.getState();
  if (owner === "open") return true;
  if (owner === "checking") return false;
  useOwner.setState({ owner: "checking" });
  const confirmed = await verifyOwner(reason);
  useOwner.setState({ owner: confirmed ? "open" : "locked" });
  return confirmed;
}

/** Where the owner check stands, without starting one: "unknown" until something asked. */
export type OwnerCheck = Owner;
export const useOwnerCheck = (): OwnerCheck => useOwner((state) => state.owner);

export type Gate = "loading" | "unsupported" | "checking" | "locked" | "open";

/** Whether the section can be shown: the computer supports it, and the phone's owner is holding it. */
export function useGate(): Gate {
  const meta = usePart("meta");
  const owner = useOwner((state) => state.owner);
  const supported = meta ? (meta.capabilities ?? []).includes(CAPABILITY) : undefined;
  useEffect(() => {
    if (supported && owner === "unknown") void checkOwner();
  }, [supported, owner]);
  if (supported === undefined) return "loading";
  if (!supported) return "unsupported";
  if (owner === "open") return "open";
  if (owner === "locked") return "locked";
  return "checking";
}

/** Whether this computer can hold credentials at all (no owner check: for the picker). */
export function useSupported() {
  return !!usePart("meta")?.capabilities?.includes(CAPABILITY);
}

/** What a screen shows in place of its content until the gate opens. */
export function GateView({ gate }: { gate: Exclude<Gate, "open"> }) {
  if (gate === "unsupported") return <EmptyState icon={KeyRound} title="Update the app on your computer to manage credentials here." />;
  if (gate === "locked") return <EmptyState icon={Lock} title="Locked" action="Unlock" onAction={() => void checkOwner()} />;
  return <Loading />;
}

// Password managers: asked of the computer, kept here so every screen of the section agrees.

type ManagerStore = {
  managers?: PasswordManagerStatus[] | null;
  /** Unlocked from this phone, so it offers to lock again. */
  unlockedHere: PasswordManagerId[];
};
export const useManagers = create<ManagerStore>(() => ({ managers: undefined, unlockedHere: [] }));
// Password managers are the computer's own.
onComputerChange(() => useManagers.setState({ managers: undefined, unlockedHere: [] }));

let loadingManagers: Promise<void> | null = null;
/** Asks the computer for the password managers. `again` makes it look at each one afresh. */
export function loadManagers(again?: boolean) {
  if (loadingManagers && !again) return loadingManagers;
  const work = attempt(again ? api["link.credentials.managers"](true) : api["link.credentials.managers"]()).then((list) => {
    if (list) useManagers.setState({ managers: list });
    else if (useManagers.getState().managers === undefined) useManagers.setState({ managers: null });
  });
  loadingManagers = work.finally(() => {
    loadingManagers = null;
  });
  return loadingManagers;
}
export function putManager(status: PasswordManagerStatus, unlockedHere?: boolean) {
  useManagers.setState((held) => ({
    managers: held.managers ? held.managers.map((manager) => (manager.id === status.id ? status : manager)) : [status],
    unlockedHere: unlockedHere === undefined ? held.unlockedHere : unlockedHere ? [...held.unlockedHere.filter((id) => id !== status.id), status.id] : held.unlockedHere.filter((id) => id !== status.id),
  }));
}

export function managerBadge(status: PasswordManagerStatus | undefined): { label: string; tone: Tone } {
  switch (status?.state) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "locked":
      return { label: "Locked", tone: "warning" };
    case "signed-out":
      return { label: "Sign in on your computer", tone: "accent" };
    case "missing":
      return { label: "Not installed", tone: "neutral" };
    case "error":
      return { label: "Problem", tone: "danger" };
    default:
      return { label: "Checking…", tone: "neutral" };
  }
}

// Marks. Simple glyphs of our own, never the companies' logos.

const MANAGER_MARK: Record<PasswordManagerId, { icon: LucideIcon; color: string }> = {
  onepassword: { icon: Vault, color: brand.tide },
  bitwarden: { icon: ShieldCheck, color: brand.fern },
  protonpass: { icon: LockKeyhole, color: brand.rose },
};
export function ManagerMark({ id, size = 36 }: { id: PasswordManagerId; size?: number }) {
  const mark = MANAGER_MARK[id];
  return <IconTile icon={mark.icon} color={mark.color} size={size} />;
}

const KIND_ICON: Record<CredentialKind, LucideIcon> = { "api-key": KeyRound, login: User, note: StickyNote };
export const KIND_LABEL: Record<CredentialKind, string> = { "api-key": "API key", login: "Login", note: "Note" };
export const SECRET_LABEL: Record<CredentialKind, string> = { "api-key": "Key", login: "Password", note: "Note" };

/** A credential's tile: its password manager's mark, or its kind. */
export function CredentialMark({ credential, size = 36 }: { credential: Credential; size?: number }) {
  const { colors } = useTheme();
  if (credential.source !== "vault") return <ManagerMark id={credential.source} size={size} />;
  const color = credential.kind === "login" ? brand.tide : credential.kind === "note" ? colors.warning : brand.clay;
  return <IconTile icon={KIND_ICON[credential.kind] ?? KeyRound} color={color} size={size} />;
}

/** The muted line under a credential's name. */
export function credentialLine(credential: Credential) {
  if (credential.source !== "vault") return credential.reference;
  return credential.username || hostOf(credential.website) || undefined;
}
const hostOf = (url: string | undefined) => (url ? (/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url) : undefined);

export const byName = (a: Credential, b: Credential) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

// The field a secret is typed into: masked, write-only. The eye only shows what is being typed now.

export type SecretFieldProps = Omit<TextInputProps, "value" | "onChangeText" | "secureTextEntry" | "multiline"> & {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
  /** A tall field when shown (a note). */
  area?: boolean;
};
export function SecretField({ label, value, onChangeText, error, area, placeholder, ...props }: SecretFieldProps) {
  const { colors, dark, type } = useTheme();
  const [shown, setShown] = useState(false);
  const typing = value.length > 0;
  const visible = shown && typing;
  return (
    <View style={{ gap: 6 }}>
      <T variant="label" color="muted" style={{ paddingHorizontal: space.xs }}>
        {label}
      </T>
      <View style={{ flexDirection: "row", alignItems: visible && area ? "flex-start" : "center", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: error ? colors.danger : colors.line, minHeight: visible && area ? 120 : 50 }}>
        <TextInput
          {...props}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          secureTextEntry={!visible}
          multiline={visible && !!area}
          textAlignVertical={visible && area ? "top" : "center"}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          placeholderTextColor={colors.faint}
          keyboardAppearance={dark ? "dark" : "light"}
          selectionColor={colors.accent}
          maxFontSizeMultiplier={1.3}
          accessibilityLabel={label}
          style={[type.callout, { flex: 1, color: colors.ink, paddingLeft: space.lg, paddingRight: typing ? 0 : space.lg, paddingVertical: 13 }]}
        />
        {typing && <IconButton icon={visible ? EyeOff : Eye} label={visible ? "Hide " + label : "Show " + label} size={44} color={colors.muted} onPress={() => setShown(!visible)} style={{ marginRight: 3, marginTop: visible && area ? 3 : 0 }} />}
      </View>
      {!!error && (
        <T variant="footnote" color="danger" style={{ paddingHorizontal: space.xs }}>
          {error}
        </T>
      )}
    </View>
  );
}

/** One muted line under a form: where the secret is kept. */
export function KeptNote({ text }: { text: string }) {
  return (
    <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
      {text}
    </T>
  );
}

// The computer's vault of tool keys (`credentials()`), which isn't in the link's Calls.

/** One key a tool uses, without its secret. */
export type ToolCredential = { id: string; label: string; kind: string; owner: string; createdAt: number; updatedAt: number; serverId?: string; usedBy?: string };
export type ToolCredentials = { protection: "keychain" | "file"; locked?: "installed-app" | "key" | "damaged"; redirectUrl: string; entries: ToolCredential[] };
export const desktopVault = api as unknown as { credentials(): Promise<ToolCredentials>; removeCredential(id: string): Promise<void> };
