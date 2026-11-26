// Rich `{{field}}` chip input for workflow prompts, messages, and templates.
// - Saved text stays plain `{{name}}` / `{{name?}}`.
// - Renders fields as inline chips; Backspace removes a whole chip in one stroke.
// - Chips turn warning-colored with a tooltip when partial-path, missing, or ambiguous.
// - Typing `{{` or clicking "Insert field" opens a compact filterable picker (prefix matches first,
//   bold match highlight, step icon & type/choices, Arrow keys, Enter/Tab, "No matches").

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Braces, GitBranch, ShieldCheck, Sparkles, Zap } from "lucide-react";
import type { AvailableField, NodeFieldAnalysis } from "./workflowAnalysis";
import { parseTemplateTokens } from "./workflowAnalysis";

interface Props {
  value: string;
  onChange: (next: string) => void;
  analysis?: NodeFieldAnalysis;
  placeholder?: string;
  multiline?: boolean;
  label?: string;
  id?: string;
}

function chipStatus(name: string, optional: boolean, analysis?: NodeFieldAnalysis): { warn: boolean; tooltip: string } {
  if (!analysis) return { warn: false, tooltip: `{{${name}${optional ? "?" : ""}}}` };
  if (analysis.ambiguous[name]) {
    return {
      warn: true,
      tooltip: `Ambiguous field "${name}" — provided by multiple steps on the same path (${analysis.ambiguous[name].join(", ")}).`,
    };
  }
  const meta = analysis.available.find((f) => f.name === name);
  if (!meta) {
    return {
      warn: true,
      tooltip: `Unknown field "${name}" — no upstream step provides it.`,
    };
  }
  if (!meta.guaranteed && !optional) {
    return {
      warn: true,
      tooltip: `Not every path provides "${name}" (only from ${meta.sources.join(", ")}). Use {{${name}?}} if optional.`,
    };
  }
  return {
    warn: false,
    tooltip: `${name} (${meta.type}) · from ${meta.sources.join(", ")}${meta.description ? ` — ${meta.description}` : ""}`,
  };
}

function StepIcon({ kind }: { kind: AvailableField["sourceKind"] }) {
  switch (kind) {
    case "trigger":
      return <Zap size={12} />;
    case "agent":
      return <Bot size={12} />;
    case "model":
      return <Sparkles size={12} />;
    case "condition":
      return <GitBranch size={12} />;
    case "approval":
      return <ShieldCheck size={12} />;
    default:
      return <Braces size={12} />;
  }
}

/** Highlights the first case-insensitive match of `query` in `text`. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <strong>{text.slice(idx, idx + query.length)}</strong>
      {text.slice(idx + query.length)}
    </>
  );
}

/** Serializes the contentEditable DOM back to plain text with `{{field}}` tokens. */
function serializeDom(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\u200B/g, "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const token = el.getAttribute("data-wf-token");
    if (token) {
      out += token;
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

/** Builds DOM nodes (text + non-editable chip spans) for a plain `{{field}}` string. */
function populateDom(root: HTMLElement, value: string, analysis?: NodeFieldAnalysis) {
  root.innerHTML = "";
  if (!value) return;
  const tokens = parseTemplateTokens(value);
  let cursor = 0;
  const appendText = (chunk: string) => {
    if (!chunk) return;
    const parts = chunk.split("\n");
    parts.forEach((p, idx) => {
      if (idx > 0) root.appendChild(document.createElement("br"));
      if (p) root.appendChild(document.createTextNode(p));
    });
  };
  for (const tok of tokens) {
    if (tok.start > cursor) appendText(value.slice(cursor, tok.start));
    const status = chipStatus(tok.name, tok.optional, analysis);
    const chip = document.createElement("span");
    chip.className = "wf-chip" + (status.warn ? " wf-chip-warn" : "");
    chip.contentEditable = "false";
    chip.setAttribute("data-wf-token", tok.raw);
    chip.setAttribute("data-wf-field", tok.name);
    chip.title = status.tooltip;
    chip.textContent = tok.optional ? `${tok.name}?` : tok.name;
    root.appendChild(chip);
    cursor = tok.end;
  }
  if (cursor < value.length) appendText(value.slice(cursor));
}

export function WorkflowFieldInput({ value, onChange, analysis, placeholder, multiline = true, label, id }: Props) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastSerializedRef = useRef<string>(value);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerSource, setPickerSource] = useState<"braces" | "button">("button");
  const [activeIdx, setActiveIdx] = useState(0);
  const savedRangeRef = useRef<Range | null>(null);

  // Sync external value or field-analysis changes into DOM without clobbering cursor during normal typing.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value !== lastSerializedRef.current || !document.activeElement || document.activeElement !== el) {
      populateDom(el, value, analysis);
      lastSerializedRef.current = value;
    }
  }, [value, analysis]);

  const fields = useMemo(() => {
    const all = analysis?.available ?? [];
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return all;
    const prefix: AvailableField[] = [];
    const rest: AvailableField[] = [];
    for (const f of all) {
      const nameLow = f.name.toLowerCase();
      const srcLow = f.sourceLabel.toLowerCase();
      if (nameLow.startsWith(q)) prefix.push(f);
      else if (nameLow.includes(q) || srcLow.includes(q)) rest.push(f);
    }
    return [...prefix, ...rest];
  }, [analysis, pickerQuery]);

  useEffect(() => {
    setActiveIdx(0);
  }, [pickerQuery, pickerOpen]);

  const detectOpenBraces = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editorRef.current?.contains(sel.anchorNode)) return;
    const node = sel.anchorNode;
    if (node?.nodeType !== Node.TEXT_NODE) {
      if (pickerSource === "braces") setPickerOpen(false);
      return;
    }
    const textBefore = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const match = /\{\{([a-zA-Z0-9_.-]*)$/.exec(textBefore);
    if (match) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      setPickerSource("braces");
      setPickerQuery(match[1]);
      setPickerOpen(true);
    } else if (pickerSource === "braces") {
      setPickerOpen(false);
    }
  }, [pickerSource]);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = serializeDom(el);
    lastSerializedRef.current = next;
    onChange(next);
  }, [onChange]);

  const insertField = useCallback(
    (field: AvailableField) => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();

      const sel = window.getSelection();
      let range = savedRangeRef.current;
      if (range && !el.contains(range.startContainer)) range = null;
      if (!range && sel && sel.rangeCount && el.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0);
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }

      // If triggered by typing `{{query`, remove that `{{query` prefix before inserting the chip.
      if (pickerSource === "braces" && range.startContainer.nodeType === Node.TEXT_NODE) {
        const textNode = range.startContainer as Text;
        const before = textNode.textContent?.slice(0, range.startOffset) ?? "";
        const m = /\{\{([a-zA-Z0-9_.-]*)$/.exec(before);
        if (m) {
          range.setStart(textNode, range.startOffset - m[0].length);
          range.deleteContents();
        }
      }

      const rawToken = `{{${field.name}}}`;
      const status = chipStatus(field.name, false, analysis);
      const chip = document.createElement("span");
      chip.className = "wf-chip" + (status.warn ? " wf-chip-warn" : "");
      chip.contentEditable = "false";
      chip.setAttribute("data-wf-token", rawToken);
      chip.setAttribute("data-wf-field", field.name);
      chip.title = status.tooltip;
      chip.textContent = field.name;

      range.deleteContents();
      range.insertNode(chip);
      const space = document.createTextNode(" ");
      chip.after(space);

      const afterRange = document.createRange();
      afterRange.setStart(space, 1);
      afterRange.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(afterRange);

      setPickerOpen(false);
      setPickerQuery("");
      savedRangeRef.current = null;
      emitChange();
    },
    [analysis, emitChange, pickerSource],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (fields.length ? (i + 1) % fields.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (fields.length ? (i - 1 + fields.length) % fields.length : 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && fields[activeIdx]) {
        e.preventDefault();
        insertField(fields[activeIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickerOpen(false);
        return;
      }
    }

    if (!multiline && e.key === "Enter") {
      e.preventDefault();
      return;
    }

    // Backspace immediately after a field chip deletes the entire chip in one keystroke.
    if (e.key === "Backspace") {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (el && sel && sel.isCollapsed && sel.rangeCount) {
        const { anchorNode, anchorOffset } = sel;
        let prevChip: HTMLElement | null = null;
        if (anchorNode === el && anchorOffset > 0) {
          const prev = el.childNodes[anchorOffset - 1];
          if (prev instanceof HTMLElement && prev.hasAttribute("data-wf-token")) prevChip = prev;
        } else if (anchorNode?.nodeType === Node.TEXT_NODE && anchorOffset === 0) {
          const prev = anchorNode.previousSibling;
          if (prev instanceof HTMLElement && prev.hasAttribute("data-wf-token")) prevChip = prev;
        }
        if (prevChip) {
          e.preventDefault();
          prevChip.remove();
          emitChange();
          return;
        }
      }
    }
  };

  const handleInput = () => {
    // Convert manually completed `{{field}}` into a chip right away.
    const el = editorRef.current;
    if (!el) return;
    const raw = serializeDom(el);
    lastSerializedRef.current = raw;
    onChange(raw);
    detectOpenBraces();
  };

  const handleBlur = () => {
    // Re-render any manually typed `{{field}}` into chips on blur.
    const el = editorRef.current;
    if (el) populateDom(el, lastSerializedRef.current, analysis);
  };

  const handleOpenButton = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
    setPickerSource("button");
    setPickerQuery("");
    setPickerOpen((o) => !o);
  };

  const warnings = useMemo(() => {
    const tokens = parseTemplateTokens(value);
    const list: string[] = [];
    for (const tok of tokens) {
      const s = chipStatus(tok.name, tok.optional, analysis);
      if (s.warn && !list.includes(s.tooltip)) list.push(s.tooltip);
    }
    return list;
  }, [value, analysis]);

  return (
    <div className="wf-field-wrap">
      <div className="wf-field-head">
        {label && (
          <label className="wf-label" htmlFor={id}>
            {label}
          </label>
        )}
        <button
          type="button"
          className="wf-insert-btn"
          onMouseDown={(e) => {
            e.preventDefault();
            handleOpenButton();
          }}
        >
          <Braces size={12} /> Insert field
        </button>
      </div>

      <div className="wf-field-box">
        <div
          id={id}
          ref={editorRef}
          className={"wf-field-editor" + (multiline ? " multiline" : " single")}
          contentEditable
          role="textbox"
          aria-multiline={multiline}
          aria-label={label || "Template"}
          data-placeholder={placeholder || "Type text or {{ to insert a field…"}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={detectOpenBraces}
          onBlur={handleBlur}
          suppressContentEditableWarning
        />

        {pickerOpen && (
          <div className="wf-field-popover" role="listbox" aria-label="Insert field">
            {pickerSource === "button" && (
              <input
                type="text"
                className="wf-popover-search"
                placeholder="Filter fields…"
                value={pickerQuery}
                autoFocus
                onChange={(e) => setPickerQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIdx((i) => (fields.length ? (i + 1) % fields.length : 0));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIdx((i) => (fields.length ? (i - 1 + fields.length) % fields.length : 0));
                  } else if ((e.key === "Enter" || e.key === "Tab") && fields[activeIdx]) {
                    e.preventDefault();
                    insertField(fields[activeIdx]);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setPickerOpen(false);
                  }
                }}
              />
            )}
            <div className="wf-popover-list">
              {fields.length === 0 ? (
                <div className="wf-popover-empty">No matches</div>
              ) : (
                fields.map((f, idx) => (
                  <button
                    key={`${f.sourceNodeId}:${f.name}`}
                    type="button"
                    role="option"
                    aria-selected={idx === activeIdx}
                    className={"wf-popover-item" + (idx === activeIdx ? " active" : "")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      insertField(f);
                    }}
                    onMouseEnter={() => setActiveIdx(idx)}
                  >
                    <span className="wf-popover-icon">
                      <StepIcon kind={f.sourceKind} />
                    </span>
                    <span className="wf-popover-main">
                      <span className="wf-popover-name">
                        <Highlight text={f.name} query={pickerQuery} />
                        {!f.guaranteed && <span className="wf-popover-partial">partial path</span>}
                      </span>
                      <span className="wf-popover-meta">
                        {f.sourceLabel} · {f.type}
                        {f.choices?.length ? ` (${f.choices.slice(0, 3).join(", ")}${f.choices.length > 3 ? "…" : ""})` : ""}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="wf-field-warnings">
          {warnings.map((w, i) => (
            <div key={i} className="wf-field-warning">
              <AlertTriangle size={12} /> <span>{w}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
