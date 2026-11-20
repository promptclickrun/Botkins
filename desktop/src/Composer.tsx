import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square, BrainCircuit, Plus, X, File, Folder, Quote } from "lucide-react";
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
  type DraftMention,
} from "./MentionMenu";
import type { Attachment, Bot, Capability, MentionInput } from "./types";
import { useComposerVoice } from "./ComposerVoice";
import ProviderIcon, { hasProviderMark } from "./ProviderIcon";

/** A reply's quoted text, set by a message's Reply action in ChatView. */
export const QuoteContext = createContext<{ quote: string; setQuote: (q: string) => void } | null>(null);

const NO_MENTIONS: DraftMention[] = [];

type Props = {
  botId: string;
  chatId?: string;
  sourceKey: string;
  draft: string;
  placeholder: string;
  busy: boolean;
  sending: boolean;
  change: (value: string) => void;
  send: (options?: { attachments?: Attachment[]; quote?: string; mentions?: MentionInput[]; delivery?: "steer" | "queue" }) => Promise<boolean | void> | void;
  stop: () => void;
  above?: boolean;
  model?: string;
  /** The provider of that model, for the mark on the model button. */
  modelProvider?: string;
  pickModel?: () => void;
  /** Group chat members: typing @ offers them and "everyone". Group chats are text only. */
  members?: Bot[];
  /** Records picked with "@" and "#", kept with the draft. */
  mentions?: DraftMention[];
  setMentions?: (list: DraftMention[]) => void;
  /** The bot this composer talks to, for the Live Voice panel. */
  botName?: string;
  /** Makes a chat to talk in when there is none yet (the home composer). */
  startChat?: () => Promise<string>;
};
export default function Composer({
  botId,
  chatId,
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
  mentions = NO_MENTIONS,
  setMentions = () => {},
  botName,
  startChat,
}: Props) {
  const [focused, focus] = useState(false);
  const [dismissed, dismiss] = useState(false);
  const [choices, setChoices] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const sub = /^\/([^\s]+) (\S*)$/.exec(draft);
  const show = focused && !dismissed && (/^\/[^\s]*$/.test(draft) || !!sub);
  const side = /^\/(?:btw|ask)\s+\S/i.test(draft);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const reply = useContext(QuoteContext);
  // "@" and "#" at the caret open the mention menu: bots (in a group chat), or projects, wiki pages and files. In a one-bot chat "@" has nothing to offer, so it opens no menu.
  const [caret, setCaret] = useState(0);
  // Tokens just inserted, so the menu stays closed right after a pick.
  const [picked, setPicked] = useState<string[]>([]);
  const trigger = findTrigger(draft, caret);
  const triggerOpen =
    focused &&
    !dismissed &&
    !!trigger &&
    (trigger.sigil === "#" || !!members?.length) &&
    !picked.some((t) => (trigger.sigil + trigger.query).startsWith(t));
  const found = useMentionables(triggerOpen, chatId, botId);
  const mentionChoices = trigger ? mentionOptions(trigger.sigil, trigger.query, found.data, members) : [];
  // Spaces are allowed while the text still matches something.
  const mentioning = triggerOpen && (!/\s/.test(trigger!.query) || mentionChoices.length > 0);
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
  const voice = useComposerVoice({ chatId, botName, draft, change, input, startChat });
  // Enter guides an active reply. Queue explicitly saves a separate turn.
  const ready = !!draft.trim() || files.length > 0;
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
    const sent = await send({
      delivery: queue ? "queue" : "steer",
      ...(files.length && { attachments: files }),
      ...(quote && { quote }),
      ...(mentions.length && { mentions: mentions.map(toInput) }),
    });
    if (sent) {
      setFiles([]);
      setMentions([]);
      setPicked([]);
      setAttachError("");
      reply?.setQuote("");
    }
  }
  useEffect(() => {
    if (!show) {
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
  }, [show, botId, chatId, sourceKey]);
  const query = (sub?.[2] ?? draft.slice(1)).toLowerCase();
  const parent =
    sub &&
    choices.find((c) =>
      [c.command, ...(c.aliases || [])].includes(sub[1].toLowerCase()),
    );
  const options = sub
    ? (parent?.options ?? []).map(
        (o) =>
          ({
            name: parent!.name + " " + o.name,
            command: parent!.command + " " + o.name,
            source: parent!.source,
            description: o.description,
            kind: parent!.kind,
          }) as Capability,
      )
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
        (!busy || c.duringTurn) &&
        [c.command, c.name, c.source, c.description, ...(c.aliases ?? [])].some(
          (t) => t?.toLowerCase().includes(query),
        ),
    )
    .sort((a, b) => rank(a) - rank(b));
  const visible =
    show && (!sub || (!!parent?.options?.length && !!matches.length));
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => {
    document
      .getElementById(listId + "-" + selected)
      ?.scrollIntoView({ block: "nearest" });
  }, [listId, selected]);
  function select(i: number, activate = false) {
    if (!matches[i]) return;
    if (activate && matches[i].command === "model" && pickModel) {
      change("");
      pickModel();
      return;
    }
    change("/" + matches[i].command + " ");
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
      {(quote || files.length > 0 || mentions.length > 0 || attachError) && (
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
          {(files.length > 0 || mentions.length > 0) && (
            <div className="composer-chips">
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
          placeholder={placeholder}
          value={draft}
          onPaste={(e) => {
            if (e.clipboardData.files.length && fromFiles(e.clipboardData.files)) e.preventDefault();
          }}
          onFocus={() => focus(true)}
          onBlur={() => focus(false)}
          onChange={(e) => {
            change(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            dismiss(false);
            setIndex(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
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
              if (!sending && draft.trim() && !(visible && loading))
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
            className={draft.trim() ? "send stop-quiet" : "send"}
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
        {(side || (busy ? !!draft.trim() : ready)) && (
          <button
            className="send"
            aria-label={busy && !side ? "Guide reply" : "Send message"}
            title={busy && !side ? "Guide the current reply when supported, or send after it finishes" : undefined}
            disabled={sending || !draft.trim() || draft.trim() === "/"}
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
          loading={found.loading}
          error={found.error}
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
          <div className="slash-heading">Commands, skills and tools</div>
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
