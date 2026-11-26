// T3 Code-style vertical accent rail cards for bot-to-bot messages (incoming, outgoing, task handoff).
import { useId, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot as BotIcon,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Globe,
} from "lucide-react";
import { BotAvatar } from "./Avatar";
import { StepList, duration, useNow } from "./ChatActivity";
import { RichText } from "./RichText";
import type { ChatFiles } from "./ChatFileLink";
import {
  buildIncomingRail,
  buildOutgoingRail,
  buildTaskHandoffRail,
  foldPreview,
  type AgentRailTone,
} from "./agentRailModel";
import type { Bot, BotTask, Message, Run, TaskHandoff, TeamAsk } from "./types";
import "./agent-rail.css";

function clock(time?: number): string {
  if (!time) return "";
  try {
    return new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function RailFace({ bot, size = 20, remote }: { bot?: Bot; size?: number; remote?: boolean }) {
  if (bot) {
    return (
      <span className="agent-rail-face" aria-hidden="true">
        <BotAvatar bot={bot} size={size} animated={false} />
      </span>
    );
  }
  return (
    <span className="agent-rail-face neutral" aria-hidden="true" style={{ width: size, height: size }}>
      {remote ? <Globe size={Math.round(size * 0.65)} /> : <BotIcon size={Math.round(size * 0.65)} />}
    </span>
  );
}

function StatusPill({ label, tone, live }: { label: string; tone: AgentRailTone; live?: boolean }) {
  return (
    <span className={`agent-rail-status tone-${tone}${live ? " live" : ""}`}>
      {live && <span className="agent-rail-dot" aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}

/**
 * Recipient-side card: renders an incoming bot-to-bot message (task handoff, remote dispatch, or teamwork)
 * with a crisp vertical left accent rail, sender identity, channel tag, collapsible body, and optional
 * link back to the originating chat. Distinct from person bubbles and bot replies.
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

  return (
    <article
      id={id}
      className={`agent-rail agent-rail-incoming via-${model.via}${expanded ? " expanded" : ""}`}
      aria-label={model.ariaLabel}
    >
      <div className="agent-rail-head">
        <RailFace bot={senderBot} remote={model.via === "remote"} />
        <div className="agent-rail-identity">
          <span className="agent-rail-who">
            <span className="agent-rail-dir">from</span>{" "}
            <strong className="agent-rail-name">{model.senderName}</strong>
          </span>
          <span className="agent-rail-via">
            {model.via === "task" && <ClipboardList size={11} aria-hidden="true" />}
            {model.via === "remote" && <Globe size={11} aria-hidden="true" />}
            <span>{model.viaLabel}</span>
          </span>
          {stamp && <time className="agent-rail-time">{stamp}</time>}
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

/**
 * Sender-side card for one outgoing teamwork or remote ask:
 * shows "to <Teammate>", the sent message, live status (asked / working / answered / failed),
 * and the folded reply + optional tool steps expandable inline.
 */
function OutgoingAskCard({ ask, bots }: { ask: TeamAsk; bots: Bot[] }) {
  const model = buildOutgoingRail(ask, bots);
  const [replyOpen, setReplyOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const replyId = useId();
  const now = useNow(model.live);
  const targetBot = ask.remote ? undefined : bots.find((b) => b.id === ask.botId);
  const messageFold = foldPreview(model.message);
  const took = model.durationMs ?? (model.live ? Math.max(0, now - ask.started) : undefined);
  const hasReplyOrError = !!(model.reply || model.error);
  const steps = ask.steps ?? [];

  return (
    <article
      className={`agent-rail agent-rail-outgoing via-${model.via} status-${model.status}`}
      aria-label={model.ariaLabel}
    >
      <div className="agent-rail-head">
        <RailFace bot={targetBot} remote={model.via === "remote"} />
        <div className="agent-rail-identity">
          <span className="agent-rail-who">
            <ArrowRight size={12} className="agent-rail-arrow" aria-hidden="true" />
            <span className="agent-rail-dir">to</span>{" "}
            <strong className="agent-rail-name">{model.targetName}</strong>
            {model.hostLabel && <span className="agent-rail-host">on {model.hostLabel}</span>}
          </span>
          <StatusPill label={model.statusLabel} tone={model.statusTone} live={model.live} />
          {took !== undefined && took > 0 && <span className="agent-rail-meta">{duration(took)}</span>}
        </div>
      </div>

      <div className="agent-rail-body">
        {messageFold.collapsible && !messageOpen ? (
          <p className="agent-rail-preview">{messageFold.preview}</p>
        ) : (
          <p className="agent-rail-text">{model.message}</p>
        )}
        {model.expecting && (
          <p className="agent-rail-expect">
            <strong>Needs:</strong> {model.expecting}
          </p>
        )}
        {messageFold.collapsible && (
          <button
            type="button"
            className="agent-rail-toggle inline"
            aria-expanded={messageOpen}
            onClick={() => setMessageOpen((v) => !v)}
          >
            {messageOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            <span>{messageOpen ? "Hide full request" : "Show full request"}</span>
          </button>
        )}
      </div>

      {hasReplyOrError && (
        <div className={"agent-rail-reply-wrap" + (replyOpen ? " open" : "")}>
          <button
            type="button"
            className="agent-rail-reply-toggle"
            aria-expanded={replyOpen}
            aria-controls={replyId}
            onClick={() => setReplyOpen((value) => !value)}
          >
            {replyOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            <span className="agent-rail-reply-label">
              {model.error ? "Error" : `Reply from ${model.targetName}`}
            </span>
            {!replyOpen && (
              <span className="agent-rail-reply-snippet">
                {(model.error ?? model.reply ?? "").replace(/\s+/g, " ").trim().slice(0, 110)}
              </span>
            )}
          </button>
          {replyOpen && (
            <div id={replyId} className="agent-rail-reply-body">
              {model.reply ? (
                <RichText text={model.reply} />
              ) : (
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
      )}
    </article>
  );
}

/**
 * Compact sender-side card in the creating bot's chat for a Task Board handoff to another bot,
 * showing live status and linking directly to the task's chat when available.
 */
function TaskHandoffCard({
  handoff,
  bots,
  tasks,
  openChat,
}: {
  handoff: TaskHandoff;
  bots: Bot[];
  tasks?: BotTask[];
  openChat?: (chatId: string) => void;
}) {
  const model = buildTaskHandoffRail(handoff, { bots, tasks });
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const targetBot = bots.find((b) => b.id === model.targetBotId);
  const hasExpandable = !!(model.details || model.result || model.problem);

  return (
    <article
      className={`agent-rail agent-rail-task via-task status-${model.status}`}
      aria-label={model.ariaLabel}
    >
      <div className="agent-rail-head">
        <RailFace bot={targetBot} />
        <div className="agent-rail-identity">
          <span className="agent-rail-who">
            <ClipboardList size={12} className="agent-rail-arrow" aria-hidden="true" />
            <span className="agent-rail-dir">task for</span>{" "}
            <strong className="agent-rail-name">{model.targetName}</strong>
          </span>
          <StatusPill label={model.statusLabel} tone={model.statusTone} live={model.live} />
        </div>
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

      <div className="agent-rail-title">{model.title}</div>

      {hasExpandable && (
        <div className={"agent-rail-reply-wrap" + (expanded ? " open" : "")}>
          <button
            type="button"
            className="agent-rail-reply-toggle"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            <span className="agent-rail-reply-label">
              {model.problem ? "Blocked reason" : model.result ? "Result" : "Details"}
            </span>
            {!expanded && (
              <span className="agent-rail-reply-snippet">
                {(model.problem ?? model.result ?? model.details ?? "").replace(/\s+/g, " ").trim().slice(0, 110)}
              </span>
            )}
          </button>
          {expanded && (
            <div id={detailId} className="agent-rail-reply-body">
              {model.details && (
                <div className="agent-rail-subblock">
                  <small className="agent-rail-sublabel">Task brief</small>
                  <RichText text={model.details} />
                </div>
              )}
              {model.result && (
                <div className="agent-rail-subblock">
                  <small className="agent-rail-sublabel">Result from {model.targetName}</small>
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
      )}
    </article>
  );
}

/**
 * Renders all sender-side agent-message rail cards for a turn (outgoing teamwork/remote asks
 * and bot-to-bot Task Board handoffs). Replaces the older compact TeamRail bar.
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
  if (!asks.length && !handoffs.length) return null;

  return (
    <section className="agent-rail-stack" aria-label="Agent messages">
      {asks.map((ask) => (
        <OutgoingAskCard key={ask.id} ask={ask} bots={bots} />
      ))}
      {handoffs.map((handoff) => (
        <TaskHandoffCard key={handoff.id} handoff={handoff} bots={bots} tasks={tasks} openChat={openChat} />
      ))}
    </section>
  );
}
