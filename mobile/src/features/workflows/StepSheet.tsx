// Edits one trigger or step of a workflow draft. Changes stay in the draft until the designer saves it.
import { Plus, Trash2, X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Modal, View } from "react-native";
import type { WorkflowNode, WorkflowTriggerKind } from "@/link/types";
import { useBots, useChats, useModels, useRoutines } from "@/state/hooks";
import { Button, Field, Group, IconButton, Row, Segmented, Sheet, space, T, useTheme } from "@/ui";
import type { NodeFieldAnalysis } from "./fields";
import { CONDITION_OPS, DAYS, DESTINATIONS, GITHUB_EVENTS, GOAL_CATEGORIES, KIND_LABEL, OP_LABEL, OPS_WITHOUT_VALUE, TASK_STATUSES, TRIGGER_KINDS, TRIGGER_LABEL } from "./graph";
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
        {node.kind === "trigger" && <TriggerEditor node={node} setConfig={setConfig} setKind={(triggerKind) => set({ triggerKind, label: node.label === TRIGGER_LABEL[node.triggerKind ?? "manual"] ? TRIGGER_LABEL[triggerKind] : node.label, config: {} })} />}
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
      {kind === "github" && (
        <>
          <Field label="Repository" placeholder="owner/repo" value={cfg.repo ?? ""} onChangeText={(repo) => setConfig({ repo: repo.trim() })} autoCapitalize="none" autoCorrect={false} />
          <Choice label="Events" multi options={GITHUB_EVENTS.map((e) => ({ value: e, label: e === "pr_opened" ? "PR opened" : e === "pr_review" ? "PR review" : "CI status" }))} value={cfg.events ?? []} onChange={(events: string[]) => setConfig({ events })} />
          <Field label="Branch" value={cfg.branch ?? ""} onChangeText={(branch) => setConfig({ branch: branch || undefined })} autoCapitalize="none" autoCorrect={false} />
          <Field label="Author" value={cfg.author ?? ""} onChangeText={(author) => setConfig({ author: author || undefined })} autoCapitalize="none" autoCorrect={false} />
        </>
      )}
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
  return (
    <View style={{ gap: space.lg }}>
      <Choice label="Send to" options={DESTINATIONS.map((d) => ({ value: d, label: label(d) }))} value={dest} onChange={(destination: string) => setConfig({ destination })} />
      <Choice label="As" options={[{ value: "", label: "First bot" }, ...bots.map((b) => ({ value: b.name, label: b.name }))]} value={cfg.botName ?? ""} onChange={(botName: string) => setConfig({ botName: botName || undefined, botId: undefined })} />
      {dest === "chat" && <Choice label="Chat" options={[{ value: "", label: "The bot's main chat" }, ...visible.map((c) => ({ value: c.id, label: c.title || "Chat" }))]} value={cfg.chatId ?? ""} onChange={(chatId: string) => setConfig({ chatId: chatId || undefined })} />}
      {dest !== "chat" && <TemplateField label="Title" area={false} value={cfg.title ?? ""} onChange={(title) => setConfig({ title: title || undefined })} fields={fields} problems={problemsFor(analysis, "title")} placeholder="The workflow's name" />}
      {dest === "goal" && <Choice label="Category" options={GOAL_CATEGORIES.map((c) => ({ value: c, label: cap(c) }))} value={cfg.category ?? "other"} onChange={(category: string) => setConfig({ category })} />}
      <TemplateField label="Message" value={cfg.template ?? ""} onChange={(template) => setConfig({ template })} fields={fields} problems={problemsFor(analysis, "template")} placeholder="What to send. Tap a field to put it in." />
      {!String(cfg.template ?? "").trim() && <T variant="footnote" style={{ color: colors.warning }}>An empty message fails the run.</T>}
    </View>
  );
}
