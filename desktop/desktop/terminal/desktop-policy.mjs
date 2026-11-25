// Choose a private Linux desktop without taking over a personal login display.
import { readFileSync } from "node:fs";

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function wantsManagedDesktop(env, trial = false, read = readText) {
  const mode = env.BOTKINS_DESKTOP || "auto";
  if (mode === "managed") return true;
  if (mode !== "auto" || trial) return false;
  const azure = /^MODE=(screen|terminal)$/m.exec(read("/etc/botkins-server/server.env"))?.[1];
  if (azure === "terminal") return false;
  if (!env.DISPLAY) return !env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "wayland";
  const local = /^:(\d+)(?:\.\d+)?$/.exec(env.DISPLAY);
  if (!local) return false;
  // Azure binds the X socket into the service's private /tmp. Its lock is outside that namespace.
  if (azure === "screen" && local[1] === "20" && env.XAUTHORITY === "/var/lib/botkins/display/Xauthority") return true;
  const pid = read("/tmp/.X" + local[1] + "-lock").trim();
  if (!/^\d+$/.test(pid) || !/^(Xvfb|Xvnc|Xtigervnc)$/.test(read("/proc/" + pid + "/comm").trim())) return false;
  // Earlier VPS installs put the virtual X server in a dedicated systemd unit, or used
  // xvfb-run around the Botkins service. A personal virtual display has its own owner.
  return /\/(?:bot-display|botkins-display|botkins)\.service(?:\/|$)/m.test(read("/proc/" + pid + "/cgroup"));
}
