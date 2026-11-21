// What the window shows of a plugin for a decision (src/pluginStarts.ts): every field of the
// description as text, where a setting goes, and when the window asks first.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decisionText,
  folderLine,
  heldBack,
  hookWords,
  linkedError,
  namedLine,
  notRunView,
  onOffLabel,
  otherFilesView,
  runsCommands,
  sentToLines,
  skillsOff,
  startQuestion,
  switchedOffNotice,
  timeLimit,
  toldKey,
  toolWords,
  unmarkedLine,
} from "../src/pluginStarts.ts";

const HERE = { starts: true };
const OLDER = { name: "Studio Mac", starts: false };
const NEWER = { name: "Studio Mac", starts: true };
const none = { skills: [], agents: [], commands: [], mcpServers: [], hooks: [] };
const local = { name: "notes", kind: "local", command: "npx", args: ["-y", "@scope/notes server", "--port", "3000"], env: [{ name: "NOTES_TOKEN", value: "${TOKEN}" }], cwd: "server/bin" };
const hook = { event: "userPromptSubmitted", command: "node hook.mjs", env: [], timeoutSec: 10 };

test("text for a decision: marks that change what is seen are written as numbers, lines and tabs stay", () => {
  assert.equal(decisionText("rm -rf ‮gnp.txt"), "rm -rf \\u{202e}gnp.txt");
  assert.equal(decisionText("a​b"), "a\\u{200b}b");
  assert.equal(decisionText("first line\n\tsecond\r\nthird"), "first line\n\tsecond\nthird");
  assert.equal(decisionText("bell\u0007"), "bell\\u{7}");
  assert.equal(decisionText("Zoë 日本語"), "Zoë 日本語");
  assert.equal(decisionText(undefined), "");
});

test("a local tool is its whole line, word by word; a name comes with its value", () => {
  assert.deepEqual(toolWords(local), ["npx", "-y", "@scope/notes server", "--port", "3000"]);
  assert.deepEqual(toolWords({ name: "old", kind: "local", command: "node" }), ["node"], "an older computer sends the command alone");
  assert.deepEqual(toolWords({ name: "x", kind: "local", command: "sh", args: ["-c", "echo ‮hi"] }), ["sh", "-c", "echo \\u{202e}hi"]);
  assert.equal(namedLine({ name: "GIT_SSH_COMMAND", value: "ssh -i ${KEY}" }), "GIT_SSH_COMMAND = ssh -i ${KEY}");
  assert.equal(timeLimit(10), "10 seconds");
  assert.equal(timeLimit(1), "1 second");
  assert.equal(hookWords("agentStop"), "When a reply ends");
  assert.equal(hookWords("somethingNew"), "somethingNew");
});

test("where a setting's value goes", () => {
  assert.deepEqual(
    sentToLines({ sentTo: [{ tool: "notes", env: "NOTES_TOKEN" }, { tool: "api", header: "Authorization", url: "https://api.example.com/mcp" }, { hook: "userPromptSubmitted", env: "TOKEN" }] }),
    ["Sent to the tool notes as NOTES_TOKEN", "Sent to the tool api at https://api.example.com/mcp in the header Authorization", "Sent to the hook “Each message you send” as TOKEN"],
  );
  assert.deepEqual(sentToLines({}), []);
});

test("the other files and what is not run", () => {
  const contents = { otherFiles: { count: 214, bytes: 3_355_443, files: [{ path: ".npmrc", bytes: 80, config: true }, { path: "node_modules/", bytes: 3_000_000, config: true, files: 180 }, { path: "README.md", bytes: 900 }] } };
  assert.deepEqual(otherFilesView(contents), { line: "214 files · 3.2 MB", read: [".npmrc · 80 B", "node_modules/ · 180 files"] });
  assert.equal(otherFilesView({ otherFiles: { count: 1, bytes: 512, files: [{ path: "a", bytes: 512 }] } }).line, "1 file · 512 B");
  assert.equal(otherFilesView({}), undefined, "an older computer names no other files");
  assert.equal(otherFilesView({ otherFiles: { count: 0, bytes: 0, files: [] } }), undefined);

  const not = notRunView({ notRun: { count: 14, items: [{ what: "hook", name: "PreCompact", why: "Botkins has no such event." }, { what: "tool", name: "ws", why: "Botkins has no tool of this type." }] } });
  assert.deepEqual(not.rows, [{ name: "Hook · PreCompact", why: "Botkins has no such event." }, { name: "Tool · ws", why: "Botkins has no tool of this type." }]);
  assert.equal(not.more, "and 12 more");
  assert.equal(notRunView({ notRun: { count: 1, items: [{ what: "hook", name: "x", why: "y" }] } }).more, "");
  assert.equal(notRunView({}), undefined);
});

test("with the mark, the window asks from what the description shows", () => {
  assert.equal(runsCommands({ ...none, mcpServers: [{ name: "web", kind: "remote", url: "https://x" }] }), false);
  assert.equal(runsCommands({ ...none, mcpServers: [local] }), true);
  assert.equal(runsCommands({ ...none, hooks: [hook] }), true);
  assert.equal(startQuestion({ contents: none, starts: 1 }, "install", HERE), undefined, "a plugin that runs nothing is not asked about");
  assert.deepEqual(startQuestion({ contents: { ...none, hooks: [hook] }, starts: 1, warnings: ["Runs a command at each message."] }, "on", HERE), {
    title: "This plugin runs commands on this computer",
    body: "Runs a command at each message.\n\nOnly go on if you trust this plugin.",
    confirm: "Turn on",
  });
  assert.equal(startQuestion({ contents: { ...none, mcpServers: [local] }, starts: 1 }, "install", NEWER).title, "This plugin runs commands on Studio Mac");
  assert.equal(startQuestion({ contents: { ...none, mcpServers: [local] }, starts: 1 }, "update", HERE).confirm, "Update");
});

test("without the mark, the window asks first, always, and says to update an older computer", () => {
  // Also when the description shows nothing that runs: it can leave out a command.
  for (const [step, word] of [["install", "Install anyway"], ["update", "Update anyway"], ["on", "Turn on anyway"]]) {
    const asked = startQuestion({ contents: none }, step, OLDER);
    assert.equal(asked.title, "This plugin may run commands on Studio Mac");
    assert.equal(asked.body, "Botkins on Studio Mac is older and may not show everything a plugin runs. Update it first, or go on only if you trust where the plugin comes from.");
    assert.equal(asked.confirm, word);
  }
  // The mark is trusted, not the list of names: a computer that names the rule and sends no mark is asked about too.
  const unmarked = startQuestion({ contents: none }, "on", HERE);
  assert.equal(unmarked.title, "This plugin may run commands on this computer");
  assert.equal(unmarked.body, "This computer could not show everything this plugin runs. Go on only if you trust where the plugin comes from.");
  assert.equal(unmarked.confirm, "Turn on anyway");
  assert.equal(startQuestion({ contents: none }, "on", NEWER).body, "Studio Mac could not show everything this plugin runs. Go on only if you trust where the plugin comes from.");
  // The line on the plugin's page, for a description without the mark.
  assert.equal(unmarkedLine(OLDER), "Update Botkins on Studio Mac to see everything a plugin runs.");
  assert.equal(unmarkedLine(HERE), "This computer could not show everything this plugin runs.");
  assert.equal(unmarkedLine(NEWER), "Studio Mac could not show everything this plugin runs.");
});

test("a plugin that Botkins switched off, and the two notices that are shown one time", () => {
  const off = { id: "a", name: "A", enabled: false, detail: "Botkins switched this plugin off.", contents: { ...none, skills: ["skills/a/SKILL.md"] } };
  const byHand = { id: "b", name: "B", enabled: false, contents: none };
  const on = { id: "c", name: "C", enabled: true, contents: none };
  const noSkills = { id: "d", name: "D", enabled: false, detail: "Botkins switched this plugin off.", contents: none };
  const linked = { id: "linked-1", name: "old", enabled: false, detail: "Botkins could not copy it.", contents: none };
  assert.equal(heldBack(off), true);
  assert.equal(heldBack(byHand), false);
  assert.equal(onOffLabel(off), "Off · Needs review");
  assert.equal(onOffLabel(byHand), "Off");
  assert.equal(onOffLabel(on), "On");
  assert.equal(linkedError(linked), true);
  assert.equal(onOffLabel(linked), "Not used");
  const all = [off, byHand, on, noSkills, linked];
  const first = switchedOffNotice(all, [], HERE);
  assert.deepEqual({ title: first.title, text: first.text }, { title: "Botkins switched off 2 plugins", text: "Botkins now shows everything a plugin runs on this computer. Review each one, then turn it on." });
  assert.deepEqual(first.keys, [toldKey(off), toldKey(noSkills)]);
  assert.equal(switchedOffNotice(all, [toldKey(off)], HERE).title, "Botkins switched off 1 plugin");
  assert.equal(switchedOffNotice(all, first.keys, HERE), undefined, "told one time");
  // Switched off again later for another reason: told again. Another computer's plugin of the same id: told for itself.
  assert.equal(switchedOffNotice([{ ...off, detail: "A hook of this plugin runs now." }], first.keys, HERE).title, "Botkins switched off 1 plugin");
  assert.equal(switchedOffNotice([off], first.keys, NEWER, "host-2").text, "Botkins now shows everything a plugin runs on Studio Mac. Review each one, then turn it on.");
  assert.deepEqual(skillsOff(all, []).map((plugin) => plugin.id), ["a"]);
  assert.deepEqual(skillsOff(all, [toldKey(off)]), []);
  assert.equal(folderLine("server/bin"), "server/bin (in the plugin’s own folder)");
  assert.equal(folderLine("/opt/tools"), "/opt/tools");
  assert.equal(folderLine("C:\\tools"), "C:\\tools");
});
