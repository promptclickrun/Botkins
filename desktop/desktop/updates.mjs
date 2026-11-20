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

// Finding the latest release.
//
// GitHub's API names a release and every file in it in one answer, but it answers an address
// that is not signed in only 60 times an hour, and counts everyone behind that address
// together: a server in a cloud, an office behind one router. So a computer can be refused
// through no fault of its own. The release page itself has no such limit: /releases/latest
// answers with a redirect to the latest stable release, and what that release holds is in its
// own SHA256SUMS (the list an install checks the signature of anyway). So that is the way
// taken first, and the API is the second try. With a sign-in (the desktop app, where GitHub CLI
// is signed in) the API is asked first: it is not limited that way, and names every file.
//
// Each way either answers or says why not (`cause` below). An answer is never made out of a
// failure: a list that did not come is not an empty list, and a file that could not be asked
// about is not a file that isn't there. Only GitHub saying 404 means "not there".

/** A way that did not answer, with the reason as a clause that fits after "GitHub did not say which release is the latest:". */
const cause = (clause) => Object.assign(new Error("GitHub did not say which release is the latest: " + clause + ". Try again later."), { clause });
const ask = async (fetcher, url, options) => {
  try {
    return await fetcher(url, { signal: AbortSignal.timeout(20000), ...options });
  } catch (error) {
    throw cause("it could not be reached (" + (error.cause?.code ?? error.name ?? "no answer") + ")");
  }
};

/** The latest stable release as GitHub's API tells it: { version, assets }. */
async function latestFromApi({ fetcher, token }) {
  const response = await ask(fetcher, "https://api.github.com/repos/promptclickrun/Botkins/releases/latest", {
    headers: { Accept: "application/vnd.github+json", ...(token && { Authorization: "Bearer " + token }) },
    redirect: "follow",
  });
  if ([403, 429].includes(response.status)) throw cause("its API is not answering this address for now (it limits how often one address may ask)");
  if (response.status === 401) throw cause("its API did not accept the sign-in from GitHub CLI");
  if (response.status === 404) throw cause("its API names no published release of Botkins");
  if (!response.ok) throw cause("its API answered HTTP " + response.status);
  const data = await response.json();
  const version = semver.valid(data.tag_name);
  if (!version || data.draft || data.prerelease || semver.prerelease(version)) throw cause("the latest release has no stable desktop version");
  return { version, assets: (data.assets ?? []).map(a => a.name) };
}

/**
 * The same without the API: the version from where /releases/latest leads, and the files from
 * the release's SHA256SUMS. The files the Mac app's own updater takes are not in that list, so
 * the Mac app (`mac`) has each asked for by name; nobody else needs them, and nobody else asks.
 */
async function latestFromPage({ fetcher, mac }) {
  const page = await ask(fetcher, releasePage, { redirect: "manual" });
  // Only the project's own address counts: a page somebody put in the way (a sign-in page of a network, say) leads elsewhere.
  const tags = releasePage.replace(/latest$/, "tag/");
  const location = page.headers.get("location") ?? "";
  const tag = location.startsWith(tags) ? location.slice(tags.length) : "";
  const version = /^v[0-9A-Za-z.+-]+$/.test(tag) ? semver.valid(tag) : null;
  if (!version || tag !== "v" + version || semver.prerelease(version)) throw cause("its release page did not lead to a stable release of Botkins (HTTP " + page.status + ")");
  const base = "https://github.com/promptclickrun/Botkins/releases/download/" + tag + "/";
  const sums = await ask(fetcher, base + "SHA256SUMS", { redirect: "follow" });
  if (!sums.ok && sums.status !== 404) throw cause("the list of what Botkins " + version + " holds did not come (HTTP " + sums.status + ")");
  const listed = sums.ok ? (await sums.text()).split(/\r?\n/).map((line) => /^[a-f0-9]{64} [ *](.+)$/.exec(line)?.[1]).filter(Boolean) : [];
  const others = ["SHA256SUMS.asc", ...(mac ? ["latest-mac.yml", ...["arm64", "x64", "universal"].map((arch) => "Botkins-" + version + "-" + arch + "-mac.zip")] : [])];
  // A file that is there answers with a redirect to where it is kept; one that is not, with 404.
  // Any other answer says nothing about the file, so it is not taken for one.
  const there = await Promise.all(
    others.map(async (name) => {
      const response = await ask(fetcher, base + name, { method: "HEAD", redirect: "manual" });
      if (response.status === 404) return false;
      if (response.status >= 200 && response.status < 400) return true;
      throw cause("it did not say whether Botkins " + version + " has " + name + " (HTTP " + response.status + ")");
    }),
  );
  return { version, assets: [...listed, ...(sums.ok ? ["SHA256SUMS"] : []), ...others.filter((_, at) => there[at])] };
}

/**
 * The latest stable release: { version, assets: [file names] }.
 * @param options.token  A GitHub sign-in, when there is one (the desktop app asks GitHub CLI).
 * @param options.mac    True for the Mac app, which installs from files that only it needs to hear of.
 */
export async function latestRelease({ fetcher = fetch, token, mac = false }) {
  const ways = token ? [latestFromApi, latestFromPage] : [latestFromPage, latestFromApi];
  const clauses = [];
  for (const way of ways) {
    try {
      return await way({ fetcher, token, mac });
    } catch (error) {
      // Both reasons are said, in the order they were met: either one alone could name the wrong cause.
      const clause = error.clause ?? String(error.message ?? error).replace(/\.$/, "");
      if (!clauses.includes(clause)) clauses.push(clause);
    }
  }
  throw cause(clauses.join("; "));
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
    const last = this.lastInstall();
    return { ...this.state, ...(this.auto && { auto: this.auto.get() === true }), ...(last && { last }) };
  }
  /**
   * How the last install ended, while it still says something about the copy that runs: an
   * install that worked brought this version, one that failed left this version. A record of
   * anything else (a failure from before a later upgrade by hand) is old news and is not shown.
   */
  lastInstall() {
    let last = null;
    try {
      last = this.last();
    } catch {
      // A record that can't be read says nothing.
    }
    if (!last) return null;
    return (last.ok ? last.to : last.from) === this.current ? last : null;
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
    // A release that was tried and didn't stay up is not tried again by itself: without this, a
    // bad release would be installed, put back and installed again for as long as it is the latest.
    // The person can still install it on purpose, and the next release is a new one.
    const last = this.lastInstall();
    if (last && !last.ok && last.to === this.state.latest) {
      if (this.skipped !== last.to) this.log("Botkins " + last.to + " was tried and put back, so it is not installed by itself again. Install it with `botkins update` when you choose to.");
      this.skipped = last.to;
      return;
    }
    const attempt = () => {
      if (!this.auto.get() || this.state.status !== "available" || !this.state.canInstall) return this.stopAuto();
      if (!this.idle()) return;
      this.stopAuto();
      this.log("Installing Botkins " + this.state.latest + " by itself (updates.auto is on).");
      this.install(undefined, { unasked: true }).catch((error) => this.log("The update was not installed: " + error.message));
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

  /**
   * @param afterTurn  A promise the restart waits for (a bot's turn that asked, a reply on its way to a phone).
   * @param options.unasked  True for an install the host starts by itself: it is given up, and
   *   tried again later, when a turn has started by the time the restart would be asked for.
   */
  install(afterTurn, { unasked = false } = {}) {
    if (this.state.status === "restarting") return Promise.resolve(this.state);
    if (this.installing) return this.installing;
    const checked = this.check();
    this.installing = (async () => {
      const info = await checked;
      if (info.status === "current") return info;
      // The reason the check itself found, when it found one, is the one to say.
      if (!info.canInstall) throw new Error(info.message ?? this.cannotInstall ?? (this.linux ? "Linux tarball updates need a matching signed build and the Botkins systemd updater helper. Open GitHub Releases to see its downloads." : "This release has no compatible in-app installer for this copy. Open GitHub Releases to see its downloads."));
      this.state = { ...info, status: "downloading", canInstall: false };
      try {
        await this.stage(info.latest);
        this.state = { ...info, status: "restarting", canInstall: false };
        // Give the tool's turn time to save its reply before the native updater closes the app.
        Promise.resolve(afterTurn).catch(() => {}).then(() => setImmediate(() => {
          // Looked at again at the last moment: the check and the staging above take time, and
          // a turn that began meanwhile is not cut short for an update nobody asked for just now.
          if (unasked && !this.idle()) {
            this.state = { ...info };
            return void this.autoInstall();
          }
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
