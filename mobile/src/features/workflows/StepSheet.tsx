// Edits one trigger or step of a workflow draft. Changes stay in the draft until the designer saves it.
import * as Clipboard from "expo-clipboard";
import { CheckCircle2, Copy, ExternalLink, KeyRound, Plus, RefreshCw, Trash2, X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Linking, Modal, View } from "react-native";
import type { WorkflowGithubStatus, WorkflowNode, WorkflowTriggerKind } from "@/link/types";
import { useBots, useChats, useModels, useRoutines } from "@/state/hooks";
import { api } from "@/state/link";
import { showToast } from "@/state/store";
import { Button, Field, Group, IconButton, Label, radius, Row, Segmented, Sheet, space, T, useTheme } from "@/ui";
import type { NodeFieldAnalysis } from "./fields";
import { CONDITION_OPS, DAYS, DESTINATIONS, GITHUB_EVENT_LABEL, GITHUB_EVENTS, GOAL_CATEGORIES, KIND_LABEL, newTrigger, OP_LABEL, OPS_WITHOUT_VALUE, TASK_STATUSES, TRIGGER_KINDS, TRIGGER_LABEL } from "./graph";
import { Choice, TemplateField } from "./parts";

type Props = {
  node: WorkflowNode | null;
  analysis?: NodeFieldAnalysis;
  canRemove: boolean;
  onChange: (node: WorkflowNode) => void;
  onRemove: () => void;
  onClose: () => void;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const problemsFor = (analysis: NodeFieldAnalysis | undefined, prop: string) => analysis?.problems.filter((p) => p.prop === prop && p.kind === "missing").map((p) => p.field);

export function StepSheet({ node, analysis, canRemove, onChange, onRemove, onClose }: Props) {
  return (
    <Modal visible={!!node} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
      {node && <StepBody node={node} analysis={analysis} canRemove={canRemove} onChange={onChange} onRemove={onRemove} onClose={onClose} />}
    </Modal>
  );
}

function StepBody({ node: given, analysis, canRemove, onChange, onRemove, onClose }: Props & { node: WorkflowNode }) {
  const [node, setNode] = useState(given);
  useEffect(() => setNode(given), [given.id]);
  const set = (patch: Partial<WorkflowNode>) => setNode((n) => ({ ...n, ...patch }));
  const cfg = node.config ?? {};
  const setConfig = (patch: Record<string, unknown>) => setNode((n) => ({ ...n, config: { ...n.config, ...patch } }));
  const fields = analysis?.available ?? [];
  const done = () => {
    onChange({ ...node, label: node.label.trim() || (node.kind === "trigger" ? TRIGGER_LABEL[node.triggerKind ?? "manual"] : KIND_LABEL[node.kind]) });
    onClose();
  };
  const title = node.kind === "trigger" ? "Trigger" : KIND_LABEL[node.kind];
  return (
    <Sheet title={title} action="Done" onAction={done} onClose={onClose}>
      <View style={{ gap: space.xl }}>
        <Field label="Name" value={node.label} onChangeText={(label) => set({ label })} maxLength={80} />
        {node.kind === "trigger" && <TriggerEditor node={node} setConfig={setConfig} setKind={(triggerKind) => set({ triggerKind, label: node.label === TRIGGER_LABEL[node.triggerKind ?? "manual"] ? TRIGGER_LABEL[triggerKind] : node.label, config: newTrigger(triggerKind, node.id).config })} />}
        {(node.kind === "agent" || node.kind === "model") && <AskEditor node={node} setConfig={setConfig} fields={fields} analysis={analysis} />}
        {node.kind === "condition" && <ConditionEditor cfg={cfg} setConfig={setConfig} fields={fields.map((f) => f.name)} />}
        {node.kind === "approval" && (
          <>
            <TemplateField label="What to ask" value={cfg.message ?? ""} onChange={(message) => setConfig({ message })} fields={fields} problems={problemsFor(analysis, "message")} placeholder="Okay to post this?" />
            <Field label="Save the reviewer's note as" hint="Later steps can use it as a field." value={cfg.noteField ?? ""} onChangeText={(noteField) => setConfig({ noteField: noteField.replace(/[^a-zA-Z0-9_.-]/g, "") || undefined })} autoCapitalize="none" autoCorrect={false} mono />
            <T variant="footnote" color="muted">
              The run waits on the Approved or Rejected lane. A rejection with nothing on its lane ends the run.
            </T>
          </>
        )}
        {node.kind === "output" && <OutputEditor cfg={cfg} setConfig={setConfig} fields={fields} analysis={analysis} />}
        {canRemove && <Button title={node.kind === "trigger" ? "Remove trigger" : "Remove step"} variant="danger" icon={Trash2} onPress={() => { onRemove(); onClose(); }} />}
      </View>
    </Sheet>
  );
}

function TriggerEditor({ node, setConfig, setKind }: { node: WorkflowNode; setConfig: (patch: Record<string, unknown>) => void; setKind: (kind: WorkflowTriggerKind) => void }) {
  const cfg = node.config ?? {};
  const bots = useBots();
  const routines = useRoutines();
  const kind = node.triggerKind ?? "manual";
  const botOptions = [{ value: "", label: "Any bot" }, ...bots.map((b) => ({ value: b.id, label: b.name }))];
  return (
    <View style={{ gap: space.lg }}>
      <Choice label="Starts when" options={TRIGGER_KINDS.map((k) => ({ value: k, label: TRIGGER_LABEL[k] }))} value={kind} onChange={setKind} />
      {kind === "manual" && <T variant="footnote" color="muted">Runs when someone taps Run now, here or on the computer. Manual runs work while the workflow is paused.</T>}
      {kind === "schedule" && (
        <>
          <Choice label="How often" options={(["daily", "weekdays", "weekly", "custom"] as const).map((v) => ({ value: v, label: cap(v) }))} value={cfg.cadence ?? "daily"} onChange={(cadence: string) => setConfig({ cadence })} />
          {cfg.cadence === "custom" ? (
            <Field label="Cron" hint="Five fields, e.g. 0 9 * * 1-5" value={cfg.cron ?? ""} onChangeText={(cron) => setConfig({ cron })} autoCapitalize="none" autoCorrect={false} mono />
          ) : (
            <Field label="Time" hint="24-hour, e.g. 09:00" value={cfg.time ?? "09:00"} onChangeText={(time) => setConfig({ time })} keyboardType="numbers-and-punctuation" maxLength={5} />
          )}
          {cfg.cadence === "weekly" && <Choice label="Days" multi options={DAYS.map((d) => ({ value: d, label: cap(d) }))} value={cfg.days ?? []} onChange={(days: string[]) => setConfig({ days })} />}
          <Field label="Time zone" hint="Leave empty for the computer's." value={cfg.timezone ?? ""} onChangeText={(timezone) => setConfig({ timezone: timezone || undefined })} autoCapitalize="none" autoCorrect={false} placeholder="America/Chicago" />
        </>
      )}
      {kind === "task" && (
        <>
          <Segmented options={[{ value: "status_changed", label: "Moves" }, { value: "created", label: "Is created" }]} value={cfg.event === "created" ? "created" : "status_changed"} onChange={(event) => setConfig({ event })} />
          {cfg.event !== "created" && <Choice label="Moves to" options={[{ value: "", label: "Any status" }, ...TASK_STATUSES.map((s) => ({ value: s, label: cap(s) }))]} value={cfg.toStatus ?? ""} onChange={(toStatus: string) => setConfig({ toStatus: toStatus || undefined })} />}
          <Choice label="Bot" options={botOptions} value={cfg.botId ?? ""} onChange={(botId: string) => setConfig({ botId: botId || undefined, botName: undefined })} />
          <Field label="Title contains" value={cfg.titleContains ?? ""} onChangeText={(titleContains) => setConfig({ titleContains: titleContains || undefined })} />
        </>
      )}
      {kind === "chat" && (
        <>
          <Choice label="Bot" options={botOptions} value={cfg.botId ?? ""} onChange={(botId: string) => setConfig({ botId: botId || undefined })} />
          <Field label="Message contains" value={cfg.textContains ?? ""} onChangeText={(textContains) => setConfig({ textContains: textContains || undefined })} />
          <Group>
            <Row title="Only when a bot is mentioned" toggled={!!cfg.mentionOnly} onToggle={(mentionOnly) => setConfig({ mentionOnly })} />
          </Group>
        </>
      )}
      {kind === "routine" && (
        <>
          <Choice label="Routine" options={[{ value: "", label: "Any routine" }, ...routines.map((r) => ({ value: r.chat.id, label: r.entry.name || r.chat.title || "Routine" }))]} value={cfg.routineChatId ?? ""} onChange={(routineChatId: string) => setConfig({ routineChatId: routineChatId || undefined, routineName: routines.find((r) => r.chat.id === routineChatId)?.entry.name || undefined })} />
          <Choice label="When it" options={[{ value: "any", label: "Finishes" }, { value: "done", label: "Succeeds" }, { value: "failed", label: "Fails" }]} value={cfg.onlyOnStatus ?? "any"} onChange={(onlyOnStatus: string) => setConfig({ onlyOnStatus })} />
        </>
      )}
      {kind === "webhook" && (
        <T variant="footnote" color="muted">
          {cfg.routeId ? "The computer made this workflow's webhook URL and secret. Copy them from Workflows on the computer." : "The computer makes a webhook URL and secret when you save."} Fields in the posted JSON body become {"{{body.name}}"}.
        </T>
      )}
      {kind === "github" && <GithubTriggerEditor nodeId={node.id} cfg={cfg} setConfig={setConfig} />}
    </View>
  );
}

function GithubTriggerEditor({ nodeId, cfg, setConfig }: { nodeId: string; cfg: Record<string, any>; setConfig: (patch: Record<string, unknown>) => void }) {
  const { colors } = useTheme();
  const [status, setStatus] = useState<WorkflowGithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = async (includeRepos = true) => {
    try {
      const next = await api.workflowGithubStatus({ includeRepos });
      setStatus(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not check GitHub connection on your computer.");
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void loadStatus(true);
  }, [nodeId]);

  const waiting = status?.signIn?.status === "waiting" || status?.signIn?.status === "starting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void loadStatus(true);
    }, 2500);
    return () => clearInterval(timer);
  }, [waiting]);

  const startSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const signIn = await api.workflowGithubSignInStart();
      setStatus((prev) =>
        prev
          ? { ...prev, signIn }
          : { installed: true, authenticated: false, login: null, scopes: [], repos: [], installUrl: "https://cli.github.com/", signIn },
      );
      if (signIn.status === "done") await loadStatus(true);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "Could not start GitHub sign-in.";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const cancelSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.workflowGithubSignInCancel();
      setStatus(next);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "Could not cancel GitHub sign-in.";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const copyAndOpen = async () => {
    const code = status?.signIn?.code;
    const url = status?.signIn?.url || "https://github.com/login/device";
    if (code) {
      await Clipboard.setStringAsync(code);
      showToast("Code copied — paste it on GitHub", "success");
    }
    void Linking.openURL(url).catch(() => showToast("Couldn't open GitHub.", "error"));
  };

  const selectedEvents: string[] = Array.isArray(cfg.events)
    ? cfg.events.map((e: unknown) => String(e))
    : typeof cfg.events === "string" && cfg.events.trim()
      ? cfg.events.split(",").map((s: string) => s.trim()).filter(Boolean)
      : ["pr_opened"];

  const onEventsChange = (events: string[]) => {
    const patch: Record<string, unknown> = { events };
    if (events.includes("bot_mentioned") && !cfg.mentionHandle) {
      patch.mentionHandle = "@botkins-bot";
    }
    setConfig(patch);
  };

  const signIn = status?.signIn;
  const repoOptions = (status?.repos ?? []).slice(0, 12).map((r) => ({ value: r, label: r }));

  return (
    <View style={{ gap: space.lg }}>
      <View>
        <Label>GitHub connection</Label>
        <Group>
          <View style={{ padding: space.md, gap: space.sm }}>
            {loading && !status ? (
              <T variant="footnote" color="muted">Checking GitHub CLI on your computer…</T>
            ) : !status?.installed ? (
              <>
                <T variant="footnote" color="muted">
                  Install the GitHub CLI (gh) on your computer so Botkins can connect GitHub and poll locally.
                </T>
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                  <Button
                    title="Install GitHub CLI"
                    size="sm"
                    icon={ExternalLink}
                    onPress={() => void Linking.openURL(status?.installUrl || "https://cli.github.com/").catch(() => showToast("Couldn't open that page.", "error"))}
                  />
                  <Button title="Refresh" size="sm" variant="secondary" icon={RefreshCw} disabled={loading} onPress={() => void loadStatus(true)} />
                </View>
              </>
            ) : signIn?.status === "waiting" && signIn.code ? (
              <>
                <T variant="footnote" color="muted">Copy this one-time code and enter it on GitHub to connect:</T>
                <View style={{ paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, backgroundColor: colors.sunken, alignSelf: "flex-start" }}>
                  <T variant="mono" weight="700" style={{ fontSize: 18, letterSpacing: 1.5 }}>{signIn.code}</T>
                </View>
                <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
                  <Button title="Copy code & open GitHub" size="sm" icon={Copy} onPress={() => void copyAndOpen()} />
                  <Button title="Cancel" size="sm" variant="secondary" disabled={busy} onPress={() => void cancelSignIn()} />
                </View>
                <T variant="caption" color="muted">Waiting for GitHub sign-in to complete…</T>
              </>
            ) : status.authenticated ? (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                  <CheckCircle2 size={16} color={colors.success} />
                  <T variant="subhead">Connected{status.login ? ` as @${status.login}` : ""}</T>
                </View>
                <View style={{ flexDirection: "row", gap: space.xs }}>
                  <Button title="Refresh" size="sm" variant="secondary" disabled={loading || busy} onPress={() => void loadStatus(true)} />
                  <Button title="Reconnect" size="sm" variant="secondary" disabled={busy} onPress={() => void startSignIn()} />
                </View>
              </View>
            ) : (
              <>
                <T variant="footnote" color="muted">
                  Sign in once with your GitHub account so your computer can poll issues, PRs, comments, and @mentions locally.
                </T>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <Button title={busy ? "Starting…" : "Connect GitHub"} size="sm" icon={KeyRound} disabled={busy} onPress={() => void startSignIn()} />
                  <Button title="Refresh" size="sm" variant="secondary" disabled={loading || busy} onPress={() => void loadStatus(true)} />
                </View>
              </>
            )}
            {(error || signIn?.status === "failed") && (
              <T variant="footnote" color="danger">{error || signIn?.error}</T>
            )}
          </View>
        </Group>
      </View>

      <Field label="Repository" placeholder="owner/repo" value={cfg.repo ?? ""} onChangeText={(repo) => setConfig({ repo: repo.trim() })} autoCapitalize="none" autoCorrect={false} />
      {repoOptions.length > 0 && (
        <Choice label="Your repositories" options={repoOptions} value={cfg.repo ?? ""} onChange={(repo: string) => setConfig({ repo })} />
      )}

      <Choice
        label="Events"
        multi
        options={GITHUB_EVENTS.map((e) => ({
          value: e,
          label: e === "user_mentioned" && status?.login ? `Mentioned @${status.login}` : GITHUB_EVENT_LABEL[e],
        }))}
        value={selectedEvents}
        onChange={onEventsChange}
      />

      {selectedEvents.includes("bot_mentioned") && (
        <Field
          label="Bot mention handle(s)"
          hint="Default @botkins-bot. Separate multiple handles with commas."
          placeholder="@botkins-bot"
          value={cfg.mentionHandle ?? "@botkins-bot"}
          onChangeText={(mentionHandle) => setConfig({ mentionHandle })}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      <Field label="Branch (PRs)" placeholder="Optional, e.g. main" value={cfg.branch ?? ""} onChangeText={(branch) => setConfig({ branch: branch.trim() || undefined })} autoCapitalize="none" autoCorrect={false} />
      <Field label="Author" placeholder="Optional username" value={cfg.author ?? ""} onChangeText={(author) => setConfig({ author: author.trim().replace(/^@/, "") || undefined })} autoCapitalize="none" autoCorrect={false} />
      <Field
        label="Poll every (minutes)"
        keyboardType="number-pad"
        value={String(cfg.pollMinutes ?? 5)}
        onChangeText={(text) => {
          const n = Number(text.replace(/[^0-9]/g, ""));
          setConfig({ pollMinutes: n >= 1 ? Math.min(120, n) : 5 });
        }}
      />
    </View>
  );
}

function AskEditor({ node, setConfig, fields, analysis }: { node: WorkflowNode; setConfig: (patch: Record<string, unknown>) => void; fields: NodeFieldAnalysis["available"]; analysis?: NodeFieldAnalysis }) {
  const cfg = node.config ?? {};
  const bots = useBots();
  const models = useModels();
  const outputs: { name: string; type?: string; choices?: string[] }[] = Array.isArray(cfg.outputFields) ? cfg.outputFields : [];
  const setOutputs = (next: typeof outputs) => setConfig({ outputFields: next });
  return (
    <View style={{ gap: space.lg }}>
      {node.kind === "agent" ? (
        <Choice label="Bot" options={bots.map((b) => ({ value: b.id, label: b.name }))} value={cfg.botId ?? bots.find((b) => b.name === cfg.botName)?.id} onChange={(botId: string) => setConfig({ botId, botName: bots.find((b) => b.id === botId)?.name })} />
      ) : (
        <Choice label="Model" options={[{ value: "", label: "Default" }, ...(models ?? []).slice(0, 24).map((m) => ({ value: m.id, label: m.name }))]} value={cfg.model ?? ""} onChange={(model: string) => setConfig({ model: model || undefined })} />
      )}
      <TemplateField label="Prompt" value={cfg.prompt ?? ""} onChange={(prompt) => setConfig({ prompt })} fields={fields} problems={problemsFor(analysis, "prompt")} placeholder={node.kind === "agent" ? "What should the bot do?" : "What should the model answer?"} />
      <View style={{ gap: space.sm }}>
        <T variant="footnote" color="muted" weight="600">
          Answer fields
        </T>
        <T variant="caption" color="muted">
          {`Named fields later steps can use. Without any, the reply is {{${node.kind === "agent" ? "agent_reply" : "model_reply"}}}.`}
        </T>
        {outputs.map((f, i) => (
          <View key={i} style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
            <View style={{ flex: 1, gap: space.xs }}>
              <Field value={f.name} placeholder="field_name" onChangeText={(name) => setOutputs(outputs.map((x, j) => (j === i ? { ...x, name: name.replace(/[^a-zA-Z0-9_.-]/g, "") } : x)))} autoCapitalize="none" autoCorrect={false} mono />
              <Segmented options={[{ value: "string", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Yes/No" }]} value={(f.type as "string") ?? "string"} onChange={(type) => setOutputs(outputs.map((x, j) => (j === i ? { ...x, type } : x)))} />
            </View>
            <IconButton icon={X} label={`Remove ${f.name || "field"}`} onPress={() => setOutputs(outputs.filter((_, j) => j !== i))} />
          </View>
        ))}
        <Button title="Add a field" variant="secondary" size="sm" icon={Plus} onPress={() => setOutputs([...outputs, { name: "", type: "string" }])} />
      </View>
    </View>
  );
}

function ConditionEditor({ cfg, setConfig, fields }: { cfg: Record<string, any>; setConfig: (patch: Record<string, unknown>) => void; fields: string[] }) {
  const { colors } = useTheme();
  const rules: { field: string; op: string; value?: string }[] = Array.isArray(cfg.rules) ? cfg.rules : [];
  const setRules = (next: typeof rules) => setConfig({ rules: next, expression: undefined });
  const names = useMemo(() => [...new Set(fields)], [fields]);
  return (
    <View style={{ gap: space.lg }}>
      <Segmented options={[{ value: "all", label: "All rules" }, { value: "any", label: "Any rule" }]} value={cfg.match === "any" ? "any" : "all"} onChange={(match) => setConfig({ match })} />
      {rules.map((r, i) => (
        <View key={i} style={{ gap: space.sm, padding: space.md, borderRadius: 14, borderWidth: 1, borderColor: colors.line }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <T variant="footnote" weight="600" style={{ flex: 1 }}>{`Rule ${i + 1}`}</T>
            <IconButton icon={X} label={`Remove rule ${i + 1}`} onPress={() => setRules(rules.filter((_, j) => j !== i))} />
          </View>
          <Field label="Field" value={r.field} onChangeText={(field) => setRules(rules.map((x, j) => (j === i ? { ...x, field: field.replace(/[{}\s]/g, "") } : x)))} autoCapitalize="none" autoCorrect={false} mono />
          {names.length > 0 && <Choice options={names.map((n) => ({ value: n, label: n }))} value={r.field} onChange={(field: string) => setRules(rules.map((x, j) => (j === i ? { ...x, field } : x)))} />}
          <Choice label="Check" options={CONDITION_OPS.map((op) => ({ value: op, label: OP_LABEL[op] }))} value={r.op} onChange={(op: string) => setRules(rules.map((x, j) => (j === i ? { ...x, op } : x)))} />
          {!OPS_WITHOUT_VALUE.includes(r.op) && <Field label="Value" hint={r.op === "in" ? "Separate choices with commas." : undefined} value={r.value ?? ""} onChangeText={(value) => setRules(rules.map((x, j) => (j === i ? { ...x, value } : x)))} autoCapitalize="none" />}
        </View>
      ))}
      <Button title="Add a rule" variant="secondary" size="sm" icon={Plus} onPress={() => setRules([...rules, { field: names[0] ?? "", op: "equals", value: "" }])} />
      {!rules.length && <T variant="footnote" color="warning">With no rules the check is always No.</T>}
    </View>
  );
}

function OutputEditor({ cfg, setConfig, fields, analysis }: { cfg: Record<string, any>; setConfig: (patch: Record<string, unknown>) => void; fields: NodeFieldAnalysis["available"]; analysis?: NodeFieldAnalysis }) {
  const bots = useBots();
  const chats = useChats();
  const { colors } = useTheme();
  const dest = cfg.destination ?? "chat";
  const label = (d: string) => (d === "chat" ? "Chat" : d === "feed" ? "Feed" : d === "idea" ? "Ideas" : d === "goal" ? "Goals" : "Notification");
  const visible = chats.filter((c) => !c.archived).slice(0, 20);
  const card = dest === "chat" && cfg.card && typeof cfg.card === "object" ? cfg.card : null;
  const a2ui = dest === "chat" && cfg.a2ui !== undefined && cfg.a2ui !== null ? cfg.a2ui : null;
  const a2uiObj = a2ui && typeof a2ui === "object" && !Array.isArray(a2ui) ? a2ui : null;
  const a2uiOnAction: string = typeof a2uiObj?.onAction === "string" ? a2uiObj.onAction : "bot";
  const a2uiText: string =
    typeof a2ui === "string"
      ? a2ui
      : typeof a2uiObj?.messages === "string"
        ? a2uiObj.messages
        : a2ui
          ? JSON.stringify(Array.isArray(a2uiObj?.messages) ? a2uiObj.messages : a2ui, null, 2)
          : "";
  const updateA2ui = (nextText: string, nextOnAction: string) => {
    let messagesVal: unknown = nextText;
    try {
      const parsed = JSON.parse(nextText);
      if (Array.isArray(parsed)) messagesVal = parsed;
    } catch {
      // Keep string while typing JSON
    }
    setConfig({ a2ui: { ...(a2uiObj ?? {}), messages: messagesVal, onAction: nextOnAction } });
  };
  const setCard = (patch: Record<string, unknown>) => setConfig({ card: { ...(card ?? {}), ...patch } });
  const dispatch = card?.dispatch && typeof card.dispatch === "object" ? card.dispatch : null;
  const setDispatch = (patch: Record<string, unknown>) => setCard({ dispatch: { ...(dispatch ?? {}), ...patch } });
  const cardFields: { label: string; value: string; tone?: string }[] = Array.isArray(card?.fields) ? card.fields : [];
  const hasMessageOrCard = !!String(cfg.template ?? "").trim() || !!(card && String(card.title ?? "").trim()) || !!a2uiText.trim();
  return (
    <View style={{ gap: space.lg }}>
      <Choice label="Send to" options={DESTINATIONS.map((d) => ({ value: d, label: label(d) }))} value={dest} onChange={(destination: string) => setConfig({ destination, ...(destination !== "chat" ? { card: undefined, a2ui: undefined } : {}) })} />
      <Choice label="As" options={[{ value: "", label: "First bot" }, ...bots.map((b) => ({ value: b.name, label: b.name }))]} value={cfg.botName ?? ""} onChange={(botName: string) => setConfig({ botName: botName || undefined, botId: undefined })} />
      {dest === "chat" && <Choice label="Chat" options={[{ value: "", label: "The bot's main chat" }, ...visible.map((c) => ({ value: c.id, label: c.title || "Chat" }))]} value={cfg.chatId ?? ""} onChange={(chatId: string) => setConfig({ chatId: chatId || undefined })} />}
      {dest === "chat" && (
        <Segmented
          options={[
            { value: "text", label: "Text" },
            { value: "card", label: "Action card" },
            { value: "a2ui", label: "A2UI" },
          ]}
          value={a2ui ? "a2ui" : card ? "card" : "text"}
          onChange={(mode) => {
            if (mode === "card") {
              setConfig({
                a2ui: undefined,
                card: card ?? {
                  title: cfg.title || "{{title}}",
                  needsYou: "{{needs_you}}",
                  body: cfg.template || "",
                  fields: [],
                },
              });
            } else if (mode === "a2ui") {
              const starter = [
                {
                  version: "1.0",
                  createSurface: {
                    surfaceId: "wf-surface",
                    sendDataModel: true,
                    components: [
                      { id: "root", component: "Column", children: ["heading", "ok_btn"] },
                      { id: "heading", component: "Text", text: "{{title?}}" },
                      { id: "ok_btn", component: "Button", child: "ok_label", variant: "primary", action: { event: { name: "acknowledge" } } },
                      { id: "ok_label", component: "Text", text: "Acknowledge" },
                    ],
                    dataModel: {},
                  },
                },
              ];
              setConfig({
                card: undefined,
                a2ui: a2ui ?? { messages: JSON.stringify(starter, null, 2), onAction: "bot" },
              });
            } else {
              setConfig({ card: undefined, a2ui: undefined });
            }
          }}
        />
      )}
      {dest === "chat" && card && (
        <View style={{ gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.sunken, borderWidth: 1, borderColor: colors.line }}>
          <TemplateField label="Card title" area={false} value={card.title ?? ""} onChange={(title) => setCard({ title })} fields={fields} problems={problemsFor(analysis, "card.title")} placeholder="Botkins #{{number}}: {{title}}" />
          <TemplateField label="Subtitle (optional)" area={false} value={card.subtitle ?? ""} onChange={(subtitle) => setCard({ subtitle: subtitle || undefined })} fields={fields} problems={problemsFor(analysis, "card.subtitle")} placeholder="[{{repo}}#{{number}}]({{url}})" />
          <TemplateField label="Needs your direction" area={false} value={typeof card.needsYou === "boolean" ? String(card.needsYou) : (card.needsYou ?? "")} onChange={(needsYou) => setCard({ needsYou })} fields={fields} problems={problemsFor(analysis, "card.needsYou")} placeholder="{{needs_you}} (yes/true or no/false)" />
          <TemplateField label="Card body (Markdown)" value={card.body ?? ""} onChange={(body) => setCard({ body })} fields={fields} problems={problemsFor(analysis, "card.body")} placeholder="Short summary shown inside the card." />
          <View style={{ gap: space.sm }}>
            <T variant="footnote" color="muted" weight="600">
              Metadata badges
            </T>
            {cardFields.map((f, i) => (
              <View key={i} style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
                <View style={{ flex: 1, gap: space.xs }}>
                  <Field value={f.label ?? ""} placeholder="Label" onChangeText={(lbl) => setCard({ fields: cardFields.map((x, j) => (j === i ? { ...x, label: lbl } : x)) })} />
                  <Field value={f.value ?? ""} placeholder="Value or {{field}}" onChangeText={(val) => setCard({ fields: cardFields.map((x, j) => (j === i ? { ...x, value: val } : x)) })} />
                </View>
                <IconButton icon={X} label={`Remove badge ${i + 1}`} onPress={() => setCard({ fields: cardFields.filter((_, j) => j !== i) })} />
              </View>
            ))}
            <Button title="Add badge" variant="secondary" size="sm" icon={Plus} onPress={() => setCard({ fields: [...cardFields, { label: "", value: "" }] })} />
          </View>
          <TemplateField label="Link label (optional)" area={false} value={card.link?.label ?? ""} onChange={(lbl) => setCard({ link: lbl || card.link?.url ? { ...(card.link ?? {}), label: lbl } : undefined })} fields={fields} problems={problemsFor(analysis, "card.link.label")} placeholder="View GitHub comment" />
          <TemplateField label="Link URL (optional)" area={false} value={card.link?.url ?? ""} onChange={(url) => setCard({ link: url || card.link?.label ? { ...(card.link ?? {}), url } : undefined })} fields={fields} problems={problemsFor(analysis, "card.link.url")} placeholder="{{comment_url}}" />
          <Segmented
            options={[
              { value: "off", label: "Dismiss only" },
              { value: "on", label: "Dispatch + Dismiss" },
            ]}
            value={dispatch ? "on" : "off"}
            onChange={(mode) => {
              if (mode === "on") {
                setCard({ dispatch: dispatch ?? { botName: cfg.botName || bots[0]?.name || "", prompt: "" } });
              } else {
                setCard({ dispatch: undefined });
              }
            }}
          />
          {dispatch && (
            <View style={{ gap: space.md }}>
              <Choice
                label="Dispatch bot"
                options={[{ value: "", label: "Same as output bot" }, ...bots.map((b) => ({ value: b.name, label: b.name }))]}
                value={dispatch.botName ?? bots.find((b) => b.id === dispatch.botId)?.name ?? ""}
                onChange={(botName: string) => setDispatch({ botName: botName || undefined, botId: undefined })}
              />
              <TemplateField label="Dispatch chat title (optional)" area={false} value={dispatch.chatTitle ?? ""} onChange={(chatTitle) => setDispatch({ chatTitle: chatTitle || undefined })} fields={fields} problems={problemsFor(analysis, "card.dispatch.chatTitle")} placeholder="Defaults to the card title" />
              <TemplateField label="Dispatch prompt" value={dispatch.prompt ?? ""} onChange={(prompt) => setDispatch({ prompt })} fields={fields} problems={problemsFor(analysis, "card.dispatch.prompt")} placeholder="First user message sent to the new chat." />
            </View>
          )}
        </View>
      )}
      {dest === "chat" && a2ui && (
        <View style={{ gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.sunken, borderWidth: 1, borderColor: colors.line }}>
          <Choice
            label="Surface action routing"
            options={[
              { value: "bot", label: "Send to owning bot" },
              { value: "resume", label: "Resume workflow approval" },
              { value: "trigger", label: "Trigger workflow" },
            ]}
            value={a2uiOnAction}
            onChange={(nextAction: string) => updateA2ui(a2uiText, nextAction)}
          />
          <TemplateField
            label="A2UI v1.0 messages JSON"
            value={a2uiText}
            onChange={(val) => updateA2ui(val, a2uiOnAction)}
            fields={fields}
            problems={problemsFor(analysis, "a2ui")}
            placeholder='[{"version":"1.0","createSurface":{"surfaceId":"s1","components":[{"id":"root","component":"Text","text":"{{title}}"}]}}]'
          />
        </View>
      )}
      {dest !== "chat" && <TemplateField label="Title" area={false} value={cfg.title ?? ""} onChange={(title) => setConfig({ title: title || undefined })} fields={fields} problems={problemsFor(analysis, "title")} placeholder="The workflow's name" />}
      {dest === "goal" && <Choice label="Category" options={GOAL_CATEGORIES.map((c) => ({ value: c, label: cap(c) }))} value={cfg.category ?? "other"} onChange={(category: string) => setConfig({ category })} />}
      <TemplateField label={card || a2ui ? "Plain-text fallback (optional)" : "Message"} value={cfg.template ?? ""} onChange={(template) => setConfig({ template })} fields={fields} problems={problemsFor(analysis, "template")} placeholder={card || a2ui ? "Auto-generated from the UI when blank." : "What to send. Tap a field to put it in."} />
      {!hasMessageOrCard && <T variant="footnote" style={{ color: colors.warning }}>An empty message fails the run.</T>}
    </View>
  );
}
