// A step's row in the chat has an icon for its kind of work (src/features/chat/WorkRows.tsx). The
// kind comes from the tool's name, as the desktop app's work summary reads it (turn.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepKind } from "../src/features/chat/turn";

test("a step's kind comes from its tool's name, and a server's tool or an unknown one is a tool", () => {
  assert.equal(stepKind({ name: "bash" }), "command");
  assert.equal(stepKind({ name: "Read_File" }), "read");
  assert.equal(stepKind({ name: "str_replace" }), "edit");
  assert.equal(stepKind({ name: "web_search" }), "web");
  // Claude spells its tools in one word: WebFetch, WebSearch, NotebookEdit.
  assert.equal(stepKind({ name: "WebFetch" }), "web-page");
  assert.equal(stepKind({ name: "WebSearch" }), "web");
  assert.equal(stepKind({ name: "NotebookEdit" }), "edit");
  assert.equal(stepKind({ name: "task" }), "helper");
  assert.equal(stepKind({ name: "bash", source: "github" }), "tool");
  assert.equal(stepKind({ name: "do_something_new" }), "tool");
  // A quiet step (report_intent) still gets a row's icon when it is shown.
  assert.equal(stepKind({ name: "report_intent" }), "tool");
});
