import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square, BrainCircuit, Plus, X, File, Folder, Quote, Sparkles, SquareSlash, Wrench } from "lucide-react";
import {
  MAX_MENTIONS,
  MentionChips,
  MentionMenu,
  findTrigger,
  mentionKey,
  mentionOptions,
  toInput,
  tokenOf,
  useMentionables,
  useProjectPulls,
  type DraftMention,
} from "./MentionMenu";
import type { Attachment, Bot, BotLook, BotVoice, Capability, MentionInput } from "./types";
import { draftPulls } from "../desktop/remote/client/pr-reference";
import {
  applyCommandOption,
  isSideCommand,
  parseSlashInput,
  stripLeadingTrigger,
  toDraftCommand,
  type DraftCommand,
} from "./slashCommand";
import { useComposerVoice } from "./ComposerVoice";
import ProviderIcon, { hasProviderMark } from "./ProviderIcon";

/** A reply's quoted text, set by a message's Reply action in ChatView. */
export const QuoteContext = createContext<{ quote: string; setQuote: (q: string | ((current: string) => string)) => void } | null>(null);

const NO_MENTIONS: DraftMention[] = [];

type Props = {
  botId: string;
  chatId?: string;
  listPulls?: boolean;
  sourceKey: string;
  draft: string;
  placeholder: string;
  busy: boolean;
  sending: boolean;
  change: (value: string) => void;
  send: (options?: { attachments?: Attachment[]; quote?: string; mentions?: MentionInput[]; delivery?: "steer" | "queue" }, onDispatch?: () => void) => Promise<boolean | void> | void;
  stop: () => void;
  above?: boolean;
  model?: string;
  /** The provider of that model, for the mark on the model button. */
  modelProvider?: string;
  pickModel?: () => void;
  /** Group chat members: typing @ offers them and "everyone". Group chats are text only. */
  members?: Bot[];
  /** Other people in this chat: typing @ offers them to notify with a mention. */
  people?: { id: string; name: string; hint?: string }[];
  /** Called when the user starts or stops typing in a multi-person chat. */
  onTyping?: (active: boolean) => void;
  /** Records picked with "@" and "#", kept with the draft. */
  mentions?: DraftMention[];
  setMentions?: (list: DraftMention[]) => void;
  /** Slash command, skill, or tool picked with "/", kept as a rail attachment with the draft. */
  command?: DraftCommand | null;
  setCommand?: (command: DraftCommand | null) => void;
  /** The bot this composer talks to, for the voice dock. */
  botName?: string;
  /** That bot's look, for the voice dock. */
  botLook?: BotLook;
  /** That bot's voice of its own, if it has one: Live Voice starts with it. */
  botVoice?: BotVoice;
  /** Makes a chat to talk in when there is none yet (the home composer). */
  startChat?: () => Promise<string>;
};

function CommandIcon({ kind }: { kind: DraftCommand["kind"] }) {
  if (kind === "Skill") return <Sparkles size={13} aria-hidden="true" />;
  if (kind === "Tool") return <Wrench size={13} aria-hidden="true" />;
  return <SquareSlash size={13} aria-hidden="true" />;
}

export default function Composer({
  botId,
  chatId,
  listPulls,
  sourceKey,
  draft,
  placeholder,
  busy,
  sending,
  change,
  send,
  stop,
  above,
  model,
  modelProvider,
  pickModel,
  members,
  people,
  onTyping,
  mentions = NO_MENTIONS,
  setMentions = () => {},
  command = null,
  setCommand = () => {},
  botName,
  botLook,
  botVoice,
  startChat,
}: Props) {
  const references = chatId ? draftPulls(draft) : [];
  const [focused, focus] = useState(false);
  const [dismissed, dismiss] = useState(false);
  const [choices, setChoices] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  // "@" and "#" at the caret open the mention menu: people/bots in the chat, or projects, wiki pages and files.
  const [caret, setCaret] = useState(0);
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;
  const typingRef = useRef<{ clear: (() => void) | null; lastSent: number }>({ clear: null, lastSent: 0 });
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function stopTyping() {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = undefined;
    }
    const clear = typingRef.current.clear;
    if (!clear) return;
    typingRef.current.clear = null;
    typingRef.current.lastSent = 0;
    clear();
  }
  function pulseTyping() {
    const fn = onTypingRef.current;
    if (!fn) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = undefined;
      stopTyping();
    }, 3000);
    const now = Date.now();
    if (!typingRef.current.clear || now - typingRef.current.lastSent >= 2000) {
      typingRef.current.clear = () => fn(false);
      typingRef.current.lastSent = now;
      fn(true);
    }
  }
  useEffect(() => () => stopTyping(), [chatId]);
  useEffect(() => {
    if (!onTyping) stopTyping();
  }, [onTyping]);
  const slash = parseSlashInput(draft, caret);
  const showCatalog = focused && !dismissed && !!slash;
  const attachedOptionMode = focused && !dismissed && !slash && !!command?.options?.length && /^\S*$/.test(draft);
  const show = showCatalog || attachedOptionMode;
  const side = isSideCommand(draft, command);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const reply = useContext(QuoteContext);
  // Tokens just inserted, so the menu stays closed right after a pick.
  const [picked, setPicked] = useState<string[]>([]);
  const trigger = findTrigger(draft, caret);
  const triggerOpen =
    focused &&
    !dismissed &&
    !!trigger &&
    (trigger.sigil === "#" || !!members?.length || !!people?.length) &&
    !picked.some((t) => (trigger.sigil + trigger.query).startsWith(t));
  const found = useMentionables(triggerOpen && trigger?.sigil === "#", chatId, botId);
  const pulls = useProjectPulls(listPulls && triggerOpen && trigger?.sigil === "#" ? chatId : undefined, trigger?.query ?? "");
  const mentionChoices = trigger ? mentionOptions(trigger.sigil, trigger.query, found.data, members, pulls.value?.items, people) : [];
  // Spaces are allowed while the text still matches something.
  const mentioning = triggerOpen && (!/\s/.test(trigger!.query) || mentionChoices.length > 0 || pulls.loading);
  const mentionAt = Math.min(index, Math.max(0, mentionChoices.length - 1));
  function pickMention(i: number) {
    const choice = mentionChoices[i];
    if (!choice || !trigger) return;
    const m = choice.mention;
    if (m && !mentions.some((x) => mentionKey(x) === mentionKey(m))) {
      if (mentions.length >= MAX_MENTIONS) {
        setAttachError("Mention up to " + MAX_MENTIONS + " records in one message.");
        return;
      }
      setMentions([...mentions, m]);
    }
    const text = choice.token + " ";
    const next = draft.slice(0, trigger.start) + text + draft.slice(caret);
    change(next);
    setPicked((p) => [...p, choice.token + " "]);
    const at = trigger.start + text.length;
    setCaret(at);
    setIndex(0);
    placeCaret.current = { at, value: next };
  }
  // The caret goes after an inserted mention in the same commit, before the next key arrives.
  const placeCaret = useRef<{ at: number; value: string }>(undefined);
  useLayoutEffect(() => {
    const el = input.current;
    const want = placeCaret.current;
    if (!el || !want || el.value !== want.value) return;
    placeCaret.current = undefined;
    el.focus();
    el.setSelectionRange(want.at, want.at);
  }, [draft]);
  // A mention whose text left the message goes with it.
  useEffect(() => {
    if (mentions.some((m) => !draft.includes(tokenOf(m)))) setMentions(mentions.filter((m) => draft.includes(tokenOf(m))));
    if (!draft) setPicked([]);
  }, [draft, mentions]);
  useEffect(() => {
    if (mentioning) document.getElementById(listId + "-x" + mentionAt)?.scrollIntoView({ block: "nearest" });
  }, [listId, mentionAt, mentioning]);
  const quote = reply?.quote || "";
  // Dictation and Live Voice (src/ComposerVoice.tsx).
  const voice = useComposerVoice({ chatId, bot: members?.length ? undefined : { id: botId, look: botLook }, botName, botVoice, draft, change, input, startChat });
  // Enter guides an active reply. Queue explicitly saves a separate turn.
  const hasContent = !!draft.trim() || !!command;
  const ready = hasContent || files.length > 0;
  function addFiles(list: Attachment[]) {
    if (members?.length) {
      setAttachError("Group chats take text only.");
      return;
    }
    setAttachError("");
    setFiles((prev) => {
      const next = [...prev];
      for (const f of list) if (!next.some((p) => p.path === f.path)) next.push(f);
      if (next.length > 10) setAttachError("Attach up to 10 files at a time.");
      return next.slice(0, 10);
    });
  }
  function fromFiles(list: FileList | null | undefined) {
    const found: Attachment[] = [];
    let skipped = 0;
    for (const file of Array.from(list ?? [])) {
      const path = window.botkins.pathForFile(file);
      if (path) found.push({ name: file.name, path });
      else skipped++;
    }
    if (found.length) addFiles(found);
    if (skipped) setAttachError("Only files saved on this computer can be attached.");
    return found.length + skipped > 0;
  }
  async function submit(queue = false) {
    stopTyping();
    let dispatched = false;
    const sent = await send({
      delivery: queue ? "queue" : "steer",
      ...(files.length && { attachments: files }),
      ...(quote && { quote }),
      ...(mentions.length && { mentions: mentions.map(toInput) }),
    }, () => {
      dispatched = true;
      setFiles([]);
      setMentions([]);
      setPicked([]);
      setAttachError("");
      reply?.setQuote("");
    });
    if (dispatched && !sent) {
      setFiles(current => [...files, ...current.filter(f => !files.some(old => old.path === f.path))]);
      if (quote) reply?.setQuote(current => current || quote);
    }
  }
  useEffect(() => {
    if (!showCatalog) {
      setChoices([]);
      setError("");
      setLoading(false);
      return;
    }
    let active = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    setChoices([]);
    setError("");
    setLoading(true);
    // An MCP server that is still starting has no tools to list yet. While the menu stays open,
    // it is read again until every server has settled (for up to about a minute).
    const load = (tries: number) =>
      window.botkins
        .catalog(botId, chatId)
        .then((data) => {
          if (!active) return;
          setChoices(data.choices);
          if (tries < 20 && data.servers.some((s) => s.status === "pending")) again = setTimeout(() => void load(tries + 1), 3000);
        })
        .catch((e) => {
          if (active) setError(String(e.message || e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void load(0);
    return () => {
      active = false;
      clearTimeout(again);
    };
  }, [showCatalog, botId, chatId, sourceKey]);
  const query = (attachedOptionMode ? draft : slash?.query ?? "").toLowerCase();
  const parent =
    slash?.mode === "subcommand"
      ? choices.find((c) =>
          [c.command, ...(c.aliases || [])].includes(slash.parent.toLowerCase()),
        )
      : undefined;
  const options: Capability[] = attachedOptionMode
    ? (command?.options ?? []).map((o) => ({
        name: command!.name + " " + o.name,
        command: command!.command + " " + o.name,
        source: command!.source,
        description: o.description,
        kind: command!.kind,
      }))
    : slash?.mode === "subcommand"
      ? (parent?.options ?? []).map((o) => ({
          name: parent!.name + " " + o.name,
          command: parent!.command + " " + o.name,
          source: parent!.source,
          description: o.description,
          kind: parent!.kind,
        }))
      : choices;
  const rank = (c: Capability) => {
    const names = [c.command, c.name, ...(c.aliases ?? [])].map((n) =>
      n.toLowerCase(),
    );
    if (names.includes(query)) return 0;
    if (names.some((n) => n.startsWith(query))) return 1;
    return 2;
  };
  const matches = options
    .filter(
      (c) =>
        (!busy || c.duringTurn || attachedOptionMode) &&
        [c.command, c.name, c.source, c.description, ...(c.aliases ?? [])].some(
          (t) => t?.toLowerCase().includes(query),
        ),
    )
    .sort((a, b) => rank(a) - rank(b));
  const visible =
    (showCatalog && (slash?.mode !== "subcommand" || (!!parent?.options?.length && !!matches.length))) ||
    (attachedOptionMode && !!matches.length);
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => {
    document
      .getElementById(listId + "-" + selected)
      ?.scrollIntoView({ block: "nearest" });
  }, [listId, selected]);
  function select(i: number, activate = false) {
    const pickedChoice = matches[i];
    if (!pickedChoice) return;
    if (attachedOptionMode && command) {
      const opt = command.options?.find((o) => command.command + " " + o.name === pickedChoice.command);
      if (opt) setCommand(applyCommandOption(command, opt));
      else setCommand(toDraftCommand(pickedChoice));
      change("");
      setCaret(0);
      setIndex(0);
      placeCaret.current = { at: 0, value: "" };
      input.current?.focus();
      return;
    }
    const nextDraft = slash ? stripLeadingTrigger(draft, slash.end) : "";
    if (activate && pickedChoice.command === "model" && pickModel) {
      change(nextDraft);
      setCommand(null);
      setCaret(0);
      setIndex(0);
      pickModel();
      return;
    }
    setCommand(toDraftCommand(pickedChoice));
    change(nextDraft);
    setCaret(0);
    setIndex(0);
    dismiss(false);
    placeCaret.current = { at: 0, value: nextDraft };
    input.current?.focus();
  }
  return (
    <div
      className={"composer-shell " + (above ? "above" : "below") + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        fromFiles(e.dataTransfer.files);
        input.current?.focus();
      }}
    >
      {voice.strip}
      {(quote || command || files.length > 0 || mentions.length > 0 || references.length > 0 || attachError) && (
        <div className="composer-extras">
          {quote && (
            <div className="reply-quote">
              <Quote size={13} />
              <span>{quote}</span>
              <button type="button" aria-label="Cancel reply" onClick={() => reply?.setQuote("")}>
                <X size={13} />
              </button>
            </div>
          )}
          {(command || files.length > 0 || mentions.length > 0 || references.length > 0) && (
            <div className="composer-chips">
          {command && (
            <ul className="attach-chips command-chips" aria-label="Command">
              <li
                className={"command-chip " + command.kind.toLowerCase()}
                title={[command.kind, "/" + command.command, command.description].filter(Boolean).join(" · ")}
              >
                <CommandIcon kind={command.kind} />
                <span>/{command.name}</span>
                <button
                  type="button"
                  aria-label={"Remove /" + command.name}
                  onClick={() => {
                    setCommand(null);
                    input.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              </li>
            </ul>
          )}
          {references.length > 0 && <ul className="attach-chips" aria-label="Pull request references">
            {references.map(({ url, label }) => <li key={url} className="mention-chip">
              <a className="mention-open pr-reference" href={url} onClick={(event) => { event.preventDefault(); void window.botkins.openLink(url); }}>{label}</a>
            </li>)}
          </ul>}
          <MentionChips list={mentions} remove={(m) => setMentions(mentions.filter((x) => x !== m))} />
          {files.length > 0 && (
            <ul className="attach-chips" aria-label="Attachments">
              {files.map((f) => (
                <li key={f.path} title={f.path}>
                  {f.kind === "directory" ? <Folder size={13} /> : <File size={13} />}
                  <span>{f.name}</span>
                  <button
                    type="button"
                    aria-label={"Remove " + f.name}
                    onClick={() => setFiles((prev) => prev.filter((p) => p.path !== f.path))}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
            </div>
          )}
          {attachError && (
            <small className="attach-error" role="alert">
              {attachError}
            </small>
          )}
        </div>
      )}
      <form
        className="composer"
        // The voice dock (in `voice.strip`) stands in for the message box while live voice is on here.
        hidden={voice.docked}
        onSubmit={(e) => {
          e.preventDefault();
          if (!sending) void submit();
        }}
      >
        {!members?.length && (
        <button
          type="button"
          className="composer-model composer-attach"
          aria-label="Attach files"
          title="Attach files"
          onClick={() =>
            void window.botkins
              .chooseFiles()
              .then(addFiles)
              .catch((e) => setAttachError(String(e.message || e)))
          }
        >
          <Plus size={19} />
        </button>
        )}
        <textarea
          ref={input}
          role="combobox"
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={visible || mentioning}
          aria-controls={visible || mentioning ? listId : undefined}
          aria-activedescendant={
            visible && matches.length
              ? listId + "-" + selected
              : mentioning && !visible && mentionChoices.length
                ? listId + "-x" + mentionAt
                : undefined
          }
          rows={1}
          maxLength={32000}
          placeholder={command?.hint || placeholder}
          value={draft}
          onPaste={(e) => {
            if (e.clipboardData.files.length && fromFiles(e.clipboardData.files)) e.preventDefault();
          }}
          onFocus={() => focus(true)}
          onBlur={() => {
            focus(false);
            stopTyping();
          }}
          onChange={(e) => {
            const value = e.target.value;
            change(value);
            setCaret(e.target.selectionStart ?? value.length);
            dismiss(false);
            setIndex(0);
            if (value.trim()) pulseTyping();
            else stopTyping();
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (
              command &&
              e.key === "Backspace" &&
              !e.metaKey &&
              !e.ctrlKey &&
              !e.altKey &&
              e.currentTarget.selectionStart === 0 &&
              e.currentTarget.selectionEnd === 0
            ) {
              e.preventDefault();
              setCommand(null);
              return;
            }
            if (mentioning && !visible) {
              const n = mentionChoices.length;
              if (e.key === "Escape") {
                e.preventDefault();
                dismiss(true);
                return;
              }
              if (n && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setIndex((mentionAt + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                return;
              }
              if (n && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                e.preventDefault();
                pickMention(mentionAt);
                return;
              }
              // Enter waits for the list rather than sending a half-typed mention.
              if (e.key === "Enter" && !e.shiftKey && found.loading) {
                e.preventDefault();
                return;
              }
            }
            if (show && e.key === "Escape") {
              e.preventDefault();
              dismiss(true);
              return;
            }
            if (
              visible &&
              matches.length &&
              (e.key === "ArrowDown" || e.key === "ArrowUp")
            ) {
              e.preventDefault();
              setIndex(
                (selected + (e.key === "ArrowDown" ? 1 : -1) + matches.length) %
                  matches.length,
              );
              return;
            }
            if (
              visible &&
              matches.length &&
              !e.shiftKey &&
              (e.key === "Enter" || e.key === "Tab")
            ) {
              e.preventDefault();
              select(selected, e.key === "Enter");
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!sending && hasContent && !(visible && loading))
                void submit();
            }
          }}
        />
        {voice.mic}
        {pickModel && (
          <button
            type="button"
            className="composer-model"
            aria-label={model ? "Chat model and thinking: " + model : "Chat model and thinking"}
            title={"Model and thinking · " + model}
            onClick={pickModel}
          >
            {/* The mark of the model's provider, as on the phone; a provider without one keeps the brain. */}
            {hasProviderMark(modelProvider) ? <ProviderIcon provider={modelProvider} size={18} /> : <BrainCircuit size={19} />}
          </button>
        )}
        {busy && !side && (
          <button
            type="button"
            className={hasContent ? "send stop-quiet" : "send"}
            aria-label="Stop reply"
            onClick={stop}
          >
            <Square size={16} />
          </button>
        )}
        {busy && !side && ready && (
          <button type="button" className="secondary" aria-label="Queue message" title="Send after this reply" disabled={sending} onClick={() => void submit(true)}>Queue</button>
        )}
        {!busy && !side && !ready && voice.live}
        {(side || (busy ? hasContent : ready)) && (
          <button
            className="send"
            aria-label={busy && !side ? "Guide reply" : "Send message"}
            title={busy && !side ? "Guide the current reply when supported, or send after it finishes" : undefined}
            disabled={sending || (!command && (!draft.trim() || draft.trim() === "/"))}
          >
            <ArrowUp size={20} />
          </button>
        )}
      </form>
      {mentioning && !visible && (
        <MentionMenu
          id={listId}
          sigil={trigger!.sigil}
          options={mentionChoices}
          selected={mentionAt}
          loading={found.loading || pulls.loading}
          error={found.error || pulls.value?.reason || ""}
          filtered={!!trigger!.query}
          pick={pickMention}
        />
      )}
      {visible && (
        <div
          className="slash-menu"
          id={listId}
          role="listbox"
          aria-label="Commands, skills and tools"
        >
          <div className="slash-heading">
            {attachedOptionMode && command ? "/" + command.name + " options" : "Commands, skills and tools"}
          </div>
          {loading ? (
            <p>Reading this bot’s capabilities…</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : !matches.length ? (
            <p>No matches</p>
          ) : (
            matches.map((c, i) => (
              <button
                role="option"
                id={listId + "-" + i}
                aria-selected={i === selected}
                key={c.command}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(i, true)}
              >
                <span>
                  <strong>
                    /{c.name}
                    {!!c.aliases?.length && (
                      <span className="aliases">
                        {" "}
                        {c.aliases.map((a) => "/" + a).join(" · ")}
                      </span>
                    )}
                  </strong>
                  <small>{c.description}</small>
                </span>
                <em>
                  {c.kind === "Skill" && c.source === "plugin"
                    ? "Plugin skill"
                    : c.kind}
                </em>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
