// A provider set up with a key ("keyed-providers-v1": OpenRouter, Azure Foundry, an OpenAI
// endpoint), inside its card in Settings › Model providers: the key, then the settings the provider
// takes (an endpoint, a base URL, its API, an API version and a list of models). The same choices
// and words as the phone's page (mobile/src/features/models/ProviderPage.tsx); the plain logic is
// in keyedProviders.ts.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { KeyApi, KeyedProvider, ProviderStatus } from "./types";
import { useAsk } from "./Pages";
import { plainError, reloadProviders } from "./providers";
import {
  API_CHOICES,
  configFromForm,
  formChanged,
  formFromConfig,
  formProblems,
  hasProblems,
  keyedParts,
  keyedWords,
  keyPage,
  newRow,
  type KeyedForm,
  type ModelRow,
} from "./keyedProviders";
import "./routines.css";

const api = window.botkins;
type Ask = ReturnType<typeof useAsk>["ask"];

/** The key and the settings of one keyed provider. `busy` and `setBusy` are the card's, so its other buttons wait. */
export function ProviderKeyed({ provider, keyed, ask, busy, setBusy }: { provider: ProviderStatus; keyed: KeyedProvider; ask: Ask; busy: string; setBusy: (b: string) => void }) {
  const parts = keyedParts(keyed);
  return (
    <>
      <KeyRow provider={provider} keyed={keyed} ask={ask} busy={busy} setBusy={setBusy} />
      {/* A new answer from the computer starts the form again from what it saved. */}
      {parts.any && <KeyedSettings key={JSON.stringify(keyed.config)} provider={provider} keyed={keyed} busy={busy} setBusy={setBusy} />}
    </>
  );
}

function KeyRow({ provider, keyed, ask, busy, setBusy }: { provider: ProviderStatus; keyed: KeyedProvider; ask: Ask; busy: string; setBusy: (b: string) => void }) {
  const words = keyedWords(provider.id, keyed);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const page = keyPage(keyed);
  const id = "keyed-key-" + provider.id;
  const saving = busy === provider.id + ":key";

  async function save(key: string) {
    setBusy(provider.id + ":key");
    setError("");
    setMessage("");
    try {
      await api.providerUseToken(provider.id, key);
      setReplacing(false);
      setMessage("Key saved.");
      await reloadProviders(true);
    } catch (e) {
      setError("The key wasn't saved. " + plainError(e));
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    const ok = await ask({
      title: "Remove the " + words.keyName + " for " + provider.name + "?",
      body: "Bots that use " + provider.name + " models can't reply until you add a key again. Your chats and bots stay here.",
      confirm: "Remove key",
      danger: true,
    });
    if (!ok) return;
    setBusy(provider.id + ":unkey");
    setError("");
    setMessage("");
    try {
      await api.signOut(provider.id);
    } catch (e) {
      setError(plainError(e));
    }
    await reloadProviders(true).catch(() => {});
    setBusy("");
  }

  const getKey = page && (
    <button type="button" className="set-link" onClick={() => void api.openLink(page).catch(() => {})}>
      Get a key
    </button>
  );
  return (
    <div className="set-row stacked keyed-key">
      <div className="set-label">
        <label className="set-name" htmlFor={id}>
          {words.keyLabel}
        </label>
        {keyed.hasKey && !replacing ? (
          <small>Saved on this computer. It isn't shown again.</small>
        ) : (
          <small>
            {words.keyHint ?? "Botkins keeps it on this computer. It isn't shown again."} {getKey}
          </small>
        )}
      </div>
      {keyed.hasKey && !replacing ? (
        <div className="keyed-buttons">
          <button type="button" className="set-button" disabled={!!busy} onClick={() => setReplacing(true)}>
            Replace key
          </button>
          <button type="button" className="set-button danger" disabled={!!busy} aria-label={"Remove the " + words.keyName + " for " + provider.name + "…"} onClick={() => void remove()}>
            {busy === provider.id + ":unkey" ? "Removing…" : "Remove key…"}
          </button>
        </div>
      ) : (
        <form
          className="service-key"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("key") as HTMLInputElement;
            const key = input.value.trim();
            if (!key || busy) return;
            // The key leaves the page as it is sent.
            input.value = "";
            void save(key);
          }}
        >
          <input id={id} name="key" type="password" autoComplete="off" spellCheck={false} autoFocus={replacing} disabled={saving} placeholder="Paste it here" />
          <button className="set-button primary" disabled={!!busy}>
            {saving ? "Saving…" : "Save key"}
          </button>
          {replacing && (
            <button type="button" className="set-button" disabled={saving} onClick={() => setReplacing(false)}>
              Cancel
            </button>
          )}
        </form>
      )}
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
      {message && (
        <small className="provider-quiet" role="status">
          {message}
        </small>
      )}
    </div>
  );
}

function KeyedSettings({ provider, keyed, busy, setBusy }: { provider: ProviderStatus; keyed: KeyedProvider; busy: string; setBusy: (b: string) => void }) {
  const parts = keyedParts(keyed);
  const words = keyedWords(provider.id, keyed);
  const [form, setForm] = useState<KeyedForm>(() => formFromConfig(keyed.config));
  // Problems show once the person tries to save, then follow each change.
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const problems = formProblems(provider.id, keyed, form);
  const shown = tried ? problems : {};
  const changed = formChanged(keyed, form);
  const saving = busy === provider.id + ":configure";
  const set = (next: Partial<KeyedForm>) => {
    setForm((f) => ({ ...f, ...next }));
    setSaved(false);
  };
  const setRow = (row: string, next: Partial<ModelRow>) => set({ models: form.models.map((r) => (r.row === row ? { ...r, ...next } : r)) });
  const fid = (name: string) => "keyed-" + provider.id + "-" + name;

  async function save() {
    setTried(true);
    if (hasProblems(problems)) return;
    setBusy(provider.id + ":configure");
    setError("");
    try {
      await api.providerConfigure(provider.id, configFromForm(keyed, form));
      setSaved(true);
      await reloadProviders(true);
    } catch (e) {
      setError("The settings weren't saved. " + plainError(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <form
      className="set-row stacked keyed-settings"
      noValidate
      aria-label={provider.name + " settings"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {parts.endpoint && (
        <Text id={fid("endpoint")} label={words.endpoint.label} placeholder={words.endpoint.placeholder} value={form.endpoint} problem={shown.endpoint} onChange={(endpoint) => set({ endpoint })} url />
      )}
      {parts.baseUrl && (
        <Text id={fid("base")} label={words.baseUrl.label} placeholder={words.baseUrl.placeholder} value={form.baseUrl} problem={shown.baseUrl} onChange={(baseUrl) => set({ baseUrl })} url />
      )}
      {parts.api && (
        <div className="keyed-field">
          <span className="set-name" id={fid("api")}>
            {words.api.label}
          </span>
          <ApiChoice labelledBy={fid("api")} value={form.api} onChange={(value) => set({ api: value })} />
        </div>
      )}
      {parts.apiVersion && (
        <Text id={fid("version")} label={words.apiVersion.label} placeholder={words.apiVersion.placeholder} value={form.apiVersion} problem={shown.apiVersion} onChange={(apiVersion) => set({ apiVersion })} />
      )}
      {parts.models && (
        <fieldset className="keyed-models">
          <legend className="set-name">{words.models.label}</legend>
          <small>{words.models.hint}</small>
          {form.models.length > 0 && (
            <div className={"keyed-model-head" + (parts.modelApi ? " with-api" : "")} aria-hidden="true">
              <small>{words.models.id}</small>
              <small>{words.models.name}</small>
              {parts.modelApi && <small>API</small>}
            </div>
          )}
          {form.models.map((r, i) => (
            <div key={r.row} className={"keyed-model" + (parts.modelApi ? " with-api" : "")}>
              <input
                aria-label={words.models.id + ", model " + (i + 1)}
                aria-invalid={!!shown.models?.[r.row] || undefined}
                placeholder={words.models.idPlaceholder}
                value={r.id}
                autoComplete="off"
                spellCheck={false}
                autoFocus={!r.id && !r.name && i === form.models.length - 1 && i > 0}
                onChange={(e) => setRow(r.row, { id: e.target.value })}
              />
              <input aria-label={words.models.name + ", model " + (i + 1)} placeholder={words.models.namePlaceholder} value={r.name} autoComplete="off" onChange={(e) => setRow(r.row, { name: e.target.value })} />
              {parts.modelApi && (
                <select aria-label={"API, model " + (i + 1)} value={r.api} onChange={(e) => setRow(r.row, { api: e.target.value as KeyApi })}>
                  {API_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="set-close"
                aria-label={"Remove " + (r.id.trim() || "model " + (i + 1))}
                onClick={() => set({ models: form.models.filter((x) => x.row !== r.row) })}
              >
                <X size={14} />
              </button>
              {shown.models?.[r.row] && (
                <small className="error-text keyed-model-problem" role="alert">
                  {shown.models[r.row]}
                </small>
              )}
            </div>
          ))}
          <div>
            <button type="button" className="set-button" onClick={() => set({ models: [...form.models, newRow()] })}>
              <Plus size={13} aria-hidden="true" /> {words.models.add}
            </button>
          </div>
        </fieldset>
      )}
      <div className="service-buttons">
        {saved && !changed && (
          <small className="provider-quiet" role="status">
            Saved.
          </small>
        )}
        <button className="set-button primary" disabled={!changed || !!busy}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
    </form>
  );
}

function Text({ id, label, placeholder, value, problem, onChange, url }: { id: string; label: string; placeholder: string; value: string; problem?: string; onChange: (v: string) => void; url?: boolean }) {
  return (
    <div className="keyed-field">
      <label className="set-name" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={url ? "url" : "text"}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!problem || undefined}
        aria-describedby={problem ? id + "-problem" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {problem && (
        <small id={id + "-problem"} className="error-text" role="alert">
          {problem}
        </small>
      )}
    </div>
  );
}

function ApiChoice({ labelledBy, value, onChange }: { labelledBy: string; value: KeyApi; onChange: (v: KeyApi) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={labelledBy}>
      {API_CHOICES.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={value === c.value} onClick={() => onChange(c.value)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
