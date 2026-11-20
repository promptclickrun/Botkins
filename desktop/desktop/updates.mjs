// Update sources are fixed by the application. A chat, tool argument or release note cannot supply a URL.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import semver from "semver";
import { defineTool } from "./providers/provider.mjs";

export const repository = { owner: "promptclickrun", repo: "Botkins" };
export const releasePage = "https://github.com/promptclickrun/Botkins/releases/latest";
const run = promisify(execFile);
export async function githubToken() {
  for (const file of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]) {
    try {
      const { stdout } = await run(file, ["auth", "token", "--hostname", "github.com"], { timeout: 5000, windowsHide: true });
      if (stdout.trim()) return stdout.trim();
    } catch { /* Another installation may be on PATH. */ }
  }
  return "";
}

export async function latestRelease({ fetcher = fetch, token }) {
  const response = await fetcher("https://api.github.com/repos/promptclickrun/Botkins/releases/latest", {
    headers: { Accept: "application/vnd.github+json", ...(token && { Authorization: "Bearer " + token }) },
    redirect: "follow", signal: AbortSignal.timeout(20000),
  });
  if ([401, 403, 404].includes(response.status))
    throw new Error("GitHub could not provide a release. Sign in to GitHub CLI with access to the Botkins repository and try again.");
  if (!response.ok) throw new Error("GitHub could not check for updates (HTTP " + response.status + ").");
  const data = await response.json();
  const version = semver.valid(data.tag_name);
  if (!version || data.draft || data.prerelease || semver.prerelease(version)) throw new Error("The latest release has no stable desktop version.");
  return { version, assets: (data.assets ?? []).map(a => a.name) };
}

export class AppUpdates {
  /**
   * @param options.linuxAsset   (version, arch) → the name of the tarball a copy installed from one
   *   updates to. The desktop app's by default; the terminal host names its own.
   * @param options.unitMissing  What to say when that tarball is there and the updater isn't set up.
   * @param options.cannotInstall  What to say when asked to install and this copy can't. The desktop app's own words when left out.
   * @param options.auto   { get() → boolean, set(on) }: the choice to install a new release without
   *   being asked, on a host that can (the terminal host). Left out, the host never does, and
   *   `status()` has no `auto`.
   * @param options.idle   () → true when no turn is under way: an install the host starts by itself waits for that.
   * @param options.last   () → how the last install ended ({ at, from, to, ok, message? }), or null.
   *   Read from where the install job wrote it, so it is still there after the restart.
   * @param options.words  { check, install }: how the bots' two tools describe themselves. The desktop app's by default.
   */
  constructor({ current, mac, linux, arch, latest, stage, restart, linuxUnitAvailable = async () => true, notify = () => {},
    linuxAsset = (version, arch) => "botkins-desktop-" + version + (arch === "arm64" ? "-arm64" : "") + ".tar.gz",
    unitMissing = "Linux updates need the Botkins systemd updater unit.",
    cannotInstall, auto, idle = () => true, last = () => null, autoPollMs = 30_000, log = () => {},
    words = {
      check: "Check the installed Botkins desktop version against the latest stable GitHub release.",
      install: "When the person asks to update Botkins, download its signed update and restart the app after this reply.",
    } }) {
    Object.assign(this, { current, mac, linux, arch, latest, stage, restart, linuxUnitAvailable, notify, linuxAsset, unitMissing, cannotInstall, auto, idle, last, autoPollMs, log, words });
    this.state = { status: "idle", current, canInstall: false };
    this.watchers = new Set();
  }

  /**
   * What a window or a paired phone is shown ("app-update-v1"): the state, with `auto` on a host
   * that can install by itself and `last` when an install has ended here before.
   */
  status() {
    let last = null;
    try {
      last = this.last();
    } catch {
      // A record that can't be read says nothing.
    }
    return { ...this.state, ...(this.auto && { auto: this.auto.get() === true }), ...(last && { last }) };
  }
  /** fn(version) each time a check finds a version newer than any it found before. Returns a function that stops it. */
  onAvailable(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }
  /** Switches installing by itself on or off. Refused on a host that has no such choice. */
  setAuto(on) {
    if (!this.auto) throw new Error("This computer doesn't install updates by itself. Install one when you choose to.");
    if (typeof on !== "boolean") throw new Error("Say on or off.");
    this.auto.set(on);
    if (on) this.autoInstall();
    else this.stopAuto();
    return this.status();
  }
  /**
   * With the choice on and a newer release this copy can install: installs it once no turn is
   * under way. A turn that is running is never cut short for an update nobody asked for just now.
   */
  autoInstall() {
    if (this.autoTimer || !this.auto?.get() || this.state.status !== "available" || !this.state.canInstall) return;
    const attempt = () => {
      if (!this.auto.get() || this.state.status !== "available" || !this.state.canInstall) return this.stopAuto();
      if (!this.idle()) return;
      this.stopAuto();
      this.log("Installing Botkins " + this.state.latest + " by itself (updates.auto is on).");
      this.install().catch((error) => this.log("The update was not installed: " + error.message));
    };
    this.autoTimer = setInterval(attempt, this.autoPollMs);
    this.autoTimer.unref?.();
    attempt();
  }
  stopAuto() {
    clearInterval(this.autoTimer);
    this.autoTimer = null;
  }

  check() {
    if (this.installing || this.state.status === "restarting") return Promise.resolve(this.state);
    if (!this.checking) this.checking = this.discover().finally(() => { this.checking = null; });
    return this.checking;
  }

  async discover() {
    this.state = { status: "checking", current: this.current, canInstall: false };
    try {
      const { version, assets } = await this.latest();
      const newer = semver.gt(version, this.current);
      const macCompatible = [this.arch, "universal"].some(arch => assets.includes("Botkins-" + version + "-" + arch + "-mac.zip")) && assets.includes("latest-mac.yml");
      const linuxName = this.linuxAsset(version, this.arch);
      const linuxCompatible = assets.includes(linuxName);
      const unitReady = this.linux === true ? await this.linuxUnitAvailable() : false;
      this.state = { status: newer ? "available" : "current", current: this.current, latest: version,
        canInstall: newer && ((this.mac === true && macCompatible) || (this.linux === true && linuxCompatible && unitReady)),
        ...(this.linux && linuxCompatible && { installer: "linux-tarball" }),
        ...(this.linux && newer && linuxCompatible && !unitReady && { message: this.unitMissing }) };
      if (newer && this.announced !== version) {
        this.announced = version;
        this.notify(version);
        // Whoever else wants to hear (the phone link tells the paired phones). One that fails stops nothing.
        for (const fn of this.watchers) {
          try {
            fn(version);
          } catch (error) {
            this.log("Update notice: " + error.message);
          }
        }
      }
      this.autoInstall();
      return this.state;
    } catch (error) {
      this.state = { status: "error", current: this.current, canInstall: false, message: error.message };
      throw error;
    }
  }

  install(afterTurn) {
    if (this.state.status === "restarting") return Promise.resolve(this.state);
    if (this.installing) return this.installing;
    const checked = this.check();
    this.installing = (async () => {
      const info = await checked;
      if (info.status === "current") return info;
      if (!info.canInstall) throw new Error(this.cannotInstall ?? (this.linux ? "Linux tarball updates need a matching signed build and the Botkins systemd updater helper. Open GitHub Releases to see its downloads." : "This release has no compatible in-app installer for this copy. Open GitHub Releases to see its downloads."));
      this.state = { ...info, status: "downloading", canInstall: false };
      try {
        await this.stage(info.latest);
        this.state = { ...info, status: "restarting", canInstall: false };
        // Give the tool's turn time to save its reply before the native updater closes the app.
        Promise.resolve(afterTurn).catch(() => {}).then(() => setImmediate(() => {
          Promise.resolve().then(() => this.restart()).catch(() => this.failedInstall());
        }));
        return this.state;
      } catch {
        this.failedInstall();
        throw new Error(this.state.message);
      }
    })().finally(() => { this.installing = null; });
    return this.installing;
  }

  failedInstall() {
    this.state = { ...this.state, status: "error", canInstall: false, message: "The update could not be installed. Check your connection and GitHub access, then try again." };
  }
}

export function updateTools(updates, chat, run, task, currentTask) {
  if (!updates || chat.helper || run?.scheduleId != null || run?.panelId || run?.taskId) return [];
  const tool = (name, description, action, skipPermission) => defineTool(name, {
    description, skipPermission, parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      if (!run || task.stopped || currentTask() !== task) throw new Error("This turn has ended.");
      return JSON.stringify(await action());
    },
  });
  return [
    tool("check_app_update", updates.words?.check ?? "Check the installed Botkins version against the latest stable GitHub release.", () => updates.check(), true),
    tool("install_app_update", updates.words?.install ?? "When the person asks to update Botkins, install its signed update and restart after this reply.", () => updates.install(task.done), false),
  ];
}
