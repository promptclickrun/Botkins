// Workflows workspace inside Botkins' Routines area.
// Combines the workflow list, starter templates, import/export, interactive node canvas,
// step inspector, and live run history.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  Pause,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowInspector } from "./WorkflowInspector";
import { analyzeWorkflowFields } from "./workflowAnalysis";
import { memberTeam } from "./teamAccess";
import type {
  Bot,
  ModelInfo,
  State,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowTriggerKind,
} from "./types";

const api = window.botkins;

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function starterTemplates(bots: Bot[]): Array<{ id: string; name: string; description: string; build: () => { name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] } }> {
  const primary = bots[0];
  const botId = primary?.id;
  const botName = primary?.name ?? "Bot";
  return [
    {
      id: "task-review",
      name: "Task → Review → Bot → Chat",
      description: `When a Task Board job moves to Review, hand the result to ${botName} and post a concise update to chat.`,
      build: () => ({
        name: "Task review handoff",
        description: `Runs ${botName} whenever a Task Board item moves to Review and posts the summary to chat.`,
        nodes: [
          {
            id: "trig_task",
            kind: "trigger",
            triggerKind: "task",
            label: "Task moves to Review",
            position: { x: 40, y: 120 },
            config: { event: "status_changed", toStatus: "review" },
          },
          {
            id: "cond_has_result",
            kind: "condition",
            label: "Status is review",
            position: { x: 350, y: 120 },
            config: { match: "all", rules: [{ field: "to", op: "equals", value: "review" }] },
          },
          {
            id: "agent_review",
            kind: "agent",
            label: `Ask ${botName} to inspect`,
            position: { x: 660, y: 80 },
            config: {
              botId,
              outputKey: "agent_reply",
              prompt: "Task “{{title}}” (by {{bot}}) moved from {{from}} to {{to}}.\n\nResult:\n{{result}}\n\nSummarize what changed, note any blockers or PR link, and recommend whether to mark Done.",
            },
          },
          {
            id: "out_chat",
            kind: "output",
            label: "Post to chat",
            position: { x: 970, y: 80 },
            config: {
              destination: "chat",
              botId,
              template: "**Ready for review:** {{title}}\n\n{{agent_reply}}",
            },
          },
        ],
        edges: [
          { id: "e1", from: "trig_task", to: "cond_has_result", branch: "default" },
          { id: "e2", from: "cond_has_result", to: "agent_review", branch: "yes" },
          { id: "e3", from: "agent_review", to: "out_chat", branch: "default" },
        ],
      }),
    },
    {
      id: "approval-gate",
      name: "PR Check → Approval → Notify",
      description: "Watch GitHub PR events across repos, ask for human approval, and post back to GitHub or chat.",
      build: () => ({
        name: "PR approval gate",
        description: "Watches PR changes via GitHub, asks for approval, and posts the outcome.",
        nodes: [
          {
            id: "trig_gh",
            kind: "trigger",
            triggerKind: "github",
            label: "GitHub PR activity",
            position: { x: 40, y: 120 },
            config: {
              repos: ["owner/repo"],
              repo: "owner/repo",
              events: ["pr.opened", "pr.reviewSubmitted", "pr.checksFailed"],
              notBot: true,
              pollMinutes: 5,
            },
          },
          {
            id: "model_triage",
            kind: "model",
            label: "Summarize PR risk",
            position: { x: 350, y: 120 },
            config: {
              prompt: "PR #{{number}} ({{title}}) by {{author}} in {{repository}} has state {{state}}. Assess risk briefly.",
              outputFields: [
                { name: "risk", type: "string", choices: ["low", "medium", "high"] },
                { name: "summary", type: "string" },
              ],
            },
          },
          {
            id: "approve_ship",
            kind: "approval",
            label: "Approve announcement?",
            position: { x: 660, y: 120 },
            config: { message: "PR #{{number}} ({{title}}) — risk: {{risk}}. {{summary}}\n\nPost to chat?", noteField: "note" },
          },
          {
            id: "out_approved",
            kind: "output",
            label: "Post update",
            position: { x: 970, y: 60 },
            config: { destination: "chat", botId, template: "Approved PR #{{number}}: {{title}} ({{url}})\n{{summary}}" },
          },
        ],
        edges: [
          { id: "e1", from: "trig_gh", to: "model_triage", branch: "default" },
          { id: "e2", from: "model_triage", to: "approve_ship", branch: "default" },
          { id: "e3", from: "approve_ship", to: "out_approved", branch: "approved" },
        ],
      }),
    },
    {
      id: "schedule-digest",
      name: "Scheduled Morning Brief → Feed",
      description: "Run on a weekday schedule, synthesize with a bot, and publish straight to Today’s Feed.",
      build: () => ({
        name: "Weekday morning brief",
        description: "Posts a concise morning brief to Today’s Feed every weekday at 8:30 AM.",
        nodes: [
          {
            id: "trig_sched",
            kind: "trigger",
            triggerKind: "schedule",
            label: "Weekdays at 8:30 AM",
            position: { x: 40, y: 120 },
            config: { cadence: "weekdays", time: "08:30", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          },
          {
            id: "agent_brief",
            kind: "agent",
            label: `${botName} prepares brief`,
            position: { x: 360, y: 120 },
            config: {
              botId,
              outputKey: "brief",
              prompt: "Today is {{weekday}}, {{local_date}}. Write a sharp 4-bullet focus brief for the day.",
            },
          },
          {
            id: "out_feed",
            kind: "output",
            label: "Publish to Feed",
            position: { x: 680, y: 120 },
            config: { destination: "feed", title: "Morning brief · {{local_date}}", template: "{{brief}}" },
          },
        ],
        edges: [
          { id: "e1", from: "trig_sched", to: "agent_brief", branch: "default" },
          { id: "e2", from: "agent_brief", to: "out_feed", branch: "default" },
        ],
      }),
    },
  ];
}

function defaultNode(kind: WorkflowNodeKind, triggerKind: WorkflowTriggerKind | undefined, existing: WorkflowNode[], bots: Bot[]): WorkflowNode {
  const maxX = existing.reduce((m, n) => Math.max(m, n.position.x), 40);
  const pos = existing.length === 0 ? { x: 40, y: 120 } : { x: maxX + 310, y: 120 };
  const botId = bots[0]?.id;
  if (kind === "trigger") {
    const tk = triggerKind ?? "task";
    return {
      id: makeId("trig"),
      kind: "trigger",
      triggerKind: tk,
      label: tk === "task" ? "Task trigger" : tk === "schedule" ? "Schedule" : `${tk[0].toUpperCase()}${tk.slice(1)} trigger`,
      position: { x: 40, y: 120 + existing.filter((n) => n.kind === "trigger").length * 160 },
      config:
        tk === "task"
          ? { event: "status_changed", toStatus: "review" }
          : tk === "schedule"
            ? { cadence: "daily", time: "09:00" }
            : tk === "github"
              ? { repos: [], events: ["issue.opened"], notBot: true, pollMinutes: 5 }
              : {},
    };
  }
  if (kind === "agent") {
    return { id: makeId("agent"), kind, label: "Agent step", position: pos, config: { botId, prompt: "", outputKey: "agent_reply" } };
  }
  if (kind === "model") {
    return { id: makeId("model"), kind, label: "Model step", position: pos, config: { prompt: "", outputFields: [] } };
  }
  if (kind === "condition") {
    return { id: makeId("cond"), kind, label: "Condition", position: pos, config: { match: "all", rules: [{ field: "to", op: "equals", value: "review" }] } };
  }
  if (kind === "approval") {
    return { id: makeId("approve"), kind, label: "Approval", position: pos, config: { message: "Approve continuing this workflow?", noteField: "approval_note" } };
  }
  return { id: makeId("out"), kind: "output", label: "Output", position: pos, config: { destination: "chat", botId, template: "{{agent_reply}}" } };
}

export function WorkflowsView({
  state,
  fail,
  webhookPort,
}: {
  state: State;
  fail: (err: unknown) => void;
  webhookPort?: number | null;
}) {
  const workflows = state.workflows ?? [];
  const allRuns = state.workflowRuns ?? [];
  const [activeId, setActiveId] = useState<string | null>(() => workflows[0]?.id ?? null);
  const [draft, setDraft] = useState<Workflow | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"step" | "runs">("step");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastServerUpdatedRef = useRef<number>(0);

  useEffect(() => {
    let live = true;
    api.models?.()
      .then((list) => {
        if (live) setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const serverWorkflow = useMemo(() => workflows.find((w) => w.id === activeId) ?? null, [workflows, activeId]);

  // Sync draft when switching workflows or when an agent/remote edits the workflow live.
  useEffect(() => {
    if (!serverWorkflow) {
      setDraft(null);
      return;
    }
    if (!draft || draft.id !== serverWorkflow.id) {
      setDraft(structuredClone(serverWorkflow));
      setSelectedNodeId(serverWorkflow.nodes[0]?.id ?? null);
      setSelectedEdgeId(null);
      setSelectedRunId(null);
      dirtyRef.current = false;
      lastServerUpdatedRef.current = serverWorkflow.updatedAt;
      return;
    }
    if (!dirtyRef.current && serverWorkflow.updatedAt !== lastServerUpdatedRef.current) {
      setDraft(structuredClone(serverWorkflow));
      lastServerUpdatedRef.current = serverWorkflow.updatedAt;
    }
  }, [serverWorkflow]); // eslint-disable-line react-hooks/exhaustive-deps

  const runs = useMemo(
    () => (activeId ? allRuns.filter((r) => r.workflowId === activeId) : []),
    [allRuns, activeId],
  );
  const activeRun = useMemo(() => {
    if (selectedRunId) return runs.find((r) => r.id === selectedRunId) ?? null;
    return runs[0] ?? null;
  }, [runs, selectedRunId]);

  const analysis = useMemo(() => (draft ? analyzeWorkflowFields(draft) : {}), [draft]);

  const persistDraft = useCallback(
    (next: Workflow, immediate = false) => {
      dirtyRef.current = true;
      setDraft(next);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const runSave = async () => {
        setSaving(true);
        try {
          const saved = await api.workflowUpdate(next.id, {
            name: next.name,
            description: next.description,
            nodes: next.nodes,
            edges: next.edges,
          });
          lastServerUpdatedRef.current = saved.updatedAt;
          dirtyRef.current = false;
        } catch (err) {
          fail(err);
        } finally {
          setSaving(false);
        }
      };
      if (immediate) void runSave();
      else saveTimerRef.current = setTimeout(() => void runSave(), 400);
    },
    [fail],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const flash = (tone: "ok" | "err", text: string) => {
    setNotice({ tone, text });
    setTimeout(() => setNotice((cur) => (cur?.text === text ? null : cur)), 4500);
  };

  const handleCreate = async (spec?: { name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => {
    try {
      const payload =
        spec ?? {
          name: "Untitled workflow",
          description: "",
          nodes: [
            defaultNode("trigger", "task", [], state.bots),
            defaultNode("agent", undefined, [{ id: "tmp", kind: "trigger", label: "", position: { x: 40, y: 120 }, config: {} }], state.bots),
          ],
          edges: [] as WorkflowEdge[],
        };
      if (!spec && payload.nodes.length === 2) {
        payload.edges = [{ id: makeId("e"), from: payload.nodes[0].id, to: payload.nodes[1].id, branch: "default" }];
      }
      const created = await api.workflowCreate({ ...payload, enabled: true });
      setActiveId(created.id);
      setDraft(structuredClone(created));
      setSelectedNodeId(created.nodes[0]?.id ?? null);
      setInspectorTab("step");
      flash("ok", `Created “${created.name}”`);
    } catch (err) {
      fail(err);
    }
  };

  const handleImport = async () => {
    try {
      const res = await api.workflowImport();
      if (!res) return;
      if (res.workflow) {
        setActiveId(res.workflow.id);
        setDraft(structuredClone(res.workflow));
        setSelectedNodeId(res.workflow.nodes[0]?.id ?? null);
        const missing = res.unresolvedAgents?.length ? ` (${res.unresolvedAgents.length} agent(s) need reassigning)` : "";
        flash("ok", `Imported “${res.workflow.name}” (starts paused)${missing}`);
      }
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    }
  };

  const handleExport = async () => {
    if (!draft) return;
    try {
      const saved = await api.workflowExport(draft.id);
      if (saved) flash("ok", "Exported portable workflow JSON (no secrets)");
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    }
  };

  const handlePauseToggle = async (wf: Workflow) => {
    try {
      const updated = wf.enabled ? await api.workflowPause(wf.id) : await api.workflowResume(wf.id);
      if (draft && draft.id === wf.id) {
        setDraft((cur) => (cur ? { ...cur, enabled: updated.enabled, updatedAt: updated.updatedAt } : cur));
        lastServerUpdatedRef.current = updated.updatedAt;
      }
    } catch (err) {
      fail(err);
    }
  };

  const handleRunNow = async () => {
    if (!draft) return;
    try {
      const run = await api.workflowRun(draft.id);
      setSelectedRunId(run.id);
      setInspectorTab("runs");
    } catch (err) {
      fail(err);
    }
  };

  const handleDelete = async (wf: Workflow) => {
    try {
      await api.workflowDelete(wf.id);
      if (activeId === wf.id) {
        const remaining = workflows.filter((w) => w.id !== wf.id);
        setActiveId(remaining[0]?.id ?? null);
        setDraft(null);
      }
    } catch (err) {
      fail(err);
    }
  };

  const handleMoveNode = useCallback(
    (nodeId: string, pos: { x: number; y: number }) => {
      if (!draft) return;
      const next: Workflow = {
        ...draft,
        nodes: draft.nodes.map((n) => (n.id === nodeId ? { ...n, position: pos } : n)),
      };
      persistDraft(next);
    },
    [draft, persistDraft],
  );

  const handleConnect = useCallback(
    (from: string, to: string, branch: string) => {
      if (!draft || from === to) return;
      if (draft.edges.some((e) => e.from === from && e.to === to && (e.branch || "default") === branch)) return;
      const next: Workflow = {
        ...draft,
        edges: [...draft.edges, { id: makeId("e"), from, to, branch }],
      };
      persistDraft(next, true);
    },
    [draft, persistDraft],
  );

  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      if (!draft) return;
      persistDraft({ ...draft, edges: draft.edges.filter((e) => e.id !== edgeId) }, true);
      setSelectedEdgeId(null);
    },
    [draft, persistDraft],
  );

  const handleAddNode = useCallback(
    (kind: WorkflowNodeKind, triggerKind?: WorkflowTriggerKind) => {
      if (!draft) return;
      const node = defaultNode(kind, triggerKind, draft.nodes, state.bots);
      const edges = [...draft.edges];
      // Auto-connect from currently selected node if it can output and isn't a trigger target.
      if (kind !== "trigger" && selectedNodeId) {
        const prev = draft.nodes.find((n) => n.id === selectedNodeId);
        if (prev && prev.kind !== "output") {
          const branch = prev.kind === "condition" ? "yes" : prev.kind === "approval" ? "approved" : "default";
          edges.push({ id: makeId("e"), from: prev.id, to: node.id, branch });
        }
      }
      persistDraft({ ...draft, nodes: [...draft.nodes, node], edges }, true);
      setSelectedNodeId(node.id);
      setInspectorTab("step");
    },
    [draft, state.bots, selectedNodeId, persistDraft],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      if (!draft) return;
      const nextNodes = draft.nodes.filter((n) => n.id !== nodeId);
      const nextEdges = draft.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
      persistDraft({ ...draft, nodes: nextNodes, edges: nextEdges }, true);
      setSelectedNodeId(nextNodes[0]?.id ?? null);
    },
    [draft, persistDraft],
  );

  const handleAutoLayout = useCallback(() => {
    if (!draft) return;
    // Left-to-right topological layout
    const depth = new Map<string, number>();
    const triggers = draft.nodes.filter((n) => n.kind === "trigger");
    const queue = triggers.map((t) => t.id);
    for (const t of triggers) depth.set(t.id, 0);
    while (queue.length) {
      const cur = queue.shift()!;
      const d = depth.get(cur) ?? 0;
      for (const e of draft.edges) {
        if (e.from !== cur) continue;
        if ((depth.get(e.to) ?? -1) < d + 1) {
          depth.set(e.to, d + 1);
          queue.push(e.to);
        }
      }
    }
    const cols = new Map<number, WorkflowNode[]>();
    for (const n of draft.nodes) {
      const col = depth.get(n.id) ?? 0;
      if (!cols.has(col)) cols.set(col, []);
      cols.get(col)!.push(n);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [col, list] of cols.entries()) {
      list.forEach((n, idx) => {
        positions.set(n.id, { x: 48 + col * 312, y: 72 + idx * 176 });
      });
    }
    persistDraft(
      {
        ...draft,
        nodes: draft.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })),
      },
      true,
    );
  }, [draft, persistDraft]);

  const templates = useMemo(() => starterTemplates(state.bots), [state.bots]);
  const selectedNode = draft?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  /* ------------------------------------------------ Empty / List View */
  if (!draft) {
    return (
      <div className="wf-empty-shell">
        {notice && <div className={`wf-toast wf-toast-${notice.tone}`}>{notice.text}</div>}

        <div className="wf-empty-actions">
          <button type="button" className="btn" onClick={handleImport}>
            <Upload size={14} aria-hidden="true" /> Import JSON
          </button>
          <button type="button" className="btn primary" onClick={() => handleCreate()}>
            <Plus size={14} aria-hidden="true" /> New workflow
          </button>
        </div>

        {workflows.length > 0 && (
          <section className="page-section" aria-label="Workflows">
            <h2 className="group-label">Workflows · {workflows.length}</h2>
            <div className="group">
              {workflows.map((wf) => {
                const latest = allRuns.find((r) => r.workflowId === wf.id);
                return (
                  <div key={wf.id} className="group-row wf-list-row">
                    <button type="button" className="wf-list-open" onClick={() => setActiveId(wf.id)}>
                      <span className="icon-tile tide" aria-hidden="true">
                        <WorkflowIcon size={15} />
                      </span>
                      <span className="row-main">
                        <span className="row-title wf-list-title">
                          {wf.name}
                          <span className={"wf-state-pill " + (wf.enabled ? "active" : "paused")}>
                            {wf.enabled ? "Active" : "Paused"}
                          </span>
                        </span>
                        <span className="row-sub">
                          {wf.description || `${wf.nodes.length} steps · ${wf.edges.length} connections`}
                          {latest ? ` · Last run: ${latest.status}` : ""}
                        </span>
                      </span>
                    </button>
                    <div className="wf-list-card-actions">
                      <button type="button" className="btn soft small" onClick={() => handlePauseToggle(wf)}>
                        {wf.enabled ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                        {wf.enabled ? "Pause" : "Resume"}
                      </button>
                      <button type="button" className="icon-btn danger" onClick={() => handleDelete(wf)} aria-label="Delete workflow" title="Delete workflow">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="page-section wf-templates" aria-label="Starter workflows">
          <h2 className="group-label">
            <Sparkles size={13} aria-hidden="true" /> Starter workflows
          </h2>
          <div className="wf-template-grid">
            {templates.map((tpl) => (
              <button key={tpl.id} type="button" className="wf-template-card" onClick={() => handleCreate(tpl.build())}>
                <strong>{tpl.name}</strong>
                <span>{tpl.description}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  /* ------------------------------------------------ Canvas Editor Workspace */
  return (
    <div className="wf-workspace">
      {notice && <div className={`wf-toast wf-toast-${notice.tone}`}>{notice.text}</div>}

      {/* Top editor bar */}
      <div className="wf-topbar">
        <div className="wf-topbar-left">
          <button type="button" className="icon-btn" onClick={() => { setActiveId(null); setDraft(null); }} title="All workflows" aria-label="All workflows">
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
          {workflows.length > 1 && (
            <select
              className="wf-switcher"
              aria-label="Switch workflow"
              value={draft.id}
              onChange={(e) => setActiveId(e.target.value)}
            >
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} {w.enabled ? "" : "(Paused)"}
                </option>
              ))}
            </select>
          )}
          <input
            className="wf-name-input"
            aria-label="Workflow name"
            value={draft.name}
            onChange={(e) => persistDraft({ ...draft, name: e.target.value })}
          />
          <span className={"wf-state-pill " + (draft.enabled ? "active" : "paused")}>
            {draft.enabled ? "Active" : "Paused"}
          </span>
          {saving && <span className="wf-saving">Saving…</span>}
        </div>

        <div className="wf-topbar-right">
          <button type="button" className="btn small" onClick={handleImport} title="Import workflow JSON">
            <Upload size={13} aria-hidden="true" /> Import
          </button>
          <button type="button" className="btn small" onClick={handleExport} title="Export portable JSON (no secrets)">
            <Download size={13} aria-hidden="true" /> Export
          </button>
          <button type="button" className="btn soft small" onClick={() => handlePauseToggle(draft)}>
            {draft.enabled ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {draft.enabled ? "Pause" : "Resume"}
          </button>
          <button type="button" className="btn primary small" onClick={handleRunNow}>
            <Play size={13} aria-hidden="true" /> Run now
          </button>
          <button type="button" className="icon-btn" onClick={() => handleCreate()} title="New workflow" aria-label="New workflow">
            <Plus size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn danger" onClick={() => handleDelete(draft)} title="Delete workflow" aria-label="Delete workflow">
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Main split: Canvas + Inspector */}
      <div className="wf-split">
        <WorkflowCanvas
          workflow={draft}
          bots={state.bots}
          analysis={analysis}
          activeRun={activeRun}
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
          onSelectNode={(id) => {
            setSelectedNodeId(id);
            if (id) setInspectorTab("step");
          }}
          onSelectEdge={setSelectedEdgeId}
          onMoveNode={handleMoveNode}
          onConnect={handleConnect}
          onDeleteEdge={handleDeleteEdge}
          onAddNode={handleAddNode}
          onDeleteNode={handleDeleteNode}
          onAutoLayout={handleAutoLayout}
          onResume={() => handlePauseToggle(draft)}
        />

        <WorkflowInspector
          workflow={draft}
          node={selectedNode}
          analysis={selectedNode ? analysis[selectedNode.id] : undefined}
          bots={state.bots}
          chats={state.chats}
          models={models}
          runs={runs}
          selectedRunId={activeRun?.id ?? null}
          isOwner={!memberTeam(state) && state.remote?.using?.member !== true}
          tab={inspectorTab}
          onTab={setInspectorTab}
          onSelectRun={setSelectedRunId}
          onChangeNode={(nodeId, updater) => {
            persistDraft({
              ...draft,
              nodes: draft.nodes.map((n) => (n.id === nodeId ? updater(n) : n)),
            });
          }}
          onRetryRun={async (runId, nodeId, options) => {
            try {
              const r = options?.allowUncertainRetry
                ? await api.workflowRetryRun(runId, nodeId ?? null, { allowUncertainRetry: true })
                : await api.workflowRetryRun(runId, nodeId);
              setSelectedRunId(r.id);
            } catch (err) {
              fail(err);
            }
          }}
          onRespondApproval={async (runId, nodeId, decision, note) => {
            try {
              const r = await api.workflowRespondApproval(runId, nodeId, decision, note);
              setSelectedRunId(r.id);
            } catch (err) {
              fail(err);
            }
          }}
          onCancelRun={async (runId) => {
            try {
              await api.workflowCancelRun(runId);
            } catch (err) {
              fail(err);
            }
          }}
          onReplayLastGithubEvent={async (nodeId) => {
            try {
              const r = await api.workflowGithubReplayLast(draft.id, nodeId);
              setSelectedRunId(r.id);
              setInspectorTab("runs");
              flash("ok", "Replayed latest GitHub event");
            } catch (err) {
              fail(err);
            }
          }}
          webhookPort={webhookPort}
        />
      </div>
    </div>
  );
}
