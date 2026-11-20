// For test/terminal-e2e/units.sh, run in its container: makes two more versions out of the one
// that is installed, as tarballs in /root/versions. Each is the installed version's own files
// with a higher version number and changed service files, so an update between them has units
// to bring up to date.
//
//   B   one more line in the service's unit (LimitCORE=0), a changed watch, a changed update job
//   C   B, with one more line again (LimitNOFILE=4096), one more unit (botkins-tidy.timer), and
//       a service that ends as soon as it starts
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const installed = realpathSync("/opt/botkins/current");
const [, from, system] = /^botkins-terminal-(\d+\.\d+\.\d+)-(.+)$/.exec(basename(installed));
const [major, minor, patch] = from.split(".").map(Number);
const out = "/root/versions";
mkdirSync(out, { recursive: true });

/** Changes a file of the version being made; a text that isn't there is a mistake in this script, not something to pass over. */
function edit(folder, file, changes) {
  let text = readFileSync(join(folder, file), "utf8");
  for (const [before, after] of changes) {
    if (!text.includes(before)) throw new Error(file + " has no " + JSON.stringify(before));
    text = text.replace(before, after);
  }
  writeFileSync(join(folder, file), text);
}

function make(letter, version, changes) {
  const name = "botkins-terminal-" + version + "-" + system;
  const folder = join(out, name);
  rmSync(folder, { recursive: true, force: true });
  cpSync(installed, folder, { recursive: true, verbatimSymlinks: true });
  edit(folder, "package.json", [['"version": "' + from + '"', '"version": "' + version + '"']]);
  for (const [file, list] of Object.entries(changes)) edit(folder, file, list);
  execFileSync("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", join(out, name + ".tar.gz"), "-C", dirname(folder), name]);
  rmSync(folder, { recursive: true });
  console.log(letter + " " + version);
}

const unitsOfB = [
  ['    "RestrictRealtime=true",\n    "LockPersonality=true",\n    "SystemCallArchitectures=native",', '    "RestrictRealtime=true",\n    "LockPersonality=true",\n    "LimitCORE=0",\n    "SystemCallArchitectures=native",'],
  ['"Description=Watch for the Botkins terminal host asking to be updated",', '"Description=Watch for the Botkins terminal host asking to be updated (B)",'],
  ['      "Type=oneshot",', '      "Type=oneshot",\n      "TimeoutStartSec=1800",'],
];
make("B", [major, minor, patch + 1].join("."), { "desktop/terminal/units.mjs": unitsOfB });
make("C", [major, minor, patch + 2].join("."), {
  "desktop/terminal/units.mjs": [
    ...unitsOfB,
    ['    "LimitCORE=0",', '    "LimitCORE=0",\n    "LimitNOFILE=4096",'],
    ["(B)", "(C)"],
    ["    [UPDATE_PATH_UNIT]: [", '    "botkins-tidy.timer": ["[Unit]", "Description=One more unit, which only C has", "", "[Timer]", "OnCalendar=yearly", "", "[Install]", "WantedBy=timers.target", ""].join("\\n"),\n    [UPDATE_PATH_UNIT]: ['],
  ],
  // The service ends at once; every other command, `service refresh` among them, works.
  "bin/botkins": [["set -eu\n", 'set -eu\nif [ "${1:-}" = serve ]; then echo "This version does not stay up (it is made that way for the test)." >&2; exit 1; fi\n']],
});
