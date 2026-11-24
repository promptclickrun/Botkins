import { useId, useState } from "react";
import { MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { decisionText } from "./pluginStarts";
import { DETACHED_LINE } from "./keep";
import type { AgentRequest, FormField } from "./types";
import { CredentialChoice, isSecretField, looksSecret, useSavedCredentials, type Picked } from "./CredentialPicker";

function SchemaInput({
  name,
  field,
  required,
}: {
  name: string;
  field: FormField;
  required: boolean;
}) {
  const choices =
    field.enum?.map((v, i) => ({
      value: v,
      label: field.enumNames?.[i] || v,
    })) ??
    field.oneOf?.map((x) => ({ value: x.const, label: x.title || x.const }));
  if (field.type === "boolean")
    return (
      <input
        type="checkbox"
        name={name}
        defaultChecked={field.default === true}
      />
    );
  if (field.type === "array") {
    const items = field.items?.enum ?? field.items?.anyOf?.map((x) => x.const);
    return items ? (
      <select
        multiple
        name={name}
        required={required}
        defaultValue={Array.isArray(field.default) ? field.default : []}
      >
        {items.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    ) : (
      <textarea
        name={name}
        required={required}
        placeholder="One item per line"
        defaultValue={
          Array.isArray(field.default) ? field.default.join("\n") : ""
        }
      />
    );
  }
  if (choices)
    return (
      <select
        name={name}
        required={required}
        defaultValue={String(field.default ?? "")}
      >
        <option value="">Choose…</option>
        {choices.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  if (["number", "integer"].includes(field.type))
    return (
      <input
        type="number"
        step={field.type === "integer" ? "1" : "any"}
        min={field.minimum}
        max={field.maximum}
        name={name}
        required={required}
        defaultValue={String(field.default ?? "")}
      />
    );
  return (
    <input
      type={
        field.format === "email"
          ? "email"
          : field.format === "uri"
            ? "url"
            : field.format === "date"
              ? "date"
              : "text"
      }
      name={name}
      required={required}
      minLength={field.minLength}
      maxLength={field.maxLength ?? 32000}
      defaultValue={String(field.default ?? "")}
    />
  );
}
export default function RequestPanel({
  req,
  count,
  bot,
}: {
  req: AgentRequest;
  count: number;
  bot: string;
}) {
  const [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const id = useId();
  const fields = Object.entries(req.schema?.properties ?? {});
  // A secret can be typed (masked) or answered with a saved credential, by its reference: the
  // computer puts the value in (desktop/savedcredentials.mjs). "" is the question's own answer.
  const secretQuestion = req.kind === "question" && looksSecret(req.title, req.label);
  const secretFields = req.kind === "form" ? fields.filter(([name, field]) => isSecretField(name, field)).map(([name]) => name) : [];
  const secure = req.kind === "secure";
  const shown = (text: string) => (req.kind === "permission" ? decisionText(text) : text);
  const saved = useSavedCredentials(secure || secretQuestion || secretFields.length > 0);
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const pick = (key: string, next: Picked | undefined) =>
    setPicked((now) => {
      const { [key]: _, ...rest } = now;
      return next ? { ...rest, [key]: next } : rest;
    });
  async function reply(
    payload: Parameters<typeof window.botkins.respond>[1],
  ) {
    if (busy) return;
    setBusy(true);
    try {
      await window.botkins.respond(req.id, payload);
    } catch (e) {
      setError(secure ? "The secure answer could not be sent. Check the fields and try again." : String(e));
      setBusy(false);
    }
  }
  return (
    <section
      className="request-panel"
      role="region"
      aria-label={
        secure ? "Secure input request" : req.kind === "permission" ? "Approval request" : "Clarifying question"
      }
    >
      <div className="request-heading">
        {secure || req.kind === "permission" ? (
          <ShieldCheck size={17} />
        ) : (
          <MessageCircleQuestion size={17} />
        )}
        <strong>
          {bot}{" "}
          {secure ? "requests secure input" : req.kind === "permission" ? "needs approval" : "has a question"}
        </strong>
        {count > 1 && <small>1 of {count}</small>}
      </div>
      {req.askedBy && <small className="request-member">Asked by {req.askedBy.name}'s turn</small>}
      {req.detached && <small className="request-member">{DETACHED_LINE}</small>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (req.kind === "question") {
            const answer = picked[""] ? picked[""].ref : value.trim();
            // Nothing secret stays on screen once it is on its way.
            if (secretQuestion) setValue("");
            void reply({ action: "answer", value: answer });
          } else if (secure) {
            const data = new FormData(e.currentTarget);
            const content: Record<string, unknown> = {};
            for (const { key } of req.fields ?? []) {
              const entry = picked[key]?.ref ?? data.get(key);
              if (entry) content[key] = entry;
            }
            HTMLFormElement.prototype.reset.call(e.currentTarget);
            setPicked({});
            void reply({ action: "accept", content });
          } else if (req.kind === "form") {
            const data = new FormData(e.currentTarget);
            const content = Object.fromEntries(
              fields.flatMap<[string, unknown]>(([name, field]) => {
                if (field.type === "boolean") return [[name, data.has(name)]];
                if (field.type === "array")
                  return [
                    [
                      name,
                      data
                        .getAll(name)
                        .flatMap((x) => String(x).split("\n"))
                        .filter(Boolean),
                    ],
                  ];
                const v = data.get(name);
                return v == null || v === ""
                  ? []
                  : [
                      [
                        name,
                        ["number", "integer"].includes(field.type)
                          ? Number(v)
                          : String(v),
                      ],
                    ];
              }),
            );
            for (const name of secretFields) {
              if (picked[name]) content[name] = picked[name].ref;
              // A typed secret leaves the field as soon as it is on its way.
              const input = e.currentTarget.elements.namedItem(name);
              if (input instanceof HTMLInputElement) input.value = "";
            }
            void reply({ action: "accept", content });
          }
        }}
      >
        <div
          className="request-scroll"
          tabIndex={0}
          aria-label="Request details"
        >
          {/* An approval is a decision: what it shows goes through the rule for such text, so a
              command or a plugin's own message cannot look like another one (src/pluginStarts.ts). */}
          <p className="request-title">{shown(req.title)}</p>
          {req.label && <small className="request-label">{shown(req.label)}</small>}
          {req.preview && <pre>{shown(req.preview)}</pre>}
          {secure && <p className="secure-destination">{req.detail}</p>}
          {req.detail && !secure && (
            <details
              className="request-raw"
              open={req.preview ? undefined : true}
            >
              <summary>Full request</summary>
              <pre>{shown(req.detail)}</pre>
            </details>
          )}
          {req.remember && (
            <small>
              Remembering this approval allows {req.remember} for this
              conversation.
            </small>
          )}
          {req.kind === "question" && (
            <>
              {!!req.choices?.length && (
                <div className="answer-options">
                  {req.choices.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-pressed={value === c}
                      onClick={() => setValue(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
              {req.freeform && !secretQuestion && (
                <label htmlFor={id}>
                  Your answer
                  <textarea
                    id={id}
                    value={value}
                    maxLength={32000}
                    rows={2}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </label>
              )}
              {req.freeform && secretQuestion && (
                <>
                  <label htmlFor={id}>
                    Your answer
                    <input
                      id={id}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={picked[""] ? "" : value}
                      placeholder={picked[""] ? "Using " + picked[""].name : undefined}
                      disabled={!!picked[""]}
                      maxLength={32000}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </label>
                  <CredentialChoice label="Your answer" saved={saved} picked={picked[""]} pick={(next) => pick("", next)} disabled={busy} />
                </>
              )}
            </>
          )}
          {secure && req.fields?.map(field => (
            <div className="scred-field" key={field.key}>
              <label>
                {field.label}{field.optional && " (optional)"}
                {field.hint && <small>{field.hint}</small>}
                <input name={field.key} type={field.kind === "text" ? "text" : "password"}
                  autoComplete={field.kind === "code" ? "one-time-code" : "off"}
                  autoCapitalize="none" spellCheck={false} maxLength={32000}
                  required={!field.optional && !picked[field.key]} disabled={busy || !!picked[field.key]} />
              </label>
              <CredentialChoice label={field.label} saved={saved} picked={picked[field.key]}
                pick={next => pick(field.key, next)} disabled={busy} />
            </div>
          ))}
          {req.kind === "form" && (
            <>
              {req.url && (
                <button
                  type="button"
                  onClick={() =>
                    window.botkins
                      .openLink(req.url!)
                      .catch((e) => setError(String(e)))
                  }
                >
                  Open requested link
                </button>
              )}
              {fields.map(([name, field]) =>
                secretFields.includes(name) ? (
                  <div className="scred-field" key={name}>
                    <label>
                      {field.title || name}
                      {field.description && <small>{field.description}</small>}
                      <input
                        type="password"
                        name={name}
                        autoComplete="off"
                        spellCheck={false}
                        required={!picked[name] && !!req.schema?.required?.includes(name)}
                        disabled={!!picked[name]}
                        placeholder={picked[name] ? "Using " + picked[name].name : undefined}
                        minLength={field.minLength}
                        maxLength={field.maxLength ?? 32000}
                      />
                    </label>
                    <CredentialChoice label={field.title || name} saved={saved} picked={picked[name]} pick={(next) => pick(name, next)} disabled={busy} />
                  </div>
                ) : (
                  <label key={name}>
                    {field.title || name}
                    {field.description && <small>{field.description}</small>}
                    <SchemaInput
                      name={name}
                      field={field}
                      required={!!req.schema?.required?.includes(name)}
                    />
                  </label>
                ),
              )}
            </>
          )}
        </div>
        <div className="request-controls">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              reply({ action: req.kind === "permission" ? "deny" : "cancel" })
            }
          >
            {req.kind === "permission" ? "Deny" : "Dismiss"}
          </button>
          {req.kind === "permission" ? (
            <>
              {req.remember && (
                <button
                  type="button"
                  disabled={busy}
                  title={"Remember for " + req.remember}
                  onClick={() => reply({ action: "remember" })}
                >
                  Allow for this chat
                </button>
              )}
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => reply({ action: "approve" })}
              >
                Allow once
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={busy || (req.kind === "question" && !value.trim() && !picked[""])}
            >
              {secure ? "Allow this use" : "Send answer"}
            </button>
          )}
        </div>
        {error && <small role="alert">{error}</small>}
      </form>
    </section>
  );
}
