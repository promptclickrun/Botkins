// Sections on the Chats screen ("chat-sections-v1"; docs/link-contract.md). A section is a person's
// own way to group their chats: nobody else sees it, and it changes nothing about a chat. So it is
// kept where each person's other marks on chats are, in the team (`team.views[person].chatSections`),
// for the owner as for a member, and never reaches the app.
//
// Every method takes the person first: "owner", or a member's id. The link's calls (`link.chats.*`)
// pass the caller; the app on the host passes "owner" for its own window.
import { b64u, random } from "./crypto.mjs";
import { chatSectionsOf, CHAT_SECTION_LIMITS, inChat } from "./team.mjs";
import { Failure } from "./tools.mjs";

const GONE = "This section no longer exists.";

export class ChatSections {
  /**
   * @param team    () => the team as stored
   * @param setTeam (team) => saves it and tells every device
   * @param chats   () => the app's chats
   */
  constructor({ team, setTeam, chats }) {
    Object.assign(this, { team, setTeam, chats });
  }
  /** A person's sections in their order, and which of their chats is in which: `{ list, of }`. */
  for(person) {
    return chatSectionsOf(this.team(), person);
  }
  save(person, held) {
    const team = this.team();
    this.setTeam({ ...team, views: { ...(team.views ?? {}), [person]: { ...(team.views?.[person] ?? {}), chatSections: held } } });
  }
  /** A name as it is kept, or a failure that says what a name may be. Another section of the person may not have it already. */
  name(held, value, except) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name.length > CHAT_SECTION_LIMITS.name || /[\u0000-\u001f\u007f]/.test(name)) throw new Failure("Give the section a name of up to " + CHAT_SECTION_LIMITS.name + " characters.");
    if (held.list.some((section) => section.id !== except && section.name.toLowerCase() === name.toLowerCase())) throw new Failure("You already have a section with that name.");
    return name;
  }
  /** A new section at the end of the person's list. Answers its id. */
  add(person, value) {
    const held = this.for(person);
    if (held.list.length >= CHAT_SECTION_LIMITS.sections) throw new Failure("You have " + CHAT_SECTION_LIMITS.sections + " sections. Delete one first.");
    const section = { id: "cs_" + b64u(random(8)), name: this.name(held, value) };
    this.save(person, { ...held, list: [...held.list, section] });
    return section.id;
  }
  rename(person, id, value) {
    const held = this.for(person);
    if (!held.list.some((section) => section.id === id)) throw new Failure(GONE);
    const name = this.name(held, value, id);
    this.save(person, { ...held, list: held.list.map((section) => (section.id === id ? { ...section, name } : section)) });
    return null;
  }
  /** The section goes. Its chats stay in the person's list, in no section. */
  remove(person, id) {
    const held = this.for(person);
    if (!held.list.some((section) => section.id === id)) return null;
    this.save(person, { list: held.list.filter((section) => section.id !== id), of: Object.fromEntries(Object.entries(held.of).filter(([, section]) => section !== id)) });
    return null;
  }
  /** The person's order. Ids they do not have are dropped, and sections not named keep their place after the named ones. */
  order(person, ids) {
    const held = this.for(person);
    const named = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"))].flatMap((id) => held.list.find((section) => section.id === id) ?? []);
    this.save(person, { ...held, list: [...named, ...held.list.filter((section) => !named.includes(section))] });
    return null;
  }
  /** Puts one of the person's chats in a section, or in none (`null`). */
  set(person, chatId, sectionId) {
    const held = this.for(person);
    const chat = typeof chatId === "string" ? (this.chats() ?? []).find((one) => one?.id === chatId) : undefined;
    if (!chat || !inChat(this.team(), chat, person)) throw new Failure("This chat no longer exists.");
    const { [chatId]: _was, ...of } = held.of;
    if (sectionId != null) {
      if (!held.list.some((section) => section.id === sectionId)) throw new Failure(GONE);
      of[chatId] = sectionId;
    }
    this.save(person, { ...held, of });
    return null;
  }
}
