// Bot templates the person saves or receives. A template is a bot's setup without its history:
// name, role, about text, instructions, look and any portable bundled skills and routines.
import { LEGACY_NAME } from "./home.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { textField } from "./panels.mjs";
import { instructionsField, summaryField } from "./agents.mjs";
import { cleanLook } from "./looks.mjs";
import { templateBundle, templateFileBundle } from "./link/template-bundle.mjs";

/** The format a template file is written in. */
export const FORMAT = "botkins.bot-template";
/** An imported file may have been written before the app was renamed. */
export const FORMATS = [FORMAT, LEGACY_NAME.toLowerCase() + ".bot-template"];
const MAX_FILE = 256 * 1024;

/**
 * Checks a template's fields. The look keeps its eyes and custom colors (desktop/looks.mjs). A
 * look the app can't draw is dropped rather than failing the template, and so is `avatar`, the
 * silhouette an earlier version saved.
 */
export function templateFields(data) {
  return checkedFields(data, templateBundle(data?.bundle));
}

function checkedFields(data, bundle) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("This isn't a bot template.");
  const look = cleanLook(data.look);
  return {
    name: textField(data.name, 48, "template name"),
    role: textField(data.role, 90, "role"),
    summary: data.summary ? summaryField(data.summary) : "",
    instructions: instructionsField(data.instructions),
    ...(look && { look }),
    ...(bundle && { bundle }),
  };
}

/** The file someone else can import. */
export function templateFile(template) {
  const { name, role, summary, instructions, look } = template;
  const bundle = templateBundle(template.bundle);
  return { format: FORMAT, version: bundle ? 2 : 1, name, role, ...(summary && { summary }), instructions, ...(look && { look }), ...(bundle && { bundle }) };
}

/** Reads a shared template file's text, refusing anything that isn't one. */
export function parseTemplateFile(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_FILE) throw new Error("That file is too large to be a bot template.");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a bot template. Templates are .json files exported from Botkins.");
  }
  if (!FORMATS.includes(data?.format)) throw new Error("That file isn't a Botkins bot template.");
  return checkedFields(data, templateFileBundle(data));
}

export class Templates {
  constructor(ws) {
    this.ws = ws;
    ws.state.templates ??= [];
  }
  get all() {
    return this.ws.state.templates;
  }
  get(id) {
    const template = this.all.find((t) => t.id === id);
    if (!template) throw new Error("This template no longer exists.");
    return template;
  }
  add(fields, source, from) {
    if (this.all.length >= 200) throw new Error("You have 200 templates. Delete some before adding more.");
    const template = { id: randomUUID(), ...fields, source, ...(from && { from }), createdAt: Date.now() };
    this.all.unshift(template);
    this.ws.save();
    return template.id;
  }
  /** Saves a bot's setup as a template. */
  saveFromBot(botId, name) {
    const bot = this.ws.bot(botId);
    const fields = templateFields({ ...bot, name: name?.trim() || bot.name });
    return this.add(fields, "saved");
  }
  rename(id, name) {
    this.get(id).name = textField(name, 48, "template name");
    this.ws.save();
  }
  remove(id) {
    this.get(id);
    this.ws.state.templates = this.all.filter((t) => t.id !== id);
    this.ws.save();
  }
  /**
   * A template, or a bot as a template, as the text of its file, with a name to save it under:
   * { name, text }. For a window that can't show a save dialog (a phone, another computer).
   */
  exportText({ templateId, botId } = {}) {
    const fields = templateId ? this.get(templateId) : templateFields(this.ws.bot(botId));
    return { name: (fields.name.replace(/[\\/:*?"<>|\0-\x1f]+/g, " ").replace(/\s+/g, " ").trim() || "Bot template") + ".json", text: JSON.stringify(templateFile(fields), null, 2) + "\n" };
  }
  /** Writes a template, or a bot as a template, to a file the person chose. */
  exportTo(path, target) {
    writeFileSync(path, this.exportText(target).text);
  }
  /**
   * Imports a template from the text of a file someone shared: { name?, text }. Its instructions
   * are someone else's words, so the person reviews them before creating a bot.
   */
  importText({ name, text } = {}) {
    if (typeof text !== "string" || !text.trim()) throw new Error("That file is empty.");
    if (Buffer.byteLength(text, "utf8") > MAX_FILE) throw new Error("That file is too large to be a bot template.");
    const from = typeof name === "string" && name.trim() ? name.trim().split(/[\\/]/).pop().slice(0, 120) : undefined;
    return this.add(parseTemplateFile(text), "imported", from);
  }
  /** Imports a template file someone shared. */
  importFrom(path) {
    if (statSync(path).size > MAX_FILE) throw new Error("That file is too large to be a bot template.");
    return this.importText({ name: path, text: readFileSync(path, "utf8") });
  }
}
