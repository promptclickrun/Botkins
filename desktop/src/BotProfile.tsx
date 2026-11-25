import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Copy,
  EyeOff,
  Eye,
  MessageSquarePlus,
  PanelsTopLeft,
  Pencil,
  Pin,
  PinOff,
  Puzzle,
  Star,
  Trash2,
  BookmarkPlus,
  Brain,
  ChevronRight,
  Download,
  MessageCircle,
} from "lucide-react";
import { BotAvatar, activityLabel, botActivity } from "./Avatar";
import { BotStudio } from "./BotStudio";
import { availableHeads, lookOf, sameLook } from "./botkins";
import ModelPicker from "./ModelPicker";
import { openProviderSettings } from "./providers";
import { ChatRow, deleteBot, useAsk, type PageActions } from "./Pages";
import { BotRoutines } from "./Routines";
import BotAccess from "./BotAccess";
import BotProactive, { showsProactive } from "./BotProactive";
import BotVoiceCard from "./BotVoiceCard";
import { teamCan } from "./teamAccess";
import { openBotViewNext } from "./Settings";
import "./integrations.css";
import type { Bot, BotLook, State } from "./types";
import "./agents.css";
import "./botpage.css";

function capabilitySummary(bot: Bot) {
  const off = (bot.skillsOff?.length ?? 0) + (bot.mcpOff?.length ?? 0);
  return off
    ? "Uses the skills and MCP servers from Settings, with " + off + " turned off for this bot."
    : "Uses every skill and MCP server from Settings.";
}

/** The bot page's Memory card: the first lines of what the bot saved, and Edit memory. */
function MemoryCard({ state, bot, actions }: { state: State; bot: Bot; actions: PageActions }) {
  const [memory, setMemory] = useState<string>();
  // Bots change their memory during chats: read it again when one of this bot's turns changes state.
  const chats = new Set(state.chats.filter((c) => c.botId === bot.id || c.botIds?.includes(bot.id)).map((c) => c.id));
  const turns = state.runs
    .filter((r) => chats.has(r.chatId))
    .map((r) => r.id + r.status)
    .join();
  useEffect(() => {
    let live = true;
    window.botkins
      .botMemory(bot.id)
      .then((m) => live && setMemory(m))
      .catch(() => live && setMemory(""));
    return () => {
      live = false;
    };
  }, [bot.id, turns]);
  const lines = (memory ?? "").split("\n").filter((l) => l.trim());
  return (
    <section className="profile-card" aria-labelledby="bot-memory-title">
      <h2 id="bot-memory-title">Memory</h2>
      {memory === undefined ? (
        <p className="muted">Loading…</p>
      ) : lines.length ? (
        <>
          <pre className="memory-peek">{lines.slice(0, 5).join("\n")}</pre>
          {lines.length > 5 && <p className="muted memory-more">and {lines.length - 5} more</p>}
        </>
      ) : (
        <p className="muted">Nothing saved yet. {bot.name} saves facts here to remember them in every chat.</p>
      )}
      <button
        className="secondary"
        onClick={() => {
          openBotViewNext("memory");
          actions.capabilities(bot.id);
        }}
      >
        <Brain size={14} />
        Edit memory
      </button>
    </section>
  );
}

/** The bot page: its live Botkin, editable profile, model default, capabilities, chats and actions. */
export default function BotProfile({
  state,
  bot,
  actions,
  back,
  proactiveSetup,
  routines,
}: {
  state: State;
  bot: Bot;
  actions: PageActions;
  back: () => void;
  /** Opens the setup steps of the bot's Proactive agent as the page appears (the shell's `actions.proactiveSetup`). */
  proactiveSetup?: boolean;
  /** Opens the Routines page on a routine, a bot's routines or a new routine. */
  routines?: (target: { id?: string; botId?: string; create?: boolean }) => void;
}) {
  const initial = {
    name: bot.name,
    role: bot.role,
    summary: bot.summary ?? "",
    instructions: bot.instructions,
  };
  const [draft, setDraft] = useState(initial);
  const [look, setLook] = useState<BotLook>(() => lookOf(bot));
  const [editAvatar, setEditAvatar] = useState(false);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [templateNote, setTemplateNote] = useState("");
  const dialogs = useAsk();
  const primary = state.bots[0]?.id === bot.id;
  const activity = botActivity(state, bot.id);
  const status = activityLabel(activity);
  const chats = state.chats.filter((c) => c.botId === bot.id).sort((a, b) => b.time - a.time);
  const live = chats.filter((c) => !c.archived);
  const archived = chats.length - live.length;
  const panels = state.panels.filter((p) => p.botId === bot.id && !p.hidden).length;
  const own = lookOf(bot);
  const lookChanged = !sameLook(look, own);
  const dirty =
    lookChanged ||
    (Object.keys(initial) as (keyof typeof initial)[]).some((k) => draft[k].trim() !== initial[k].trim());
  const valid = draft.name.trim() && draft.role.trim() && draft.instructions.trim();
  const field = (k: keyof typeof draft) => ({
    value: draft[k],
    onChange: (e: { target: { value: string } }) => {
      setSaved(false);
      setDraft((d) => ({ ...d, [k]: e.target.value }));
    },
  });
  const act = (p: Promise<unknown>) => void p.catch(actions.fail);
  async function save() {
    setSaving(true);
    try {
      await window.botkins.updateBot(bot.id, {
        name: draft.name.trim(),
        role: draft.role.trim(),
        summary: draft.summary.trim(),
        instructions: draft.instructions.trim(),
        ...(lookChanged ? { look } : {}),
      });
      setSaved(true);
      setEditAvatar(false);
    } catch (e) {
      actions.fail(e);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="page bot-profile">
      <button className="link-button profile-back" onClick={back}>
        <ArrowLeft size={15} />
        Back
      </button>
      {/* The bot as the phone shows it: its Botkin, its name and role, and the ways to talk to it. */}
      <section className="profile-hero">
        <span className="profile-portrait">
          <BotAvatar look={look} state={activity} size={112} animated />
        </span>
        <div className="profile-title">
          <h1>{bot.name}</h1>
          <p className="profile-role">{bot.role}</p>
          {(primary || bot.pinned || bot.hidden || status) && (
            <span className="profile-badges">
              {status && (
                <small className={"botstatus " + activity}>
                  <i />
                  {status}
                </small>
              )}
              {primary && <span className="botbadge">Primary</span>}
              {bot.pinned && !primary && <span className="botbadge plain"><Pin size={12} /> Pinned</span>}
              {bot.hidden && <span className="botbadge plain"><EyeOff size={12} /> Hidden</span>}
            </span>
          )}
          {bot.summary && <p className="profile-about">{bot.summary}</p>}
          {templateNote && (
            <p className="profile-note" role="status">
              {templateNote}
            </p>
          )}
          <div className="profile-actions">
            {state.proactive?.chatMode ? (
              <button className="btn primary" onClick={() => actions.mainChat(bot.id)}>
                <MessageCircle size={15} />
                Main chat
              </button>
            ) : (
              <button className="btn primary" onClick={() => actions.botChat(bot)}>
                <MessageCircle size={15} />
                Chat
              </button>
            )}
            <button className="btn soft" onClick={() => actions.newChatWith(bot.id)}>
              <MessageSquarePlus size={15} />
              New chat
            </button>
          </div>
        </div>
      </section>

      <div className="page-columns profile-columns">
        <div className="main-column profile-main">
          <section className="profile-card profile-edit">
            <div className="sectionhead">
              <h2>Profile</h2>
              <button
                type="button"
                className="link-button"
                aria-haspopup="dialog"
                onClick={() => setEditAvatar(true)}
              >
                <Pencil size={14} />
                Bot Studio
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {editAvatar && (
                // Bot Studio saves the look straight to the bot; the profile fields keep their own Save.
                <BotStudio
                  value={look}
                  characters={availableHeads(state.remote)}
                  saving={avatarSaving}
                  cancel={() => setEditAvatar(false)}
                  save={async (v) => {
                    setAvatarSaving(true);
                    try {
                      await window.botkins.updateBot(bot.id, { look: v });
                      setLook(v);
                      setEditAvatar(false);
                    } catch (e) {
                      actions.fail(e);
                    } finally {
                      setAvatarSaving(false);
                    }
                  }}
                />
              )}
              <div className="profile-pair">
                <label>
                  Name
                  <input required maxLength={48} {...field("name")} />
                </label>
                <label>
                  Role
                  <input required maxLength={90} {...field("role")} />
                </label>
              </div>
              <label>
                About
                <textarea
                  rows={2}
                  maxLength={240}
                  placeholder="A line about what this bot is for"
                  {...field("summary")}
                />
              </label>
              <label>
                Instructions
                <textarea rows={6} required maxLength={30000} {...field("instructions")} />
              </label>
              <div className="profile-save">
                <button className="btn primary" disabled={!dirty || !valid || saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                {dirty && (
                  <button
                    type="button"
                    className="btn soft"
                    onClick={() => {
                      setDraft(initial);
                      setLook(lookOf(bot));
                      setEditAvatar(false);
                    }}
                  >
                    Discard
                  </button>
                )}
                <small role="status">{saved && !dirty ? "Saved" : ""}</small>
              </div>
            </form>
          </section>

          <section className="page-section profile-chats" aria-labelledby="bot-chats-title">
            <div className="group-label">
              <h2 id="bot-chats-title">Chats</h2>
              <span className="spacer" />
              <small>
                {live.length} {live.length === 1 ? "chat" : "chats"}
                {archived ? " · " + archived + " archived" : ""}
              </small>
            </div>
            {live.length ? (
              <div className="group">
                {live.map((c) => (
                  <ChatRow key={c.id} state={state} chat={c} open={actions.open} actions={actions} look="card" />
                ))}
              </div>
            ) : (
              <div className="group">
                <button className="group-row" onClick={() => actions.newChatWith(bot.id)}>
                  <span className="icon-tile">
                    <MessageSquarePlus size={16} />
                  </span>
                  <span className="row-main">
                    <span className="row-title">Start a chat with {bot.name}</span>
                  </span>
                  <ChevronRight size={16} className="row-chevron" />
                </button>
              </div>
            )}
          </section>
          {/* The rest of what the bot's ⋯ menu does, as rows, as on the phone's bot page. */}
          <section className="page-section profile-manage" aria-labelledby="bot-manage-title">
            <h2 id="bot-manage-title" className="group-label">
              Manage
            </h2>
            <div className="group">
              <button className="group-row" onClick={() => act(window.botkins.setBotFlags(bot.id, { pinned: !bot.pinned }))}>
                {bot.pinned ? <PinOff size={16} /> : <Pin size={16} />}
                <span className="row-main">{bot.pinned ? "Unpin" : "Pin"}</span>
              </button>
              {!primary && (
                <button className="group-row" onClick={() => act(window.botkins.makePrimary(bot.id))}>
                  <Star size={16} />
                  <span className="row-main">Make primary</span>
                </button>
              )}
              <button
                className="group-row"
                onClick={() => act(window.botkins.duplicateBot(bot.id).then((id) => actions.botPage(id)))}
              >
                <Copy size={16} />
                <span className="row-main">Duplicate</span>
              </button>
              <button
                className="group-row"
                onClick={() =>
                  act(
                    window.botkins.saveTemplate(bot.id).then(() => setTemplateNote("Saved as a template. Find it in Create a bot.")),
                  )
                }
              >
                <BookmarkPlus size={16} />
                <span className="row-main">Save as template</span>
              </button>
              <button
                className="group-row"
                onClick={() =>
                  act(
                    window.botkins
                      .exportTemplate({ botId: bot.id })
                      .then((done) => done && setTemplateNote("Template exported. Anyone with Botkins can import it.")),
                  )
                }
              >
                <Download size={16} />
                <span className="row-main">Export template…</span>
              </button>
              <button
                className="group-row"
                disabled={primary && !bot.hidden}
                title={primary && !bot.hidden ? "The primary bot can't be hidden" : undefined}
                onClick={() => act(window.botkins.setBotFlags(bot.id, { hidden: !bot.hidden }))}
              >
                {bot.hidden ? <Eye size={16} /> : <EyeOff size={16} />}
                <span className="row-main">{bot.hidden ? "Show" : "Hide"}</span>
              </button>
              <button
                className="group-row danger"
                disabled={state.bots.length < 2}
                title={state.bots.length < 2 ? "Keep at least one bot" : undefined}
                onClick={() => act(deleteBot(bot, dialogs.ask))}
              >
                <Trash2 size={16} />
                <span className="row-main">Delete…</span>
              </button>
            </div>
          </section>
        </div>

        <div className="profile-side">
          <section className="profile-card">
            <h2>Model</h2>
            <p className="muted">The default for new chats with {bot.name}.</p>
            <ModelPicker
              key={bot.id}
              scope="bot"
              id={bot.id}
              value={bot.model}
              speedSettings={!state.remote?.using || state.remote.using.capabilities.includes("fast-mode-v1") ? { value: bot.fastMode, inherited: state.settings.fastMode } : undefined}
              inherited={state.settings.model}
              openProviders={openProviderSettings}
            />
          </section>
          <section className="profile-card">
            <h2>Capabilities</h2>
            <p className="muted">{capabilitySummary(bot)}</p>
            <button className="secondary" onClick={() => actions.capabilities(bot.id)}>
              <Puzzle size={14} />
              Manage capabilities
            </button>
          </section>
          {/* A bot's voice is for a role that manages bots: the host sends it the shared choices, never a key. */}
          {teamCan(state, "agents", "manage") && <BotVoiceCard bot={bot} />}
          {/* A role that manages bots sets a bot's Proactive agent up; anyone it looks out for has their own alerts there. */}
          {showsProactive(state, bot) && <BotProactive state={state} bot={bot} setUpNow={proactiveSetup} />}
          <MemoryCard state={state} bot={bot} actions={actions} />
          <section className="profile-card">
            <h2>Today</h2>
            <p className="muted profile-stat">
              <PanelsTopLeft size={15} />
              {panels === 0 ? "No Today panels" : panels === 1 ? "1 Today panel" : panels + " Today panels"}
            </p>
          </section>
          {routines && <BotRoutines state={state} bot={bot} open={routines} />}
          <BotAccess state={state} bot={bot} />
        </div>
      </div>
      {dialogs.node}
    </div>
  );
}
