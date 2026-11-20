// The wiki's HTML and PDF export as one self-contained document: a title, the date, a contents list,
// then each page as its own section (each starts on a new printed page). Markdown is read with the
// same rules as the app (src/RichText.tsx). Links between exported pages become places in the
// document, links to pages left out become plain text, and web links stay links. No scripts, and
// nothing loads from anywhere: the styles are inline and images show as their description.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { type Components } from "react-markdown";
import { markdownRules } from "./RichText";
import { pageLookup, resolveLink } from "./wikiModel";

export type ExportPage = { path: string; title: string; section: string; content: string };

const web = (href: unknown) => (typeof href === "string" && /^(https?:|mailto:)/i.test(href) ? href : undefined);
/** A page's place in the document. */
export const anchorOf = (path: string) => "page-" + path.replace(/\.md$/i, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

function components(page: ExportPage, lookup: (path: string) => string | undefined): Components {
  return {
    a: ({ href, children }) => {
      const url = web(href);
      if (url) return <a href={url}>{children}</a>;
      // Footnotes keep working: their ids and links carry the page's own prefix, so pages don't collide.
      if (typeof href === "string" && href.startsWith("#") && href.length > 1) return <a href={href}>{children}</a>;
      const hit = typeof href === "string" ? resolveLink(page.path, href, lookup) : null;
      if (hit?.exists) return <a href={"#" + anchorOf(hit.path)}>{children}</a>;
      return <span>{children}</span>;
    },
    // Images are never loaded; the description stays, with the address when it is on the web.
    img: ({ src, alt }) => {
      const url = web(src);
      const label = "[" + (alt || "Image") + "]";
      return url ? <a href={url}>{label}</a> : alt ? <span className="image">{label}</span> : null;
    },
    pre: ({ children }) => <pre>{children}</pre>,
    blockquote: ({ node: _node, children, ...props }) => {
      const kind = (props as Record<string, unknown>)["data-callout"] as keyof typeof markdownRules.callouts | undefined;
      if (!kind || !markdownRules.callouts[kind]) return <blockquote>{children}</blockquote>;
      return (
        <div className={"callout callout-" + kind}>
          <p className="callout-title">{markdownRules.callouts[kind][0]}</p>
          {children}
        </div>
      );
    },
  };
}

// The Botkins look for a document that can't load the app's fonts or CSS. This is the one place where
// colors are literal: they are the Botkins light theme's values (src/tokens.css) on white paper, since
// the oat canvas prints too dark. Ink #42291F, muted #705746, lines #E7D8BF, accent #923F26, and the
// theme's status colors with their soft steps for callouts and code.
const STYLE = `
@page { size: A4; margin: 18mm 17mm 20mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #fff; }
body { margin: 0 auto; max-width: 760px; padding: 40px 28px 64px; color: #42291F; background: #fff;
  font: 15px/1.65 "Open Sans", -apple-system, "Segoe UI", sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print { body { max-width: none; padding: 0; } }
a { color: #923F26; text-decoration: underline; text-decoration-color: #E7D8BF; text-underline-offset: 2px; }
h1, h2, h3, h4, h5, h6 { font-family: "DejaVu Serif", Georgia, serif; font-weight: 700; line-height: 1.25; break-after: avoid; page-break-after: avoid; }
.cover { padding-bottom: 8px; }
.doc-kicker { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: #705746; }
.doc-title { margin: 0; font-size: 34px; line-height: 1.15; }
.doc-meta { margin: 8px 0 28px; color: #705746; font-size: 13px; }
.toc { border-top: 1px solid #E7D8BF; padding-top: 18px; }
.toc h2 { margin: 0 0 10px; font-size: 17px; }
.toc ol { margin: 0; padding: 0; list-style: none; }
.toc li { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; }
.toc li a { color: #42291F; text-decoration: none; font-weight: 600; }
.toc li span { margin-left: auto; color: #705746; font-size: 13px; white-space: nowrap; }
.page { break-before: page; page-break-before: always; padding-top: 36px; }
@media screen { .page { margin-top: 44px; border-top: 1px solid #E7D8BF; } }
@media print { .page { padding-top: 0; } }
.page-section { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: #705746; }
.page-path { margin: 2px 0 18px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #705746; }
.page h1 { margin: 0 0 6px; font-size: 28px; }
.page h2 { margin: 28px 0 8px; font-size: 20px; }
.page h3 { margin: 22px 0 6px; font-size: 17px; }
.page h4, .page h5, .page h6 { margin: 18px 0 6px; font-size: 15px; }
p, ul, ol, blockquote, pre, table, .callout { margin: 0 0 12px; }
ul, ol { padding-left: 24px; }
li + li { margin-top: 3px; }
li > p { margin: 0; }
.contains-task-list { list-style: none; padding-left: 4px; }
.task-list-item input { margin: 0 7px 0 0; vertical-align: -1px; accent-color: #923F26; }
hr { border: 0; border-top: 1px solid #E7D8BF; margin: 20px 0; }
blockquote { padding: 2px 0 2px 14px; border-left: 3px solid #E7D8BF; color: #5A3F31; }
code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #F3E6CD; border-radius: 4px; padding: 1px 4px; }
pre { padding: 11px 13px; background: #FBF1DE; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; break-inside: avoid; }
th, td { text-align: left; padding: 6px 9px; border-bottom: 1px solid #E7D8BF; vertical-align: top; }
th { font-weight: 600; border-bottom-color: #CFBCA3; }
td[align="right"], th[align="right"] { text-align: right; }
td[align="center"], th[align="center"] { text-align: center; }
del { color: #705746; }
.image { color: #705746; font-style: italic; }
.callout { padding: 10px 14px; border-radius: 12px; background: #FBF1DE; break-inside: avoid; }
.callout > :last-child { margin-bottom: 0; }
.callout-title { margin: 0 0 4px; font-size: 13px; font-weight: 700; }
.callout-note { background: #D6E5DB; } .callout-note .callout-title { color: #3B6A5D; }
.callout-tip { background: #DDE6CB; } .callout-tip .callout-title { color: #41633D; }
.callout-important { background: #F3D8C3; } .callout-important .callout-title { color: #923F26; }
.callout-warning { background: #F7E3B9; } .callout-warning .callout-title { color: #865514; }
.callout-caution { background: #F5D8D0; } .callout-caution .callout-title { color: #9F3935; }
.footnotes { margin-top: 24px; padding-top: 8px; border-top: 1px solid #E7D8BF; font-size: 13px; color: #5A3F31; }
.footnotes h2 { font-size: 13px; margin: 0 0 6px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #923F26; }
.hljs-string, .hljs-attr, .hljs-template-tag { color: #41633D; }
.hljs-number, .hljs-literal { color: #865514; }
.hljs-comment, .hljs-quote { color: #705746; font-style: italic; }
.hljs-title, .hljs-function, .hljs-section { color: #3B6A5D; }
.hljs-variable, .hljs-params, .hljs-type { color: #5A3F31; }
`;

/** The whole document as HTML text, ready to save or print. */
export function exportDocument({ title, pages, date = new Date() }: { title: string; pages: ExportPage[]; date?: Date }) {
  const lookup = pageLookup(pages.map((p) => p.path));
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const count = pages.length === 1 ? "1 page" : pages.length + " pages";
  const body: ReactNode = (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="generator" content="Botkins" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <header className="cover">
          <p className="doc-kicker">Wiki export</p>
          <h1 className="doc-title">{title}</h1>
          <p className="doc-meta">
            Exported from the Botkins wiki on {day} · {count}
          </p>
          <nav className="toc" aria-label="Contents">
            <h2>Contents</h2>
            <ol>
              {pages.map((p) => (
                <li key={p.path}>
                  <a href={"#" + anchorOf(p.path)}>{p.title}</a>
                  <span>{p.section}</span>
                </li>
              ))}
            </ol>
          </nav>
        </header>
        <main>
          {pages.map((p, i) => {
            const prefix = "p" + (i + 1) + "-";
            return (
              <section className="page" id={anchorOf(p.path)} key={p.path} aria-label={p.title}>
                <p className="page-section">{p.section}</p>
                {!/^\s*#\s+\S/.test(p.content) && <h1>{p.title}</h1>}
                <Markdown
                  components={components(p, lookup)}
                  remarkPlugins={markdownRules.remarkPlugins}
                  rehypePlugins={markdownRules.rehypePlugins}
                  remarkRehypeOptions={{ clobberPrefix: prefix }}
                >
                  {p.content}
                </Markdown>
              </section>
            );
          })}
        </main>
      </body>
    </html>
  );
  return "<!doctype html>\n" + renderToStaticMarkup(body);
}
