// Interactive OpenBot-style node canvas for Botkins Workflows.
// Supports pan/zoom, dragging nodes, dragging port-to-port edges, live step status/timers,
// field-chip previews, warning indicators, and live updates when bots edit workflows via tools.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot as BotIcon,
  CalendarClock,
  CheckCircle2,
  Clock,
  GitBranch,
  GitPullRequest,
  Globe,
  Hand,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minus,
  PauseCircle,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
  ClipboardCheck,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import type {
  Bot,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowTriggerKind,
} from "./types";
import type { NodeFieldAnalysis } from "./workflowAnalysis";
import { parseTemplateTokens } from "./workflowAnalysis";

const NODE_W = 248;
const NODE_H_DEFAULT = 116;

interface Props {
  workflow: Workflow;
  bots: Bot[];
  analysis: Record<string, NodeFieldAnalysis>;
  activeRun: WorkflowRun | null;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onMoveNode: (id: string, pos: { x: number; y: number }) => void;
  onConnect: (from: string, to: string, branch: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onAddNode: (kind: WorkflowNodeKind, triggerKind?: WorkflowTriggerKind) => void;
  onDeleteNode: (nodeId: string) => void;
  onAutoLayout: () => void;
  onResume: () => void;
}

function triggerMeta(kind?: WorkflowTriggerKind) {
  switch (kind) {
    case "task":
      return { label: "Task Board", icon: ClipboardCheck };
    case "schedule":
      return { label: "Schedule", icon: CalendarClock };
    case "manual":
      return { label: "Manual", icon: Hand };
    case "routine":
      return { label: "Routine", icon: Clock };
    case "chat":
      return { label: "Chat message", icon: MessageSquare };
    case "webhook":
      return { label: "Webhook", icon: Globe };
    case "github":
      return { label: "GitHub", icon: GitPullRequest };
    default:
      return { label: "Trigger", icon: Zap };
  }
}

function nodePorts(node: WorkflowNode): Array<{ branch: string; label: string; yOffset: number; tone?: string }> {
  if (node.kind === "condition") {
    return [
      { branch: "yes", label: "Yes", yOffset: 44, tone: "ok" },
      { branch: "no", label: "No", yOffset: 82, tone: "muted" },
    ];
  }
  if (node.kind === "approval") {
    return [
      { branch: "approved", label: "Approved", yOffset: 44, tone: "ok" },
      { branch: "rejected", label: "Rejected", yOffset: 82, tone: "danger" },
    ];
  }
  if (node.kind === "output") return [];
  return [{ branch: "default", label: "", yOffset: 58 }];
}

function formatDuration(step: WorkflowStepRun | undefined, now: number): string | null {
  if (!step?.startedAt) return null;
  const end = step.finishedAt ?? (step.status === "running" || step.status === "waiting_approval" ? now : null);
  if (!end) return null;
  const ms = Math.max(0, end - step.startedAt);
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/** Renders a short preview string with inline `{{field}}` chips (highlighting warnings). */
function PreviewWithChips({ text, analysis }: { text: string; analysis?: NodeFieldAnalysis }) {
  if (!text) return <span className="wf-node-empty">Not configured yet</span>;
  const clipped = text.length > 110 ? text.slice(0, 108) + "…" : text;
  const tokens = parseTemplateTokens(clipped);
  if (!tokens.length) return <span className="wf-node-preview-text">{clipped}</span>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.start > cursor) parts.push(<span key={`t${i}`}>{clipped.slice(cursor, tok.start)}</span>);
    const problem = analysis?.problems.find((p) => p.field === tok.name);
    parts.push(
      <span
        key={`c${i}`}
        className={"wf-chip wf-chip-mini" + (problem ? " wf-chip-warn" : "")}
        title={problem?.message ?? tok.raw}
      >
        {tok.optional ? `${tok.name}?` : tok.name}
      </span>,
    );
    cursor = tok.end;
  }
  if (cursor < clipped.length) parts.push(<span key="tail">{clipped.slice(cursor)}</span>);
  return <span className="wf-node-preview-text">{parts}</span>;
}

function nodePreview(node: WorkflowNode, bots: Bot[], analysis?: NodeFieldAnalysis) {
  const cfg = node.config ?? {};
  if (node.kind === "trigger") {
    switch (node.triggerKind) {
      case "task": {
        const to = cfg.toStatus ? `→ ${Array.isArray(cfg.toStatus) ? cfg.toStatus.join(", ") : cfg.toStatus}` : "any status";
        const bot = cfg.botId ? bots.find((b) => b.id === cfg.botId)?.name : cfg.botName;
        return (
          <div className="wf-node-meta-lines">
            <span className="wf-pill">{cfg.event === "created" ? "Task created" : `Status ${to}`}</span>
            {bot && <span className="wf-pill muted">{bot}</span>}
          </div>
        );
      }
      case "schedule":
        return <span className="wf-node-preview-text">{cfg.when || cfg.cron || "Daily at 9:00 AM"}</span>;
      case "manual":
        return <span className="wf-node-preview-text">Run on demand{Array.isArray(cfg.inputs) && cfg.inputs.length ? ` · ${cfg.inputs.length} input(s)` : ""}</span>;
      case "routine":
        return <span className="wf-node-preview-text">After routine{cfg.routineName ? ` “${cfg.routineName}”` : ""} finishes</span>;
      case "chat":
        return <span className="wf-node-preview-text">{cfg.mentionOnly ? "When mentioned in chat" : "On chat message"}{cfg.textContains ? ` containing “${cfg.textContains}”` : ""}</span>;
      case "webhook":
        return <span className="wf-node-preview-text">POST /webhooks/{(cfg.routeId || "…").slice(0, 10)}</span>;
      case "github":
        return <span className="wf-node-preview-text">{cfg.repo || "Configure owner/repo"}</span>;
      default:
        return null;
    }
  }
  if (node.kind === "agent") {
    return <PreviewWithChips text={cfg.prompt || ""} analysis={analysis} />;
  }
  if (node.kind === "model") {
    const outCount = Array.isArray(cfg.outputFields) ? cfg.outputFields.length : 0;
    return (
      <>
        <PreviewWithChips text={cfg.prompt || ""} analysis={analysis} />
        {outCount > 0 && <span className="wf-pill muted">{outCount} structured field{outCount > 1 ? "s" : ""}</span>}
      </>
    );
  }
  if (node.kind === "condition") {
    const rules = Array.isArray(cfg.rules) && cfg.rules.length ? cfg.rules : null;
    const summary = rules
      ? rules.map((r: any) => `${r.field || "?"} ${r.op || "="} ${r.value ?? ""}`.trim()).join(cfg.match === "any" ? " OR " : " AND ")
      : cfg.expression || "";
    return summary ? <code className="wf-code-preview">{summary}</code> : <span className="wf-node-empty">Add a rule (no model)</span>;
  }
  if (node.kind === "approval") {
    return <PreviewWithChips text={cfg.message || "Ask person to approve before continuing"} analysis={analysis} />;
  }
  if (node.kind === "output") {
    const destLabel: Record<string, string> = {
      chat: "Post to chat",
      feed: "Today Feed",
      idea: "Today Ideas",
      goal: "Today Goals",
      notification: "Notification",
    };
    return (
      <>
        <span className="wf-pill">{destLabel[cfg.destination || "chat"] || "Output"}</span>
        <PreviewWithChips text={cfg.template || ""} analysis={analysis} />
      </>
    );
  }
  return null;
}

export function WorkflowCanvas({
  workflow,
  bots,
  analysis,
  activeRun,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onConnect,
  onDeleteEdge,
  onAddNode,
  onDeleteNode,
  onAutoLayout,
  onResume,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [zoom, setZoom] = useState(1);
  const [draggingNode, setDraggingNode] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [panning, setPanning] = useState<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [connecting, setConnecting] = useState<{ fromId: string; branch: string; fromX: number; fromY: number; toX: number; toY: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick live duration timers while any step in activeRun is running or waiting.
  const hasActiveStep = useMemo(
    () => !!activeRun && (activeRun.status === "running" || activeRun.status === "waiting_approval"),
    [activeRun],
  );
  useEffect(() => {
    if (!hasActiveStep) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [hasActiveStep]);

  const toCanvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  const fitView = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !workflow.nodes.length) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of workflow.nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_W);
      maxY = Math.max(maxY, n.position.y + NODE_H_DEFAULT + 24);
    }
    const pad = 48;
    const w = Math.max(200, maxX - minX + pad * 2);
    const h = Math.max(200, maxY - minY + pad * 2);
    const nextZoom = Math.min(1.0, Math.max(0.5, Math.min(rect.width / w, rect.height / h)));
    setZoom(Number(nextZoom.toFixed(2)));
    setPan({
      x: Math.round((rect.width - (maxX - minX) * nextZoom) / 2 - minX * nextZoom),
      y: Math.round((rect.height - (maxY - minY) * nextZoom) / 2 - minY * nextZoom - 16),
    });
  }, [workflow.nodes]);

  // Fit whenever switching to a different workflow.
  useEffect(() => {
    const id = requestAnimationFrame(fitView);
    return () => cancelAnimationFrame(id);
  }, [workflow.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (draggingNode) {
        const dx = (e.clientX - draggingNode.startX) / zoom;
        const dy = (e.clientY - draggingNode.startY) / zoom;
        const x = Math.round((draggingNode.origX + dx) / 12) * 12;
        const y = Math.round((draggingNode.origY + dy) / 12) * 12;
        onMoveNode(draggingNode.id, { x, y });
      } else if (panning) {
        setPan({ x: panning.origX + (e.clientX - panning.startX), y: panning.origY + (e.clientY - panning.startY) });
      } else if (connecting) {
        const pt = toCanvasPoint(e.clientX, e.clientY);
        setConnecting((c) => (c ? { ...c, toX: pt.x, toY: pt.y } : null));
      }
    };
    const handleUp = () => {
      setDraggingNode(null);
      setPanning(null);
      setConnecting(null);
    };
    if (draggingNode || panning || connecting) {
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
      return () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
    }
  }, [draggingNode, panning, connecting, zoom, onMoveNode, toCanvasPoint]);

  const nodeById = useMemo(() => new Map(workflow.nodes.map((n) => [n.id, n])), [workflow.nodes]);

  const edgeGeometry = useCallback(
    (edge: WorkflowEdge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return null;
      const ports = nodePorts(from);
      const port = ports.find((p) => p.branch === (edge.branch || "default")) ?? ports[0] ?? { yOffset: 58, label: "" };
      const x1 = from.position.x + NODE_W;
      const y1 = from.position.y + port.yOffset;
      const x2 = to.position.x;
      const y2 = to.position.y + 58;
      const dx = Math.max(56, Math.abs(x2 - x1) * 0.45);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      return { d, mx, my, label: port.label };
    },
    [nodeById],
  );

  const edgeActiveState = (edge: WorkflowEdge) => {
    if (!activeRun) return "idle";
    const src = activeRun.steps[edge.from];
    const dst = activeRun.steps[edge.to];
    if (!src) return "idle";
    if (src.status === "completed") {
      if (src.kind === "condition" && src.branch && edge.branch !== src.branch) return "untaken";
      if (src.kind === "approval" && src.branch && edge.branch !== src.branch) return "untaken";
      if (dst?.status === "running" || dst?.status === "waiting_approval") return "flowing";
      if (dst?.status === "completed") return "taken";
    }
    return "idle";
  };

  return (
    <div className="wf-canvas-shell">
      {/* Add-step palette */}
      <div className="wf-palette" role="toolbar" aria-label="Add workflow step">
        <span className="wf-palette-label">Add step</span>
        <button type="button" className="wf-palette-btn" onClick={() => onAddNode("trigger", "task")} title="Add trigger node">
          <Zap size={13} /> Trigger
        </button>
        <button type="button" className="wf-palette-btn" onClick={() => onAddNode("agent")} title="Hand off to a Botkins bot">
          <BotIcon size={13} /> Agent
        </button>
        <button type="button" className="wf-palette-btn" onClick={() => onAddNode("model")} title="One-shot LLM structured extraction">
          <Sparkles size={13} /> Model
        </button>
        <button type="button" className="wf-palette-btn" onClick={() => onAddNode("condition")} title="Branch on fields without a model">
          <GitBranch size={13} /> Condition
        </button>
        <button type="button" className="wf-palette-btn" onClick={() => onAddNode("approval")} title="Pause and wait for person's approval">
          <ShieldCheck size={13} /> Approval
        </button>
        <button type="button" className="wf-palette-btn" onClick={() => onAddNode("output")} title="Post to chat, Feed, Ideas, Goals, or Notification">
          <Send size={13} /> Output
        </button>
      </div>

      {/* Paused banner */}
      {!workflow.enabled && (
        <div className="wf-paused-banner" role="status">
          <PauseCircle size={15} />
          <span>
            <strong>Paused</strong> — events and schedules won’t fire while paused. Manual runs still work.
          </span>
          <button type="button" className="wf-banner-btn" onClick={onResume}>
            <Play size={12} /> Resume
          </button>
        </div>
      )}

      {/* Interactive viewport */}
      <div
        ref={wrapRef}
        className={"wf-canvas-viewport" + (panning ? " panning" : "")}
        onMouseDown={(e) => {
          if (e.target !== wrapRef.current && !(e.target as HTMLElement).classList.contains("wf-canvas-svg")) return;
          onSelectNode(null);
          onSelectEdge(null);
          setPanning({ startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y });
        }}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            setZoom((z) => Number(Math.min(1.5, Math.max(0.45, z - e.deltaY * 0.0015)).toFixed(2)));
          }
        }}
      >
        <div
          className="wf-canvas-stage"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {/* SVG Edges layer */}
          <svg className="wf-canvas-svg" width={4000} height={3000}>
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            {workflow.edges.map((edge) => {
              const geom = edgeGeometry(edge);
              if (!geom) return null;
              const selected = selectedEdgeId === edge.id;
              const state = edgeActiveState(edge);
              return (
                <g
                  key={edge.id}
                  className={`wf-edge wf-edge-${state}` + (selected ? " selected" : "")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectNode(null);
                    onSelectEdge(edge.id);
                  }}
                >
                  <path d={geom.d} className="wf-edge-hit" />
                  <path d={geom.d} className="wf-edge-path" markerEnd="url(#wf-arrow)" />
                  {geom.label && (() => {
                    const lw = Math.max(40, geom.label.length * 7 + 16);
                    return (
                      <g transform={`translate(${geom.mx}, ${geom.my})`}>
                        <rect x={-lw / 2} y={-10} width={lw} height={20} rx={10} className="wf-edge-label-bg" />
                        <text textAnchor="middle" dominantBaseline="central" className="wf-edge-label">
                          {geom.label}
                        </text>
                      </g>
                    );
                  })()}
                  {selected && (
                    <g
                      transform={`translate(${geom.mx}, ${geom.my + (geom.label ? 20 : 0)})`}
                      className="wf-edge-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteEdge(edge.id);
                      }}
                    >
                      <circle r={10} />
                      <text textAnchor="middle" dominantBaseline="central">
                        ×
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {connecting && (
              <path
                className="wf-edge-draft"
                d={`M ${connecting.fromX} ${connecting.fromY} C ${connecting.fromX + 70} ${connecting.fromY}, ${connecting.toX - 70} ${connecting.toY}, ${connecting.toX} ${connecting.toY}`}
              />
            )}
          </svg>

          {/* Nodes layer */}
          {workflow.nodes.map((node) => {
            const selected = selectedNodeId === node.id;
            const nodeAnalysis = analysis[node.id];
            const warnCount = nodeAnalysis?.problems.length ?? 0;
            const stepRun = activeRun?.steps[node.id];
            const duration = formatDuration(stepRun, now);
            const ports = nodePorts(node);
            const assignedBot = node.config?.botId ? bots.find((b) => b.id === node.config.botId) : undefined;
            const TrigMeta = triggerMeta(node.triggerKind);
            const TrigIcon = TrigMeta.icon;

            return (
              <div
                key={node.id}
                data-node-id={node.id}
                data-node-kind={node.kind}
                className={
                  `wf-node wf-node-${node.kind}` +
                  (selected ? " selected" : "") +
                  (stepRun ? ` wf-step-${stepRun.status}` : "")
                }
                style={{ left: node.position.x, top: node.position.y, width: NODE_W }}
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).closest(".wf-port, .wf-node-del")) return;
                  e.stopPropagation();
                  onSelectEdge(null);
                  onSelectNode(node.id);
                  setDraggingNode({
                    id: node.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: node.position.x,
                    origY: node.position.y,
                  });
                }}
              >
                {/* Input port (every non-trigger node) */}
                {node.kind !== "trigger" && (
                  <button
                    type="button"
                    className={"wf-port wf-port-in" + (connecting && connecting.fromId !== node.id ? " ready" : "")}
                    title="Drop connection here"
                    onMouseUp={(e) => {
                      if (!connecting || connecting.fromId === node.id) return;
                      e.stopPropagation();
                      onConnect(connecting.fromId, node.id, connecting.branch);
                      setConnecting(null);
                    }}
                  />
                )}

                {/* Header */}
                <div className="wf-node-head">
                  <span className={`wf-kind-badge wf-kind-${node.kind}`}>
                    {node.kind === "trigger" && <TrigIcon size={12} />}
                    {node.kind === "agent" && <BotIcon size={12} />}
                    {node.kind === "model" && <Sparkles size={12} />}
                    {node.kind === "condition" && <GitBranch size={12} />}
                    {node.kind === "approval" && <ShieldCheck size={12} />}
                    {node.kind === "output" && (node.config?.destination === "notification" ? <Bell size={12} /> : <Send size={12} />)}
                    <span>{node.kind === "trigger" ? TrigMeta.label : node.kind}</span>
                  </span>

                  <div className="wf-node-head-right">
                    {warnCount > 0 && (
                      <span
                        className="wf-node-warn"
                        title={nodeAnalysis.problems.map((p) => p.message).join("\n")}
                      >
                        <AlertTriangle size={12} />
                      </span>
                    )}
                    {selected && workflow.nodes.length > 1 && (
                      <button
                        type="button"
                        className="wf-node-del"
                        title="Delete step"
                        aria-label={`Delete ${node.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteNode(node.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Title + Bot chip */}
                <div className="wf-node-title-row">
                  {assignedBot && (node.kind === "agent" || node.kind === "output") && (
                    <BotAvatar bot={assignedBot} size={20} />
                  )}
                  <span className="wf-node-title">{node.label}</span>
                </div>

                {/* Body preview */}
                <div className="wf-node-body">{nodePreview(node, bots, nodeAnalysis)}</div>

                {/* Live step status footer */}
                {stepRun && (
                  <div className={`wf-node-status wf-status-${stepRun.status}`}>
                    {stepRun.status === "running" && <LoaderCircle size={12} className="wf-spin" />}
                    {stepRun.status === "completed" && <CheckCircle2 size={12} />}
                    {stepRun.status === "failed" && <XCircle size={12} />}
                    {stepRun.status === "waiting_approval" && <ShieldCheck size={12} />}
                    <span>
                      {stepRun.status === "waiting_approval"
                        ? "Waiting for approval"
                        : stepRun.status === "completed" && stepRun.branch
                          ? `Done · ${stepRun.branch}`
                          : stepRun.status}
                    </span>
                    {duration && <span className="wf-node-timer">{duration}</span>}
                  </div>
                )}

                {/* Output port(s) */}
                {ports.map((port) => (
                  <div
                    key={port.branch}
                    className="wf-port-out-wrap"
                    style={{ top: port.yOffset - 8 }}
                  >
                    {port.label && <span className={`wf-port-tag ${port.tone || ""}`}>{port.label}</span>}
                    <button
                      type="button"
                      className="wf-port wf-port-out"
                      title={port.label ? `Drag to connect (${port.label})` : "Drag to connect to next step"}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const fromX = node.position.x + NODE_W;
                        const fromY = node.position.y + port.yOffset;
                        setConnecting({ fromId: node.id, branch: port.branch, fromX, fromY, toX: fromX + 20, toY: fromY });
                      }}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Zoom & layout controls */}
        <div className="wf-canvas-controls">
          <button type="button" onClick={() => setZoom((z) => Number(Math.max(0.45, z - 0.1).toFixed(2)))} title="Zoom out" aria-label="Zoom out">
            <Minus size={13} />
          </button>
          <span className="wf-zoom-readout">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Number(Math.min(1.5, z + 0.1).toFixed(2)))} title="Zoom in" aria-label="Zoom in">
            <Plus size={13} />
          </button>
          <button type="button" onClick={fitView} title="Fit workflow to view" aria-label="Fit to view">
            <Maximize2 size={13} />
          </button>
          <button type="button" onClick={onAutoLayout} title="Auto-arrange steps" aria-label="Tidy layout">
            <LayoutGrid size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
