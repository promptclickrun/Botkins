// The *incoming* release owns this migration. Already-installed updaters call its
// service refresh before restarting the host, including the updater in 0.17.15.
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { wantsManagedDesktop } from "./desktop-policy.mjs";
import { unitWords } from "./units.mjs";
import { installLayout, notRootOwned } from "./update-install.mjs";

const exec = promisify(execFile);
const unit = "botkins-desktop-provision.service";
const systemctl = "/usr/bin/systemctl";
const entry = fileURLToPath(new URL("../../cli/botkins.mjs", import.meta.url));
const displayKeys = new Set(["BOTKINS_DESKTOP", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE"]);

async function invoke(file, args) {
  try {
    return { code: 0, ...(await exec(file, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "" };
  }
}
const flags = scope => scope === "user" ? ["--user"] : [];

async function provisioning(scope, run) {
  const status = await run(systemctl, [...flags(scope), "show", unit, "--property=ActiveState", "--value"]);
  return ["active", "activating", "reloading"].includes(status.stdout.trim());
}

function currentScope() {
  try {
    return /\/user@\d+\.service\//.test(readFileSync("/proc/self/cgroup", "utf8")) ? "user" : "system";
  } catch { return "system"; }
}

/** Type=simple keeps the service PID stable during the old updater's health check.
 * Only wait if a separate package job is actually doing work for this installation. */
export async function waitForDesktopProvision({ scope = currentScope(), run = invoke, pause = sleep } = {}) {
  while (await provisioning(scope, run)) await pause(1000);
}

function displayEnvironment(raw) {
  const env = {};
  for (const word of unitWords(raw)) {
    const at = word.indexOf("=");
    const name = word.slice(0, at);
    if (at > 0 && displayKeys.has(name)) env[name] = word.slice(at + 1);
  }
  return env;
}

export async function prepareDesktopUpdate(service, { layout = installLayout(entry), run = invoke, uid = process.getuid?.() } = {}) {
  if (!layout || service.kind !== "systemd") return;
  const scope = service.scope;
  if ((scope === "system") !== (uid === 0)) return;
  const scopeFlags = flags(scope);
  const settings = await run(systemctl, [...scopeFlags, "show", "botkins.service", "--property=Environment", "--value"]);
  if (settings.code !== 0) throw new Error("Could not inspect the Botkins service before setting up its desktop.");
  const inherited = scope === "user" ? await run(systemctl, ["--user", "show-environment"]) : { stdout: "" };
  const env = { ...displayEnvironment(inherited.stdout), ...displayEnvironment(settings.stdout) };
  if (!wantsManagedDesktop(env)) return;

  const helper = join(layout.folder, "docker/desktop/install-tools");
  if (uid === 0) {
    const file = lstatSync(helper);
    if (notRootOwned(dirname(helper)) || !file.isFile() || file.uid !== 0 || (file.mode & 0o022))
      throw new Error("System desktop setup requires the installed release to be owned by root.");
  }
  if ((await run("/bin/sh", [helper, "--check"])).code === 0 || await provisioning(scope, run)) return;
  // Running the distro package manager can take longer than an outgoing release's
  // refresh deadline. Give it its own unit. A second refresh joins the same job.
  const job = await run("/usr/bin/systemd-run", [...scopeFlags, "--quiet", "--collect", "--unit=" + unit,
    "--property=Type=exec", "--property=RuntimeMaxSec=15min", "--", "/bin/sh", helper]);
  if (job.code !== 0 && !await provisioning(scope, run)) throw new Error("Could not start " + unit + " to set up the desktop.");
}
