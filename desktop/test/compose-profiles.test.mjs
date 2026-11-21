// One Compose file holds two setups: the terminal host (`botkins`), which `docker compose up -d`
// starts, and the one with a screen (`host` and `workspace`, the profile "display"). A command
// that gives the profile and names no service starts all three, and then two of them ask for the
// same port. Every written command that starts the setup with a screen must name its two services.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compose = read("../docker-compose.yml");

/** Each service of the Compose file with the profiles it is in (none: it starts with every `up`). */
function services(text) {
  const out = {};
  const body = text.slice(text.search(/^services:\s*$/m)).split("\n").slice(1);
  let name = null;
  for (const line of body) {
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const service = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (service) out[(name = service[1])] = [];
    const profiles = /^ {4}profiles:\s*\[(.*)\]\s*$/.exec(line);
    if (profiles && name) out[name] = profiles[1].split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return out;
}
/** What `docker compose [--profile p] up [names]` starts. */
function started(all, profile, names) {
  if (names.length) return names;
  return Object.entries(all).filter(([, profiles]) => !profiles.length || profiles.includes(profile)).map(([name]) => name);
}
/** The `docker compose … up …` commands written in a text, in backticks or after `#`. */
function upCommands(text) {
  return [...text.matchAll(/docker compose((?: (?!up\b)[^\s`]+)*) up((?: [^\s`.,;)]+)*)/g)].map(([whole, before, after]) => ({
    whole,
    profile: / --profile (\S+)/.exec(before)?.[1] ?? null,
    names: after.trim().split(/\s+/).filter((word) => word && !word.startsWith("-")),
  }));
}

test("the Compose file has the terminal host for a plain `up`, and the two services of the setup with a screen in a profile", () => {
  const all = services(compose);
  assert.deepEqual(all, { botkins: [], host: ["display"], workspace: ["display"] });
  assert.deepEqual(started(all, null, []), ["botkins"], "`docker compose up -d` starts the terminal host and nothing else");
  // The reason every written command names its services: the profile alone starts all three.
  assert.deepEqual(started(all, "display", []), ["botkins", "host", "workspace"]);
  // Both published ports follow BOTKINS_BIND_PORT, so with it set the two setups ask for one port.
  assert.equal(compose.match(/\$\{BOTKINS_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{BOTKINS_BIND_PORT:-\d+\}:/g).length, 2);
});

test("every written command that starts the setup with a screen names its two services", () => {
  const all = services(compose);
  const found = [];
  for (const path of ["../docker-compose.yml", "../Dockerfile", "../desktop/README.md", "../docs/terminal.md", "../README.md", "../../README.md"]) {
    for (const command of upCommands(read(path))) {
      found.push(command.whole);
      const runs = started(all, command.profile, command.names).sort();
      if (command.profile === "display") assert.deepEqual(runs, ["host", "workspace"], path + ": `" + command.whole + "` would start " + runs.join(", "));
      else assert.deepEqual(runs, ["botkins"], path + ": `" + command.whole + "` would start " + runs.join(", "));
    }
  }
  // The commands this test is for are still written where a person looks for them.
  assert.ok(found.filter((command) => command.includes("--profile display")).length >= 4, found.join(" | "));
  assert.ok(found.some((command) => !command.includes("--profile")), "and the terminal host's plain `up`");
  // A profile set for every command in `.env` is offered only beside a start that names the services.
  const readme = read("../desktop/README.md");
  assert.match(readme, /up --build -d host workspace`\. Name the two services each time you start them/);
});
