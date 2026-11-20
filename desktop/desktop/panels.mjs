import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { defineTool } from "./providers/provider.mjs";
import { Routines } from "./routines.mjs";
import { assertProject } from "./access.mjs";
import { frameFields } from "./frames.mjs";

const string = { type: "string" };
const strings = { type: "array", items: string };
const object = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const blockSchema = {
  anyOf: [
    object({ type: { const: "markdown" }, text: string }, ["type", "text"]),
    object(
      { type: { const: "metric" }, label: string, value: string, note: string },
      ["type", "label", "value"],
    ),
    object({ type: { const: "list" }, items: strings }, ["type", "items"]),
    object(
      {
        type: { const: "table" },
        columns: strings,
        rows: { type: "array", items: strings },
      },
      ["type", "columns", "rows"],
    ),
    object(
      {
        type: { const: "bars" },
        label: string,
        items: {
          type: "array",
          items: object({ label: string, value: { type: "number" } }, [
            "label",
            "value",
          ]),
        },
      },
      ["type", "label", "items"],
    ),
    // A custom view: one self-contained HTML page drawn in a sandboxed frame (desktop/frames.mjs).
    // Without `html`, a panel keeps the page it has at that position and only its data changes.
    object({ type: { const: "html" }, html: string, data: {}, height: { type: "integer" } }, ["type"]),
    // Bighelp Cards v1 elements: progress, badges and a line chart.
    object(
      { type: { const: "progress" }, label: string, value: { type: "number" }, max: { type: "number" }, note: string },
      ["type", "label", "value", "max"],
    ),
    object(
      {
        type: { const: "badges" },
        items: {
          type: "array",
          items: object({ label: string, tone: { enum: ["neutral", "positive", "warning", "negative", "accent"] } }, ["label"]),
        },
      },
      ["type", "items"],
    ),
    object(
      {
        type: { const: "line" },
        label: string,
        labels: strings,
        series: {
          type: "array",
          items: object({ name: string, values: { type: "array", items: { type: "number" } } }, ["name", "values"]),
        },
      },
      ["type", "label", "labels", "series"],
    ),
  ],
};
export const TONES = ["neutral", "positive", "warning", "negative", "accent"];
export function textField(value, max, name) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid " + name);
  return value.trim();
}
function list(value, limit, convert, name) {
  if (!Array.isArray(value) || !value.length || value.length > limit)
    throw new Error("Invalid " + name);
  return value.map(convert);
}
function block(b) {
  const short = (s) => textField(s, 200, "label");
  switch (b?.type) {
    case "markdown":
      return { type: b.type, text: textField(b.text, 8000, "markdown") };
    case "metric":
      return {
        type: b.type,
        label: short(b.label),
        value: short(b.value),
        note: b.note ? short(b.note) : "",
      };
    case "list":
      return {
        type: b.type,
        items: list(
          b.items,
          40,
          (item) => textField(item, 800, "item"),
          "list",
        ),
      };
    case "table": {
      const columns = list(b.columns, 10, short, "columns");
      const rows = list(
        b.rows,
        50,
        (row) => {
          if (!Array.isArray(row) || row.length !== columns.length)
            throw new Error("Each table row needs one cell per column");
          return row.map((cell) => {
            if (typeof cell !== "string" || cell.length > 500)
              throw new Error("Invalid table cell");
            return cell;
          });
        },
        "rows",
      );
      return { type: b.type, columns, rows };
    }
    case "bars":
      return {
        type: b.type,
        label: short(b.label),
        items: list(
          b.items,
          30,
          (item) => {
            if (!Number.isFinite(item.value) || item.value < 0)
              throw new Error("Bar values must be nonnegative numbers");
            return { label: short(item.label), value: item.value };
          },
          "bars",
        ),
      };
    case "progress": {
      if (!Number.isFinite(b.value) || !Number.isFinite(b.max) || b.max <= 0 || b.value < 0)
        throw new Error("Progress needs a nonnegative value and a positive max");
      return { type: b.type, label: short(b.label), value: Math.min(b.value, b.max), max: b.max, note: b.note ? short(b.note) : "" };
    }
    case "badges":
      return {
        type: b.type,
        items: list(b.items, 12, (item) => ({
          label: textField(item?.label, 60, "badge"),
          tone: TONES.includes(item.tone) ? item.tone : "neutral",
        }), "badges"),
      };
    case "line": {
      const labels = list(b.labels, 120, (l) => textField(l, 40, "label"), "labels");
      const series = list(b.series, 6, (s) => {
        if (!Array.isArray(s?.values) || s.values.length !== labels.length || s.values.some((v) => !Number.isFinite(v)))
          throw new Error("Each line series needs one number per label");
        return { name: short(s.name), values: s.values };
      }, "series");
      return { type: b.type, label: short(b.label), labels, series };
    }
    case "html":
      // Checked here; the page itself is stored by storeFrames once the whole write is valid.
      return {
        type: b.type,
        height: Number.isFinite(b.height) ? Math.min(Math.max(Math.round(b.height), 80), 1200) : 320,
        ...(b.html === undefined
          ? { keep: true, ...(b.data !== undefined && { pending: { json: frameFields({ html: "-", data: b.data }).json } }) }
          : { pending: frameFields(b) }),
      };
    default:
      throw new Error("Unknown panel block");
  }
}
function richBlocks(value) {
  const blocks = list(value, 18, block, "blocks");
  if (blocks.filter((b) => b.type === "html").length > 2) throw new Error("Use at most two html blocks.");
  // A frame's page is stored on its own, so it doesn't count toward the size of the blocks.
  if (JSON.stringify(blocks.map(({ pending: _pending, ...b }) => b)).length > 48000)
    throw new Error("Content exceeds 48000 characters");
  return blocks;
}
/**
 * Stores the pages of checked html blocks as frames of `owner` and returns the blocks as they are
 * kept: { type: "html", frame, height }. `previous` is the owner's current blocks: an html block
 * sent without a page keeps the page at the same position, with new data when some was sent.
 */
function storeFrames(frames, owner, botId, blocks, previous = []) {
  const kept = blocks.map((b, i) => {
    if (b.type !== "html" || !b.keep) return null;
    const old = previous[i]?.type === "html" ? previous[i] : previous.find((p) => p.type === "html");
    if (!old) throw new Error(previous.length ? "This panel has no html block to keep. Send the page in `html`." : "An html block needs its page in `html`.");
    return old;
  });
  return blocks.map((b, i) => {
    if (b.type !== "html") return b;
    if (b.keep && !b.pending) return { type: "html", frame: kept[i].frame, height: b.height };
    const page = b.keep ? { html: frames.html(kept[i].frame), json: b.pending.json } : b.pending;
    return { type: "html", frame: frames.create(owner, botId, page), height: b.height };
  });
}
export function nextTime(cron, timezone, now = Date.now()) {
  if (
    typeof cron !== "string" ||
    cron.trim().split(/\s+/).length !== 5 ||
    cron.length > 160
  )
    throw new Error(
      "Enter five cron fields: minute, hour, day, month, weekday",
    );
  new Intl.DateTimeFormat("en", { timeZone: timezone });
  return CronExpressionParser.parse(cron, {
    tz: timezone,
    currentDate: new Date(now),
  })
    .next()
    .getTime();
}

export class Panels {
  constructor(workspace) {
    this.ws = workspace;
    // Bot routines share the scheduler with panel routines; see desktop/routines.mjs.
    this.routines = new Routines(workspace);
  }
  get all() {
    return this.ws.state.panels;
  }
  get(id) {
    const p = this.all.find((p) => p.id === id);
    if (!p) throw new Error("Panel no longer exists");
    return p;
  }
  write(botId, chatId, args, run) {
    const key = textField(args.key, 72, "panel key");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key))
      throw new Error("Use lowercase letters, numbers and hyphens for key");
    const panel = this.all.find((p) => p.botId === botId && p.key === key);
    if (run?.panelId && panel?.id !== run.panelId)
      throw new Error("This refresh can only update its assigned panel");
    if ((args.revision ?? 0) !== (panel?.revision ?? 0))
      throw new Error(
        "Panel changed. List your panels and use the current revision.",
      );
    const title = textField(args.title, 120, "panel title");
    const checked = richBlocks(args.blocks);
    // A panel published from a chat in a project belongs to that project; a refresh keeps the panel's.
    const chat = this.ws.state.chats.find((c) => c.id === chatId);
    const projectId = panel?.projectId ?? chat?.projectId;
    if (projectId && this.ws.state.projects?.some((p) => p.id === projectId))
      assertProject(this.ws.state, this.ws.bot(botId), projectId);
    const now = Date.now();
    const result = panel ?? {
      id: randomUUID(),
      key,
      botId,
      chatId,
      size: "wide",
      hidden: false,
      revision: 0,
      routine: null,
    };
    if (projectId && this.ws.state.projects?.some((p) => p.id === projectId)) result.projectId = projectId;
    // Everything is valid: pages of html blocks are stored now, and the panel's earlier ones removed.
    const owner = "panel:" + result.id;
    const blocks = storeFrames(this.ws.frames, owner, botId, checked, panel?.blocks);
    this.ws.frames.removeOwner(owner, blocks.filter((b) => b.type === "html").map((b) => b.frame));
    Object.assign(result, {
      title,
      blocks,
      revision: result.revision + 1,
      updatedAt: now,
      lastWriter: run?.id,
    });
    if (!panel) this.all.push(result);
    this.ws.save();
    return { key, revision: result.revision, title };
  }
  routine(id, { action, cron, prompt, timezone }) {
    const p = this.get(id);
    if (action === "set") {
      const expression = textField(cron, 160, "cron");
      const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const nextAt = nextTime(expression, zone);
      p.routine = {
        cron: expression,
        timezone: zone,
        prompt: textField(prompt, 4000, "refresh instructions"),
        enabled: true,
        nextAt,
      };
    } else if (action === "remove") p.routine = null;
    else {
      if (!p.routine || !["pause", "resume"].includes(action))
        throw new Error("No matching routine");
      p.routine.enabled = action === "resume";
      p.routine.nextAt = p.routine.enabled
        ? nextTime(p.routine.cron, p.routine.timezone)
        : null;
    }
    this.ws.save();
    return p.routine;
  }
  change(id, action) {
    const p = this.get(id),
      i = this.all.indexOf(p);
    if (action === "delete") {
      this.all.splice(i, 1);
      this.ws.frames.removeOwner("panel:" + id);
    }
    else if (action === "hide" || action === "show")
      p.hidden = action === "hide";
    else if (["small", "wide", "tall"].includes(action)) p.size = action;
    else if (action === "earlier" || action === "later") {
      const j = i + (action === "earlier" ? -1 : 1);
      if (j >= 0 && j < this.all.length)
        [this.all[i], this.all[j]] = [this.all[j], p];
    } else throw new Error("Unknown panel action");
    this.ws.save();
  }
  /** A panel as its bot reads it: an html block shows its data and the start of its page, or all of it with `full`. */
  readable(panel, full) {
    return {
      ...panel,
      blocks: panel.blocks.map((b) => {
        if (b.type !== "html") return b;
        const html = this.ws.frames.html(b.frame);
        return {
          type: "html",
          height: b.height,
          data: this.ws.frames.data(b.frame),
          ...(full || html.length <= 1200 ? { html } : { html_start: html.slice(0, 1200), html_characters: html.length }),
        };
      }),
    };
  }
  refresh(id, trigger = "manual", now = Date.now()) {
    const p = this.get(id);
    if (p.refreshChatId && this.ws.active.has(p.refreshChatId))
      throw new Error("This panel is already refreshing");
    if (trigger === "scheduled") {
      if (!p.routine?.enabled || p.routine.nextAt > now) return;
      p.routine.nextAt = nextTime(p.routine.cron, p.routine.timezone, now);
    }
    if (!p.refreshChatId)
      p.refreshChatId = this.ws.createChat(
        p.botId,
        "Updates · " + p.title,
        p.id,
      );
    const request =
      p.routine?.prompt ||
      "Check the information in the panel and update it using available sources.";
    const prompt =
      'Refresh your Today panel "' +
      p.key +
      '". Use today_list for its current contents and revision, then today_publish with new blocks if anything changed. ' +
      request;
    return this.ws.send(p.refreshChatId, prompt, {
      panelId: id,
      trigger,
      title: "Update " + p.title,
    });
  }
  async tick(now = Date.now()) {
    // Admit one run at a time. Advance its next slot before starting the turn.
    // Missed slots after sleep collapse to one check.
    if (this.ws.closing || this.ticking) return;
    this.ticking = true;
    try {
      const due = this.all
        .filter(
          (p) =>
            p.routine?.enabled &&
            p.routine.nextAt <= now &&
            !this.ws.active.has(p.refreshChatId),
        )
        .sort((a, b) => a.routine.nextAt - b.routine.nextAt)[0];
      if (due) await this.refresh(due.id, "scheduled", now);
    } finally {
      this.ticking = false;
    }
  }
  tools(bot, chat, run, task) {
    const owned = (key) => {
      const p = this.all.find((p) => p.botId === bot.id && p.key === key);
      if (!p || (run?.panelId && run.panelId !== p.id))
        throw new Error("Unknown panel for this bot");
      return p;
    };
    const tool = (name, description, properties, required, handler) =>
      defineTool(name, {
        description,
        parameters: object(properties, required),
        skipPermission: true,
        defer: "never",
        handler: (args) => {
          if (
            task.stopped ||
            this.ws.closing ||
            !run ||
            this.ws.active.get(chat.id) !== task
          )
            throw new Error("This turn is no longer active");
          return JSON.stringify(handler(args));
        },
      });
    const tools = [
      tool(
        "today_list",
        "List your own Today panels and revisions. Supply a key to read the complete blocks. An html block comes back with its data and the start of its page; set full to get the whole page.",
        { key: string, full: { type: "boolean" } },
        [],
        ({ key, full }) =>
          key
            ? this.readable(owned(key), full)
            : this.all
                .filter(
                  (p) =>
                    p.botId === bot.id &&
                    (!run?.panelId || p.id === run.panelId),
                )
                .map(({ key, title, revision, routine }) => ({
                  key,
                  title,
                  revision,
                  routine,
                })),
      ),
      tool(
        "today_publish",
"Create or update a rich Today panel owned by this bot. Reuse a stable key. Supply its current revision when updating; omit revision for creation. For a custom view (a chart, a dashboard, a timeline, anything interactive) use an html block: one self-contained HTML page or fragment with inline CSS and JavaScript. It has no network, so use inline SVG or data: URLs. It is drawn inside the panel and should use the app's colors through the CSS variables --ink, --muted, --line, --paper and --accent, which follow light and dark. Put changing values in the block's `data` and read them with `await botkins.getData()`; on a later update send the html block with only `data` to keep the page. `botkins.sendAnswer(text)` puts text in the person's message box and `botkins.openLink(url)` asks to open a web page.",
        {
          key: string,
          revision: { type: "integer" },
          title: string,
          blocks: { type: "array", items: blockSchema },
        },
        ["key", "title", "blocks"],
        (args) => this.write(bot.id, chat.id, args, run),
      ),
    ];
    if (!run?.panelId)
      tools.push(
        tool(
          "render_card",
"Display a rich card in this chat with metrics, tables, bars, lists, Markdown or an html block (a self-contained page, as in today_publish). Optional reply buttons place a suggested reply in the composer.",
          {
            title: string,
            blocks: { type: "array", items: blockSchema },
            replies: strings,
          },
          ["title", "blocks"],
          ({ title, blocks, replies = [] }) => {
            if ((run.cards?.length ?? 0) >= 8)
              throw new Error("Maximum eight cards per turn");
            // Everything is checked before a page is stored, so a refused card leaves nothing behind.
            const checked = {
              title: textField(title, 120, "card title"),
              blocks: richBlocks(blocks),
              replies: replies.length ? list(replies, 6, (item) => textField(item, 240, "reply"), "replies") : [],
            };
            const card = {
              id: randomUUID(),
              ...checked,
              // A card's html blocks belong to its chat and are removed with it.
              blocks: storeFrames(this.ws.frames, "chat:" + chat.id, bot.id, checked.blocks),
            };
            (run.cards ??= []).push(card);
            this.ws.save();
            return { displayed: card.title };
          },
        ),
        tool(
          "today_routine",
          "Manage a panel's recurring Copilot refresh. Set a five-field cron expression and instructions when a recurring update is requested. Cadence uses the supplied IANA timezone or the computer's timezone.",
          {
            key: string,
            action: { enum: ["set", "pause", "resume", "remove"] },
            cron: string,
            timezone: string,
            prompt: string,
          },
          ["key", "action"],
          (args) => this.routine(owned(args.key).id, args),
        ),
        tool(
          "today_remove",
          "Remove one of your Today panels and its routine when requested.",
          { key: string, revision: { type: "integer" } },
          ["key", "revision"],
          (args) => {
            const p = owned(args.key);
            if (p.revision !== args.revision)
              throw new Error("Panel changed. List your panels again.");
            this.change(p.id, "delete");
            return { removed: args.key };
          },
        ),
      );
    return tools;
  }
}
