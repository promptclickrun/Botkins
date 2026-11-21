// Spaces: named pages of panels, private or shared ("spaces-v1", docs/spaces.md).
//
// A space is a page on this computer that holds panels and cards. A person makes one and keeps
// it private or shares it. Today, Feed, Ideas and Goals are spaces too: every person has those
// four, and they cannot be renamed or deleted.
//
// What is kept here is the content: the records, which space a panel or a card is in, an app
// panel's saved state and its notes. Who may open a space is the phone link's to keep
// (`team.spaces` in its store) and to decide (`spaceCan` in link/team.mjs). This file asks it
// through `workspace.spaceCanOf`, and without a link knows only the rule that needs none: a
// space is its maker's, and the computer's owner can open every space on it.
//
// A person is "owner" or a member's id, as everywhere a team is involved (TEAMS.md).
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { nextTime, textField } from "./panels.mjs";
import { memberSeesBot } from "./team-turn.mjs";

export const SPACES = "spaces-v1";
export const OWNER = "owner";
/** The four spaces every person has, with the kind of card each holds. */
export const BUILTIN = { today: { name: "Today" }, feed: { name: "Feed", kind: "feed" }, ideas: { name: "Ideas", kind: "idea" }, goals: { name: "Goals", kind: "goal" } };
export const LIMITS = { spaces: 60, panels: 40, notes: 50, note: 2000, state: 64 * 1024, keys: 200, label: 80 };
/** How a new panel may start: one more line for the bot beside the person's sentence. */
export const STARTS = { checklist: "Make it a checklist.", tracker: "Make it a tracker.", chart: "Make it a chart.", table: "Make it a table.", notes: "Make it a place for notes.", app: "Make it an app people use together." };
/** The most a link's copy may be once it is packed: 4 MiB, less what sealing adds. */
export const COPY_BYTES = 4 * 1024 * 1024 - 28;
/** The host's own pace for what a person does in an app panel (Spaces.paced). `every` is milliseconds for one more. */
export const PACE = {
  state: { burst: 10, every: 1000, wait: "Wait a moment before you change this panel again." },
  note: { burst: 5, every: 5000, wait: "Wait a moment before you write another note." },
};

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const newId = () => "s_" + [...randomBytes(10)].map((byte) => BASE32[byte % 32]).join("");
const makerOf = (space) => space.createdBy ?? OWNER;

function record(name, person, builtin, now = Date.now()) {
  return { id: newId(), name, ...(builtin && { builtin }), ...(person !== OWNER && { createdBy: person }), createdAt: now, updatedAt: now, rev: 1 };
}

/**
 * Brings a workspace from before spaces to one with them, and is safe to run at every start:
 * the owner has the four built-in spaces, every panel is in a space, and so is every card.
 * What was on the one Today page goes to the owner's: panels to Today, cards to Feed, Ideas or
 * Goals by their kind.
 */
export function migrateSpaces(state) {
  // (Only records count: an entry that is not one, from a file that was changed by hand, is dropped and not tripped over.)
  state.spaces = (Array.isArray(state.spaces) ? state.spaces : []).filter((space) => space && typeof space === "object" && typeof space.id === "string" && space.id);
  const mine = (builtin) => {
    let space = state.spaces.find((item) => item.builtin === builtin && !item.createdBy);
    if (!space) state.spaces.push((space = record(BUILTIN[builtin].name, OWNER, builtin)));
    return space;
  };
  const builtins = Object.fromEntries(Object.keys(BUILTIN).map((builtin) => [builtin, mine(builtin)]));
  const known = new Set(state.spaces.map((space) => space.id));
  const ofKind = { feed: builtins.feed, idea: builtins.ideas, goal: builtins.goals };
  // A panel or a card whose space is gone goes to the owner's too: it is never left where nobody can find it.
  for (const panel of state.panels ?? []) if (!known.has(panel.spaceId)) panel.spaceId = builtins.today.id;
  for (const card of state.board ?? []) if (!known.has(card.spaceId)) card.spaceId = (ofKind[card.kind] ?? builtins.feed).id;
}

export class Spaces {
  constructor(workspace) {
    this.ws = workspace;
    migrateSpaces(workspace.state);
    this.pace = new Map();
    // A clock that only goes forward, for the pace above.
    this.clock = () => performance.now();
  }
  get all() {
    return this.ws.state.spaces;
  }
  get(id) {
    const space = this.all.find((item) => item.id === id);
    if (!space) throw new Error("This space no longer exists.");
    return space;
  }
  maker(space) {
    return makerOf(space);
  }
  /** The space a panel or a card is in. */
  of(item) {
    return this.get(item.spaceId);
  }
  panels(spaceId) {
    return this.ws.state.panels.filter((panel) => panel.spaceId === spaceId);
  }
  cards(spaceId) {
    return this.ws.state.board.filter((card) => card.spaceId === spaceId);
  }

  /**
   * A person's four built-in spaces, made when they are not there: { today, feed, ideas, goals },
   * each a record. Safe to repeat. The link asks for a member's the first time their device is
   * sent anything; a bot's work for a person lands in them.
   */
  ensure(person = OWNER) {
    let made = false;
    const out = {};
    for (const builtin of Object.keys(BUILTIN)) {
      out[builtin] = this.all.find((space) => space.builtin === builtin && makerOf(space) === person);
      if (out[builtin]) continue;
      this.all.push((out[builtin] = record(BUILTIN[builtin].name, person, builtin)));
      made = true;
    }
    if (made) this.ws.save();
    return out;
  }
  /** The built-in space of a person that holds cards of a kind ("feed", "idea", "goal"). */
  forCards(person, kind) {
    // (Someone who is no longer on the team gets no spaces made for them.)
    if (person !== OWNER && !this.ws.teamOf()?.members?.some((member) => member.id === person)) throw new Error("That person is no longer on the team.");
    const builtin = Object.keys(BUILTIN).find((name) => BUILTIN[name].kind === kind) ?? "feed";
    return this.ensure(person)[builtin];
  }
  /**
   * How often one person may change one panel's state or write a note on it. The window and the
   * phone hold a page to a real touch and once a second; this is the host's own limit, for a
   * client that does not: each save writes the whole workspace. Ten changes at once, then one a
   * second; five notes at once, then one every five seconds.
   */
  paced(kind, person, panelId) {
    const { burst, every, wait } = PACE[kind];
    const now = this.clock();
    const key = kind + ":" + person + ":" + panelId;
    const had = this.pace.get(key);
    const tokens = Math.min(burst, (had ? had.tokens + (now - had.at) / every : burst));
    if (tokens < 1) throw new Error(wait);
    this.pace.set(key, { tokens: tokens - 1, at: now });
    // What is full again says nothing: forgotten, so the list stays short.
    if (this.pace.size > 2000) for (const [name, entry] of this.pace) if (entry.tokens + (now - entry.at) / PACE[name.split(":")[0]].every >= PACE[name.split(":")[0]].burst) this.pace.delete(name);
  }

  /** A new space, private until its maker shares it. Answers its id. */
  create({ name } = {}, person = OWNER) {
    if (this.all.filter((space) => makerOf(space) === person).length >= LIMITS.spaces) throw new Error("You have " + LIMITS.spaces + " spaces, which is the most a person has. Delete one first.");
    const space = record(textField(name, 40, "name"), person);
    this.all.push(space);
    this.ws.save();
    return space.id;
  }

  /** A change to a space or to anything in it: its time and its count go up. Does not save. */
  touch(spaceId, now = Date.now()) {
    const space = this.all.find((item) => item.id === spaceId);
    if (!space) return;
    space.updatedAt = now;
    space.rev = (space.rev ?? 0) + 1;
  }

  /**
   * What a person may do with a space: "own", "edit", "view" or null. The link decides
   * (`spaceCan`, with what it keeps about sharing). Without it, the rules that need no record of
   * sharing: the maker and the computer's owner own a space; the owner's four built-in spaces
   * are every member's to change, as the one Today page was before spaces and as the link shares
   * them when it first meets spaces; and any other space is there for nobody else.
   */
  can(space, person) {
    const told = this.ws.spaceCanOf?.(space, person);
    if (told !== undefined) return told;
    if (person === OWNER || makerOf(space) === person) return "own";
    return space.builtin && makerOf(space) === OWNER ? "edit" : null;
  }
  /** What several people may all do with a space: the least of what each may. A turn works for the chat's starter and for whoever wrote the message. */
  canAll(space, people) {
    const order = [null, "view", "edit", "own"];
    return people.map((person) => this.can(space, person)).reduce((least, can) => (order.indexOf(can) < order.indexOf(least) ? can : least), "own");
  }
  /** The spaces every one of these people can open. */
  open(people) {
    return this.all.filter((space) => this.canAll(space, people));
  }
  /** One of those spaces, by its id or its name (a bot names a space either way). Another person's built-in is found by id only. */
  find(reference, people) {
    const wanted = String(reference ?? "").trim();
    const open = this.open(people);
    const space = open.find((item) => item.id === wanted) ?? open.find((item) => item.name.toLowerCase() === wanted.toLowerCase() && (!item.builtin || people.includes(makerOf(item)))) ?? open.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
    // A space these people can't open is not there for them: the same words as for one that doesn't exist.
    if (!space) throw new Error("No space named " + JSON.stringify(wanted.slice(0, 60)) + ". Use space_list to see the spaces.");
    return space;
  }

  // ── What a person does with a space (the contract's calls). `person` is "owner" or a member's id. ──
  //
  // The link checks a device's call against who may open the space and the member's role before
  // it gets here. The space's own rule is asked again here: this is where the content is, and
  // the owner's own window calls these too.

  /** Refuses unless the person may: "open" a space, "change" it, or "own" it. A space they can't open is, for them, one that doesn't exist. */
  need(space, person, level = "open") {
    const can = this.can(space, person);
    if (!can) throw new Error("This space no longer exists.");
    // (The link's own sentences for the same refusals, word for word: desktop/link/SPACES.md, "Sentences the link answers with".)
    if (level === "change" && can === "view") throw new Error("You can look at this space, not change it.");
    if (level === "own" && can !== "own") throw new Error("Only the person who made this space can do that.");
    return can;
  }
  /** The name the team has for a person, for a panel's last line and for notes. */
  named(person) {
    const name = this.ws.teamOf()?.people?.find((item) => item.id === person)?.name ?? this.ws.teamOf()?.members?.find((item) => item.id === person)?.name;
    return { id: person, name: typeof name === "string" && name ? name : person === OWNER ? "Owner" : "A member" };
  }
  /** Whether a member's role shows them a bot. The owner sees every bot. */
  seesBot(person, botId) {
    return person === OWNER || memberSeesBot(person, this.ws.teamOf(), botId);
  }

  /**
   * A space's content for one person: { id, rev, panels, cards }. A member is sent a panel or a
   * card only when their role shows them its bot, a hidden panel only when they may change the
   * space, and no project, no chat they are not in, and no routine's prompt unless they may
   * change the space.
   */
  read(id, person = OWNER) {
    const space = this.get(id);
    const can = this.need(space, person);
    const change = can !== "view";
    const view = (panel) => {
      const { lastWriter: _lastWriter, ...rest } = panel;
      if (person === OWNER) return rest;
      const { projectId: _projectId, chatId, refreshChatId, routine, ...out } = rest;
      return {
        ...out,
        ...(chatId && this.ws.inChat(chatId, person) && { chatId }),
        ...(refreshChatId && this.ws.inChat(refreshChatId, person) && { refreshChatId }),
        routine: routine && !change ? (({ prompt: _prompt, ...kept }) => kept)(routine) : routine,
      };
    };
    return {
      id: space.id,
      rev: space.rev,
      panels: this.panels(id).filter((panel) => this.seesBot(person, panel.botId) && (change || !panel.hidden)).map(view),
      cards: this.cards(id).filter((card) => this.seesBot(person, card.botId)),
    };
  }
  rename(id, name, person = OWNER) {
    const space = this.get(id);
    this.need(space, person, "own");
    if (space.builtin) throw new Error(space.name + " can't be renamed.");
    space.name = textField(name, 40, "name");
    this.touch(id);
    this.ws.save();
  }
  /** Deletes a space with its panels, their routines, their refresh chats and their views. */
  async remove(id, person = OWNER) {
    const space = this.get(id);
    this.need(space, person, "own");
    if (space.builtin) throw new Error(space.name + " can't be deleted.");
    const panels = this.panels(id);
    for (const panel of panels) this.ws.frames.removeOwner("panel:" + panel.id);
    this.ws.state.panels = this.ws.state.panels.filter((panel) => panel.spaceId !== id);
    this.ws.state.board = this.ws.state.board.filter((card) => card.spaceId !== id);
    this.ws.state.spaces = this.all.filter((item) => item !== space);
    for (const chat of this.ws.state.chats) if (chat.spaceId === id) delete chat.spaceId;
    this.ws.save();
    // A refresh chat is of no use without its panel. A chat that is gone already is no reason to stop.
    for (const panel of panels) if (panel.refreshChatId) await this.ws.agents.deleteChat(panel.refreshChatId).catch(() => {});
  }
  /** Attaches a space to a project, or with null takes it off. Projects are the owner's. */
  setProject(id, projectId, person = OWNER) {
    const space = this.get(id);
    if (person !== OWNER || makerOf(space) !== OWNER) throw new Error("Only the owner's spaces go with a project.");
    if (projectId == null) delete space.projectId;
    else {
      if (!this.ws.state.projects?.some((project) => project.id === projectId)) throw new Error("This project no longer exists.");
      space.projectId = projectId;
    }
    this.touch(id);
    this.ws.save();
  }
  setPanelProject(panelId, projectId, person = OWNER) {
    const panel = this.ws.panels.get(panelId);
    if (person !== OWNER) throw new Error("Only the owner attaches a panel to a project.");
    if (projectId == null) delete panel.projectId;
    else {
      if (!this.ws.state.projects?.some((project) => project.id === projectId)) throw new Error("This project no longer exists.");
      panel.projectId = projectId;
    }
    this.touch(panel.spaceId);
    this.ws.save();
  }
  /** A chat with a bot that is about a space: the person's own, with the space (and a panel) it was started from. */
  chatAbout(space, botId, person, panelId) {
    if (!this.seesBot(person, botId)) throw new Error("Unknown bot");
    const chatId = this.ws.createChat(botId);
    const chat = this.ws.chat(chatId);
    chat.spaceId = space.id;
    if (panelId) chat.aboutPanelId = panelId;
    if (person !== OWNER) chat.createdBy = person;
    return chat;
  }
  /**
   * Starts a chat with a bot, in a space, with the person's sentence for a new panel, as typing
   * /today-panel does. `start` adds one line. `refresh` ({ cron, timezone }) becomes the panel's
   * routine, with the person's sentence as its prompt, when the bot first publishes from that chat.
   * Answers { chatId }; the reply goes on in that chat.
   */
  newPanel({ spaceId, botId, prompt, start, refresh } = {}, person = OWNER) {
    const space = this.get(spaceId);
    this.need(space, person, "change");
    const sentence = textField(prompt, 4000, "prompt");
    if (start != null && !Object.hasOwn(STARTS, start)) throw new Error("Unknown way to start a panel.");
    if (this.panels(space.id).length >= LIMITS.panels) throw new Error(space.name + " has " + LIMITS.panels + " panels, which is the most a space holds.");
    let routine;
    if (refresh != null) {
      const zone = refresh.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      nextTime(refresh.cron, zone);
      routine = { cron: String(refresh.cron).trim(), timezone: zone, prompt: sentence };
    }
    const chat = this.chatAbout(space, botId, person);
    if (routine) chat.panelRoutine = routine;
    this.ws.save();
    const sent = this.ws.send(chat.id, "/today-panel " + sentence + (start ? " " + STARTS[start] : ""), person === OWNER ? {} : { author: this.ws.memberAuthor(person) });
    // The turn's own failures are said in the chat; this call has done its part once the chat is there.
    Promise.resolve(sent).catch(() => {});
    return { chatId: chat.id };
  }
  /** Starts a chat with a bot about a space, or with `panelId` about one of its panels. Answers { chatId }. */
  ask({ spaceId, botId, text, panelId } = {}, person = OWNER) {
    const space = this.get(spaceId);
    // Asking a bot from a space is acting in it: for someone who may change it (the contract's "Who can do what").
    this.need(space, person, "change");
    const said = textField(text, 32000, "message");
    if (panelId != null && this.ws.panels.get(panelId).spaceId !== space.id) throw new Error("Panel no longer exists");
    const chat = this.chatAbout(space, botId, person, panelId ?? undefined);
    this.ws.save();
    Promise.resolve(this.ws.send(chat.id, said, person === OWNER ? {} : { author: this.ws.memberAuthor(person) })).catch(() => {});
    return { chatId: chat.id };
  }
  /** What a bot is told in a chat that is about a space: its name, and its panels' titles and keys. */
  context(chat) {
    const space = chat?.spaceId && this.all.find((item) => item.id === chat.spaceId);
    if (!space) return "";
    const people = this.ws.turnPeople(chat).people;
    if (!this.canAll(space, people)) return "";
    // (Not the panels of a bot that the role of one of the chat's people hides, as `read` leaves them out.)
    const panels = this.panels(space.id).filter((panel) => !panel.hidden && people.every((person) => this.seesBot(person, panel.botId)));
    const about = chat.aboutPanelId && panels.find((panel) => panel.id === chat.aboutPanelId);
    const bot = (panel) => this.ws.state.bots.find((item) => item.id === panel.botId)?.name ?? "a bot";
    return (
      "\nThis chat was started from the space " + JSON.stringify(space.name) + " (a page of panels). What you publish here goes to that space." +
      (panels.length ? " Its panels: " + panels.slice(0, 40).map((panel) => JSON.stringify(panel.title) + " (key " + panel.key + ", by " + bot(panel) + ")").join("; ") + ". Read your own with today_list." : " It has no panels yet.") +
      (about ? " The person is asking about the panel " + JSON.stringify(about.title) + " (key " + about.key + ")." : "")
    );
  }
  /**
   * Puts a panel in a space, before one of its panels or at its end. Leaving a space needs to
   * own it or to be the person the panel was made for; entering one needs to be able to change it.
   */
  movePanel(panelId, { spaceId, before = null } = {}, person = OWNER) {
    const panel = this.ws.panels.get(panelId);
    const from = this.of(panel);
    const to = this.get(spaceId);
    this.need(to, person, "change");
    if (from.id === to.id) this.need(from, person, "change");
    else if (this.need(from, person) !== "own" && (panel.createdBy ?? OWNER) !== person) throw new Error("Only the person who made " + from.name + ", or the one this panel was made for, can move it out.");
    this.ws.panels.move(panelId, to.id, before);
  }

  // ── For the link: what an app is sent, the copy a link opens, and a member who left ─────────

  /** The spaces as the link needs them to make each person's list: each record with what it holds ({ id, botId, updatedAt } for every panel and open card). */
  part() {
    return this.all.map((space) => ({
      ...space,
      items: [
        ...this.panels(space.id).filter((panel) => !panel.hidden).map((panel) => ({ id: panel.id, botId: panel.botId, updatedAt: panel.updatedAt ?? 0 })),
        ...this.cards(space.id).filter((card) => card.status === "open").map((card) => ({ id: card.id, botId: card.botId, updatedAt: card.updatedAt ?? card.createdAt ?? 0 })),
      ],
    }));
  }
  /**
   * The copy of a space that a link opens (`SpaceSnapshot`): every panel that is not hidden and
   * every open card, with the page of each custom view in it. When a member made the space, only
   * what that member's role shows them. It holds no id of the host, of a chat, a bot, a panel or
   * a project, no routine's prompt, no note, no last line and no person's name but `from`.
   * What a panel itself says (its text, its page, its data, its state) is public as it is.
   * A copy that would be too large leaves out the largest pages first, and says so on those panels.
   */
  snapshot(id, { from, limit = COPY_BYTES } = {}) {
    const space = this.get(id);
    const maker = makerOf(space);
    const bot = (botId) => {
      const found = this.ws.state.bots.find((item) => item.id === botId);
      return { name: found?.name ?? "", look: found?.look ?? null };
    };
    const panels = this.panels(id)
      .filter((panel) => !panel.hidden && this.seesBot(maker, panel.botId))
      .map((panel) => ({
        title: panel.title,
        size: ["small", "wide", "tall"].includes(panel.size) ? panel.size : "wide",
        bot: bot(panel.botId),
        updatedAt: panel.updatedAt ?? 0,
        blocks: (panel.blocks ?? []).map((block) => (block.type === "html" ? { type: "html", height: block.height, page: this.ws.frames.html(block.frame), ...(this.ws.frames.data(block.frame) !== undefined && { data: this.ws.frames.data(block.frame) }) } : block)),
        ...(panel.state && { state: panel.state }),
      }));
    const cards = this.cards(id)
      .filter((card) => card.status === "open" && this.seesBot(maker, card.botId))
      .map((card) => ({ kind: card.kind, title: card.title, body: card.body ?? "", links: (card.links ?? []).map((link) => (typeof link === "string" ? link : link?.url)).filter((url) => typeof url === "string"), ...(card.category && { category: card.category }), bot: bot(card.botId), createdAt: card.createdAt ?? 0 }));
    const copy = {
      v: 1,
      name: space.name,
      from: typeof from === "string" && from ? from : (this.ws.teamOf()?.name || this.named(OWNER).name),
      kind: space.builtin && space.builtin !== "today" ? space.builtin : "panels",
      updatedAt: space.updatedAt,
      panels,
      cards,
    };
    // Packed as it will be sent. Over the limit, the largest page goes, then the next, until it
    // fits. Each page is measured once, by itself; the whole copy is packed again only to check
    // a cut that should fit, not at every step.
    const size = (value) => gzipSync(JSON.stringify(value)).length;
    let packed = size(copy);
    if (packed <= limit) return copy;
    const cut = (pieces, take) => {
      // The largest first. What a piece weighs alone is close to what the copy loses without it.
      const measured = pieces.map((piece) => ({ ...piece, bytes: size(piece.what) })).sort((a, b) => b.bytes - a.bytes);
      let estimate = packed;
      for (let at = 0; at < measured.length && packed > limit; at++) {
        take(measured[at]);
        estimate -= measured[at].bytes;
        if (estimate <= limit || at === measured.length - 1) estimate = packed = size(copy);
      }
    };
    // First the pages of custom views.
    cut(panels.flatMap((panel) => panel.blocks.filter((block) => block.type === "html").map((block) => ({ panel, block, what: block.page }))), ({ panel, block }) => {
      panel.blocks = panel.blocks.filter((other) => other !== block);
      panel.left = "size";
    });
    // Then all of a panel but its title: its other blocks and what people saved in it.
    cut(panels.map((panel) => ({ panel, what: [panel.blocks, panel.state ?? null] })), ({ panel }) => {
      panel.blocks = [];
      delete panel.state;
      panel.left = "size";
    });
    // Then cards, the largest first. A copy that is still too large is not given: it is never sent over its limit.
    cut(cards.map((card) => ({ card, what: card })), ({ card }) => void copy.cards.splice(copy.cards.indexOf(card), 1));
    if (packed > limit) throw new Error("This space is too large to share by link.");
    return copy;
  }
  /**
   * A member left the team: the spaces they made pass to the owner, the panels made for them
   * are the owner's from here, and the routines they set are paused. Their notes stay, with their name.
   * Safe to repeat. The link takes away what it keeps itself: who the spaces were shared with,
   * their links, and the member's own view.
   */
  memberRemoved(memberId) {
    if (typeof memberId !== "string" || !memberId || memberId === OWNER) return;
    const now = Date.now();
    for (const space of this.all) {
      if (space.createdBy !== memberId) continue;
      delete space.createdBy;
      // Two of the owner's built-in spaces of one kind can't be: what the member's held joins the owner's, and theirs goes.
      if (space.builtin) {
        const own = this.ensure(OWNER)[space.builtin];
        for (const panel of this.ws.state.panels) {
          if (panel.spaceId !== space.id) continue;
          // A bot has one panel by a key in a space. Where the owner's already has that key, this one gets the next free one.
          const taken = (key) => this.ws.state.panels.some((other) => other !== panel && other.spaceId === own.id && other.botId === panel.botId && other.key === key);
          if (taken(panel.key)) {
            const base = panel.key.slice(0, 66);
            let n = 2;
            while (taken(base + "-" + n)) n++;
            panel.key = base + "-" + n;
          }
          panel.spaceId = own.id;
        }
        for (const card of this.ws.state.board) if (card.spaceId === space.id) card.spaceId = own.id;
        for (const chat of this.ws.state.chats) if (chat.spaceId === space.id) chat.spaceId = own.id;
        this.touch(own.id, now);
        space.gone = true;
      } else this.touch(space.id, now);
    }
    this.ws.state.spaces = this.all.filter((space) => !space.gone);
    for (const panel of this.ws.state.panels) {
      let changed = false;
      if (panel.createdBy === memberId) {
        delete panel.createdBy;
        changed = true;
      }
      // The routine they set stops. It keeps their name as its writer: its prompt is their text, and
      // run again as it is (by hand, or resumed) it gets the limits of someone who is on no team,
      // which are the narrowest. Setting the routine anew makes it the setter's.
      if (panel.routine?.setBy === memberId && panel.routine.enabled !== false) {
        panel.routine.enabled = false;
        panel.routine.nextAt = null;
        changed = true;
      }
      if (changed) this.touch(panel.spaceId, now);
    }
    this.ws.save();
  }

  // ── What people do in an app panel: its saved state, and notes ───────────────────────────────

  /**
   * Merges top-level keys into a panel's saved state (null removes a key), so two people who
   * change different things do not undo each other. `by` is { id, name }: the person, for the
   * panel's last line. Answers { rev }.
   */
  patchState(panelId, patch, label, by) {
    const panel = this.ws.panels.get(panelId);
    if (typeof by === "string") {
      this.need(this.of(panel), by, "change");
      by = this.named(by);
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A panel's state is changed with an object of the keys to set.");
    if (by) this.paced("state", by.id, panel.id);
    const state = { ...(panel.state ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete state[key];
      else state[key] = value;
    }
    const now = Date.now();
    panel.state = checkedState(state);
    panel.stateRev = (panel.stateRev ?? 0) + 1;
    if (by) panel.last = { by: by.id, name: by.name, ...(label != null && String(label).trim() && { label: plain(label, LIMITS.label) }), at: now };
    this.touch(panel.spaceId, now);
    this.ws.save();
    if (by) this.happened({ spaceId: panel.spaceId, panelId: panel.id, by: by.id, kind: "change", ...(panel.last.label && { label: panel.last.label }) });
    return { rev: panel.stateRev };
  }
  /**
   * Says what a person did, for the alerts: the link picks who is told (who can open the space,
   * what each asked for, never the person themselves or someone looking at it). What goes wrong
   * with an alert never undoes what the person did.
   */
  happened(event) {
    try {
      Promise.resolve(this.ws.spaceEventOf?.(event)).catch(() => {});
    } catch {}
  }
  /** A short note on a panel. Answers its id. */
  note(panelId, text, by) {
    const panel = this.ws.panels.get(panelId);
    if (typeof by === "string") {
      this.need(this.of(panel), by, "change");
      by = this.named(by);
    }
    const notes = (panel.notes ??= []);
    if (notes.length >= LIMITS.notes) throw new Error("This panel has " + LIMITS.notes + " notes. Remove one first.");
    const written = textField(text, LIMITS.note, "note");
    this.paced("note", by.id, panel.id);
    const now = Date.now();
    const note = { id: newId().replace("s_", "n_"), by: by.id, name: by.name, text: written, at: now };
    notes.push(note);
    panel.last = { by: by.id, name: by.name, label: "wrote a note", at: now };
    this.touch(panel.spaceId, now);
    this.ws.save();
    this.happened({ spaceId: panel.spaceId, panelId: panel.id, by: by.id, kind: "note", text: note.text });
    return note.id;
  }
  /** Removes a note. `mayRemoveAny` is for the space's maker and the computer's owner; anyone else removes their own. */
  removeNote(panelId, noteId, person, mayRemoveAny = this.can(this.of(this.ws.panels.get(panelId)), person) === "own") {
    const panel = this.ws.panels.get(panelId);
    this.need(this.of(panel), person, "change");
    const note = panel.notes?.find((item) => item.id === noteId);
    if (!note) throw new Error("This note no longer exists.");
    if (!mayRemoveAny && note.by !== person) throw new Error("You can remove your own notes.");
    panel.notes = panel.notes.filter((item) => item !== note);
    this.touch(panel.spaceId);
    this.ws.save();
  }
}

/** A whole saved state, as a bot or the first write gives it: an object within the limits. */
export function checkedState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("A panel's state is an object.");
  if (Object.keys(state).length > LIMITS.keys) throw new Error("A panel's state holds at most " + LIMITS.keys + " keys.");
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > LIMITS.state) throw new Error("A panel's state is at most 64 KB.");
  return JSON.parse(json);
}

/** A page's own words, as one line of plain text. */
function plain(value, max) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}
