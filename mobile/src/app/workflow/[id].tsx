import { useLocalSearchParams, router } from "expo-router";
import { ShieldCheck, Workflow as WorkflowIcon } from "lucide-react-native";
import { useState } from "react";
import { Switch, View } from "react-native";
import { useCan, useWorkflowRuns, useWorkflows } from "@/state/hooks";
import { api, attempt } from "@/state/link";
import { Button, Dot, EmptyState, Group, haptic, IconTile, Label, Page, Row, space, switchColors, T, useTheme } from "@/ui";

function durLabel(start?: number | null, end?: number | null) {
  if (!start) return "";
  const ms = Math.max(0, (end ?? Date.now()) - start);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function statusTone(status: string): "success" | "warning" | "danger" | "accent" | undefined {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting_approval") return "warning";
  if (status === "running") return "accent";
  return undefined;
}

export default function WorkflowDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const workflows = useWorkflows();
  const runs = useWorkflowRuns(id);
  const canManage = useCan("today", "manage");
  const canUse = useCan("today", "use");
  const [busy, setBusy] = useState(false);

  const workflow = workflows.find((w) => w.id === id);

  if (!workflow) {
    return (
      <Page title="Workflow">
        <EmptyState title="Workflow not found" action="Back" onAction={() => router.back()} />
      </Page>
    );
  }

  const triggers = workflow.nodes.filter((n) => n.kind === "trigger").map((n) => n.triggerKind || "trigger");

  const toggleEnabled = (next: boolean) => {
    haptic.select();
    void attempt(next ? api.workflowResume(workflow.id) : api.workflowPause(workflow.id), next ? "Workflow resumed" : "Workflow paused");
  };

  const runNow = async () => {
    setBusy(true);
    try {
      await attempt(api.workflowRun(workflow.id), "Workflow started");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={workflow.name}>
      <View style={{ gap: space.lg }}>
        <Group>
          <Row
            leading={<IconTile icon={WorkflowIcon} color={workflow.enabled ? colors.accent : colors.muted} size={40} />}
            title={workflow.enabled ? "Active" : "Paused"}
            subtitle={
              workflow.enabled
                ? `${workflow.nodes.length} steps · triggers: ${triggers.join(", ") || "none"}`
                : "Events and schedules paused · manual runs still work"
            }
            trailing={
              canManage ? (
                <Switch
                  value={workflow.enabled}
                  onValueChange={toggleEnabled}
                  {...switchColors(colors, workflow.enabled)}
                  accessibilityLabel={workflow.name + (workflow.enabled ? ", active" : ", paused")}
                />
              ) : undefined
            }
          />
          {canUse && (
            <View style={{ padding: space.md, flexDirection: "row", gap: space.sm }}>
              <Button title={busy ? "Starting…" : "Run now"} disabled={busy} onPress={() => void runNow()} />
            </View>
          )}
        </Group>

        <View>
          <Label>{"Runs · " + runs.length}</Label>
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" text="Tap Run now to test this workflow, or wait for its trigger event." />
          ) : (
            <View style={{ gap: space.md }}>
              {runs.slice(0, 15).map((run) => (
                <Group key={run.id}>
                  <Row
                    title={run.status === "waiting_approval" ? "Waiting for approval" : run.status[0].toUpperCase() + run.status.slice(1)}
                    subtitle={[
                      run.manual ? "Manual" : run.triggerKind || "Event",
                      new Date(run.startedAt).toLocaleString(),
                      durLabel(run.startedAt, run.finishedAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    trailing={<Dot tone={statusTone(run.status)} />}
                  />

                  {run.status === "waiting_approval" && run.pendingApproval && canUse && (
                    <View style={{ padding: space.md, gap: space.sm }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                        <ShieldCheck size={16} color={colors.warning} />
                        <T variant="callout" weight="600">
                          {run.pendingApproval.label}
                        </T>
                      </View>
                      <T variant="subhead" color="muted">
                        {run.pendingApproval.message}
                      </T>
                      <View style={{ flexDirection: "row", gap: space.sm }}>
                        <Button
                          title="Approve"
                          size="sm"
                          onPress={() =>
                            void attempt(
                              api.workflowRespondApproval(run.id, run.pendingApproval!.nodeId, "approved"),
                              "Approved",
                            )
                          }
                        />
                        <Button
                          title="Reject"
                          variant="ghost"
                          size="sm"
                          onPress={() =>
                            void attempt(
                              api.workflowRespondApproval(run.id, run.pendingApproval!.nodeId, "rejected"),
                              "Rejected",
                            )
                          }
                        />
                      </View>
                    </View>
                  )}

                  {Object.values(run.steps).map((step) => (
                    <Row
                      key={step.nodeId}
                      title={step.label}
                      subtitle={[step.status, durLabel(step.startedAt, step.finishedAt), step.error || step.summary]
                        .filter(Boolean)
                        .join(" · ")}
                      subtitleLines={2}
                      trailing={<Dot tone={statusTone(step.status)} />}
                    />
                  ))}

                  {run.status === "failed" && canUse && (
                    <View style={{ padding: space.md, flexDirection: "row", gap: space.sm }}>
                      <Button
                        title="Retry failed step"
                        size="sm"
                        onPress={() => void attempt(api.workflowRetryRun(run.id), "Retrying failed step")}
                      />
                    </View>
                  )}
                </Group>
              ))}
            </View>
          )}
        </View>
      </View>
    </Page>
  );
}
