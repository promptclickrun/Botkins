// Device access on the phone: the tool table against the computer's (link-host/device.mjs), the
// argument checks, dates, and how results are shaped. Run by `npm test` (tsx).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSources as hostCleanSources, DEVICE_TOOLS } from "../link-host/device.mjs";
import { checkArgs, DeviceError, isoLocal, limitOf, optList, optNumber, parseWhen, reqString, spanOf, startOfDay } from "../src/device/args";
import { HEALTH_KINDS, HEALTH_LOGS, HEALTH_TYPES, healthRequest, SUMMARY_KINDS, workoutName } from "../src/device/healthTypes";
import { appleLabel, cleanLabel, clip, compact, contactDate, contactSummary, daysOf, fit, matchContact, sleepByDay } from "../src/device/shape";
import { allows, cleanSources, countOn, levelsOf, PHONE_TOOLS, type PhoneToolName, sameSources, SOURCES, toolLabel, toolOf } from "../src/device/tools";

type HostTool = { name: string; source: string; level: string; hands?: boolean; parameters: { properties: Record<string, { enum?: string[] }>; required: string[] } };
const HOST = DEVICE_TOOLS as unknown as HostTool[];

test("every tool the computer offers runs on the phone, at the same source and level", () => {
  for (const tool of HOST) {
    const phone = toolOf(tool.name);
    assert.ok(phone, tool.name + " has no runner on the phone");
    assert.equal(phone.source, tool.source, tool.name);
    assert.equal(phone.level, tool.level, tool.name);
    assert.equal(!!phone.hands, !!tool.hands, tool.name + " hands");
  }
  // And the phone has nothing the computer doesn't know.
  assert.deepEqual(Object.keys(PHONE_TOOLS).sort(), HOST.map((tool) => tool.name).sort());
});

test("each tool takes exactly the arguments the computer's schema lists", () => {
  for (const tool of HOST) {
    const phone = PHONE_TOOLS[tool.name as PhoneToolName];
    assert.deepEqual([...phone.args].sort(), Object.keys(tool.parameters.properties).sort(), tool.name);
    for (const name of tool.parameters.required) assert.ok(phone.args.includes(name), tool.name + " requires " + name);
  }
});

test("the Health kinds match the computer's", () => {
  const samples = HOST.find((tool) => tool.name === "phone_health_samples")!;
  assert.deepEqual([...HEALTH_KINDS].sort(), [...samples.parameters.properties.type.enum!].sort());
  const log = HOST.find((tool) => tool.name === "phone_health_log")!;
  assert.deepEqual(Object.keys(HEALTH_LOGS).sort(), [...log.parameters.properties.type.enum!].sort());
  for (const kind of SUMMARY_KINDS) assert.ok(HEALTH_TYPES[kind]);
  // Only what may be written is asked for writing, and only at "interact".
  assert.deepEqual(healthRequest("read").toShare, []);
  assert.equal(healthRequest("interact").toShare.length, Object.keys(HEALTH_LOGS).length);
  assert.ok(healthRequest("read").toRead.includes("HKCategoryTypeIdentifierSleepAnalysis"));
  assert.equal(workoutName(37), "running");
  assert.equal(workoutName(63), "high intensity interval training");
  assert.equal(workoutName(12345), "other");
});

test("each source offers the levels some tool needs", () => {
  assert.deepEqual(levelsOf("calendar"), ["off", "read", "interact"]);
  assert.deepEqual(levelsOf("contacts"), ["off", "read", "interact"]);
  assert.deepEqual(levelsOf("health"), ["off", "read", "interact"]);
  assert.deepEqual(levelsOf("location"), ["off", "read"]);
  assert.deepEqual(levelsOf("photos"), ["off", "read", "interact"]);
  assert.deepEqual(levelsOf("mail"), ["off", "interact"]);
});

test("the switches the phone sends are the ones the computer keeps", () => {
  const all = { calendar: "interact", contacts: "read", health: "interact", location: "interact", photos: "interact", mail: "read", extra: "read" };
  const clean = cleanSources(all);
  // Location has nothing to change and Mail nothing to read, so those two are dropped.
  assert.deepEqual(clean, { calendar: "interact", contacts: "read", health: "interact", photos: "interact" });
  assert.deepEqual(hostCleanSources(clean), clean);
  for (const source of SOURCES) for (const level of levelsOf(source)) assert.deepEqual(hostCleanSources(cleanSources({ [source]: level })), cleanSources({ [source]: level }));
  assert.ok(sameSources({ calendar: "read", mail: "off" }, { calendar: "read" }));
  assert.ok(!sameSources({ calendar: "read" }, { calendar: "interact" }));
  assert.equal(countOn({ calendar: "read", mail: "interact", location: "off" }), 2);
  assert.deepEqual(cleanSources(null), {});
});

test("a switch allows its level and the ones below", () => {
  assert.ok(allows({ calendar: "interact" }, "calendar", "read"));
  assert.ok(allows({ calendar: "read" }, "calendar", "read"));
  assert.ok(!allows({ calendar: "read" }, "calendar", "interact"));
  assert.ok(!allows({}, "calendar", "read"));
});

test("the activity list says what a tool did in plain words", () => {
  assert.equal(toolLabel("phone_calendar_events"), "Read your calendar");
  assert.equal(toolLabel("phone_nope"), "Used a phone tool");
  assert.equal(toolOf("constructor"), undefined);
  for (const name of Object.keys(PHONE_TOOLS)) assert.ok(!toolLabel(name).includes("_"), name);
});

test("arguments are checked", () => {
  assert.deepEqual(checkArgs(undefined, []), {});
  assert.throws(() => checkArgs([], ["a"]), DeviceError);
  assert.throws(() => checkArgs({ calendarId: "x" }, ["calendar"]), /Unknown argument: calendarId/);
  assert.deepEqual(checkArgs({ a: 1, b: undefined }, ["a"]), { a: 1, b: undefined });
  assert.throws(() => reqString({ id: "  " }, "id"), /`id` is needed/);
  assert.throws(() => reqString({ id: 4 }, "id"), /must be text/);
  assert.equal(limitOf({}, 50, 200), 50);
  assert.equal(limitOf({ limit: 1000 }, 50, 200), 200);
  assert.equal(limitOf({ limit: 7.9 }, 50, 200), 7);
  assert.throws(() => limitOf({ limit: 0 }, 50, 200), /at least 1/);
  assert.throws(() => optNumber({ value: Number.NaN }, "value"), /must be a number/);
  assert.throws(() => optList({ phones: [1] }, "phones", (entry) => entry), /must be an object/);
});

test("dates: a date alone is that day's start in the phone's time zone", () => {
  const day = parseWhen("2026-11-19")!;
  assert.equal(day.dateOnly, true);
  assert.equal(day.date.getTime(), new Date(2026, 10, 19).getTime());
  assert.equal(parseWhen("2026-02-30"), null);
  assert.equal(parseWhen("tomorrow"), null);
  assert.equal(parseWhen("2026-11-19T09:00:00-06:00")!.date.toISOString(), "2026-11-19T15:00:00.000Z");
  assert.equal(parseWhen("2026-11-19T09:00:00Z")!.date.toISOString(), "2026-11-19T09:00:00.000Z");
  assert.equal(parseWhen("2026-11-19T09:00:00+0530")!.date.toISOString(), "2026-11-19T03:30:00.000Z");
  // A time without an offset is the phone's own.
  assert.equal(parseWhen("2026-11-19T09:30")!.date.getTime(), new Date(2026, 10, 19, 9, 30).getTime());
});

test("dates: a span from one date to the same date is that whole day", () => {
  const { start, end } = spanOf(parseWhen("2026-11-19")!, parseWhen("2026-11-19")!);
  assert.equal(start.getTime(), new Date(2026, 10, 19).getTime());
  assert.equal(end.getTime(), new Date(2026, 10, 20).getTime());
  assert.throws(() => spanOf(parseWhen("2026-11-19T10:00")!, parseWhen("2026-11-19T09:00")!), /before/);
  assert.throws(() => spanOf(parseWhen("2020-01-01")!, parseWhen("2026-01-01")!, 400), /too long/);
});

test("dates: results carry the phone's offset and read back to the same time", () => {
  const now = new Date(2026, 10, 19, 9, 5, 7);
  const text = isoLocal(now);
  assert.match(text, /^2026-11-19T09:05:07[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(text).getTime(), now.getTime());
  assert.equal(isoLocal("nonsense"), "");
});

test("days of a span start at midnight", () => {
  const days = daysOf(new Date(2026, 10, 18, 15), new Date(2026, 10, 20, 1));
  assert.deepEqual(days.map((day) => day.key), ["2026-11-18", "2026-11-19", "2026-11-20"]);
  assert.equal(days[0].start.getTime(), startOfDay(new Date(2026, 10, 18, 15)).getTime());
  assert.equal(daysOf(new Date(2026, 0, 1), new Date(2026, 11, 31)).length, 93);
});

test("sleep counts once, on the morning it ends", () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
  const hours = sleepByDay([
    { start: at(18, 23), end: at(19, 3), value: 3 }, // core
    { start: at(19, 2), end: at(19, 6), value: 5 }, // REM, overlapping a watch's record
    { start: at(19, 6), end: at(19, 6, 30), value: 2 }, // awake: not sleep
    { start: at(18, 22), end: at(19, 7), value: 0 }, // in bed: not sleep
  ]);
  assert.deepEqual(hours, { "2026-11-19": 7 });
});

test("contacts are found by name, company, number or email", () => {
  const card = { id: "1", fullName: "Ana María López", company: "Fern & Co", phones: [{ label: "_$!<Mobile>!$_", number: "+1 (512) 555-0134" }], emails: [{ label: "work", address: "ana@fern.example" }] };
  assert.ok(matchContact(card, "ana lopez"));
  assert.ok(matchContact(card, "FERN"));
  assert.ok(matchContact(card, "555 0134"));
  assert.ok(matchContact(card, "ana@fern"));
  assert.ok(!matchContact(card, "bea"));
  assert.ok(!matchContact(card, "  "));
  assert.deepEqual(contactSummary(card), { id: "1", name: "Ana María López", company: "Fern & Co", phones: [{ label: "mobile", number: "+1 (512) 555-0134" }], emails: [{ label: "work", email: "ana@fern.example" }] });
  assert.equal(cleanLabel("_$!<HomeFAX>!$_"), "homefax");
  assert.equal(appleLabel("Mobile", "phone"), "_$!<Mobile>!$_");
  assert.equal(appleLabel("Gym", "phone"), "Gym");
  assert.equal(contactDate({ month: 11, day: 9 }), "--11-09");
  assert.equal(contactDate({ year: 1990, month: 1, day: 2 }), "1990-01-02");
});

test("answers stay small", () => {
  assert.equal(clip("  hello  "), "hello");
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip(""), undefined);
  assert.deepEqual(compact({ a: 1, b: undefined, c: [], d: "", e: null, f: false }), { a: 1, f: false });
  const big = { items: Array.from({ length: 2000 }, (_, index) => ({ id: index, text: "x".repeat(200) })) };
  const fitted = fit(big, "items");
  assert.ok(JSON.stringify(fitted).length <= 200 * 1024);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.items.length > 100);
  assert.equal(fit({ items: [1, 2] }, "items").truncated, undefined);
});
