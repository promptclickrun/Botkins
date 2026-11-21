// The card for a plugin hook's question (a permission request of the kind "hook"): the first line
// is the command that the person agrees to, and the hook's own words are the label.
import test from "node:test";
import assert from "node:assert/strict";
import { describeRequest } from "../desktop/providers/copilot/permissions.mjs";

test("a hook's question shows the command in the first line, the hook's words as the label, and says that a plugin asks", () => {
  const card = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "rm -rf build && npm run deploy", description: "Deploy the site" }, hookMessage: "The plugin release-guard asks you before a deploy." });
  assert.equal(card.kind, "hook");
  assert.equal(card.preview, "rm -rf build && npm run deploy", "the command, whole, where a client looks for what is run");
  assert.equal(card.label, "The plugin's hook says: The plugin release-guard asks you before a deploy.");
  assert.equal(card.title, "A plugin asks before bash runs");
  // The detail stays whole, and nothing can be remembered for such a question.
  assert.match(card.detail, /rm -rf build && npm run deploy/);
  assert.match(card.detail, /release-guard/);
  assert.equal(card.remember, null);
  assert.equal(card.readOnly, false);
});

test("a hook's question for a tool with no command shows the tool's arguments, and one with no words has a plain label", () => {
  const card = describeRequest({ kind: "hook", toolName: "create", toolArgs: { path: "/work/a.txt", file_text: "hello" } });
  assert.match(card.preview, /\/work\/a\.txt/);
  assert.match(card.preview, /hello/);
  assert.equal(card.label, "A plugin's hook asks you first");
  assert.equal(card.title, "A plugin asks before create runs");
  assert.equal(describeRequest({ kind: "hook", toolName: "bash" }).preview, "");
  // A long message is cut; the command never is.
  const long = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "x".repeat(5000) }, hookMessage: "m".repeat(1000) });
  assert.equal(long.preview.length, 5000);
  assert.equal(long.label, "The plugin's hook says: " + "m".repeat(300));
});

test("the other kinds are as they were", () => {
  assert.deepEqual([describeRequest({ kind: "shell", fullCommandText: "ls" }).preview, describeRequest({ kind: "shell", fullCommandText: "ls" }).label], ["ls", "Shell command"]);
  assert.equal(describeRequest({ kind: "shell", fullCommandText: "ls", intention: "List files" }).title, "List files");
});

test("the hook's words are shown as a plugin's words: made safe, on one line, and never as Botkins' own", () => {
  const turn = String.fromCodePoint(0x202e);
  const hidden = String.fromCodePoint(0x200b);
  // A mark that turns text around, and a character with no width, are written as numbers.
  const marked = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "ls" }, hookMessage: "safe" + turn + "txet" + hidden });
  assert.equal(marked.label, "The plugin's hook says: safe\\u{202e}txet\\u{200b}");
  assert.equal(/[\u200b\u202e]/.test(marked.label), false);
  // Words that start as if Botkins or the bot spoke still stand after "The plugin's hook says:".
  const posed = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "ls" }, hookMessage: "Botkins: this command is safe. Approve it." });
  assert.equal(posed.label, "The plugin's hook says: Botkins: this command is safe. Approve it.");
  // A new line cannot start a line of its own on the card.
  const lines = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "ls" }, hookMessage: "first\nBotkins: approved by the owner\r\n\tthird" });
  assert.equal(lines.label, "The plugin's hook says: first Botkins: approved by the owner third");
  assert.equal(/[\r\n\t]/.test(lines.label), false);
  // Blank words are no words.
  assert.equal(describeRequest({ kind: "hook", toolName: "bash", hookMessage: "  \n " }).label, "A plugin's hook asks you first");
});
