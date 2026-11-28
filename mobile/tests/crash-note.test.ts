// The note kept of an error that closed the app (src/state/crashNote.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crashNote, crashText, parseCrashNote } from "../src/state/crashNote";

test("a note keeps what the error said and where, short enough to read", () => {
  const error = new TypeError("Cannot read property 'id' of undefined");
  error.stack = "TypeError: Cannot read property 'id' of undefined\n    at ChatPane (index.bundle:1:100)\n    at BotHome (index.bundle:1:200)\n" + Array.from({ length: 80 }, (_, i) => "    at frame" + i).join("\n");
  const note = crashNote(error, "fatal", 1000, "0.17.25");
  assert.equal(note.message, "TypeError: Cannot read property 'id' of undefined");
  assert.equal(note.kind, "fatal");
  assert.equal(note.version, "0.17.25");
  const lines = note.stack.split("\n");
  assert.equal(lines[0], "at ChatPane (index.bundle:1:100)");
  assert.equal(lines.length, 30);
});

test("anything thrown makes a note", () => {
  assert.equal(crashNote("plain words", "screen", 1).message, "plain words");
  assert.equal(crashNote({ code: 7 }, "fatal", 1).message, '{"code":7}');
  assert.equal(crashNote(undefined, "fatal", 1).message, "undefined");
  assert.equal(crashNote(new Error("x".repeat(5000)), "fatal", 1).message.length, 600);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.ok(crashNote(loop, "fatal", 1).message.length > 0);
});

test("a kept note reads back, and anything else is no note", () => {
  const note = crashNote(new Error("boom"), "screen", 42, "1.0");
  assert.deepEqual(parseCrashNote(JSON.stringify(note)), note);
  assert.equal(parseCrashNote(""), null);
  assert.equal(parseCrashNote("not json"), null);
  assert.equal(parseCrashNote('{"message":"no time"}'), null);
  assert.equal(parseCrashNote(JSON.stringify({ at: 1, message: "m", kind: "other" }))?.kind, "fatal");
  assert.match(crashText(note), /^A screen failed at 1970-01-01T00:00:00\.042Z \(version 1\.0\)\n\nboom/);
});
