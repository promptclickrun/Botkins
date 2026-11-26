// A workflow's recent runs: each one's steps in order, with approve or reject, retry and cancel where they apply.
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import type { Workflow, WorkflowNode, WorkflowRun, WorkflowStepRun } from "@/link/types";
import { api, attempt } from "@/state/link";
import { Button, Dot, EmptyState, Field, Group, radius, Row, space, T, Tap, useShape, useTheme } from "@/ui";

export function durLabel(start?: number | null, end?: number | null) {
  if (!start) return "";
  const ms = Math.max(0, (end ?? Date.now()) - start);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function statusTone(status: string): "success" | "warning" | "danger" | "accent" | undefined {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting_approval") return "warning";
  if (status === "running") return "accent";
  return undefined;
}

const statusWord = (s: string) => (s === "waiting_approval" ? "Waiting for approval" : s.charAt(0).toUpperCase() + s.slice(1));

/** Steps in the order the workflow draws them, then any the run has that the workflow no longer does. */
function ordered(run: WorkflowRun, nodes: WorkflowNode[]): WorkflowStepRun[] {
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  return Object.values(run.steps).sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (order.get(a.nodeId) ?? 99) - (order.get(b.nodeId) ?? 99));
}

export function RunsView({ workflow, runs, nodes, canUse }: { workflow: Workflow; runs: WorkflowRun[]; nodes: WorkflowNode[]; canUse: boolean }) {
  const shape = useShape();
  const [open, setOpen] = useState<string | null>(runs[0]?.id ?? null);
  if (!runs.length)
    return (
      <View style={{ flex: 1, padding: space.lg }}>
        <EmptyState title="No runs yet" text={`Tap Run now on Design to test ${workflow.name}, or wait for its trigger.`} />
      </View>
    );
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.md, maxWidth: shape.wide ? 760 : undefined, width: "100%", alignSelf: "center" }}>
      {runs.slice(0, 30).map((run) => (
        <RunCard key={run.id} run={run} nodes={nodes} canUse={canUse} open={open === run.id} onToggle={() => setOpen(open === run.id ? null : run.id)} />
      ))}
    </ScrollView>
  );
}

function RunCard({ run, nodes, canUse, open, onToggle }: { run: WorkflowRun; nodes: WorkflowNode[]; canUse: boolean; open: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  const [note, setNote] = useState("");
  const Chevron = open ? ChevronDown : ChevronRight;
  const steps = ordered(run, nodes);
  const failed = steps.find((s) => s.status === "failed");
  const respond = (decision: "approved" | "rejected") =>
    void attempt(api.workflowRespondApproval(run.id, run.pendingApproval!.nodeId, decision, note.trim() || undefined), decision === "approved" ? "Approved" : "Rejected").then(() => setNote(""));
  return (
    <Group>
      <Tap onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md }}>
        <Dot tone={statusTone(run.status)} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="callout" weight="700">
            {statusWord(run.status)}
          </T>
          <T variant="footnote" color="muted" numberOfLines={1}>
            {[run.manual ? "Run by hand" : run.triggerKind || "Event", new Date(run.startedAt).toLocaleString(), durLabel(run.startedAt, run.finishedAt)].filter(Boolean).join(" · ")}
          </T>
        </View>
        <Chevron size={18} color={colors.muted} />
      </Tap>

      {run.status === "waiting_approval" && run.pendingApproval && canUse && (
        <View style={{ padding: space.md, gap: space.sm, backgroundColor: colors.warningSoft }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
            <ShieldCheck size={16} color={colors.warning} />
            <T variant="callout" weight="700">
              {run.pendingApproval.label}
            </T>
          </View>
          <T variant="subhead">{run.pendingApproval.message}</T>
          {!!run.pendingApproval.noteField && <Field placeholder="Add a note (optional)" value={note} onChangeText={setNote} />}
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Approve" size="sm" onPress={() => respond("approved")} />
            <Button title="Reject" variant="secondary" size="sm" onPress={() => respond("rejected")} />
          </View>
        </View>
      )}

      {open && (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.md }}>
          {!!run.error && (
            <View style={{ padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.dangerSoft, marginBottom: space.sm }}>
              <T variant="footnote" color="danger">
                {run.error}
              </T>
            </View>
          )}
          {steps.map((step, i) => (
            <View key={step.nodeId} style={{ flexDirection: "row", gap: space.md }}>
              <View style={{ alignItems: "center", width: 12 }}>
                <View style={{ marginTop: 6 }}>
                  <Dot tone={statusTone(step.status)} />
                </View>
                {i < steps.length - 1 && <View style={{ flex: 1, width: 2, backgroundColor: colors.line, marginTop: 4 }} />}
              </View>
              <View style={{ flex: 1, paddingBottom: space.md }}>
                <T variant="footnote" weight="700">
                  {step.label}
                </T>
                <T variant="caption" color="muted">
                  {[statusWord(step.status), step.branch ? `took ${step.branch}` : "", durLabel(step.startedAt, step.finishedAt)].filter(Boolean).join(" · ")}
                </T>
                {!!(step.error || step.summary) && (
                  <T variant="footnote" color={step.error ? "danger" : "ink2"} numberOfLines={6} selectable>
                    {step.error || step.summary}
                  </T>
                )}
              </View>
            </View>
          ))}
          {canUse && (
            <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
              {run.status === "failed" && <Button title={failed ? `Retry ${failed.label}` : "Retry"} size="sm" onPress={() => void attempt(api.workflowRetryRun(run.id, failed?.nodeId), "Retrying")} />}
              {(run.status === "running" || run.status === "waiting_approval") && <Button title="Cancel run" variant="danger" size="sm" onPress={() => void attempt(api.workflowCancelRun(run.id), "Run cancelled")} />}
            </View>
          )}
        </View>
      )}
      {!open && run.status === "failed" && failed && <Row title={failed.label} subtitle={failed.error} subtitleLines={2} tone="danger" />}
    </Group>
  );
}
