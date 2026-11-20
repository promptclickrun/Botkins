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
  constructor({ current, mac, linux, arch, latest, stage, restart, linuxUnitAvailable = async () => true, notify = () => {} }) {
    Object.assign(this, { current, mac, linux, arch, latest, stage, restart, linuxUnitAvailable, notify });
    this.state = { status: "idle", current, canInstall: false };
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
      const linuxName = "botkins-desktop-" + version + (this.arch === "arm64" ? "-arm64" : "") + ".tar.gz";
      const linuxCompatible = assets.includes(linuxName);
      const unitReady = this.linux === true ? await this.linuxUnitAvailable() : false;
      this.state = { status: newer ? "available" : "current", current: this.current, latest: version,
        canInstall: newer && ((this.mac === true && macCompatible) || (this.linux === true && linuxCompatible && unitReady)),
        ...(this.linux && linuxCompatible && { installer: "linux-tarball" }),
        ...(this.linux && newer && linuxCompatible && !unitReady && { message: "Linux updates need the Botkins systemd updater unit." }) };
      if (newer && this.announced !== version) {
        this.announced = version;
        this.notify(version);
      }
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
      if (!info.canInstall) throw new Error(this.linux ? "Linux tarball updates need a matching signed build and the Botkins systemd updater helper. Open GitHub Releases to see its downloads." : "This release has no compatible in-app installer for this copy. Open GitHub Releases to see its downloads.");
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
    tool("check_app_update", "Check the installed Botkins desktop version against the latest stable GitHub release.", () => updates.check(), true),
    tool("install_app_update", "When the person asks to update Botkins, download its signed update and restart the app after this reply.", () => updates.install(task.done), false),
  ];
}
