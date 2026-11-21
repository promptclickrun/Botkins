// The page a shared link opens (`/s/<shareId>`) and the empty document an app panel runs in
// (`/s/frame`). Only web-standard Response here, no Cloudflare imports, so the Node relay loads this
// file as it is. The scripts are plain files (space-page.js.txt, space-frame.js.txt): the Worker
// imports them as text, the Node relay reads them, and the tests run them.
//
// The relay never sees a space: it serves the same page for every id, and the page opens the sealed
// copy in the browser with the key in the link's fragment, which a browser never sends anywhere.

import { hex } from "./pure.ts";

/**
 * What a custom view may do. The same policy the phone gives one (FRAME_CSP in mobile/src/ui/frame.ts;
 * mobile/tests/space-page.test.ts keeps the two the same).
 */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
].join("; ");

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// Ink, the apps' own default theme (mobile/src/ui/themes.ts): black on white, white on black.
const SPACE_CSS = `
    :root { color-scheme: light dark; --canvas: #FFFFFF; --surface: #F5F5F3; --sunken: #EDEDEA; --ink: #000000; --muted: #595959; --faint: #9A9A98; --line: #E7E7E4; --line-strong: #C8C8C4; --accent-soft: #E6E6E3; --success: #225C36; --success-soft: #E3EEE5; --warning: #7A5200; --warning-soft: #F5ECD6; --danger: #9B231C; --danger-soft: #F7E1DE; --info: #27536F; --info-soft: #E0EAF0; }
    @media (prefers-color-scheme: dark) {
      :root { --canvas: #000000; --surface: #131313; --sunken: #1A1A1A; --ink: #FFFFFF; --muted: #A8A8A8; --faint: #6E6E6E; --line: #242424; --line-strong: #3D3D3D; --accent-soft: #2B2B2B; --success: #93D6A8; --success-soft: #12281A; --warning: #E9C46A; --warning-soft: #2B2412; --danger: #FF9E94; --danger-soft: #351715; --info: #9FCBE6; --info-soft: #12232F; }
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body { margin: 0; background: var(--canvas); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; overflow-wrap: break-word; }
    main { max-width: 880px; margin: 0 auto; padding: 40px 20px 48px; }
    h1 { margin: 0; font-size: 32px; line-height: 1.15; letter-spacing: -.02em; }
    .from { margin: 6px 0 24px; color: var(--muted); font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .cards { display: grid; gap: 12px; margin-top: 12px; }
    .panel { min-width: 0; padding: 16px; border-radius: 16px; background: var(--surface); }
    .panel.wide { grid-column: span 2; }
    .panel.tall { grid-row: span 2; }
    .who { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--muted); font-size: 13px; }
    .who img { flex: none; width: 24px; height: 24px; }
    .who .time { margin-left: auto; white-space: nowrap; }
    .tag { padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--ink); font-size: 12px; }
    h2 { margin: 0 0 10px; font-size: 18px; line-height: 1.3; }
    .panel > :last-child, .md > :last-child { margin-bottom: 0; }
    .md > :first-child { margin-top: 0; }
    .md, .block { margin: 0 0 12px; }
    .md p, .md ul, .md ol, .md pre, .md blockquote, .md table { margin: 0 0 10px; }
    .md h3, .md h4, .md h5, .md h6 { margin: 14px 0 6px; font-size: 16px; line-height: 1.3; }
    .md ul, .md ol, .block ul { padding-left: 22px; }
    .md li.todo, .md li.done { list-style: none; margin-left: -22px; }
    .md li.todo::before { content: "\\2610\\00a0\\00a0"; }
    .md li.done::before { content: "\\2611\\00a0\\00a0"; }
    .md li.done { color: var(--muted); }
    .md p { white-space: pre-line; }
    .md blockquote { padding-left: 12px; border-left: 3px solid var(--line-strong); color: var(--muted); }
    .md hr { height: 1px; margin: 12px 0; border: 0; background: var(--line); }
    code { padding: 1px 5px; border-radius: 6px; background: var(--sunken); font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { padding: 12px; border-radius: 12px; background: var(--sunken); overflow-x: auto; }
    pre code { padding: 0; background: none; }
    a { color: var(--ink); text-underline-offset: 2px; }
    a:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
    .label { color: var(--muted); font-size: 13px; }
    .value { font-size: 28px; font-weight: 700; line-height: 1.2; letter-spacing: -.01em; }
    .note { color: var(--muted); font-size: 13px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .bar-row { display: grid; grid-template-columns: minmax(64px, 30%) 1fr auto; gap: 8px; align-items: center; margin-top: 6px; font-size: 14px; }
    .track { height: 8px; border-radius: 999px; background: var(--sunken); overflow: hidden; }
    .fill { height: 100%; border-radius: 999px; background: var(--ink); }
    .progress .track { margin: 6px 0 4px; }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge { padding: 2px 10px; border-radius: 999px; background: var(--accent-soft); font-size: 13px; }
    .badge.positive { background: var(--success-soft); color: var(--success); }
    .badge.warning { background: var(--warning-soft); color: var(--warning); }
    .badge.negative { background: var(--danger-soft); color: var(--danger); }
    .badge.accent { background: var(--ink); color: var(--canvas); }
    .chart { display: block; width: 100%; height: 140px; margin-top: 6px; }
    .chart polyline { fill: none; stroke: var(--ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
    .chart .s1 { stroke: var(--muted); }
    .chart .s2 { stroke: var(--faint); }
    .chart .s3 { stroke: var(--muted); stroke-dasharray: 4 4; }
    .chart line { stroke: var(--line); vector-effect: non-scaling-stroke; }
    .axis, .legend { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
    .legend { justify-content: flex-start; flex-wrap: wrap; margin-top: 4px; }
    .key::before { content: ""; display: inline-block; width: 12px; height: 2px; margin-right: 6px; vertical-align: middle; background: var(--ink); }
    .key.s1::before { background: var(--muted); }
    .key.s2::before { background: var(--faint); }
    .key.s3::before { background: repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 8px); }
    .view { margin: 0 0 12px; }
    .view iframe { display: block; width: 100%; border: 0; border-radius: 12px; background: transparent; }
    .ask { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 8px; padding: 10px 12px; border-radius: 12px; background: var(--sunken); font-size: 14px; }
    .ask .url { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
    .ask a, .ask button { min-height: 44px; padding: 0 14px; border: 0; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer; }
    .ask a { display: inline-flex; align-items: center; background: var(--ink); color: var(--canvas); text-decoration: none; }
    .ask button { background: transparent; color: var(--ink); }
    .links { margin: 8px 0 0; padding: 0; list-style: none; font-size: 14px; }
    .state { margin: 20vh 0 0; color: var(--muted); text-align: center; }
    .state:empty, .cards:empty { display: none; }
    .made { margin: 40px 0 0; font-size: 13px; text-align: center; }
    .made a { color: var(--muted); }
    [hidden] { display: none !important; }
    @media (max-width: 640px) {
      main { padding: 24px 16px 40px; }
      h1 { font-size: 28px; }
      .grid { grid-template-columns: minmax(0, 1fr); }
      .panel.wide { grid-column: auto; }
      .panel.tall { grid-row: auto; }
    }
  `;

const SPACE_BODY = `  <main>
    <header id="head" hidden>
      <h1 id="name"></h1>
      <p id="from" class="from"></p>
    </header>
    <div id="grid" class="grid"></div>
    <div id="cards" class="cards"></div>
    <p id="state" class="state" role="status"></p>
    <p class="made"><a href="https://botkins.app" rel="noopener">Made with Botkins</a></p>
  </main>`;

/** The page a link opens. It is the same for every space; `script` is space-page.js.txt. */
export function spacePage(script: string): Response {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Botkins</title>
  <style nonce="${nonce}">${SPACE_CSS}</style>
</head>
<body>
${SPACE_BODY}
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      ...PAGE_HEADERS,
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * The empty document an app panel runs in. The header's `sandbox` gives it no origin of its own,
 * however it is opened, so it cannot read the page that holds it, the link's key or anything this
 * address keeps. `script` is space-frame.js.txt: it waits for one message from its parent.
 */
export function spaceFrame(script: string): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><script>${script}</script></head><body></body></html>`, {
    headers: {
      ...PAGE_HEADERS,
      "content-security-policy": `${FRAME_CSP}; sandbox allow-scripts; frame-ancestors 'self'`,
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
