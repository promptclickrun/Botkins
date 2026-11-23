// Text from a bot or a person, rendered as GitHub-flavored Markdown: tables, task lists,
// strikethrough, footnotes, callouts and highlighted code with a Copy button.
// Raw HTML in the text is never rendered. Links open in the browser. The page loads nothing
// remote, so an image shows as a link to it.
import { Fragment, createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Image as ImageIcon, Info, Lightbulb, MessageSquareWarning, OctagonAlert, TriangleAlert } from "lucide-react";
import "./markdown.css";
import { ChatFileContext, FileLink, pathMarkup, useChatFiles, type ChatFiles } from "./ChatFileLink";
import { ChatMedia } from "./ChatMedia";

const api = window.botkins;

const CALLOUTS = {
  note: ["Note", Info],
  tip: ["Tip", Lightbulb],
  important: ["Important", MessageSquareWarning],
  warning: ["Warning", TriangleAlert],
  caution: ["Caution", OctagonAlert],
} as const;
type Callout = keyof typeof CALLOUTS;

type Node = { type: string; value?: string; tagName?: string; children?: Node[]; data?: Record<string, unknown>; properties?: Record<string, unknown>; position?: { start: { offset?: number }; end: { offset?: number } } };

/** GitHub alerts: a quote that starts with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION]. */
function remarkCallouts() {
  const walk = (node: Node) => {
    for (const child of node.children ?? []) walk(child);
    if (node.type !== "blockquote") return;
    const first = node.children?.[0];
    const text = first?.type === "paragraph" ? first.children?.[0] : undefined;
    const match = text?.type === "text" ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(text.value ?? "") : null;
    if (!first || !text || !match) return;
    text.value = (text.value ?? "").slice(match[0].length);
    if (!text.value) first.children!.shift();
    if (!first.children!.length) node.children!.shift();
    node.data = { ...node.data, hProperties: { "data-callout": match[1].toLowerCase() } };
  };
  return (tree: Node) => walk(tree);
}

/** The text inside a rendered element, for Copy. */
const textOf = (node?: Node): string => (node ? (node.value ?? (node.children ?? []).map(textOf).join("")) : "");

function CodeBlock({ node, children }: { node?: Node; children?: ReactNode }) {
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const classes = ([] as unknown[]).concat(code?.properties?.className ?? []).map(String);
  const language = classes.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  const { found } = useContext(ChatFileContext);
  const codeText = textOf(code ?? node).replace(/\n$/, "");
  const start = node?.position?.start.offset ?? -1;
  const end = node?.position?.end.offset ?? -1;
  const blockPaths = new Map(found.flatMap((span, index) => span.start >= start && span.end <= end ? [[span.path, index] as const] : []));
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{language || "text"}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() =>
            void api
              .copyText(textOf(code ?? node).replace(/\n$/, ""))
              .then(() => {
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => {})
          }
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{blockPaths.size ? <code>{codeText.split("\n").map((line, index) => {
        const trimmed = line.trim();
        const quoted = /^(['"`]).+\1$/.test(trimmed);
        const value = quoted ? trimmed.slice(1, -1) : trimmed;
        const position = blockPaths.get(value);
        const at = line.indexOf(value);
        return <Fragment key={index}>{index > 0 && "\n"}{position === undefined ? line : <>
          {line.slice(0, at)}<FileLink index={position}>{value}</FileLink>{line.slice(at + value.length)}
        </>}</Fragment>;
      })}</code> : children}</pre>
    </div>
  );
}

/** The web address in a link or image target, if it is one. */
const web = (href: unknown) => (typeof href === "string" && /^https?:\/\//i.test(href) ? href : undefined);
const open = (href: string) => (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
  void api.openLink(href);
};
/** True inside a link. An image there is part of that link, not a second link of its own. */
const InLink = createContext(false);


/** A link in the text: web addresses open in the browser; a footnote link moves within the text. */
function Anchor({ href, children }: { href?: string; children?: ReactNode }) {
  const url = web(href);
  if (url)
    return (
      <a href={url} title={url} onClick={open(url)}>
        <InLink.Provider value>{children}</InLink.Provider>
      </a>
    );
  // A footnote's link moves to its note (or back) inside the same message.
  if (typeof href === "string" && href.startsWith("#") && href.length > 1)
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          const target = e.currentTarget.closest(".md")?.querySelector("#" + CSS.escape(href.slice(1)));
          target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }}
      >
        {children}
      </a>
    );
  return <span>{children}</span>;
}

/** An image is never loaded. It shows as a link to the picture, or as a label when it sits inside a link. */
function Picture({ src, alt }: { src?: unknown; alt?: string }) {
  const inLink = useContext(InLink);
  const url = web(src);
  if (url && !inLink)
    return (
      <a className="md-image" href={url} title={url} onClick={open(url)}>
        <ImageIcon size={13} aria-hidden="true" />
        {alt || "Image"}
      </a>
    );
  if (!url && !alt) return null;
  return (
    <span className="md-image">
      {url && <ImageIcon size={13} aria-hidden="true" />}
      {alt || "Image"}
    </span>
  );
}

const components: Components = {
  a: Anchor,
  img: ({ src, alt }) => <Picture src={src} alt={alt} />,
  pre: ({ node, children }) => <CodeBlock node={node as Node | undefined}>{children}</CodeBlock>,
  span: ({ node, children, ...props }) => {
    const marker = node?.properties?.["data-chat-file"] ?? node?.properties?.dataChatFile;
    if (marker != null) return <FileLink index={Number(marker)}>{children}</FileLink>;
    const media = node?.properties?.["data-chat-media"] ?? node?.properties?.dataChatMedia;
    if (media != null) return <ChatMedia index={Number(media)} />;
    return <span {...props}>{children}</span>;
  },
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
  blockquote: ({ node: _node, children, ...props }) => {
    const kind = (props as Record<string, unknown>)["data-callout"] as Callout | undefined;
    if (!kind || !CALLOUTS[kind]) return <blockquote>{children}</blockquote>;
    const [label, Icon] = CALLOUTS[kind];
    return (
      <div className={"md-callout md-callout-" + kind} role="note">
        <p className="md-callout-title">
          <Icon size={14} aria-hidden="true" />
          {label}
        </p>
        {children}
      </div>
    );
  },
};
// One tilde is everyday writing ("~5 minutes"); only "~~text~~" strikes text out.
const remarkPlugins: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }], remarkCallouts];
// Code is colored only when its block names a language.
const rehypePlugins: Options["rehypePlugins"] = [[rehypeHighlight, { detect: false }]];

/** The Markdown rules the app reads text with, for other renderings of the same text (the wiki's export). */
export const markdownRules = { remarkPlugins, rehypePlugins, callouts: CALLOUTS };

/** Draws a link that is neither a web address nor a place in the same text, such as a wiki page's path. */
export type LinkRenderer = (href: string, children: ReactNode) => ReactNode;

/**
 * The Markdown of `text` as the page's elements, with no box around them: the rows of a box that
 * other blocks share (a reply that is still arriving, see src/StreamingText.tsx) sit side by side.
 * Unchanged text is not parsed again when what is around it updates.
 */
export const RichBody = memo(function RichBody({ text, link, files }: { text: string; link?: LinkRenderer; files?: ChatFiles }) {
  const found = useChatFiles(text, files);
  const plugins = useMemo<Options["remarkPlugins"]>(() => found.length
    ? [...remarkPlugins!, pathMarkup(text, found)]
    : remarkPlugins, [text, found]);
  const own = useMemo<Components | undefined>(() => link ? {
    ...components,
    a: (props) => {
      const href = props.href;
      if (!href || web(href) || href.startsWith("#")) return <Anchor {...props} />;
      return <InLink.Provider value>{link(href, props.children)}</InLink.Provider>;
    },
  } : undefined, [link]);
  return (
    <ChatFileContext.Provider value={{ files, found }}>
      <Markdown components={own ?? components} remarkPlugins={plugins} rehypePlugins={rehypePlugins}>{text}</Markdown>
    </ChatFileContext.Provider>
  );
});

/**
 * Markdown text. Unchanged text is not parsed again when the chat around it updates.
 * `link` draws links to other places in the app (the Wiki uses it for its pages); without it, as in
 * chats, such a link is plain text.
 */
export const RichText = memo(function RichText({ text, link, files }: { text: string; link?: LinkRenderer; files?: ChatFiles }) {
  return <div className="md"><RichBody text={text} link={link} files={files} /></div>;
});
