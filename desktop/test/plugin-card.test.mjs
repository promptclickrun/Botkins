// The card a person reads before a bot's plugin change (desktop/plugin-card.mjs): it is built
// from the whole description, and every text from the plugin goes through shownText.
import test from "node:test";
import assert from "node:assert/strict";
import { pluginCard, pluginCardLines } from "../desktop/plugin-card.mjs";
import { hasUnshown } from "../desktop/shown-text.mjs";

const full = {
  name: "calendar",
  version: "1.2.0",
  revision: "rev-1",
  contents: {
    skills: ["a", "b"],
    agents: ["c"],
    commands: [],
    hooks: [
      {
        event: "SessionStart",
        command: "node start.js --quiet",
        env: [{ name: "MODE", value: "fast" }],
        envNotSet: [{ name: "HOOK_TOKEN", why: "no setting has this name" }],
        timeoutSec: 30,
      },
    ],
    mcpServers: [
      { name: "files", kind: "local", command: "node", args: ["server.js", "--root", "my folder"], env: [{ name: "LEVEL", value: "debug" }], cwd: "tools" },
      { name: "abs", kind: "local", command: "/usr/bin/tool", args: [], env: [], cwd: "/opt/tool" },
      {
        name: "web",
        kind: "remote",
        type: "sse",
        url: "https://calendar.example/sse",
        headers: [{ name: "X-Key", value: "abc" }, { name: "X-Other", value: "d e" }],
        oauth: true,
        oauthClientId: "client-1",
      },
    ],
  },
  config: [
    {
      key: "CALENDAR_KEY",
      label: "Key",
      secret: true,
      required: true,
      sentTo: [{ tool: "files", env: "KEY" }, { tool: "web", header: "X-Key", url: "https://calendar.example/sse" }, { hook: "SessionStart", env: "KEY" }],
    },
    { key: "REGION", label: "Region", secret: false, required: false, default: "eu", sentTo: [] },
  ],
  notRun: { count: 5, items: [{ what: "hook", name: "PostToolUse", why: "this event is not supported" }, { what: "tool", name: "old", why: "it uses a server type that is not supported" }] },
  otherFiles: {
    count: 30,
    bytes: 4096,
    files: [{ path: "settings.json", bytes: 10, config: true }, { path: "conf", bytes: 20, config: true, files: 4 }, { path: "readme.md", bytes: 5 }],
  },
  warnings: ["It asks for more than it uses."],
};

test("the card shows the whole description", () => {
  assert.deepEqual(pluginCardLines(full, { bots: "Pip", action: "install", id: "cal@market" }), [
    "Plugin: calendar 1.2.0 (cal@market)",
    "Bots: Pip",
    "Revision: rev-1",
    "Holds: 2 skills, 1 agent, 0 commands.",
    "Runs on this computer:",
    "  at SessionStart: node start.js --quiet",
    "      for at most 30 seconds",
    '      with MODE="fast"',
    "      not set by Botkins: HOOK_TOKEN (no setting has this name)",
    '  the tool files: node server.js --root "my folder"',
    '      in the folder "tools" of the plugin\'s own copy',
    '      with LEVEL="debug"',
    "  the tool abs: /usr/bin/tool",
    '      in the folder "/opt/tool"',
    "Reaches on the web:",
    "  the tool web: https://calendar.example/sse, as a stream (sse)",
    '      with the header X-Key="abc"',
    '      with the header X-Other="d e"',
    "      signs in, client id client-1",
    "Settings:",
    "  CALENDAR_KEY (needed) (secret): goes to the environment value KEY of the tool files; the header X-Key of the tool web at https://calendar.example/sse; the environment value KEY of the hook at SessionStart",
    '  REGION: goes to no tool and no hook of the plugin; default "eu"',
    "Not run by Botkins:",
    "  hook PostToolUse: this event is not supported",
    "  tool old: it uses a server type that is not supported",
    "  and 3 more",
    "Other files of the plugin: 30 files, 4096 bytes.",
    "  settings.json",
    "  conf (4 files)",
    "  and 25 more",
    "A command runs with these files, and Botkins cannot show all that they make it do.",
    "Note: It asks for more than it uses.",
  ]);
});

test("an update starts with the line that says the card is the new version", () => {
  assert.equal(pluginCardLines(full, { bots: "Pip", action: "update", id: "x" })[0], "After this update:");
  assert.equal(pluginCardLines(full, { bots: "Pip", action: "enable", id: "x" })[0], "Plugin: calendar 1.2.0 (x)");
});

test("notRun as a list of rows, string envNotSet and string headers are accepted", () => {
  const lines = pluginCardLines(
    {
      name: "p",
      contents: {
        hooks: [{ event: "Stop", command: "run", env: [], envNotSet: ["TOKEN"] }],
        mcpServers: [
          { name: "l", kind: "local", command: "c", args: [], env: [], envNotSet: ["OTHER"] },
          { name: "r", kind: "remote", url: "https://r.example", headers: ["Authorization"] },
        ],
      },
      notRun: [{ what: "hook", name: "x", why: "no" }],
    },
    { bots: "All bots", action: "enable", id: "p" },
  );
  assert.ok(lines.includes("      not set by Botkins: TOKEN"));
  assert.ok(lines.includes("      not set by Botkins: OTHER"));
  assert.ok(lines.includes("      with the header Authorization"));
  assert.deepEqual(lines.slice(lines.indexOf("Not run by Botkins:")), ["Not run by Botkins:", "  hook x: no"]);
  assert.ok(!lines.some((line) => line.startsWith("Other files")));
});

test("an empty description runs nothing", () => {
  for (const empty of [{}, { name: "e", contents: { mcpServers: [], hooks: [], skills: [], agents: [], commands: [] } }]) {
    const lines = pluginCardLines(empty, { bots: "Pip", action: "install", id: "e" });
    assert.ok(lines.includes("Runs nothing on this computer."));
    assert.ok(!lines.includes("Runs on this computer:"));
  }
});

test("a character that hides or turns text is written as its number, in every field", () => {
  const bad = "x‮y​z";
  const hidden = {
    name: bad,
    version: bad,
    revision: bad,
    contents: {
      hooks: [{ event: bad, command: bad, env: [{ name: bad, value: bad }], envNotSet: [{ name: bad, why: bad }] }],
      mcpServers: [
        { name: bad, kind: "local", command: bad, args: [bad], env: [{ name: bad, value: bad }], envNotSet: [bad], cwd: bad },
        { name: bad, kind: "remote", type: "sse", url: bad, headers: [{ name: bad, value: bad }, bad], oauth: true, oauthClientId: bad },
      ],
    },
    config: [{ key: bad, secret: false, required: true, default: bad, sentTo: [{ tool: bad, env: bad }, { tool: bad, header: bad, url: bad }, { hook: bad, env: bad }] }],
    notRun: { count: 2, items: [{ what: bad, name: bad, why: bad }] },
    otherFiles: { count: 3, bytes: 1, files: [{ path: bad, bytes: 1, config: true }] },
    warnings: [bad],
  };
  const lines = pluginCardLines(hidden, { bots: bad, action: "install", id: bad });
  assert.ok(lines.length > 20);
  for (const line of lines) assert.equal(hasUnshown(line), false, line);
  const text = lines.join("\n");
  assert.ok(text.includes("x\\u{202e}y\\u{200b}z"));
  assert.ok(text.split("\\u{202e}").length > 25);
  // A new line inside a value cannot start a line of its own.
  const newline = pluginCardLines(
    { name: "n", contents: { hooks: [{ event: "e", command: "a\nNote: fake", env: [] }] } },
    { bots: "b\nBots: fake", action: "install", id: "n" },
  );
  assert.ok(newline.includes("  at e: a\\u{a}Note: fake"));
  assert.ok(!newline.some((line) => line.startsWith("Note: fake") || line === "Bots: fake"));
});

test("a value that needs quoting is quoted, so it cannot end its own quotes", () => {
  const lines = pluginCardLines(
    { name: "q", contents: { mcpServers: [{ name: "t", kind: "local", command: "sh", args: ["-c", 'echo "hi" && x', "", "a\\b"], env: [{ name: "V", value: 'a" B="c' }] }] } },
    { bots: "b", action: "install", id: "q" },
  );
  assert.ok(lines.includes('  the tool t: sh -c "echo \\"hi\\" && x" "" "a\\\\b"'));
  assert.ok(lines.includes('      with V="a\\" B=\\"c"'));
});

test("a long command is carried on, not cut; other text is cut; the card is bounded", () => {
  const command = "c".repeat(4000);
  const lines = pluginCardLines(
    { name: "long", contents: { mcpServers: [{ name: "t", kind: "local", command, args: [command, command], env: [] }] }, warnings: ["w".repeat(5000)] },
    { bots: "b", action: "install", id: "long" },
  );
  assert.ok(lines.every((line) => line.length <= 4200));
  const joined = lines.join("\n").replace(/\n {6}\(continued\) /g, "");
  assert.ok(joined.includes(command + " " + command + " " + command));
  const note = lines.find((line) => line.startsWith("Note: "));
  assert.equal(note.length, "Note: ".length + 1000 + 2);
  assert.ok(note.endsWith(" …"));

  const many = pluginCardLines(
    { name: "many", contents: { hooks: Array.from({ length: 500 }, (_, i) => ({ event: "e" + i, command: "run", env: [] })) } },
    { bots: "b", action: "install", id: "many" },
  );
  assert.equal(many.length, 400);
  assert.equal(many[399], "and more: look at the plugin in Settings");
});

test("a card that is cut, or that holds less than the description counts, is not whole", () => {
  const many = pluginCard(
    { name: "many", contents: { hooks: Array.from({ length: 500 }, (_, i) => ({ event: "e" + i, command: "run", env: [] })) } },
    { bots: "b", action: "install", id: "many" },
  );
  assert.equal(many.whole, false);
  assert.equal(many.lines.length, 400);
  assert.equal(many.lines.at(-1), "and more: look at the plugin in Settings");

  const rows = [{ what: "hook", name: "x", why: "no" }];
  const notRun = (contents, top) => pluginCard({ name: "n", contents, ...top }, { bots: "b", action: "install", id: "n" });
  assert.equal(notRun({ notRun: { count: 5, items: rows } }).whole, false);
  assert.equal(notRun({}, { notRun: { count: 5, items: rows } }).whole, false);
  assert.equal(notRun({ notRun: { count: 1, items: rows } }).whole, true);
  assert.equal(notRun({ notRun: rows }).whole, true);
  // The host puts the not-run rows under contents, and they are shown from there.
  assert.ok(notRun({ notRun: { count: 1, items: rows } }).lines.includes("  hook x: no"));

  const files = (n) => Array.from({ length: n }, (_, i) => ({ path: "c" + i, bytes: 1, config: true }));
  assert.equal(notRun({ otherFiles: { count: 13, bytes: 13, files: files(13) } }).whole, false);
  assert.equal(notRun({ otherFiles: { count: 12, bytes: 12, files: files(12) } }).whole, true);
  assert.equal(pluginCard(full, { bots: "Pip", action: "install", id: "cal@market" }).whole, false);
  assert.equal(notRun({ hooks: [{ event: "e", command: "run" }] }).whole, true);
});

test("an environment value, a header's value and a default are never shortened", () => {
  const value = (n) => "v".repeat(n);
  const card = pluginCard(
    {
      name: "values",
      contents: {
        hooks: [{ event: "e", command: "run", env: [{ name: "SHORT", value: value(1001) }, { name: "LONG", value: value(4000) }] }],
        mcpServers: [{ name: "r", kind: "remote", url: "https://r.example", headers: [{ name: "H", value: value(4000) }] }],
      },
      config: [{ key: "K", secret: false, required: false, default: value(1500), sentTo: [] }],
    },
    { bots: "b", action: "install", id: "values" },
  );
  assert.equal(card.whole, true);
  const joined = card.lines.join("\n").replace(/\n {6}\(continued\) /g, "");
  assert.ok(joined.includes('SHORT="' + value(1001) + '"'));
  assert.ok(joined.includes('LONG="' + value(4000) + '"'));
  assert.ok(joined.includes('H="' + value(4000) + '"'));
  assert.ok(joined.includes('default "' + value(1500) + '"'));
  assert.ok(!joined.includes(" …"));
});

test("a name that decides something is never shortened, free text is, outside any quotes", () => {
  const name = "n".repeat(3000);
  const card = pluginCard(
    {
      name: "names",
      contents: { hooks: [{ event: "e", command: "run", env: [], envNotSet: [{ name, why: "w".repeat(2000) }] }] },
      notRun: { count: 1, items: [{ what: "tool", name, why: "y".repeat(2000) }] },
    },
    { bots: "b", action: "install", id: "names" },
  );
  const joined = card.lines.join("\n").replace(/\n {6}\(continued\) /g, "");
  assert.equal(joined.split(name).length, 3);
  assert.ok(joined.includes("w".repeat(1000) + " …)"));
  assert.ok(!joined.includes("w".repeat(1001)));
  assert.ok(joined.includes("y".repeat(1000) + " …"));
});
