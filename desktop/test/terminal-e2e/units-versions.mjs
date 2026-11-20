// For test/terminal-e2e/units.sh and macos-update.sh: makes three versions out of one built
// tarball, so an update between them has service files to bring up to date.
//
//   node units-versions.mjs --tarball <built tarball> --out <folder> --mirror <url> --key <public key file> --fingerprint <its fingerprint>
//
//   A   the tarball as it was built, from this checkout
//   B   A with a higher version and changed service files: one more line in the service's unit,
//       a changed watch and a changed update job (Linux), a changed job (macOS)
//   C   B with a higher version, service files changed again, one more unit (Linux), and a
//       service that ends as soon as it starts
//
// Each lands in <folder>/v<version>/ as a release does. They are not signed here: the script
// that called this signs them.
//
// One thing is changed in all three, and nothing else: where a release comes from. `botkins
// update` takes only the latest signed release from the project's own address, checked against
// the project's own key, and has no setting that says otherwise, on purpose. So that a test can
// run a whole update (the service asks, the updater downloads, checks the signature, installs,
// watches), these copies name this run's mirror and this run's key in the four places the
// program names GitHub and the Botkins release key. The code that does the update is untouched.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { tarball: { type: "string" }, out: { type: "string" }, mirror: { type: "string" }, key: { type: "string" }, fingerprint: { type: "string" } } });
for (const name of ["tarball", "out", "mirror", "key", "fingerprint"]) if (!values[name]) throw new Error("--" + name + " is needed.");
const [, from, system] = /^botkins-terminal-(\d+\.\d+\.\d+)-(.+)\.tar\.gz$/.exec(basename(values.tarball));
const [major, minor, patch] = from.split(".").map(Number);
const mac = system.startsWith("macos-");
const work = mkdtempSync(join(tmpdir(), "bk-versions-"));
const gnu = /GNU tar/.test(execFileSync("tar", ["--version"], { encoding: "utf8" }));
const owner = gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--numeric-owner"];

/** Changes a file of the version being made; a text that isn't there is a mistake in this script, not something to pass over. */
function edit(folder, file, changes) {
  let text = readFileSync(join(folder, file), "utf8");
  for (const [before, after] of changes) {
    if (!text.includes(before)) throw new Error(file + " has no " + JSON.stringify(before));
    text = text.replace(before, after);
  }
  writeFileSync(join(folder, file), text);
}
/** Packs a version's folder as a release has it. */
function pack(folder, version) {
  const name = "botkins-terminal-" + version + "-" + system;
  mkdirSync(join(values.out, "v" + version), { recursive: true });
  execFileSync("tar", [...owner, "-czf", join(values.out, "v" + version, name + ".tar.gz"), "-C", work, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}
/** The next version: the folder of `earlier` under a new name, with `changes` made. */
function next(earlier, version, changes) {
  const folder = join(work, "botkins-terminal-" + version + "-" + system);
  cpSync(earlier.folder, folder, { recursive: true, verbatimSymlinks: true });
  edit(folder, "package.json", [['"version": "' + earlier.version + '"', '"version": "' + version + '"']]);
  for (const [file, list] of Object.entries(changes)) edit(folder, file, list);
  pack(folder, version);
  return { folder, version };
}

// A: the built tarball, taking its releases from this run's mirror and trusting this run's key.
execFileSync("tar", ["-xzf", values.tarball, "-C", work]);
const a = { folder: join(work, "botkins-terminal-" + from + "-" + system), version: from };
edit(a.folder, "desktop/updates.mjs", [["https://api.github.com/repos/promptclickrun/Botkins/releases/latest", values.mirror + "/latest.json"]]);
edit(a.folder, "desktop/terminal/update-install.mjs", [['const RELEASES = "https://github.com/promptclickrun/Botkins/releases/download/";', 'const RELEASES = "' + values.mirror + '/";']]);
edit(a.folder, "desktop/linux-service/botkins-update-helper.mjs", [[/const fingerprint = "[0-9A-F]{40}";/.exec(readFileSync(join(a.folder, "desktop/linux-service/botkins-update-helper.mjs"), "utf8"))[0], 'const fingerprint = "' + values.fingerprint + '";']]);
writeFileSync(join(a.folder, "desktop/linux-service/botkins-release.asc"), readFileSync(values.key));
pack(a.folder, from);

// B and C change what the service's files say. A line that a version stops writing, or writes
// differently, goes into ONCE_WRITTEN, as desktop/terminal/units.mjs asks of every such change:
// that is how the next version knows the earlier line for Botkins' own and not the person's.
const units = "desktop/terminal/units.mjs";
const once = (kind, lines) => ["export const ONCE_WRITTEN = { systemd: [], launchd: [] };", "export const ONCE_WRITTEN = { systemd: " + JSON.stringify(kind === "systemd" ? lines : []) + ", launchd: " + JSON.stringify(kind === "launchd" ? lines : []) + " };"];
const watch = "Description=Watch for the Botkins terminal host asking to be updated";
const b = next(
  a,
  [major, minor, patch + 1].join("."),
  mac
    ? { [units]: [once("launchd", ["ThrottleInterval 5"]), ['    "  <key>ThrottleInterval</key>",\n    "  <integer>5</integer>",', '    "  <key>ThrottleInterval</key>",\n    "  <integer>7</integer>",']] }
    : {
        [units]: [
          once("systemd", [watch]),
          ['    "RestrictRealtime=true",\n    "LockPersonality=true",\n    "SystemCallArchitectures=native",', '    "RestrictRealtime=true",\n    "LockPersonality=true",\n    "LimitCORE=0",\n    "SystemCallArchitectures=native",'],
          ['"' + watch + '",', '"' + watch + ' (B)",'],
          ['      "Type=oneshot",', '      "Type=oneshot",\n      "TimeoutStartSec=1800",'],
        ],
      },
);
const c = next(b, [major, minor, patch + 2].join("."), {
  [units]: mac
    ? [[JSON.stringify(["ThrottleInterval 5"]), JSON.stringify(["ThrottleInterval 5", "ThrottleInterval 7"])], ['    "  <integer>7</integer>",', '    "  <integer>9</integer>",']]
    : [
        [JSON.stringify([watch]), JSON.stringify([watch, watch + " (B)"])],
        ['    "LimitCORE=0",', '    "LimitCORE=0",\n    "LimitNOFILE=4096",'],
        [watch + ' (B)",', watch + ' (C)",'],
        ["    [UPDATE_PATH_UNIT]: [", '    "botkins-tidy.timer": ["[Unit]", "Description=One more unit, which only C has", "", "[Timer]", "OnCalendar=yearly", "", "[Install]", "WantedBy=timers.target", ""].join("\\n"),\n    [UPDATE_PATH_UNIT]: ['],
      ],
  // The service ends at once; every other command, `service refresh` among them, works.
  "bin/botkins": [["set -eu\n", 'set -eu\nif [ "${1:-}" = serve ]; then echo "This version does not stay up (it is made that way for the test)." >&2; exit 1; fi\n']],
});
rmSync(work, { recursive: true, force: true });
console.log("A " + a.version + "\nB " + b.version + "\nC " + c.version);
