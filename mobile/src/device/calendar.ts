// Calendar tools, through expo-calendar's object API (SDK 58).
import { type Access, accessOf, requireAccess } from "./access";
import { type Args, checkArgs, DeviceError, isoLocal, limitOf, optBool, optNumber, optString, optWhen, reqString, reqWhen, spanOf } from "./args";
import { calendarModule, need } from "./native";
import { argsOf } from "./tools";
import { clip, compact, fit, fold } from "./shape";

type CalendarModule = NonNullable<ReturnType<typeof calendarModule>>;
type Calendar = Awaited<ReturnType<CalendarModule["getCalendars"]>>[number];
type CalendarEvent = Awaited<ReturnType<CalendarModule["listEvents"]>>[number];

/** Reading needs full access; so does changing an event, which is found by reading. */
export async function calendarAccess(): Promise<Access> {
  const Calendar = calendarModule();
  if (!Calendar) return { state: "unavailable" };
  return accessOf(await Calendar.getCalendarPermissions(false));
}
export async function askCalendar(): Promise<Access> {
  const Calendar = calendarModule();
  if (!Calendar) return { state: "unavailable" };
  return accessOf(await Calendar.requestCalendarPermissions(false));
}

async function ready() {
  const Calendar = need(calendarModule);
  requireAccess("calendar", accessOf(await Calendar.getCalendarPermissions(false)));
  return Calendar;
}

async function eventCalendars(Calendar: CalendarModule) {
  return Calendar.getCalendars(Calendar.EntityTypes.EVENT);
}

/** A calendar by id, or by name (any case). */
function findCalendar(calendars: Calendar[], wanted: string): Calendar | undefined {
  return calendars.find((calendar) => calendar.id === wanted) ?? calendars.find((calendar) => fold(calendar.title) === fold(wanted));
}

const toDate = (value: string | Date | undefined | null) => (value ? new Date(value) : undefined);

async function eventOf(event: CalendarEvent, calendars: Map<string, string>) {
  let attendees: { name?: string; email?: string; status?: string }[] = [];
  try {
    attendees = (await event.getAttendees()).slice(0, 30).map((attendee) => compact({ name: clip(attendee.name, 120), email: clip(attendee.email, 200), status: attendee.status && attendee.status !== "unknown" ? String(attendee.status) : undefined }));
  } catch {
    // An event without attendees, or one the phone won't list them for.
  }
  return compact({
    id: event.id,
    title: clip(event.title, 300) ?? "(no title)",
    start: isoLocal(toDate(event.startDate) ?? new Date(NaN)),
    end: isoLocal(toDate(event.endDate) ?? new Date(NaN)),
    allDay: event.allDay,
    location: clip(event.location, 300),
    notes: clip(event.notes, 1000),
    url: clip(event.url, 500),
    calendar: calendars.get(event.calendarId),
    recurring: event.recurrenceRule ? true : undefined,
    attendees,
  });
}

async function list(raw: unknown) {
  checkArgs(raw, argsOf("phone_calendar_list"));
  const Calendar = await ready();
  const calendars = await eventCalendars(Calendar);
  return {
    calendars: calendars.map((calendar) => compact({ id: calendar.id, name: calendar.title, account: calendar.source?.name, color: calendar.color, canAddEvents: calendar.allowsModifications })),
  };
}

async function events(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_calendar_events"));
  const { start, end } = spanOf(reqWhen(args, "from"), reqWhen(args, "to"), 400);
  const query = optString(args, "query", 200)?.trim();
  const only = optString(args, "calendar", 200)?.trim();
  const limit = limitOf(args, 50, 200);
  const Calendar = await ready();
  const all = await eventCalendars(Calendar);
  let chosen = all;
  if (only) {
    const calendar = findCalendar(all, only);
    if (!calendar) throw new DeviceError("No calendar named " + JSON.stringify(only.slice(0, 80)) + ".");
    chosen = [calendar];
  }
  if (!chosen.length) return { events: [] };
  let found = await Calendar.listEvents(chosen.map((calendar) => calendar.id), start, end);
  if (query) {
    const words = fold(query);
    found = found.filter((event) => [event.title, event.location, event.notes].some((text) => text && fold(text).includes(words)));
  }
  found.sort((a, b) => (toDate(a.startDate)?.getTime() ?? 0) - (toDate(b.startDate)?.getTime() ?? 0));
  const names = new Map(all.map((calendar) => [calendar.id, calendar.title]));
  const shown = await Promise.all(found.slice(0, limit).map((event) => eventOf(event, names)));
  return fit({ events: shown, ...(found.length > limit && { more: found.length - limit }) }, "events");
}

/** The fields an event takes, from a tool's arguments. */
function details(args: Args, creating: boolean) {
  const start = creating ? reqWhen(args, "start") : optWhen(args, "start");
  const end = creating ? reqWhen(args, "end") : optWhen(args, "end");
  let allDay = optBool(args, "allDay");
  // An event given as two dates alone is an all-day one.
  if (creating && allDay === undefined && start?.dateOnly && end?.dateOnly) allDay = true;
  let endDate = end?.date;
  if (start && end) endDate = spanOf(start, end, 3660).end;
  const title = creating ? reqString(args, "title", 500) : optString(args, "title", 500);
  return compact({
    title: title?.trim(),
    startDate: start?.date,
    endDate,
    allDay,
    location: optString(args, "location", 1000),
    notes: optString(args, "notes", 10_000),
    url: optString(args, "url", 2000),
  });
}

async function create(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_calendar_create_event"));
  const fields = details(args, true);
  const alert = optNumber(args, "alertMinutes", { min: 0, max: 40_320 });
  const wanted = optString(args, "calendar", 200)?.trim();
  const Calendar = await ready();
  let calendar: Calendar;
  if (wanted) {
    const found = findCalendar(await eventCalendars(Calendar), wanted);
    if (!found) throw new DeviceError("No calendar named " + JSON.stringify(wanted.slice(0, 80)) + ".");
    calendar = found;
  } else {
    try {
      calendar = Calendar.getDefaultCalendarSync();
    } catch {
      throw new DeviceError("This phone has no default calendar. Name one with `calendar`.");
    }
  }
  if (!calendar.allowsModifications) throw new DeviceError("Events can't be added to " + JSON.stringify(calendar.title) + ".");
  const event = await calendar.createEvent({ ...fields, ...(alert !== undefined && { alarms: [{ relativeOffset: -Math.round(alert) }] }) });
  return { id: event.id, calendar: calendar.title };
}

async function getEvent(Calendar: CalendarModule, id: string) {
  try {
    return await Calendar.ExpoCalendarEvent.get(id);
  } catch {
    throw new DeviceError("No event with that id.");
  }
}

async function update(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_calendar_update_event"));
  const id = reqString(args, "id", 500);
  const fields = details(args, false);
  if (!Object.keys(fields).length) throw new DeviceError("Give at least one field to change.");
  const Calendar = await ready();
  const event = await getEvent(Calendar, id);
  const start = fields.startDate ?? toDate(event.startDate);
  const end = fields.endDate ?? toDate(event.endDate);
  if (start && end && end.getTime() < start.getTime()) throw new DeviceError("The event would end before it starts.");
  await event.update(fields);
  return { id: event.id, updated: true };
}

async function remove(raw: unknown) {
  const args = checkArgs(raw, argsOf("phone_calendar_delete_event"));
  const id = reqString(args, "id", 500);
  const Calendar = await ready();
  const event = await getEvent(Calendar, id);
  await event.delete();
  return { id, deleted: true };
}

export const calendarTools = {
  phone_calendar_list: list,
  phone_calendar_events: events,
  phone_calendar_create_event: create,
  phone_calendar_update_event: update,
  phone_calendar_delete_event: remove,
};
