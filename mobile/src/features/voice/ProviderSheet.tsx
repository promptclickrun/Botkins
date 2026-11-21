// One provider's key and connection details. A key typed here lives only in its field and is
// cleared the moment it is sent; the computer keeps it, and the phone never gets it back.
import { useEffect, useState } from "react";
import { Modal, View } from "react-native";
import { CredentialPicker } from "@/features/credentials/CredentialPicker";
import { SecretField } from "@/features/credentials/shared";
import type { VoiceKeyProvider, VoicePatch, VoiceSettings } from "@/link/types";
import { api, attempt } from "@/state/link";
import { Button, Field, Group, Label, Row, Segmented, Sheet, space, T } from "@/ui";
import { providerName, providerState, sizeLabel } from "./choices";
import type { SheetProvider } from "./settings/summary";

export type { SheetProvider };

const save = (patch: VoicePatch) => void attempt(api["link.voice.set"](patch));

/** A field that saves when the person is done with it. */
function Detail({ label, value, placeholder, onSave, url }: { label: string; value?: string; placeholder?: string; onSave: (value: string) => void; url?: boolean }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== (value ?? "")) onSave(next);
  };
  return (
    <Field
      label={label}
      value={draft}
      onChangeText={setDraft}
      onEndEditing={commit}
      onSubmitEditing={commit}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={url ? "url" : "default"}
      returnKeyType="done"
    />
  );
}

function Connection({ provider, voice }: { provider: VoiceKeyProvider; voice: VoiceSettings }) {
  const p = voice.providers;
  if (provider === "openai")
    return <Detail label="Address" value={p.openai.baseUrl} placeholder="https://api.openai.com/v1" url onSave={(baseUrl) => save({ providers: { openai: { baseUrl } } })} />;
  if (provider === "custom")
    return <Detail label="Address" value={p.custom.baseUrl} placeholder="http://192.168.1.20:8000/v1" url onSave={(baseUrl) => save({ providers: { custom: { baseUrl } } })} />;
  if (provider === "elevenlabs") return <Detail label="Agent id, for live voice" value={p.elevenlabs.agentId} placeholder="Made for you when empty" onSave={(agentId) => save({ providers: { elevenlabs: { agentId: agentId || undefined } } })} />;
  if (provider === "azure") {
    const azure = p.azure;
    const set = (patch: NonNullable<NonNullable<VoicePatch["providers"]>["azure"]>) => save({ providers: { azure: patch } });
    return (
      <View style={{ gap: space.lg }}>
        <Segmented
          options={[
            { value: "openai", label: "Azure OpenAI" },
            { value: "speech", label: "Speech" },
          ]}
          value={azure.kind}
          onChange={(kind) => set({ kind })}
        />
        <Detail label="Endpoint" value={azure.endpoint} placeholder={azure.kind === "speech" ? "Or leave empty and set a region" : "https://name.openai.azure.com"} url onSave={(endpoint) => set({ endpoint })} />
        {azure.kind === "speech" ? (
          <Detail label="Region" value={azure.region} placeholder="eastus" onSave={(region) => set({ region })} />
        ) : (
          <>
            <Detail label="Transcription deployment" value={azure.sttDeployment} onSave={(sttDeployment) => set({ sttDeployment: sttDeployment || undefined })} />
            <Detail label="Speech deployment" value={azure.ttsDeployment} onSave={(ttsDeployment) => set({ ttsDeployment: ttsDeployment || undefined })} />
            <Detail label="API version" value={azure.apiVersion} placeholder="2025-04-01-preview" onSave={(apiVersion) => set({ apiVersion: apiVersion || undefined })} />
          </>
        )}
      </View>
    );
  }
  return null;
}

/** The providers whose key goes to an address a person can set. */
const ADDRESSED: VoiceKeyProvider[] = ["openai", "azure", "custom"];

function KeySheet({ provider, voice, onClose }: { provider: VoiceKeyProvider; voice: VoiceSettings; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const hasKey = voice.providers[provider].hasKey;
  const send = async (value: string | { $credential: string } | null, done: string) => {
    setSaving(true);
    // The typed key leaves the field as it is sent.
    setKey("");
    await attempt(api["link.voice.key"](provider, value), done);
    setSaving(false);
  };
  return (
    <Sheet title={providerName(provider)} onClose={onClose} action="Save" onAction={() => void send(key.trim(), "Key saved")} actionDisabled={!key.trim()} actionLoading={saving}>
      {/* The address comes first: a key is saved for the address that is set, and a new address removes it (link-host/voice.mjs). */}
      <Connection provider={provider} voice={voice} />
      {ADDRESSED.includes(provider) && (
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs, marginTop: -space.md }}>
          A new address removes the saved key, so the key never goes somewhere you didn't give it for.
        </T>
      )}
      <View style={{ gap: space.sm }}>
        <SecretField label={hasKey ? "Replace the key" : provider === "custom" ? "Key, if your server needs one" : "API key"} value={key} onChangeText={setKey} placeholder={hasKey ? "Key saved" : "Paste the key"} />
        <CredentialPicker onPick={(ref, name) => void send(ref, "Using " + name)} disabled={saving} />
        <T variant="footnote" color="muted" style={{ paddingHorizontal: space.xs }}>
          Kept on your computer, never on this phone.
        </T>
      </View>
      {hasKey && (
        <View style={{ alignItems: "flex-start" }}>
          <Button title="Remove key" variant="danger" size="sm" onPress={() => void send(null, "Key removed")} disabled={saving} />
        </View>
      )}
    </Sheet>
  );
}

function LocalSheet({ voice, onClose }: { voice: VoiceSettings; onClose: () => void }) {
  const local = voice.providers.local;
  const groups = [
    { kind: "stt" as const, title: "Dictation" },
    { kind: "tts" as const, title: "Reading aloud" },
  ];
  return (
    <Sheet title={providerName("local")} onClose={onClose}>
      {!local.available ? (
        <T variant="body" color="muted">
          {providerState("local", voice)}
        </T>
      ) : (
        groups.map(({ kind, title }) => {
          const models = local.models.filter((model) => model.kind === kind);
          return (
            <View key={kind}>
              <Label>{title}</Label>
              <Group>
                {models.length ? (
                  models.map((model) => <Row key={model.id} title={model.name} subtitle={[sizeLabel(model.sizeMB), model.installed ? "Installed" : "Not installed"].filter(Boolean).join(" · ")} />)
                ) : (
                  <Row title="No models" subtitle="Add one in Botkins on your computer" disabled />
                )}
              </Group>
            </View>
          );
        })
      )}
    </Sheet>
  );
}

export function ProviderSheet({ provider, voice, onClose }: { provider: SheetProvider; voice: VoiceSettings; onClose: () => void }) {
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {provider === "local" ? <LocalSheet voice={voice} onClose={onClose} /> : <KeySheet provider={provider} voice={voice} onClose={onClose} />}
    </Modal>
  );
}
