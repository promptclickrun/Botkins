// One credential: a new one for the computer's vault, a saved one, or one linked to a password
// manager. A saved value never comes back: its field starts empty, and empty keeps it.
import { router, useLocalSearchParams } from "expo-router";
import { ShieldCheck, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Alert } from "react-native";
import { isUnsharedProtonVault } from "@/link/proton-pass";
import type { Credential, CredentialInput, CredentialKind } from "@/link/types";
import { usePart } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { useApp } from "@/state/store";
import { Badge, EmptyState, Field, Group, IconTile, Loading, Row, Segmented, Sheet, useTheme } from "@/ui";
import { CredentialMark, GateView, KIND_LABEL, KeptNote, managerName, SECRET_LABEL, SecretField, useComputerName, useGate, useProtonSupport } from "./shared";

export default function CredentialEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const gate = useGate();
  const credential = usePart("credentials")?.find((item) => item.id === id);
  const synced = useApp((state) => state.synced);
  if (gate !== "open")
    return (
      <Sheet title="Credential">
        <GateView gate={gate} />
      </Sheet>
    );
  if (id !== "new" && !credential)
    return <Sheet title="Credential">{synced ? <EmptyState title="This credential is gone" action="Go back" onAction={() => router.back()} /> : <Loading />}</Sheet>;
  return <Editor key={id} credential={credential} />;
}

type Draft = { kind: CredentialKind; name: string; username: string; website: string; notes: string };
const draftOf = (credential: Credential | undefined): Draft => ({
  kind: credential?.kind ?? "api-key",
  name: credential?.name ?? "",
  username: credential?.username ?? "",
  website: credential?.website ?? "",
  notes: credential?.notes ?? "",
});

const KINDS: { value: CredentialKind; label: string }[] = (["api-key", "login", "note"] as const).map((value) => ({ value, label: KIND_LABEL[value] }));

function Editor({ credential }: { credential: Credential | undefined }) {
  const proton = useProtonSupport();
  const { colors } = useTheme();
  const computer = useComputerName();
  const [start] = useState(() => draftOf(credential));
  const [draft, setDraft] = useState(start);
  // The secret being typed. It is sent once and cleared straight after.
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<{ running: boolean; ok?: boolean; message?: string }>({ running: false });

  const isNew = !credential;
  const linked = !!credential && credential.source !== "vault";
  const set = (patch: Partial<Draft>) => setDraft((held) => ({ ...held, ...patch }));
  const problems = {
    name: draft.name.trim() ? undefined : "Give it a name.",
    value: isNew && !value ? "Enter the " + SECRET_LABEL[draft.kind].toLowerCase() + "." : undefined,
  };
  const shown: Partial<typeof problems> = checked ? problems : {};
  const changed = !!value || JSON.stringify(draft) !== JSON.stringify(start);

  const save = async () => {
    setChecked(true);
    if (problems.name || problems.value) return;
    const login = draft.kind === "login";
    const input: CredentialInput = linked
      ? { id: credential.id, name: draft.name.trim(), kind: credential.kind, value: null }
      : {
          ...(credential && { id: credential.id }),
          name: draft.name.trim(),
          kind: draft.kind,
          username: login ? draft.username.trim() : undefined,
          website: login ? draft.website.trim() : undefined,
          notes: draft.notes.trim(),
          value: value ? value : null,
        };
    setSaving(true);
    const id = await attempt(api["link.credentials.save"](input), isNew ? "Credential saved" : "Saved");
    // The typed value leaves the phone's memory whether or not the call worked.
    input.value = null;
    setValue("");
    setSaving(false);
    if (id) router.back();
  };

  const runCheck = async () => {
    if (!credential) return;
    setCheck({ running: true });
    const result = await attempt(api["link.credentials.check"](credential.id));
    setCheck({ running: false, ok: result?.ok, message: result?.message });
  };

  const remove = () => {
    if (!credential) return;
    Alert.alert("Remove " + credential.name + "?", linked ? "It stays in " + managerName(credential.source) + "." : "Tools and bots that use it stop working.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          router.back();
          void attempt(api["link.credentials.remove"](credential.id), "Credential removed");
        },
      },
    ]);
  };

  const secretLabel = SECRET_LABEL[draft.kind];
  const checkResult = check.ok === undefined ? undefined : check.ok ? { label: "Works", tone: "success" as const } : { label: "Can't read", tone: "warning" as const };

  return (
    <Sheet title={isNew ? "New credential" : credential.name} action="Save" onAction={() => void save()} actionDisabled={!isNew && !changed} actionLoading={saving}>
      {isNew && <Segmented options={KINDS} value={draft.kind} onChange={(kind) => set({ kind })} />}

      <Field label="Name" placeholder={draft.kind === "login" ? "GitHub" : draft.kind === "note" ? "Recovery codes" : "OpenAI key"} value={draft.name} onChangeText={(name) => set({ name })} error={shown.name} autoFocus={isNew} returnKeyType="next" />

      {linked ? (
        <Group>
          <Row leading={<CredentialMark credential={credential} />} title={managerName(credential.source)} subtitle={credential.reference} subtitleLines={2} />
        </Group>
      ) : (
        <>
          {draft.kind === "login" && (
            <>
              <Field label="Username" placeholder="name@example.com" value={draft.username} onChangeText={(username) => set({ username })} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" />
              <Field label="Website" placeholder="https://…" value={draft.website} onChangeText={(website) => set({ website })} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" />
            </>
          )}
          <SecretField key={draft.kind} label={secretLabel} value={value} onChangeText={setValue} placeholder={isNew ? (draft.kind === "api-key" ? "Paste key" : undefined) : "Saved"} error={shown.value} area={draft.kind === "note"} />
          {draft.kind !== "note" && <Field label="Notes" placeholder="Optional" value={draft.notes} onChangeText={(notes) => set({ notes })} area style={{ minHeight: 88 }} />}
        </>
      )}

      <KeptNote text={linked ? "Read from " + managerName(credential.source) + " when it's used. This phone can't show it." : "Kept encrypted on " + computer + ". This phone can't show it."} />

      {credential && (
        <Group>
          <Row
            leading={<IconTile icon={ShieldCheck} color={colors.info} />}
            title="Check"
            subtitle={check.running ? "Checking…" : check.ok === false ? (check.message ?? "It can't be read right now") : check.ok ? check.message : undefined}
            subtitleLines={3}
            trailing={check.running ? <ActivityIndicator color={colors.muted} /> : checkResult ? <Badge label={checkResult.label} tone={checkResult.tone} /> : undefined}
            onPress={check.running ? undefined : () => void runCheck()}
          />
          {proton && credential.source === "protonpass" && isUnsharedProtonVault(check.message) && (
            <Row title="Share more vaults" onPress={() => router.push({ pathname: "/credentials/manager/[id]", params: { id: "protonpass", share: "1" } })} />
          )}
          <Row leading={<IconTile icon={Trash2} color={colors.danger} />} title="Remove credential" tone="danger" onPress={remove} />
        </Group>
      )}
    </Sheet>
  );
}
