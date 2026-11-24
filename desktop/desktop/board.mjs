// Feed, Ideas and Goals: what bots post to Today, and how the person answers. Modeled on Bighelp's agent board.
import { randomUUID } from "node:crypto";
import { defineTool } from "./providers/provider.mjs";
import { textField } from "./panels.mjs";

export const BOARD_KINDS = ["feed", "idea", "goal"];
export const GOAL_CATEGORIES = ["health", "relationships", "finance", "career", "interests", "productivity", "other"];
export const DOWN_REASONS = ["Not relevant", "Too frequent", "Already knew", "Wrong timing"];
const OPEN_LIMIT = 60; // open items per bot and kind; the oldest open item is cleared past this

function optionalText(value, max, name) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid " + name);
  return value.trim();
}
function links(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error("Use up to five links.");
  return value.map((l) => {
    const url = new URL(textField(l?.url, 2000, "link"));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Links must use http or https.");
    return { url: url.href, title: optionalText(l.title, 200, "link title") || url.hostname };
  });
}
function category(kind, value) {
  if (kind !== "goal") return undefined;
  if (value == null) return "other";
  if (!GOAL_CATEGORIES.includes(value)) throw new Error("Use one of these goal categories: " + GOAL_CATEGORIES.join(", "));
  return value;
}
/** The next local midnight after `now`, for Not today. */
export function nextMidnight(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
/** Whether an item shows on Today: open, and not put away for today. */
export function isShowing(item, now = Date.now()) {
  return item.status === "open" && !(item.snoozedUntil > now);
}

export class Board {
  constructor(ws) {
    this.ws = ws;
    ws.state.board ??= [];
  }
  get items() {
    return this.ws.state.board;
  }
  item(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error("This item no longer exists.");
    return item;
  }
  /** `spaceId` is the Feed, Ideas or Goals the card goes to: a person's own. Left out, the owner's. */
  post(botId, { kind, title, body, links: raw, category: cat, source }, spaceId) {
    this.ws.bot(botId);
    if (!BOARD_KINDS.includes(kind)) throw new Error("Use feed, idea or goal.");
    const now = Date.now();
    spaceId ??= this.ws.spaces.forCards("owner", kind).id;
    const item = {
      id: randomUUID(),
      botId,
      kind,
      spaceId,
      title: textField(title, 120, "title"),
      body: optionalText(body, 4000, "body"),
      links: links(raw),
      ...(kind === "goal" && { category: category(kind, cat) }),
      // The routine that posted it, shown beside the bot's name.
      ...(source && { source: textField(source, 80, "source") }),
      status: "open",
      read: false,
      createdAt: now,
      updatedAt: now,
    };
    this.items.unshift(item);
    // Old open items roll off within one space: what a bot posts for one person never clears another person's.
    const open = this.items.filter((i) => i.botId === botId && i.kind === kind && i.spaceId === spaceId && i.status === "open");
    for (const old of open.slice(OPEN_LIMIT)) Object.assign(old, { status: "cleared", updatedAt: now });
    // Finished items are history; keep the newest 300 per bot.
    const finished = this.items.filter((i) => i.botId === botId && i.status !== "open");
    if (finished.length > 300) {
      const drop = new Set(finished.slice(300));
      this.ws.state.board = this.items.filter((i) => !drop.has(i));
    }
    this.ws.spaces.touch(spaceId, now);
    this.ws.save();
    return item;
  }
  /** A bot's own items with the person's answers, so it can learn what helps. `spaceIds`, when given, are the spaces it may look in. */
  list(botId, kind, spaceIds) {
    return this.items
      .filter((i) => i.botId === botId && (!kind || i.kind === kind) && (!spaceIds || spaceIds.has(i.spaceId)))
      .slice(0, 80)
      .map(({ id, kind, title, status, answer, rating, reason, category, read, createdAt }) => ({
        id, kind, title, status, answer, rating, reason, category, read,
        posted: new Date(createdAt).toISOString(),
      }));
  }
  /** Bot edits to its own item: wording, links, category, or marking a goal done. */
  update(botId, id, patch) {
    const item = this.item(id);
    if (item.botId !== botId) throw new Error("You can only change your own items.");
    if (patch.title !== undefined) item.title = textField(patch.title, 120, "title");
    if (patch.body !== undefined) item.body = optionalText(patch.body, 4000, "body");
    if (patch.links !== undefined) item.links = links(patch.links);
    if (patch.category !== undefined) item.category = category(item.kind, patch.category);
    if (patch.status !== undefined) {
      if (!["open", "done", "cleared"].includes(patch.status)) throw new Error("Use open, done or cleared.");
      item.status = patch.status;
    }
    item.updatedAt = Date.now();
    // The bot's change is the newest: news to everyone.
    delete item.by;
    this.ws.spaces.touch(item.spaceId, item.updatedAt);
    this.ws.save();
    return { id: item.id, title: item.title, status: item.status };
  }
  /**
   * The person's answers from Today. Returns the new item's id for "goal". `person` made the
   * change ("owner" or a member's id): it is not news to them. Marking an item read or unread is
   * no change to it at all, so it never makes the space look changed to anyone.
   */
  act(id, action, value, person) {
    const item = this.item(id);
    const now = Date.now();
    let created;
    switch (action) {
      case "read":
      case "unread":
        item.read = action === "read";
        break;
      case "clear":
        item.status = "cleared";
        break;
      case "done":
        item.status = "done";
        break;
      case "reopen":
        item.status = "open";
        delete item.snoozedUntil;
        break;
      case "yes":
        if (item.kind !== "idea") throw new Error("Only ideas take Let's do it.");
        item.answer = "yes";
        item.status = "done";
        break;
      case "goal": {
        if (item.kind !== "idea") throw new Error("Only ideas become goals.");
        item.answer = "goal";
        item.status = "done";
        // The goal goes to the Goals of the person whose Ideas the idea was in.
        created = this.post(item.botId, { kind: "goal", title: item.title, body: item.body, links: item.links, category: GOAL_CATEGORIES.includes(value) ? value : "other" }, this.ws.spaces.forCards(this.ws.spaces.maker(this.ws.spaces.of(item)), "goal").id);
        created.read = true;
        break;
      }
      case "notToday":
        if (item.kind !== "goal") throw new Error("Only goals take Not today.");
        item.snoozedUntil = nextMidnight(now);
        break;
      case "up":
        item.rating = item.rating === "up" ? undefined : "up";
        delete item.reason;
        break;
      case "down":
        if (value != null && !DOWN_REASONS.includes(value)) throw new Error("Unknown reason");
        item.rating = "down";
        item.reason = value ?? undefined;
        if (item.kind === "feed") item.status = "cleared";
        break;
      case "delete":
        this.ws.state.board = this.items.filter((i) => i !== item);
        break;
      default:
        throw new Error("Unknown board action");
    }
    if (item.proactiveRunId && (action === "up" || action === "down")) this.ws.proactive.feedback(item.botId, item.proactiveRunId, person ?? "owner", item.rating);
    if (action !== "read" && action !== "unread") {
      item.updatedAt = now;
      if (typeof person === "string" && person) item.by = person;
      else delete item.by;
    }
    this.ws.spaces.touch(item.spaceId, now);
    this.ws.save();
    return created?.id;
  }
  removeBot(botId) {
    for (const spaceId of new Set(this.items.filter((i) => i.botId === botId).map((i) => i.spaceId))) this.ws.spaces.touch(spaceId);
    this.ws.state.board = this.items.filter((i) => i.botId !== botId);
  }
  /** Copilot tools that let a bot post to and maintain its own Feed, Ideas and Goals. */
  tools(bot, chat, run, task) {
    let posted = 0;
    // The people this turn works for (workspace.turnPeople): a card goes to the chat starter's
    // own Feed, Ideas or Goals, and the bot reads and changes its cards only in the spaces all of
    // them can open or change. A bot serves several people; one person's cards are not another's.
    const turn = this.ws.turnPeople(chat, task);
    const spaces = this.ws.spaces;
    const changes = (space) => {
      if (!["own", "edit"].includes(spaces.canAll(space, turn.people))) throw new Error("The people in this chat can't change " + space.name + ".");
    };
    const tool = (name, description, properties, required, handler) =>
      defineTool(name, {
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
        skipPermission: true,
        defer: "never",
        handler: (args) => {
          if (task.stopped || this.ws.closing || !run || this.ws.active.get(chat.id) !== task)
            throw new Error("This turn is no longer active");
          return JSON.stringify(handler(args));
        },
      });
    const string = { type: "string" };
    const linkList = { type: "array", items: { type: "object", properties: { url: string, title: string }, required: ["url"], additionalProperties: false } };
    return [
      tool(
        "board_post",
        "Post to the person's Today board. kind feed: something useful or timely to read (news, a finding, a reminder). kind idea: a suggestion the person can say yes to. kind goal: a goal to track, with a category (" + GOAL_CATEGORIES.join(", ") + "). Use a short title and an optional Markdown body. Post only when asked or when a routine says to.",
        { kind: { type: "string", enum: BOARD_KINDS }, title: string, body: string, links: linkList, category: { type: "string", enum: GOAL_CATEGORIES } },
        ["kind", "title"],
        (args) => {
          if (++posted > 10) throw new Error("Post at most ten items per reply.");
          if (!turn.sees()) throw new Error("The person this chat is for has a role that can't open spaces, so there is nowhere to post this.");
          const space = spaces.forCards(turn.starter, BOARD_KINDS.includes(args.kind) ? args.kind : "feed");
          changes(space);
          const item = this.post(bot.id, args, space.id);
          return { posted: item.id, kind: item.kind, title: item.title };
        },
      ),
      tool(
        "board_list",
        "List your own Feed posts, ideas and goals, with the person's answers: rating up or down, the reason for a thumbs down, and whether they said yes to an idea or finished a goal. Use it to avoid repeats and to post more of what helps.",
        { kind: { type: "string", enum: BOARD_KINDS } },
        [],
        ({ kind }) => this.list(bot.id, kind, new Set(turn.sees() ? spaces.open(turn.people).map((space) => space.id) : [])),
      ),
      tool(
        "board_update",
        "Change one of your own board items: its title, body, links or goal category, or set status to done, cleared or open.",
        { id: string, title: string, body: string, links: linkList, category: { type: "string", enum: GOAL_CATEGORIES }, status: { type: "string", enum: ["open", "done", "cleared"] } },
        ["id"],
        ({ id, ...patch }) => {
          const item = this.items.find((entry) => entry.id === id && entry.botId === bot.id && spaces.canAll(spaces.of(entry), turn.people));
          // A card in a space these people can't open is not there for them.
          if (!item) throw new Error("This item no longer exists.");
          changes(spaces.of(item));
          return this.update(bot.id, id, patch);
        },
      ),
    ];
  }
}
