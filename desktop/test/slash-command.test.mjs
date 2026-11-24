// Slash command rail attachments (src/slashCommand.ts): parsing leading slash triggers,
// stripping triggers on pick, applying subcommand options, and composing outgoing slash prompts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCommandOption,
  composeSlashPrompt,
  isSideCommand,
  parseSlashInput,
  stripLeadingTrigger,
  toDraftCommand,
} from "../src/slashCommand.ts";

test("parseSlashInput recognizes leading slash commands and subcommands without matching paths", () => {
  assert.deepEqual(parseSlashInput("/", 1), { mode: "command", query: "", end: 1 });
  assert.deepEqual(parseSlashInput("/brain", 6), { mode: "command", query: "brain", end: 6 });
  assert.deepEqual(parseSlashInput("/brain refactor auth", 6), { mode: "command", query: "brain", end: 6 });
  assert.deepEqual(parseSlashInput("/thinking hi", 12), { mode: "subcommand", parent: "thinking", query: "hi", end: 12 });
  // Mid-token caret or file paths like /usr/bin should not open the slash menu.
  assert.equal(parseSlashInput("/brainstorm", 5), null);
  assert.equal(parseSlashInput("/usr/bin", 8), null);
  assert.equal(parseSlashInput("hello /brain", 12), null);
});

test("stripLeadingTrigger removes only the slash trigger and its single separating space", () => {
  assert.equal(stripLeadingTrigger("/brain", 6), "");
  assert.equal(stripLeadingTrigger("/brain refactor auth", 6), "refactor auth");
  assert.equal(stripLeadingTrigger("/thinking hi", 12), "");
});

test("toDraftCommand normalizes leading slashes and applyCommandOption builds subcommands", () => {
  const cmd = toDraftCommand({
    name: "/thinking",
    command: "/thinking",
    kind: "Command",
    source: "Built-in",
    description: "Adjust reasoning depth",
    hint: "Choose a level",
    options: [{ name: "high", description: "Deep reasoning" }],
  });
  assert.equal(cmd.name, "thinking");
  assert.equal(cmd.command, "thinking");
  assert.equal(cmd.hint, "Choose a level");
  assert.equal(cmd.options?.length, 1);

  const sub = applyCommandOption(cmd, { name: "high", description: "Deep reasoning" });
  assert.deepEqual(sub, {
    name: "thinking high",
    command: "thinking high",
    kind: "Command",
    source: "Built-in",
    description: "Deep reasoning",
  });
  assert.equal(sub.options, undefined);
});

test("composeSlashPrompt combines an attached rail command with drafted body text", () => {
  const skill = toDraftCommand({
    name: "review",
    command: "review",
    kind: "Skill",
    source: "Local",
    description: "Review changes",
  });
  assert.equal(composeSlashPrompt("", skill), "/review");
  assert.equal(composeSlashPrompt("  check the diff  ", skill), "/review check the diff");
  assert.equal(composeSlashPrompt("  plain message  ", null), "plain message");
});

test("isSideCommand detects /btw and /ask whether typed inline or attached on the rail", () => {
  const btw = toDraftCommand({
    name: "btw",
    command: "btw",
    kind: "Command",
    source: "Built-in",
    description: "Ask a side question",
  });
  assert.equal(isSideCommand("", btw), false);
  assert.equal(isSideCommand("   ", btw), false);
  assert.equal(isSideCommand("what port is it on?", btw), true);
  assert.equal(isSideCommand("/ask quick question", null), true);
  assert.equal(isSideCommand("/ask ", null), false);
});
