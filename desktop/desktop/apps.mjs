// HTML apps: a bot hands the person a small interactive page (Bighelp's HTML apps, docs/HTML_APPS.md).
// The page is stored with the workspace and opens in its own sandboxed window (desktop/app-window.mjs).
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "./providers/provider.mjs";
import { textField } from "./panels.mjs";

const MAX_HTML = 600_000;
const MAX_DATA = 1_000_000;

function htmlField(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Provide the app's HTML.");
  if (value.length > MAX_HTML) throw new Error("Keep the app under 600,000 characters.");
  return value;
}
function dataField(value) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined || text.length > MAX_DATA) throw new Error("Keep the app's data under 1,000,000 characters of JSON.");
  return text;
}

export class Apps {
  constructor(ws) {
    this.ws = ws;
    ws.state.apps ??= [];
    this.dir = join(ws.dir, "apps");
  }
  get all() {
    return this.ws.state.apps;
  }
  get(id) {
    const app = this.all.find((a) => a.id === id);
    if (!app) throw new Error("This app no longer exists.");
    return app;
  }
  folder(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid app");
    return join(this.dir, id);
  }
  create(botId, chatId, runId, { title, description, html, data, sendsAnswers = false }) {
    const app = {
      id: randomUUID(),
      botId,
      chatId,
      runId,
      title: textField(title, 80, "app title"),
      description: textField(description, 240, "app description"),
      sendsAnswers: !!sendsAnswers,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const page = htmlField(html);
    const json = dataField(data);
    mkdirSync(this.folder(app.id), { recursive: true });
    writeFileSync(join(this.folder(app.id), "index.html"), page, { mode: 0o600 });
    writeFileSync(join(this.folder(app.id), "data.json"), json ?? "null", { mode: 0o600 });
    this.all.push(app);
    this.ws.save();
    return app;
  }
  /** A bot replaces its own app's page or data; an open window receives new data at once. */
  update(botId, id, { html, data, title, description }) {
    const app = this.get(id);
    if (app.botId !== botId) throw new Error("You can only change your own apps.");
    // Check everything before changing anything.
    const page = html !== undefined ? htmlField(html) : undefined;
    const json = data !== undefined ? dataField(data) : undefined;
    const name = title !== undefined ? textField(title, 80, "app title") : undefined;
    const about = description !== undefined ? textField(description, 240, "app description") : undefined;
    if (page !== undefined) writeFileSync(join(this.folder(id), "index.html"), page, { mode: 0o600 });
    if (json !== undefined) writeFileSync(join(this.folder(id), "data.json"), json, { mode: 0o600 });
    if (name !== undefined) app.title = name;
    if (about !== undefined) app.description = about;
    app.updatedAt = Date.now();
    this.ws.save();
    this.onChange?.(app, { html: html !== undefined, data: data !== undefined });
    return app;
  }
  page(id) {
    this.get(id);
    return readFileSync(join(this.folder(id), "index.html"), "utf8");
  }
  data(id) {
    this.get(id);
    try {
      return JSON.parse(readFileSync(join(this.folder(id), "data.json"), "utf8"));
    } catch {
      return null;
    }
  }
  removeChats(chatIds) {
    const ids = new Set(chatIds);
    this.onRemove?.(this.all.filter((a) => ids.has(a.chatId)).map((a) => a.id));
    for (const app of this.all.filter((a) => ids.has(a.chatId))) rmSync(this.folder(app.id), { recursive: true, force: true });
    this.ws.state.apps = this.all.filter((a) => !ids.has(a.chatId));
  }
  tools(bot, chat, run, task) {
    const string = { type: "string" };
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
    return [
      tool(
        "show_app",
        "Show the person a small interactive app in this chat, such as a calculator, a form, a checklist, a picker or a visualization. Write one self-contained HTML document with inline CSS and JavaScript. The page has no network access and cannot load outside scripts, styles, fonts or images (use inline SVG or data: URLs). Read data with `await window.botkins.getData()` and live updates with `window.botkins.onData(fn)`. When the person finishes, call `window.botkins.sendAnswer(text)`: the text goes into the person's message box for them to review and send. Set sends_answers when the app does that.",
        { title: string, description: string, html: string, data: {}, sends_answers: { type: "boolean" } },
        ["title", "description", "html"],
        ({ title, description, html, data, sends_answers }) => {
          if ((run.apps?.length ?? 0) >= 4) throw new Error("Show at most four apps per reply.");
          const app = this.create(bot.id, chat.id, run.id, { title, description, html, data, sendsAnswers: sends_answers });
          (run.apps ??= []).push({ id: app.id, title: app.title, description: app.description, sendsAnswers: app.sendsAnswers });
          this.ws.save();
          return { shown: app.id, title: app.title };
        },
      ),
      tool(
        "update_app",
        "Replace the HTML or the data of an app you showed earlier. New data reaches an open app at once through onData.",
        { id: string, html: string, data: {}, title: string, description: string },
        ["id"],
        ({ id, ...patch }) => {
          const app = this.update(bot.id, id, patch);
          return { updated: app.id };
        },
      ),
    ];
  }
}
