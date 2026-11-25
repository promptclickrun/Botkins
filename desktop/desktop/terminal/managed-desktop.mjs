// Starts the terminal host's private Linux desktop before the workspace and its tools inherit DISPLAY.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findTool, searchDirs, toolEnv } from "../link/tools.mjs";
import { wantsManagedDesktop } from "./desktop-policy.mjs";

const session = fileURLToPath(new URL("../../docker/desktop/botkins-desktop-session", import.meta.url));

export async function startManagedDesktop({ paths, env = process.env, trial = false, note = () => {}, dirs = searchDirs() }) {
  if (process.platform !== "linux" || !wantsManagedDesktop(env, trial)) return null;
  // An explicit request for a private display must never fall back to a personal screen.
  delete env.DISPLAY;
  delete env.XAUTHORITY;
  delete env.WAYLAND_DISPLAY;
  const profile = join(env.HOME || homedir(), ".local", "share", "botkins-desktop-tools", "bin");
  // An updated systemd service can start while the signed release's package setup is finishing.
  if (env.INVOCATION_ID) {
    const { waitForDesktopProvision } = await import("./desktop-provision.mjs");
    await waitForDesktopProvision();
  }
  if (existsSync(profile)) {
    dirs = [profile, ...dirs];
    env.PATH = [profile, env.PATH].filter(Boolean).join(":");
  }
  const needed = ["xvfb-run", "Xvfb", "xauth", "dbus-run-session", "openbox", "xdpyinfo", "xprop", "hsetroot", "xdotool"];
  const missing = needed.filter(name => !findTool(name, dirs));
  if (!findTool("ffmpeg", dirs) && !findTool("import", dirs)) missing.push("ffmpeg or ImageMagick");
  if (missing.length) {
    note("The private desktop needs " + missing.join(", ") + ". Install the Linux screen tools and restart Botkins.");
    return null;
  }

  const home = join(paths.root, "display", "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const geometry = env.BOTKINS_DISPLAY_GEOMETRY || "1440x900x24";
  if (!/^\d{3,4}x\d{3,4}x24$/.test(geometry)) throw new Error("BOTKINS_DISPLAY_GEOMETRY must be WIDTHxHEIGHTx24.");
  // Desktop apps get their own home and D-Bus session. A terminal can reach this exact workspace.
  // The private X cookie and every display socket stay local. xvfb-run chooses a free display.
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 " + geometry + " -nolisten tcp -noreset", "dbus-run-session", "--", session], {
    detached: true,
    env: toolEnv(dirs, { HOME: home, LANG: env.LANG || "C.UTF-8", BOTKINS_DESKTOP_MANAGED: "1", BOTKINS_DATA_DIR: paths.root, BOTKINS_SOCKET: paths.socket }),
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.on("error", () => {});
  const closed = new Promise(resolve => {
    child.once("error", resolve);
    child.once("close", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  let deadline;
  const ready = await Promise.race([
    new Promise(resolve => lines.once("line", resolve)),
    closed.then(() => ""),
    new Promise(resolve => { deadline = setTimeout(() => resolve(""), 15000); }),
  ]);
  clearTimeout(deadline);
  lines.close();

  let stopping;
  function stop() {
    if (stopping) return stopping;
    child.stdin.end();
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    }, 3000);
    stopping = closed.finally(() => clearTimeout(timer));
    return stopping;
  }
  const match = /^(:\d+)\t(\/[^\t\r\n]+)$/.exec(ready);
  if (!match) {
    await stop();
    note("The Botkins desktop could not start its private X display. Check the Xvfb and Openbox installation.");
    return null;
  }
  env.DISPLAY = match[1];
  env.XAUTHORITY = match[2];
  env.XDG_SESSION_TYPE = "x11";
  return { stop };
}
