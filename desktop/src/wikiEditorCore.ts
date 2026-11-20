// The wiki's rich Markdown editor: Milkdown Crepe, built from only the features the wiki uses.
// Loaded on demand (src/WikiEditor.tsx imports this file), so chats never load the editor.
//
// Nothing here touches the network: images, image upload, math and the AI feature are left out,
// and dropped or pasted files are never turned into images.
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { APPEARANCE_EVENT } from "./appearance";
import { blockEdit } from "@milkdown/crepe/feature/block-edit";
import { codeMirror, setCodeMirrorTheme } from "@milkdown/crepe/feature/code-mirror";
import { cursor } from "@milkdown/crepe/feature/cursor";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { placeholder } from "@milkdown/crepe/feature/placeholder";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import { languages } from "@codemirror/language-data";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { commandsCtx, editorViewCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { uploadConfig } from "@milkdown/kit/plugin/upload";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import {
  addBlockTypeCommand,
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  isMarkSelectedCommand,
  linkSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  remarkPreserveEmptyLinePlugin,
  selectTextNearPosCommand,
  setBlockTypeCommand,
  strongSchema,
  emphasisSchema,
  toggleEmphasisCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { createTable, remarkGFMPlugin, strikethroughSchema, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { MarkType } from "@milkdown/kit/prose/model";
import { undo, redo } from "@milkdown/kit/prose/history";

import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "./wiki-editor.css";

export type Block = "paragraph" | "h1" | "h2" | "h3" | "h4";
export type Command =
  | Block
  | "bold"
  | "italic"
  | "strike"
  | "bullets"
  | "numbers"
  | "tasks"
  | "quote"
  | "code"
  | "table"
  | "divider"
  | "link"
  | "undo"
  | "redo";

/** What the toolbar shows as on: the block at the caret and the marks on the selection. */
export type Active = { block: Block | "other"; bold: boolean; italic: boolean; strike: boolean; link: boolean };

export type WikiEditorHandle = {
  markdown: () => string;
  run: (command: Command) => void;
  /** Inserts a link at the caret, or turns the selected text into one. */
  insertLink: (href: string, text: string) => void;
  active: () => Active;
  focus: () => void;
  destroy: () => Promise<void>;
};

/** Applies `change` to each line's text outside code: fenced blocks and `inline code` stay as they are. */
function outsideCode(markdown: string, change: (text: string) => string) {
  let fence = "";
  return markdown
    .split("\n")
    .map((line) => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim()) fence = "";
        return line;
      }
      if (mark) {
        fence = mark;
        return line;
      }
      // Odd parts are code spans: a run of backticks, the code, and the same run again.
      const parts: string[] = [];
      let rest = line;
      for (;;) {
        const open = /`+/.exec(rest);
        const close = open && rest.indexOf(open[0], open.index + open[0].length);
        if (!open || close === null || close < 0) break;
        parts.push(rest.slice(0, open.index), rest.slice(open.index, close + open[0].length));
        rest = rest.slice(close + open[0].length);
      }
      parts.push(rest);
      return parts.map((part, i) => (i % 2 ? part : change(part))).join("");
    })
    .join("\n");
}

/**
 * Undoes escapes the Markdown writer adds where the wiki doesn't need them, so a page keeps its text:
 * a lone "~" ("~5 minutes": only "~~" strikes text out here), a "*" between spaces, a callout's
 * "[!NOTE]", and an empty task box "- [ ]" in a template.
 */
export function tidyMarkdown(markdown: string) {
  return outsideCode(markdown, (text) =>
    text
      .replace(/(?<!~)\\~(?!\\?~)/g, "~")
      // "5 * 3": a star between spaces can't start or end emphasis.
      .replace(/(?<=\s)\\\*(?=\s)/g, "*")
      .replace(/^(\s*(?:>\s*)+)\\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, "$1[!$2]")
      .replace(/^(\s*(?:[-*+]|\d+[.)]) )\\\[([ xX])\]\s*$/, "$1[$2]"),
  );
}

/** Code blocks in Botkins' colors, with highlighting that reads in light and in dark. */
const codeTheme = (dark: boolean) => [
  EditorView.theme(
    {
      "&": { backgroundColor: "transparent", color: "var(--ink)", fontSize: "13px" },
      ".cm-content": { caretColor: "var(--ink)" },
      ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--ink) 5%, transparent)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
      },
    },
    { dark },
  ),
  syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
];
const isDark = () => document.documentElement.dataset.mode === "dark";

function markOn(ctx: Ctx, type: MarkType) {
  if (ctx.get(commandsCtx).call(isMarkSelectedCommand.key, type)) return true;
  const { state } = ctx.get(editorViewCtx);
  if (state.storedMarks) return state.storedMarks.some((m) => m.type === type);
  const cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
  return !!cursor?.marks().some((m) => m.type === type);
}

/**
 * Creates the editor in `root` with `markdown`. `changed` runs after every edit with the new Markdown;
 * `selection` runs when the caret moves, so the toolbar can follow.
 */
export async function createWikiEditor(
  root: HTMLElement,
  markdown: string,
  { changed, selection, label }: { changed: (markdown: string) => void; selection: () => void; label: string },
): Promise<WikiEditorHandle> {
  const crepe = new CrepeBuilder({ root, defaultValue: markdown });
  crepe.editor.config((ctx) => {
    // Plain Markdown that diffs well: "-" bullets, "*" emphasis, "**" bold, fenced code, and no
    // escaping of characters that are ordinary text, such as "~5", "$5" and snake_case.
    ctx.update(remarkStringifyOptionsCtx, (options) => ({
      ...options,
      bullet: "-" as const,
      emphasis: "*" as const,
      strong: "*" as const,
      fence: "`" as const,
      fences: true,
      rule: "-" as const,
      listItemIndent: "one" as const,
    }));
    // One tilde is everyday writing ("~5 minutes"); only "~~text~~" strikes text out, as in chats.
    ctx.set(remarkGFMPlugin.options.key, { singleTilde: false });
    // Files dropped or pasted into a page never become images: the page loads nothing from outside.
    ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: async () => [] }));
  });
  // An empty paragraph (an empty bullet in a template, say) stays empty instead of becoming "<br />".
  await crepe.editor.remove(remarkPreserveEmptyLinePlugin);
  crepe
    .addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip, { inputPlaceholder: "Paste a web address or a page path" })
    .addFeature(toolbar)
    .addFeature(placeholder, { text: "Start writing, or type / for headings, lists and tables", mode: "block" })
    .addFeature(table)
    .addFeature(codeMirror, {
      languages,
      theme: codeTheme(isDark()),
      searchPlaceholder: "Search languages",
      noResultText: "No matching language",
    })
    .addFeature(blockEdit, {
      textGroup: { label: "Text", h5: null, h6: null },
      listGroup: { label: "Lists" },
      advancedGroup: { label: "Insert", image: null, math: null },
    });
  crepe.on((api) => {
    api.markdownUpdated((_ctx, next) => changed(tidyMarkdown(next)));
    api.selectionUpdated(() => selection());
  });
  await crepe.create();
  // Code blocks follow the app between light and dark.
  const appearance = () => crepe.editor.action(setCodeMirrorTheme(codeTheme(isDark())));
  window.addEventListener(APPEARANCE_EVENT, appearance);
  const view = () => crepe.editor.ctx.get(editorViewCtx);
  const dom = view().dom;
  dom.setAttribute("aria-label", label);
  dom.setAttribute("aria-multiline", "true");
  dom.setAttribute("role", "textbox");

  const act = (fn: (ctx: Ctx) => void) => crepe.editor.action(fn);
  const call = (key: typeof toggleStrongCommand.key) =>
    act((ctx) => {
      ctx.get(commandsCtx).call(key);
    });
  const heading = (level: number) =>
    act((ctx) => ctx.get(commandsCtx).call(setBlockTypeCommand.key, { nodeType: headingSchema.type(ctx), attrs: { level } }));

  return {
    markdown: () => tidyMarkdown(crepe.getMarkdown()),
    focus: () => view().focus(),
    destroy: async () => {
      window.removeEventListener(APPEARANCE_EVENT, appearance);
      await crepe.destroy();
    },
    active: () => {
      let result: Active = { block: "other", bold: false, italic: false, strike: false, link: false };
      act((ctx) => {
        const { $from } = ctx.get(editorViewCtx).state.selection;
        const node = $from.parent;
        const block: Active["block"] =
          node.type === headingSchema.type(ctx)
            ? ((["h1", "h2", "h3", "h4"][(node.attrs.level as number) - 1] as Block | undefined) ?? "other")
            : node.type === paragraphSchema.type(ctx)
              ? "paragraph"
              : "other";
        result = {
          block,
          bold: markOn(ctx, strongSchema.type(ctx)),
          italic: markOn(ctx, emphasisSchema.type(ctx)),
          strike: markOn(ctx, strikethroughSchema.type(ctx)),
          link: markOn(ctx, linkSchema.type(ctx)),
        };
      });
      return result;
    },
    run: (command) => {
      const v = view();
      switch (command) {
        case "paragraph":
          act((ctx) => ctx.get(commandsCtx).call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) }));
          break;
        case "h1":
        case "h2":
        case "h3":
        case "h4":
          heading(Number(command[1]));
          break;
        case "bold":
          call(toggleStrongCommand.key);
          break;
        case "italic":
          call(toggleEmphasisCommand.key);
          break;
        case "strike":
          call(toggleStrikethroughCommand.key);
          break;
        case "bullets":
          act((ctx) => ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) }));
          break;
        case "numbers":
          act((ctx) => ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) }));
          break;
        case "tasks":
          act((ctx) =>
            ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, { nodeType: listItemSchema.type(ctx), attrs: { checked: false } }),
          );
          break;
        case "quote":
          act((ctx) => ctx.get(commandsCtx).call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) }));
          break;
        case "code":
          act((ctx) => ctx.get(commandsCtx).call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) }));
          break;
        case "table":
          act((ctx) => {
            const commands = ctx.get(commandsCtx);
            const { from } = ctx.get(editorViewCtx).state.selection;
            commands.call(addBlockTypeCommand.key, { nodeType: createTable(ctx, 3, 3) });
            commands.call(selectTextNearPosCommand.key, { pos: from });
          });
          break;
        case "divider":
          act((ctx) => ctx.get(commandsCtx).call(addBlockTypeCommand.key, { nodeType: hrSchema.type(ctx) }));
          break;
        case "link":
          act((ctx) => {
            const view = ctx.get(editorViewCtx);
            const type = linkSchema.type(ctx);
            if (view.state.selection.empty && markOn(ctx, type)) view.dispatch(view.state.tr.removeStoredMark(type));
            else ctx.get(commandsCtx).call(toggleLinkCommand.key);
          });
          break;
        case "undo":
          undo(v.state, v.dispatch);
          break;
        case "redo":
          redo(v.state, v.dispatch);
          break;
      }
      v.focus();
    },
    insertLink: (href, text) => {
      act((ctx) => {
        const view = ctx.get(editorViewCtx);
        const mark = linkSchema.type(ctx).create({ href });
        const { from, to, empty } = view.state.selection;
        const tr = empty
          ? view.state.tr.insert(from, view.state.schema.text(text, [mark])).insertText(" ", from + text.length)
          : view.state.tr.addMark(from, to, mark);
        view.dispatch(tr.scrollIntoView());
        view.focus();
      });
    },
  };
}
