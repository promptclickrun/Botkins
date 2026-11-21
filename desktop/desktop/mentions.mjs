// Mentions in a message: "#" names a project, a wiki page or a file in the bot's workspace; "@" addresses a group chat's bots.
// A message can also carry an item from Today (kind "board"), which Today's Discuss button and a phone send.
// The composer lists what can be mentioned (candidates) and sends the chosen records with the
// message. Before the turn starts, resolve() checks each one against the chat's bots and turns it
// into text for the model, plus the files to attach. The message keeps the mentions for display.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { canUseProject } from "./access.mjs";
import { memberSeesBot } from "./team-turn.mjs";
import { isGroup } from "./groups.mjs";

export const MAX_MENTIONS = 12;
/** The name a phone asks about before it sends a Today item with a message ({ kind: "board", id }). */
export const BOARD_MENTIONS = "board-mentions-v1";
const BOARD_NAMES = { feed: "Feed", idea: "Ideas", goal: "Goals" };
const MAX_FILES = 300;
const MAX_DEPTH = 4;
const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"]);

const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Files under a folder, newest first. Hidden entries and dependency folders are left out; links are not followed. */
export function listFiles(root, where, limit = MAX_FILES) {
  const found = [];
  const queue = [[root, 0]];
  let visited = 0;
  while (queue.length && visited < 4000) {
    const [dir, depth] = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP.has(entry.name)) queue.push([path, depth + 1]);
      } else if (entry.isFile()) {
        try {
          const info = statSync(path);
          found.push({ path, name: entry.name, folder: relative(root, dir), where, modified: info.mtimeMs, size: info.size });
        } catch {
          // The file went away while listing.
        }
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

export class Mentions {
  constructor(ws) {
    this.ws = ws;
  }
  bots(chat) {
    return this.ws.projects.botsOf(chat);
  }
  /** The folders whose files a chat may mention: each bot's own folder, and a coding chat's project folder. */
  roots(chat) {
    if (isGroup(chat)) return [];
    const roots = [{ path: join(this.ws.dir, "files", chat.botId), where: "Bot files" }];
    const folder = this.ws.projects.folderFor(chat);
    if (folder) roots.push({ path: folder, where: "Project folder" });
    return roots;
  }
  /**
   * A test for the files a team member may mention: (path) => boolean. The bot's folder holds
   * every chat's files, so a member gets only those that are artifacts of a chat they are in
   * (a file a bot made or was given there, or one inside a folder shared there).
   */
  memberFiles(memberId) {
    const artifacts = this.ws.artifacts;
    const rows = artifacts.rows.filter((row) => row.chatId && this.ws.inChat(row.chatId, memberId));
    // The index keeps real paths, so a path that reaches the file through a link is made real first.
    return (path) => {
      if (!rows.length) return false;
      try {
        return !!artifacts.entry(realpathSync(path), rows);
      } catch {
        return false;
      }
    };
  }
  /**
   * What the composer's "@" and "#" menus offer in this chat, or for a bot before its chat exists.
   * `memberId` is set when a team member asks: projects and the wiki are the owner's, so a member
   * is offered neither, and only the files of chats they are in.
   */
  /** Whether a member can open the space a card is in. A card in no space, or in one that is gone, is the owner's alone. */
  opens(card, memberId) {
    const space = this.ws.spaces.all.find((item) => item.id === card.spaceId);
    return !!space && !!this.ws.spaces.can(space, memberId);
  }
  candidates(chatId, botId, memberId) {
    const chat = chatId ? this.ws.chat(chatId) : { botId: this.ws.bot(botId).id };
    const bots = this.bots(chat);
    const state = this.ws.state;
    const usable = (check) => bots.every(check);
    if (memberId) {
      const mine = this.memberFiles(memberId);
      const files = this.roots(chat).flatMap((root) => listFiles(root.path, root.where)).filter((file) => mine(file.path));
      return {
        projects: [],
        wiki: [],
        files: files.sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES),
        bots: isGroup(chat) ? bots.map((b) => ({ id: b.id, name: b.name, hint: b.role })) : [],
      };
    }
    const projects = (state.projects ?? [])
      .filter((p) => usable((b) => canUseProject(state, b, p)))
      .map((p) => ({
        id: p.id,
        name: p.name,
        // A coding project shows its folder's name.
        hint: p.folder ? basename(p.folder) : "",
        current: p.id === chat.projectId,
      }))
      // The chat's own project leads the list.
      .sort((a, b) => Number(b.current) - Number(a.current));
    const files = this.roots(chat).flatMap((root) => listFiles(root.path, root.where));
    return {
      projects,
      // Wiki pages every bot in the chat may use (desktop/wiki.mjs).
      wiki: this.ws.wiki.mentionables(bots),
      files: files.sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES),
      // A group chat's "@" also addresses its members.
      bots: isGroup(chat) ? bots.map((b) => ({ id: b.id, name: b.name, hint: b.role })) : [],
    };
  }
  /**
   * Checks the mentions sent with a message. Returns what the message keeps (`list`), the text
   * the model reads after the message (`context`) and the files to attach (`files`).
   *
   * `author` is who wrote the message. A team member's message keeps only what a member may
   * mention: a file of a chat they are in, and a Today item of a bot their role may see. Anything
   * else is left out before it can reach the prompt, whatever the device sent.
   */
  resolve(chat, mentions, author) {
    if (mentions == null) return { list: [], context: "", files: [] };
    if (!Array.isArray(mentions) || mentions.length > MAX_MENTIONS) throw new Error("Mention up to " + MAX_MENTIONS + " records in one message.");
    const state = this.ws.state;
    if (author?.memberId) {
      const mine = this.memberFiles(author.memberId);
      const team = this.ws.teamOf();
      mentions = mentions.filter((m) => {
        if (m?.kind === "file") return mine(String(m.path));
        // A card of a space the member cannot open is not there for them, as an unknown id is not.
        if (m?.kind === "board") {
          const card = (state.board ?? []).find((item) => item.id === m.id);
          return !!card && memberSeesBot(author.memberId, team, card.botId) && this.opens(card, author.memberId);
        }
        return false;
      });
    }
    const bots = this.bots(chat);
    const refuse = (kind, name) => {
      throw new Error(bots.length > 1 ? "Not every bot in this chat has access to the " + kind + " “" + name + "”." : bots[0].name + " doesn't have access to the " + kind + " “" + name + "”.");
    };
    const roots = this.roots(chat).flatMap((r) => {
      try {
        return [realpathSync(r.path)];
      } catch {
        return [];
      }
    });
    const list = [];
    const parts = [];
    const files = [];
    const seen = new Set();
    for (const m of mentions) {
      const key = m?.kind + ":" + (m?.id ?? m?.path);
      if (seen.has(key)) continue;
      seen.add(key);
      if (m?.kind === "project") {
        const p = state.projects?.find((p) => p.id === m.id);
        if (!p) throw new Error("A mentioned project no longer exists.");
        if (!bots.every((b) => canUseProject(state, b, p))) refuse("project", p.name);
        const open = p.todos.filter((t) => !t.done);
        list.push({ kind: "project", id: p.id, label: p.name });
        parts.push(
          "#" + p.name + " is a project." +
            (p.description ? "\nDescription: " + p.description : "") +
            (p.folder ? "\nFolder: " + p.folder : "") +
            "\nOpen to-dos (" + open.length + "): " + (open.length ? open.slice(0, 30).map((t) => t.text).join("; ") : "none"),
        );
      } else if (m?.kind === "wiki") {
        // The page's text goes to the model with the message, so it also works in a group chat.
        const page = this.ws.wiki.mention(bots, m.path);
        list.push({ kind: "wiki", path: page.path, label: page.label });
        parts.push(page.text);
      } else if (m?.kind === "file") {
        if (isGroup(chat)) throw new Error("Group chats take text only. Mention files in a chat with one bot.");
        let real;
        try {
          real = realpathSync(String(m.path));
          if (!statSync(real).isFile()) throw new Error("not a file");
        } catch {
          throw new Error("A mentioned file no longer exists: " + basename(String(m?.path ?? "")));
        }
        // Only files inside the chat's own folders, wherever a link points.
        if (!roots.some((root) => inside(root, real))) throw new Error("Only files in this bot's workspace can be mentioned.");
        list.push({ kind: "file", path: real, label: basename(real) });
        parts.push("#" + basename(real) + " is a file at " + real + " (attached).");
        files.push({ name: basename(real), path: real, kind: "file" });
      } else if (m?.kind === "board") {
        // An item from Today's Feed, Ideas or Goals that the person wants to talk about. Today is
        // the person's own, so any chat may be told of an item, whichever bot posted it. The
        // message keeps enough to show a card for it after the item itself is cleared.
        const item = (state.board ?? []).find((i) => i.id === m.id);
        if (!item) throw new Error("A mentioned Today item no longer exists.");
        const from = state.bots.find((b) => b.id === item.botId)?.name;
        const links = (item.links ?? []).filter((link) => typeof link?.url === "string").slice(0, 10);
        list.push({ kind: "board", id: item.id, label: item.title, board: item.kind, ...(item.body && { body: item.body.slice(0, 600) }), ...(links.length && { links: links.map((link) => ({ url: link.url, ...(link.title && { title: link.title }) })) }) });
        parts.push(
          "#" + item.title + " is an item from the person's Today page (" + (BOARD_NAMES[item.kind] ?? item.kind) + (item.category ? ", " + item.category : "") + ")" +
            (from ? ", posted by " + from : "") + (item.source ? " from the routine “" + item.source + "”" : "") + "." +
            (item.body ? "\n" + item.body : "") +
            (links.length ? "\nLinks: " + links.map((link) => (link.title ? link.title + " " : "") + link.url).join("; ") : "") +
            "\nIts id is " + item.id + ", for the board tools.",
        );
      } else throw new Error("Unknown mention");
    }
    return {
      list,
      context: parts.length ? "\n\n[Records the person mentioned]\n" + parts.join("\n\n") : "",
      files,
    };
  }
}
