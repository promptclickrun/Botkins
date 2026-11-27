// Quiet hairline cards for bot-to-bot messages (incoming, grouped outgoing asks,
// grouped task handoffs, and folded node calls). Matches the phone's AgentMessageRail.
import { useId, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bot as BotIcon,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Globe,
  X as XIcon,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import { StepList, useNow } from "./ChatActivity";
import { RichText } from "./RichText";
import type { ChatFiles } from "./ChatFileLink";
import {
  askRowSummary,
  buildIncomingRail,
  buildOutgoingRail,
  buildTaskHandoffGroup,
  formatCompactElapsed,
  groupAsks,
  type AskGroupModel,
  type NodeCallGroupModel,
  type TaskHandoffGroupModel,
  type TaskHandoffRailModel,
} from "./agentRailModel";
import type { Bot, BotTask, Message, Run, TeamAsk } from "./types";
import "./agent-rail.css";

function clock(time?: number): string {
  if (!time) return "";
  try {
    return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function RailFace({ bot, size = 18, remote }: { bot?: Bot; size?: number; remote?: boolean }) {
  if (bot) {
    return (
      <span className="agent-rail-face" aria-hidden="true">
        <BotAvatar bot={bot} size={size} animated={false} />
      </span>
    );
  }
  return (
    <span className="agent-rail-face neutral" aria-hidden="true" style={{ width: size, height: size }}>
      {remote ? <Globe size={Math.round(size * 0.62)} /> : <BotIcon size={Math.round(size * 0.62)} />}
    </span>
  );
}

/**
 * Recipient-side card: quiet hairline card for an incoming bot-to-bot message
 * (task handoff, remote dispatch, or teamwork). No colored left rail and no channel pills.
 */
export function IncomingAgentRail({
  message,
  bots,
  accessibleChatIds,
  openChat,
  files,
  id,
}: {
  message: Message;
  bots: Bot[];
  accessibleChatIds?: ReadonlySet<string>;
  openChat?: (chatId: string) => void;
  files?: ChatFiles;
  id?: string;
}) {
  const model = buildIncomingRail(message, { bots, accessibleChatIds });
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  if (!model) return null;

  const senderBot = bots.find((b) => b.id === model.senderBotId);
  const stamp = clock(model.time);
  const canOpenSource = !!(model.sourceChatId && openChat);
  const metaParts = [model.viaLabel, stamp].filter(Boolean).join(" · ");

  return (
    <article
      id={id}
      className={`agent-rail agent-rail-incoming via-${model.via}${expanded ? " expanded" : ""}`}
      aria-label={model.ariaLabel}
    >
      <div className="agent-rail-head">
        <RailFace bot={senderBot} size={18} remote={model.via === "remote"} />
        <div className="agent-rail-identity">
          <span className="agent-rail-who">
            <span className="agent-rail-dir">from</span>{" "}
            <strong className="agent-rail-name">{model.senderName}</strong>
          </span>
          {metaParts && <span className="agent-rail-meta">· {metaParts}</span>}
        </div>
        {canOpenSource && (
          <button
            type="button"
            className="agent-rail-link"
            onClick={() => openChat!(model.sourceChatId!)}
            aria-label={`Open chat with ${model.senderName}`}
          >
            <span>Source chat</span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {model.taskTitle && <div className="agent-rail-title">{model.taskTitle}</div>}

      <div id={bodyId} className="agent-rail-body">
        {model.collapsible && !expanded ? (
          <p className="agent-rail-preview">{model.preview}</p>
        ) : (
          <RichText text={model.body} files={files} />
        )}
      </div>

      {model.collapsible && (
        <div className="agent-rail-foot">
          <button
            type="button"
            className="agent-rail-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            <span>{expanded ? "Show less" : "Show full message"}</span>
          </button>
        </div>
      )}
    </article>
  );
}

/** One compact expandable ask row inside a grouped card. */
function AskRow({ ask, bots }: { ask: TeamAsk; bots: Bot[] }) {
  const model = useMemo(() => buildOutgoingRail(ask, bots), [ask, bots]);
  const [expanded, setExpanded] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const detailId = useId();
  const now = useNow(model.live);
  const targetBot = ask.remote ? undefined : bots.find((b) => b.id === ask.botId);
  const took = model.durationMs ?? (model.live ? Math.max(0, now - ask.started) : undefined);
  const summary = askRowSummary(model);
  const steps = ask.steps ?? [];

  return (
    <div className={`agent-rail-row status-${model.status}${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="agent-rail-row-btn"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={model.ariaLabel}
        onClick={() => setExpanded((v) => !v)}
      >
        <RailFace bot={targetBot} size={18} remote={model.via === "remote"} />
        <strong className="agent-rail-name">{model.targetName}</strong>
        <span className="agent-rail-row-summary">{summary}</span>
        <span className="agent-rail-row-trail">
          {model.status === "answered" ? (
            <Check size={14} className="agent-rail-check" aria-hidden="true" />
          ) : model.status === "failed" ? (
            <XIcon size={14} className="agent-rail-fail" aria-hidden="true" />
          ) : model.status === "stopped" ? (
            <span className="agent-rail-muted-tag">stopped</span>
          ) : (
            <span className="agent-rail-live-time">{formatCompactElapsed(took ?? 0)}</span>
          )}
        </span>
      </button>

      {expanded && (
        <div id={detailId} className="agent-rail-row-body">
          <p className="agent-rail-text">{model.message}</p>
          {model.expecting && (
            <p className="agent-rail-expect">
              <strong>Needs:</strong> {model.expecting}
            </p>
          )}
          {model.reply && (
            <div className="agent-rail-reply-body">
              <RichText text={model.reply} />
            </div>
          )}
          {model.error && (
            <p className="agent-rail-error" role="status">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{model.error}</span>
            </p>
          )}
          {steps.length > 0 && (
            <div className="agent-rail-steps">
              <button
                type="button"
                className="agent-rail-toggle inline"
                aria-expanded={stepsOpen}
                onClick={() => setStepsOpen((v) => !v)}
              >
                {stepsOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                <span>
                  {steps.length} {steps.length === 1 ? "tool step" : "tool steps"}
                </span>
              </button>
              {stepsOpen && (
                <div className="tool-trail work-done team-steps">
                  <StepList steps={steps} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One quiet hairline card holding consecutive teammate/remote asks as 1-line expandable rows. */
function AskGroupCard({ group, bots }: { group: AskGroupModel; bots: Bot[] }) {
  return (
    <article className="agent-rail-group" aria-label={group.header}>
      <div className="agent-rail-group-head">
        {group.live && <span className="agent-rail-dot" aria-hidden="true" />}
        <span className="agent-rail-group-title">{group.header}</span>
      </div>
      <div className="agent-rail-rows">
        {group.asks.map((ask) => (
          <AskRow key={ask.id} ask={ask} bots={bots} />
        ))}
      </div>
    </article>
  );
}

/** One compact expandable task handoff row inside a grouped handoff card. */
function TaskHandoffRow({
  model,
  bots,
  openChat,
}: {
  model: TaskHandoffRailModel;
  bots: Bot[];
  openChat?: (chatId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const targetBot = bots.find((b) => b.id === model.targetBotId);
  const done = model.status === "done" || model.status === "review";

  return (
    <div className={`agent-rail-row status-${model.status}${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="agent-rail-row-btn"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={model.ariaLabel}
        onClick={() => setExpanded((v) => !v)}
      >
        <RailFace bot={targetBot} size={18} />
        <strong className="agent-rail-name">{model.targetName}</strong>
        <span className="agent-rail-row-summary">{model.title}</span>
        <span className="agent-rail-row-trail">
          {done ? (
            <Check size={14} className="agent-rail-check" aria-hidden="true" />
          ) : model.status === "blocked" ? (
            <XIcon size={14} className="agent-rail-fail" aria-hidden="true" />
          ) : (
            <span className={model.live ? "agent-rail-live-time" : "agent-rail-muted-tag"}>
              {model.statusLabel.toLowerCase()}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div id={detailId} className="agent-rail-row-body">
          <div className="agent-rail-head">
            <span className="agent-rail-title">{model.title}</span>
            {model.taskChatId && openChat && (
              <button
                type="button"
                className="agent-rail-link"
                onClick={() => openChat(model.taskChatId!)}
                aria-label={`Open task chat: ${model.title}`}
              >
                <span>Open task</span>
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          {model.details && (
            <div className="agent-rail-subblock">
              <small className="agent-rail-sublabel">Task brief</small>
              <RichText text={model.details} />
            </div>
          )}
          {model.result && (
            <div className="agent-rail-reply-body">
              <RichText text={model.result} />
            </div>
          )}
          {model.problem && (
            <p className="agent-rail-error" role="status">
              <CircleAlert size={14} aria-hidden="true" />
              <span>{model.problem}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One quiet hairline card grouping bot-to-bot Task Board handoffs for a turn. */
function TaskHandoffGroupCard({
  group,
  bots,
  openChat,
}: {
  group: TaskHandoffGroupModel;
  bots: Bot[];
  openChat?: (chatId: string) => void;
}) {
  return (
    <article className="agent-rail-group" aria-label={group.header}>
      <div className="agent-rail-group-head">
        {group.live && <span className="agent-rail-dot" aria-hidden="true" />}
        <span className="agent-rail-group-title">{group.header}</span>
      </div>
      <div className="agent-rail-rows">
        {group.items.map((model) => (
          <TaskHandoffRow key={model.id} model={model} bots={bots} openChat={openChat} />
        ))}
      </div>
    </article>
  );
}

/** Back-to-back node calls folded into one quiet hairline card; open it to inspect each call row. */
function NodeCallGroupCard({ group, bots }: { group: NodeCallGroupModel; bots: Bot[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <article className={`agent-rail-group agent-rail-node-group${open ? " open" : ""}`} aria-label={group.ariaLabel}>
      <button
        type="button"
        className="agent-rail-row-btn"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={13} className="agent-rail-chev" aria-hidden="true" /> : <ChevronRight size={13} className="agent-rail-chev" aria-hidden="true" />}
        <RailFace size={18} remote />
        <strong className="agent-rail-name">{group.title}</strong>
        {!open && <span className="agent-rail-row-summary">{group.summary.replace(/\s+/g, " ").trim()}</span>}
        <span className="agent-rail-row-trail">
          {group.live ? (
            <span className="agent-rail-live-time">{group.running} running</span>
          ) : group.failed ? (
            <span className="agent-rail-fail-text">{group.failed} failed</span>
          ) : (
            <Check size={14} className="agent-rail-check" aria-hidden="true" />
          )}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="agent-rail-rows">
          {group.asks.map((ask) => (
            <AskRow key={ask.id} ask={ask} bots={bots} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Renders all sender-side quiet grouped agent cards for a turn (outgoing teamwork/remote asks,
 * folded node calls, and bot-to-bot Task Board handoffs).
 */
export function AgentMessageRail({
  run,
  bots,
  tasks,
  openChat,
}: {
  run: Run;
  bots: Bot[];
  tasks?: BotTask[];
  openChat?: (chatId: string) => void;
}) {
  const asks = run.teamwork ?? [];
  const handoffs = run.taskHandoffs ?? [];
  const groupedAsks = useMemo(() => groupAsks(asks, bots), [asks, bots]);
  const handoffGroup = useMemo(() => buildTaskHandoffGroup(handoffs, { bots, tasks }), [handoffs, bots, tasks]);
  if (!groupedAsks.length && !handoffGroup) return null;

  return (
    <section className="agent-rail-stack" aria-label="Agent messages">
      {groupedAsks.map((item) =>
        item.kind === "ask-group" ? (
          <AskGroupCard key={item.id} group={item} bots={bots} />
        ) : (
          <NodeCallGroupCard key={item.id} group={item} bots={bots} />
        ),
      )}
      {handoffGroup && <TaskHandoffGroupCard group={handoffGroup} bots={bots} openChat={openChat} />}
    </section>
  );
}
