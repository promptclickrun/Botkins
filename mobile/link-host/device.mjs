// Tools that run on a paired phone ("device access").
//
// A person switches sources on in the phone app (Tools › Device access): Calendar, Contacts,
// Health, Location, Photos, Apple Music, Mail, each off, read, or read and interact. The phone tells this
// computer its choices, and the app offers its bots the matching tools (`tools()`). When a bot calls
// one (`call()`), the call waits in the "asks" part until the phone it is addressed to answers it
// with "link.device.answer". A phone that is asleep is woken with a push it doesn't show; when that
// doesn't work, the person gets a notification that a bot is waiting.
//
// The switches are the consent: a tool exists only while some phone allows its source at the level
// it needs. The phone checks again before it acts, so a stale list here can't reach past a switch.
// What a tool returns is the person's own data, on its way to a bot they chose to give it to; it is
// carried through the link sealed like everything else and is never written to disk or logged here.
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { Failure } from "./tools.mjs";

export const DEVICE_SOURCES = ["calendar", "contacts", "health", "location", "photos", "music", "mail"];
export const DEVICE_LEVELS = ["off", "read", "interact"];
const RANK = { off: 0, read: 1, interact: 2 };

const ANSWER_MS = 45_000; // how long a phone has for a tool that needs no one's hands
const HANDS_MS = 150_000; // and for one the person finishes on the phone (a mail to send)
const NUDGE_MS = 9_000; // an ask still unanswered after this long gets a visible notification
const MAX_ASKS = 16;
const MAX_RESULT = 256 * 1024;
const MAX_SEND = 5 * 1024 * 1024; // a picture on its way to a phone
const PICTURES = [".png", ".jpg", ".jpeg", ".heic", ".heif", ".gif", ".webp"];

const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const when = { type: "string", description: "An ISO 8601 date-time with offset (YYYY-MM-DDTHH:MM:SS±HH:MM) or YYYY-MM-DD for the start of that day in the phone's time zone." };
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const HEALTH_TYPES = ["steps", "distance", "activeEnergy", "exerciseMinutes", "standHours", "flightsClimbed", "heartRate", "restingHeartRate", "heartRateVariability", "sleep", "weight", "bodyFat", "bloodOxygen", "respiratoryRate", "water", "caffeine", "mindfulMinutes", "workouts"];
const HEALTH_LOGS = ["water", "weight", "caffeine", "mindfulMinutes", "bodyFat"];

/**
 * Every phone tool: its source, the level it needs, and what a bot is told. `hands` marks a tool
 * the person finishes on the phone, which only works while the app is open there.
 */
export const DEVICE_TOOLS = [
  { name: "phone_calendar_list", source: "calendar", level: "read", description: "Lists the calendars on the person's phone (name, account, color, whether events can be added).", parameters: object({}) },
  {
    name: "phone_calendar_events",
    source: "calendar",
    level: "read",
    description: "Reads events from the calendars on the person's phone between two times. Use it for what is on their schedule. Returns up to `limit` events with id, title, start, end, all-day, location, notes, calendar and attendees.",
    parameters: object({ from: when, to: when, query: { ...string, description: "Only events whose title, location or notes contain this." }, calendar: { ...string, description: "Only this calendar, by name or id." }, limit: { ...number, description: "Default 50, at most 200." } }, ["from", "to"]),
  },
  {
    name: "phone_calendar_create_event",
    source: "calendar",
    level: "interact",
    description: "Adds an event to a calendar on the person's phone. Returns the new event's id.",
    parameters: object({ title: string, start: when, end: when, allDay: boolean, location: string, notes: string, url: string, calendar: { ...string, description: "The calendar's name or id. Default: the phone's default calendar." }, alertMinutes: { ...number, description: "Remind this many minutes before." } }, ["title", "start", "end"]),
  },
  {
    name: "phone_calendar_update_event",
    source: "calendar",
    level: "interact",
    description: "Update an existing calendar event on the person's phone. Resolve the exact event id and source calendar with phone_calendar_events (and phone_calendar_list if needed) first, send only the fields to change, then read the event back with phone_calendar_events to verify.",
    parameters: object({ id: string, title: string, start: when, end: when, allDay: boolean, location: string, notes: string, url: string }, ["id"]),
  },
  { name: "phone_calendar_delete_event", source: "calendar", level: "interact", description: "Delete a calendar event from the person's phone by id (ask the person first unless they already said to). Resolve the exact event id and source calendar with phone_calendar_events first, then verify removal by reading back.", parameters: object({ id: string }, ["id"]) },

  {
    name: "phone_contacts_search",
    source: "contacts",
    level: "read",
    description: "Searches the contacts on the person's phone by name, company, phone number or email. Returns up to `limit` contacts with id, name, company, phone numbers and emails.",
    parameters: object({ query: string, limit: { ...number, description: "Default 20, at most 100." } }, ["query"]),
  },
  { name: "phone_contacts_get", source: "contacts", level: "read", description: "Reads one contact from the person's phone in full (addresses, birthday, notes, links), by id.", parameters: object({ id: string }, ["id"]) },
  {
    name: "phone_contacts_create",
    source: "contacts",
    level: "interact",
    description: "Adds a contact to the person's phone. Returns the new contact's id.",
    parameters: object({
      firstName: string,
      lastName: string,
      company: string,
      jobTitle: string,
      phones: { type: "array", items: object({ label: string, number: string }, ["number"]) },
      emails: { type: "array", items: object({ label: string, email: string }, ["email"]) },
      note: string,
    }),
  },
  {
    name: "phone_contacts_update",
    source: "contacts",
    level: "interact",
    description: "Changes a contact on the person's phone. Give its id and only the fields to change; a list of phones or emails replaces the list it has.",
    parameters: object(
      {
        id: string,
        firstName: string,
        lastName: string,
        company: string,
        jobTitle: string,
        phones: { type: "array", items: object({ label: string, number: string }, ["number"]) },
        emails: { type: "array", items: object({ label: string, email: string }, ["email"]) },
        note: string,
      },
      ["id"],
    ),
  },

  {
    name: "phone_health_summary",
    source: "health",
    level: "read",
    description: "Summarizes the person's Health data from their phone for a span of days (default: today): steps, distance, active energy, exercise minutes, sleep, heart rate, weight and workouts, with a total or average for each day.",
    parameters: object({ from: when, to: when }),
  },
  {
    name: "phone_health_samples",
    source: "health",
    level: "read",
    description: "Reads the person's Health records of one kind from their phone between two times, newest first.",
    parameters: object({ type: { type: "string", enum: HEALTH_TYPES }, from: when, to: when, limit: { ...number, description: "Default 100, at most 500." } }, ["type", "from", "to"]),
  },
  {
    name: "phone_health_log",
    source: "health",
    level: "interact",
    description: "Writes one record to Health on the person's phone: water (mL), weight (kg), caffeine (mg), mindful minutes (min) or body fat (percent).",
    parameters: object({ type: { type: "string", enum: HEALTH_LOGS }, value: number, at: when }, ["type", "value"]),
  },

  { name: "phone_location", source: "location", level: "read", description: "Where the person's phone is now: latitude, longitude, how exact it is, and the street address when it can be found.", parameters: object({}) },

  {
    name: "phone_photos_recent",
    source: "photos",
    level: "read",
    description: "Lists recent photos and videos on the person's phone, newest first, with id, time taken, size, kind and place when known. Use phone_photos_get to look at one.",
    parameters: object({ limit: { ...number, description: "Default 20, at most 100." }, from: when, to: when, album: { ...string, description: "Only this album, by name." }, kind: { type: "string", enum: ["photo", "video", "any"] } }),
  },
  {
    name: "phone_photos_get",
    source: "photos",
    level: "read",
    description: "Brings one photo from the person's phone to this computer, so you can look at it. Returns the file's path here. Videos are not brought over.",
    parameters: object({ id: string, maxSize: { ...number, description: "The longest side in pixels. Default 1600, at most 4000." } }, ["id"]),
    file: true,
  },
  {
    name: "phone_photos_save",
    source: "photos",
    level: "interact",
    description: "Saves a picture from this computer to the photo library on the person's phone. Give the file's full path here (PNG, JPEG, HEIC, GIF or WebP, at most 5 MB). Returns the new photo's id.",
    parameters: object({ path: { ...string, description: "The picture's full path on this computer." }, album: { ...string, description: "Also put it in this album (made when it doesn't exist)." } }, ["path"]),
    // The file at this argument travels to the phone, which is told only its name.
    send: "path",
  },
  {
    name: "phone_music_now_playing",
    source: "music",
    level: "read",
    description: "Reads the Apple Music item currently playing on the person's phone, including playback state, position, title, artist, album and duration.",
    parameters: object({}),
  },
  {
    name: "phone_music_search",
    source: "music",
    level: "read",
    description: "Searches Apple Music by title, artist or playlist name. `types` may contain songs, albums, playlists and artists. `source` is catalog or library (default: catalog when the person's subscription can play it, otherwise library). Returns stable Music IDs for play or library tools.",
    parameters: object({
      query: string,
      types: { type: "array", items: { type: "string", enum: ["songs", "albums", "playlists", "artists"] } },
      source: { type: "string", enum: ["catalog", "library"] },
      limit: { ...number, description: "Results per kind, from 1 to 25. Default 10." },
    }, ["query"]),
  },
  {
    name: "phone_music_library",
    source: "music",
    level: "read",
    description: "Lists Apple Music playlists or recently played songs from the person's library.",
    parameters: object({
      type: { type: "string", enum: ["playlists", "recent"] },
      limit: { ...number, description: "From 1 to 50. Default 25." },
    }),
  },
  {
    name: "phone_music_play",
    source: "music",
    level: "interact",
    description: "Starts a MusicKit song, album, playlist or artist on the person's phone. Give an ID from search/library together with its type and source, or give a query to play the best song match. Optional shuffle changes the queue's shuffle mode.",
    parameters: object({
      id: string,
      type: { type: "string", enum: ["song", "songs", "album", "albums", "playlist", "playlists", "artist", "artists"] },
      source: { type: "string", enum: ["catalog", "library"] },
      query: string,
      shuffle: boolean,
    }),
  },
  {
    name: "phone_music_control",
    source: "music",
    level: "interact",
    description: "Controls the Apple Music player on the person's phone.",
    parameters: object({ action: { type: "string", enum: ["pause", "resume", "next", "previous", "stop"] } }, ["action"]),
  },
  {
    name: "phone_music_create_playlist",
    source: "music",
    level: "interact",
    description: "Creates an Apple Music playlist on the person's phone. songIds may contain library or catalog song IDs. Returns the new playlist ID.",
    parameters: object({
      name: string,
      description: string,
      songIds: { type: "array", items: string, maxItems: 100 },
    }, ["name"]),
  },
  {
    name: "phone_music_add_playlist",
    source: "music",
    level: "interact",
    description: "Adds up to 100 songs, by library or catalog ID, to an Apple Music playlist already in the person's library.",
    parameters: object({
      playlistId: string,
      songIds: { type: "array", items: string, maxItems: 100 },
    }, ["playlistId", "songIds"]),
  },
  {
    name: "phone_music_add_library",
    source: "music",
    level: "interact",
    description: "Adds a song, album or playlist from the Apple Music catalog to the person's library. Artists cannot be added.",
    parameters: object({
      id: string,
      type: { type: "string", enum: ["song", "songs", "album", "albums", "playlist", "playlists"] },
    }, ["id", "type"]),
  },
  {
    name: "phone_mail_compose",
    source: "mail",
    level: "interact",
    hands: true,
    description:
      "Opens a new email on the person's phone with the fields filled in, for them to read and send themselves. It works only while Botkins is open on the phone, and it answers with what they did: sent, saved as a draft, or cancelled. An iPhone does not let apps read mail, so there is no tool to read it there.",
    parameters: object({ to: { type: "array", items: string }, cc: { type: "array", items: string }, bcc: { type: "array", items: string }, subject: string, body: string, html: { ...boolean, description: "The body is HTML." } }, ["to", "subject", "body"]),
  },
];
const BY_NAME = new Map(DEVICE_TOOLS.map((tool) => [tool.name, tool]));
const SOURCE_NAMES = { calendar: "Calendar", contacts: "Contacts", health: "Health", location: "Location", photos: "Photos", music: "Apple Music", mail: "Mail" };

/** A picture on this computer, read to be sent to a phone. Throws a sentence a bot can read. */
function pictureAt(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Give the picture's full path on this computer.");
  if (!PICTURES.includes(extname(path).toLowerCase())) throw new Error("Only a picture can be saved to Photos (PNG, JPEG, HEIC, GIF or WebP).");
  let size;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new Error("There is no picture at that path.");
  }
  if (size > MAX_SEND) throw new Error("That picture is over 5 MB. Make it smaller first.");
  return { name: basename(path).slice(0, 120), data: readFileSync(path) };
}

/** The switches a phone may send: known sources and levels only. Mail has nothing to read, and Location nothing to change. */
export function cleanSources(sources) {
  const clean = {};
  for (const source of DEVICE_SOURCES) {
    let level = DEVICE_LEVELS.includes(sources?.[source]) ? sources[source] : "off";
    if (source === "location" && level === "interact") level = "read";
    if (source === "mail" && level === "read") level = "off";
    if (level !== "off") clean[source] = level;
  }
  return clean;
}

export class DeviceTools {
  /**
   * @param store    the LinkStore (each phone's switches)
   * @param push     the Push module, to wake a phone or tell the person a bot is waiting
   * @param uploads  the Uploads module: a photo a phone sends arrives as one of its own uploads
   * @param changed  () => the "asks" part changed
   * @param onTools  () => the list of tools changed (a phone changed a switch, or was removed)
   * @param botName  (botId) => the bot's name, for the notification
   */
  constructor({ store, push, uploads, changed = () => {}, onTools = () => {}, botName = () => undefined, log = () => {}, now = Date.now }) {
    Object.assign(this, { store, push, uploads, changed, onTools, botName, log, now });
    this.pending = new Map(); // ask id → { ask, tool, resolve, reject, timers }
  }

  /** The phones that allow `source` at `level`, most recently seen first. */
  phones(source, level) {
    return this.store.data.devices.filter((device) => RANK[this.store.sources(device.id)[source] ?? "off"] >= RANK[level]).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  /** The tools some paired phone allows now. `readOnly` tools only look; the rest add or change something on the phone. */
  tools() {
    return DEVICE_TOOLS.filter((tool) => this.phones(tool.source, tool.level).length > 0).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, readOnly: tool.level === "read", source: tool.source }));
  }

  setSources(deviceId, sources) {
    this.store.setSources(deviceId, cleanSources(sources));
    this.changed();
    this.onTools();
  }

  /** The calls waiting on a phone, as the "asks" part carries them. */
  asks() {
    return [...this.pending.values()].map((entry) => entry.ask);
  }

  /**
   * Runs a tool on a phone and resolves with its result. Rejects with an Error a bot can read: no
   * phone allows it, the phone didn't answer, or the phone said no.
   */
  call(name, args = {}, { botId, chatId, signal } = {}) {
    const tool = BY_NAME.get(String(name));
    if (!tool) return Promise.reject(new Error("There is no phone tool named " + String(name).slice(0, 60) + "."));
    const device = this.phones(tool.source, tool.level)[0];
    if (!device) {
      const need = tool.level === "interact" ? "Read and interact" : "Read";
      return Promise.reject(new Error("No phone allows this. The person can switch " + SOURCE_NAMES[tool.source] + " to " + need + " in Botkins on their phone, under Tools › Device access."));
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) return Promise.reject(new Error("The arguments must be an object."));
    let file;
    if (tool.send) {
      try {
        file = pictureAt(args[tool.send]);
      } catch (error) {
        return Promise.reject(error);
      }
      // The phone fetches the picture with "link.device.file"; the path on this computer stays here.
      args = { ...args, [tool.send]: file.name };
    }
    if (this.pending.size >= MAX_ASKS) return Promise.reject(new Error("Too many phone tools are waiting. Try again in a moment."));
    if (signal?.aborted) return Promise.reject(new Error("Stopped."));

    const id = randomBytes(9).toString("base64url");
    const ask = { id, deviceId: device.id, tool: tool.name, args, at: this.now(), ...(botId && { botId }), ...(chatId && { chatId }) };
    return new Promise((resolve, reject) => {
      const done = (settle, value) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        for (const timer of entry.timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.changed();
        settle(value);
      };
      const onAbort = () => done(reject, new Error("Stopped."));
      const asleep = !this.push?.present(device.id);
      const timers = [
        setTimeout(() => done(reject, new Error(tool.hands ? "The person didn't finish this on their phone in time." : "The phone didn't answer. It may be off, out of reach, or Botkins may need to be opened on it.")), tool.hands ? HANDS_MS : ANSWER_MS),
      ];
      if (asleep) {
        // A tool the person finishes by hand needs the app in front, so they are told at once.
        if (tool.hands) this.nudge(device.id, tool, botId, chatId);
        else {
          this.push?.wake(device.id);
          timers.push(setTimeout(() => this.pending.has(id) && this.nudge(device.id, tool, botId, chatId), NUDGE_MS));
        }
      }
      for (const timer of timers) timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { ask, tool, timers, file, resolve: (value) => done(resolve, value), reject: (error) => done(reject, error) });
      this.changed();
    });
  }

  nudge(deviceId, tool, botId, chatId) {
    const name = this.botName(botId) ?? "A bot";
    this.push?.notify(deviceId, { t: name + " is waiting on your phone", m: "Open Botkins to let it use " + SOURCE_NAMES[tool.source] + ".", c: chatId, k: "device" }, { urgent: true, expiration: 120 });
  }

  /** The file an ask sends along, for the phone it is addressed to and while the ask is open. */
  file(deviceId, id) {
    const entry = this.pending.get(String(id));
    if (!entry || entry.ask.deviceId !== deviceId || !entry.file) throw new Failure("That question is no longer open.");
    return { name: entry.file.name, data: entry.file.data.toString("base64") };
  }

  /** A phone's answer to one of its asks. Anything else is refused. */
  answer(deviceId, id, answer) {
    const entry = this.pending.get(String(id));
    if (!entry || entry.ask.deviceId !== deviceId) throw new Failure("That question is no longer open.");
    if (answer?.ok !== true) return entry.reject(new Error(typeof answer?.error === "string" && answer.error ? answer.error.slice(0, 400) : "The phone couldn't do that."));
    let result = answer.result ?? null;
    if (entry.tool.file) {
      // The phone sent the picture as one of its own uploads; a bot is given the real file's path.
      const path = this.uploads?.ownFile(deviceId, result?.path);
      if (!path) return entry.reject(new Error("The photo didn't arrive."));
      result = { ...result, path };
    }
    let text;
    try {
      text = JSON.stringify(result);
    } catch {
      return entry.reject(new Error("The phone's answer couldn't be read."));
    }
    if (text.length > MAX_RESULT) return entry.reject(new Error("The phone's answer was too large. Ask for less at a time."));
    entry.resolve(result);
  }

  /** A phone was removed: its asks fail now, and its tools go. */
  forget(deviceId) {
    for (const entry of [...this.pending.values()]) if (entry.ask.deviceId === deviceId) entry.reject(new Error("That phone was removed."));
    this.onTools();
  }
  dispose() {
    for (const entry of [...this.pending.values()]) entry.reject(new Error("Botkins is closing."));
  }
}
