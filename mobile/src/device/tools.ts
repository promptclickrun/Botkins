// The phone's own list of the tools a bot can run on it (the computer's list is DEVICE_TOOLS in
// link-host/device.mjs; tests/device.test.ts keeps the two the same). No React Native imports.
import type { DeviceLevel, DeviceSource, DeviceSources } from "@/link/types";

export type PhoneTool = {
  source: DeviceSource;
  /** The least level the source must be switched to. */
  level: Exclude<DeviceLevel, "off">;
  /** The person finishes it on the phone, so it needs the app in front. */
  hands?: boolean;
  /** What it did, in plain words, for the activity list. */
  label: string;
  /** The arguments it takes (the computer's JSON Schema lists the same). */
  args: readonly string[];
};

export const PHONE_TOOLS = {
  phone_calendar_list: { source: "calendar", level: "read", args: [], label: "Listed your calendars" },
  phone_calendar_events: { source: "calendar", level: "read", args: ["from", "to", "query", "calendar", "limit"], label: "Read your calendar" },
  phone_calendar_create_event: { source: "calendar", level: "interact", args: ["title", "start", "end", "allDay", "location", "notes", "url", "calendar", "alertMinutes"], label: "Added an event" },
  phone_calendar_update_event: { source: "calendar", level: "interact", args: ["id", "title", "start", "end", "allDay", "location", "notes", "url"], label: "Changed an event" },
  phone_calendar_delete_event: { source: "calendar", level: "interact", args: ["id"], label: "Deleted an event" },
  phone_contacts_search: { source: "contacts", level: "read", args: ["query", "limit"], label: "Searched your contacts" },
  phone_contacts_get: { source: "contacts", level: "read", args: ["id"], label: "Read a contact" },
  phone_contacts_create: { source: "contacts", level: "interact", args: ["firstName", "lastName", "company", "jobTitle", "phones", "emails", "note"], label: "Added a contact" },
  phone_contacts_update: { source: "contacts", level: "interact", args: ["id", "firstName", "lastName", "company", "jobTitle", "phones", "emails", "note"], label: "Changed a contact" },
  phone_health_summary: { source: "health", level: "read", args: ["from", "to"], label: "Read your Health summary" },
  phone_health_samples: { source: "health", level: "read", args: ["type", "from", "to", "limit"], label: "Read your Health records" },
  phone_health_log: { source: "health", level: "interact", args: ["type", "value", "at"], label: "Logged to Health" },
  phone_location: { source: "location", level: "read", args: [], label: "Checked where you are" },
  phone_photos_recent: { source: "photos", level: "read", args: ["limit", "from", "to", "album", "kind"], label: "Listed your photos" },
  phone_photos_get: { source: "photos", level: "read", args: ["id", "maxSize"], label: "Brought over a photo" },
  phone_photos_save: { source: "photos", level: "interact", args: ["path", "album"], label: "Saved a picture to Photos" },
  phone_music_now_playing: { source: "music", level: "read", args: [], label: "Checked what is playing" },
  phone_music_search: { source: "music", level: "read", args: ["query", "types", "source", "limit"], label: "Searched Apple Music" },
  phone_music_library: { source: "music", level: "read", args: ["type", "limit"], label: "Read your Apple Music library" },
  phone_music_play: { source: "music", level: "interact", args: ["id", "type", "source", "query", "shuffle"], label: "Played Apple Music" },
  phone_music_control: { source: "music", level: "interact", args: ["action"], label: "Controlled Apple Music" },
  phone_music_create_playlist: { source: "music", level: "interact", args: ["name", "description", "songIds"], label: "Made an Apple Music playlist" },
  phone_music_add_playlist: { source: "music", level: "interact", args: ["playlistId", "songIds"], label: "Added songs to an Apple Music playlist" },
  phone_music_add_library: { source: "music", level: "interact", args: ["id", "type"], label: "Added music to your library" },
  phone_mail_compose: { source: "mail", level: "interact", args: ["to", "cc", "bcc", "subject", "body", "html"], hands: true, label: "Opened an email for you" },
} satisfies Record<string, PhoneTool>;

export type PhoneToolName = keyof typeof PHONE_TOOLS;

export const SOURCES: DeviceSource[] = ["calendar", "contacts", "health", "location", "photos", "music", "mail"];
export const SOURCE_NAMES: Record<DeviceSource, string> = { calendar: "Calendar", contacts: "Contacts", health: "Health", location: "Location", photos: "Photos", music: "Apple Music", mail: "Mail" };

const RANK: Record<DeviceLevel, number> = { off: 0, read: 1, interact: 2 };

export function toolOf(name: string): PhoneTool | undefined {
  return Object.prototype.hasOwnProperty.call(PHONE_TOOLS, name) ? (PHONE_TOOLS as Record<string, PhoneTool>)[name] : undefined;
}

/** The levels a source offers: off, and each level some tool needs. Location has nothing to change; Mail has nothing to read. */
export function levelsOf(source: DeviceSource): DeviceLevel[] {
  const needed = new Set(Object.values(PHONE_TOOLS as Record<string, PhoneTool>).filter((tool) => tool.source === source).map((tool) => tool.level));
  return ["off", ...(["read", "interact"] as const).filter((level) => needed.has(level))];
}

/** Whether `sources` lets a tool that needs `level` of `source` run. */
export function allows(sources: DeviceSources, source: DeviceSource, level: DeviceLevel): boolean {
  return RANK[sources[source] ?? "off"] >= RANK[level];
}

/** Known sources at levels they offer, with "off" left out: what the computer keeps. */
export function cleanSources(sources: unknown): DeviceSources {
  const clean: DeviceSources = {};
  const given = (sources && typeof sources === "object" ? sources : {}) as Record<string, unknown>;
  for (const source of SOURCES) {
    const level = given[source];
    if ((level === "read" || level === "interact") && levelsOf(source).includes(level)) clean[source] = level;
  }
  return clean;
}

/** Two sets of switches mean the same. */
export function sameSources(a: DeviceSources | undefined, b: DeviceSources | undefined): boolean {
  const left = cleanSources(a);
  const right = cleanSources(b);
  return SOURCES.every((source) => left[source] === right[source]);
}

/** How many sources are on. */
export function countOn(sources: DeviceSources): number {
  return Object.keys(cleanSources(sources)).length;
}

/** The arguments a tool takes. */
export function argsOf(name: PhoneToolName): readonly string[] {
  return PHONE_TOOLS[name].args;
}

/** The tool's name in plain words, for the activity list. */
export function toolLabel(name: string): string {
  return toolOf(name)?.label ?? "Used a phone tool";
}
