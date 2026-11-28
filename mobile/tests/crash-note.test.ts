// The note kept of an error nothing caught (src/state/crashNote.ts), and what is done with such an error (crashHandler in lastCrash.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crashNote, crashText, parseCrashNote } from "../src/state/crashNote";

test("a note keeps what the error said and where, short enough to read", () => {
  const error = new TypeError("Cannot read property 'id' of undefined");
  error.stack = "TypeError: Cannot read property 'id' of undefined\n    at ChatPane (index.bundle:1:100)\n    at BotHome (index.bundle:1:200)\n" + Array.from({ length: 80 }, (_, i) => "    at frame" + i).join("\n");
  const note = crashNote(error, "error", 1000, "0.17.25");
  assert.equal(note.message, "TypeError: Cannot read property 'id' of undefined");
  assert.equal(note.kind, "error");
  assert.equal(note.version, "0.17.25");
  const lines = note.stack.split("\n");
  assert.equal(lines[0], "at ChatPane (index.bundle:1:100)");
  assert.equal(lines.length, 30);
});

test("anything thrown makes a note", () => {
  assert.equal(crashNote("plain words", "screen", 1).message, "plain words");
  assert.equal(crashNote({ code: 7 }, "error", 1).message, '{"code":7}');
  assert.equal(crashNote(undefined, "error", 1).message, "undefined");
  assert.equal(crashNote(new Error("x".repeat(5000)), "error", 1).message.length, 600);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.ok(crashNote(loop, "error", 1).message.length > 0);
});

test("a kept note reads back, and anything else is no note", () => {
  const note = crashNote(new Error("boom"), "screen", 42, "1.0");
  assert.deepEqual(parseCrashNote(JSON.stringify(note)), note);
  assert.equal(parseCrashNote(""), null);
  assert.equal(parseCrashNote("not json"), null);
  assert.equal(parseCrashNote('{"message":"no time"}'), null);
  assert.equal(parseCrashNote(JSON.stringify({ at: 1, message: "m", kind: "other" }))?.kind, "error");
  assert.match(crashText(note), /^A screen failed at 1970-01-01T00:00:00\.042Z \(version 1\.0\)\n\nboom/);
});

test("an error nothing caught is kept and does not close the app; in development it still shows", async () => {
  const load = (await import("node:module")).createRequire(__filename);
  const Module = (await import("node:module")).default;
  const standIn = (path: string, exports: unknown) => {
    const id = load.resolve(path);
    const replacement = new Module(id);
    replacement.exports = exports;
    replacement.loaded = true;
    load.cache[id] = replacement;
  };
  standIn("expo-application", {});
  standIn("expo-file-system", {});
  standIn("../src/state/store", { showToast() {} });
  const { crashHandler } = load("../src/state/lastCrash");
  const kept: unknown[] = [];
  const passed: unknown[] = [];
  let told = 0;
  let clock = 0;
  const make = (dev: boolean) => crashHandler({ dev, before: (error: unknown, fatal?: boolean) => void passed.push([error, fatal]), keep: (error: unknown) => void kept.push(error), tell: () => void told++, now: () => clock });
  const live = make(false);
  live("boom", true);
  assert.deepEqual([kept, passed, told], [["boom"], [], 1], "kept, the person told, and React Native's handler (which closes the app) not called");
  // The same error again and again: kept each time, said once in a while.
  clock = 1000;
  live("boom", true);
  assert.deepEqual([kept.length, told], [2, 1]);
  clock = 9000;
  live("boom", true);
  assert.equal(told, 2);
  // What is not fatal goes on as before.
  live("warn", false);
  assert.deepEqual(passed, [["warn", false]]);
  // In development the red screen still shows.
  make(true)("dev", true);
  assert.deepEqual(passed.at(-1), ["dev", true]);
  // Telling the person fails: that is not a second error.
  crashHandler({ dev: false, keep() {}, tell: () => { throw new Error("no toast"); } })("x", true);
});
