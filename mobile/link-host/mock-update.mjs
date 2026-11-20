// The demo computer's stand-in for its own updates ("app-update-v1"; docs/link-contract.md), so
// every case can be tried without a real release. BOTKINS_DEV_UPDATE picks the case:
//   current    up to date (the default)
//   available  a newer version, and this copy installs it by itself (with "auto", off)
//   cannot     a newer version this copy can't install (it says to pull a new image)
//   error      checking fails
//   rollback   a newer version that doesn't stay up: the install ends with the old one back
//   off        no capability, as an older computer
// Installing "restarts" the demo's link through `onRestart` (dev-host.mjs stops it for a few
// seconds), and afterwards `last` says how it went. Nothing is downloaded and nothing restarts.

export const DEMO_VERSION = "0.8.0-demo";
export const DEMO_LATEST = "0.8.1";
const MODES = ["current", "available", "cannot", "error", "rollback", "off"];
const CANNOT = "This copy runs in Docker. Pull the new image to update: docker compose pull && docker compose up -d";

export class DemoUpdates {
  /** @param backend  the MockBackend, for its `sleep`. */
  constructor(backend, mode = "current") {
    this.backend = backend;
    this.mode = MODES.includes(mode) ? mode : "current";
    this.current = DEMO_VERSION;
    /** dev-host.mjs: () => Promise, stops the link for a moment and starts it again. */
    this.onRestart = async () => {};
    /** dev-host.mjs: (version) => void, tells the paired phones (link.push.updateAvailable). */
    this.onAvailable = () => {};
    this.auto = this.mode === "available" || this.mode === "rollback" ? false : undefined;
    this.last = undefined;
    this.state = this.found() ?? { status: "idle" };
  }
  get capable() {
    return this.mode !== "off";
  }
  /** What a check finds, or null when there is nothing to find (an error). */
  found() {
    if (this.mode === "error") return null;
    if (this.mode === "current" || this.current === DEMO_LATEST) return { status: "current", latest: this.current };
    if (this.mode === "cannot") return { status: "available", latest: DEMO_LATEST, message: CANNOT };
    return { status: "available", latest: DEMO_LATEST, canInstall: true };
  }
  status() {
    return {
      canInstall: false,
      ...this.state,
      current: this.current,
      ...(this.auto !== undefined && { auto: this.auto }),
      ...(this.last && { last: this.last }),
    };
  }
  async check() {
    if (["checking", "downloading", "restarting"].includes(this.state.status)) return this.status();
    this.state = { status: "checking" };
    await this.backend.sleep(1200);
    const found = this.found();
    this.state = found ?? { status: "error", message: "GitHub could not check for updates (HTTP 503)." };
    if (found?.status === "available") this.onAvailable(found.latest);
    return this.status();
  }
  install() {
    if (this.state.status !== "available") throw new Error("There is no update to install. Check for updates first.");
    if (!this.state.canInstall) throw new Error(this.state.message ?? "This copy can't install updates by itself.");
    const from = this.current;
    const to = this.state.latest;
    this.state = { status: "downloading", latest: to };
    void (async () => {
      await this.backend.sleep(1500);
      this.state = { status: "restarting", latest: to };
      this.backend.changed();
      await this.backend.sleep(400);
      await this.onRestart();
      const at = new Date().toISOString();
      if (this.mode === "rollback") {
        this.last = { at, from, to, ok: false, message: "Botkins " + to + " didn't stay up, so " + from + " is back." };
        this.state = { status: "idle" };
      } else {
        this.current = to;
        this.last = { at, from, to, ok: true };
        this.state = { status: "current", latest: to };
      }
      this.backend.changed();
    })();
    return this.status();
  }
  setAuto(on) {
    if (this.auto === undefined) throw new Error("This computer can't install updates by itself.");
    this.auto = on === true;
    return this.status();
  }
}
