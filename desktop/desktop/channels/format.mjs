// Outbound reply markdown conversion and length-aware splitting for external channels.
// Each adapter declares `capabilities: { maxLength, markdown, threads, files, typing }`.

/** Escapes HTML special characters for Telegram HTML mode. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converts standard Markdown into a channel's native flavor.
 * Supported flavors: "slack_mrkdwn", "telegram_html", "discord_markdown", "plain".
 */
export function formatForChannel(markdown, flavor = "plain") {
  const input = String(markdown ?? "").replace(/\r\n/g, "\n").trim();
  if (!input) return "";
  if (flavor === "discord_markdown" || flavor === "markdown") return input;

  if (flavor === "plain") {
    return input
      .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => code.trim())
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/^#{1,6}\s+/gm, "");
  }

  if (flavor === "slack_mrkdwn") {
    const parts = input.split(/(```[\s\S]*?```)/g);
    return parts
      .map((part) => {
        if (part.startsWith("```") && part.endsWith("```")) return part;
        const inlineParts = part.split(/(`[^`]+`)/g);
        return inlineParts
          .map((seg) => {
            if (seg.startsWith("`") && seg.endsWith("`")) return seg;
            return seg
              .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
              .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
              .replace(/\*\*([^*]+)\*\*/g, "*$1*")
              .replace(/__([^_]+)__/g, "*$1*")
              .replace(/~~([^~]+)~~/g, "~$1~");
          })
          .join("");
      })
      .join("");
  }

  if (flavor === "telegram_html") {
    const parts = input.split(/(```[^\n]*\n[\s\S]*?```)/g);
    return parts
      .map((part) => {
        const fence = /^```[^\n]*\n([\s\S]*?)```$/.exec(part);
        if (fence) return `<pre>${escapeHtml(fence[1].replace(/\n$/, ""))}</pre>`;
        const inlineParts = part.split(/(`[^`\n]+`)/g);
        return inlineParts
          .map((seg) => {
            if (seg.startsWith("`") && seg.endsWith("`")) {
              return `<code>${escapeHtml(seg.slice(1, -1))}</code>`;
            }
            const links = [];
            let out = seg.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
              const idx = links.length;
              links.push({ label, url });
              return `\u0000LINK${idx}\u0000`;
            });
            out = escapeHtml(out)
              .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
              .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
              .replace(/__([^_\n]+)__/g, "<b>$1</b>")
              .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
              .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
            return out.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => {
              const link = links[Number(idx)];
              const safeUrl = link.url.replace(/"/g, "&quot;");
              return `<a href="${safeUrl}">${escapeHtml(link.label)}</a>`;
            });
          })
          .join("");
      })
      .join("");
  }

  return input;
}

/**
 * Splits text into chunks each at most `maxLength` characters long.
 * Prefers paragraph boundaries, then newlines, then spaces; falls back to hard cut.
 */
export function splitMessage(text, maxLength = 2000) {
  const limit = Math.max(64, Number(maxLength) || 2000);
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks = [];
  let remaining = clean;
  while (remaining.length > limit) {
    let cut = -1;
    const windowText = remaining.slice(0, limit);

    const para = windowText.lastIndexOf("\n\n");
    if (para >= Math.floor(limit * 0.4)) cut = para;

    if (cut < 0) {
      const nl = windowText.lastIndexOf("\n");
      if (nl >= Math.floor(limit * 0.4)) cut = nl;
    }

    if (cut < 0) {
      const sp = windowText.lastIndexOf(" ");
      if (sp >= Math.floor(limit * 0.4)) cut = sp;
    }

    if (cut <= 0) cut = limit;

    let piece = remaining.slice(0, cut).trimEnd();
    let rest = remaining.slice(cut).trimStart();

    // Balance triple-backtick code fences across split boundary while respecting `limit`.
    let fences = (piece.match(/```/g) || []).length;
    if (fences % 2 === 1) {
      if (piece.length + 4 > limit) {
        const safer = remaining.slice(0, Math.max(1, limit - 4));
        const nl = safer.lastIndexOf("\n");
        cut = nl >= Math.floor(limit * 0.3) ? nl : safer.length;
        piece = remaining.slice(0, cut).trimEnd();
        rest = remaining.slice(cut).trimStart();
        fences = (piece.match(/```/g) || []).length;
      }
      if (fences % 2 === 1 && piece.length + 4 <= limit) {
        const lastFence = piece.lastIndexOf("```");
        const langMatch = /^```([a-zA-Z0-9_-]*)/.exec(piece.slice(lastFence));
        const lang = langMatch ? langMatch[1] : "";
        piece = piece + "\n```";
        rest = "```" + lang + "\n" + rest;
      }
    }

    if (piece) chunks.push(piece);
    remaining = rest;
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Formats markdown for a channel and splits it to fit `capabilities.maxLength`. */
export function prepareOutboundChunks(text, capabilities = {}) {
  const formatted = formatForChannel(text, capabilities.markdown || capabilities.markdownFlavor || "plain");
  return splitMessage(formatted, capabilities.maxLength || 2000);
}
