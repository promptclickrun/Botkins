// Scaffold for native OS app credential fill (`app_fill`), gated behind an explicit opt-in flag
// and separate OS-permission check.
//
// Why this is gated behind a flag by default:
// Native app autofill relies on focused-window accessibility APIs (macOS Accessibility / Linux
// AT-SPI or xdotool) that have inherent focus-race risks compared to origin-pinned browser fill.
// Enable only when explicitly opted in via `BOTKINS_ENABLE_APP_FILL=1` or `settings.appFillEnabled`.
// Values are never placed on the OS clipboard.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isAppFillEnabled({ env = process.env, settings = {} } = {}) {
  return env?.BOTKINS_ENABLE_APP_FILL === "1" || settings?.appFillEnabled === true;
}

/**
 * Checks whether the host OS has the required accessibility / input-automation permission.
 * Returns `{ granted: boolean, platform, reason? }`.
 */
export async function checkAppFillPermission({ platform = process.platform, checkMacAccessibility, exec = execFileAsync } = {}) {
  if (platform === "darwin") {
    if (typeof checkMacAccessibility === "function") {
      const trusted = await checkMacAccessibility();
      return trusted
        ? { granted: true, platform }
        : { granted: false, platform, reason: "Grant Botkins Accessibility access in System Settings › Privacy & Security › Accessibility." };
    }
    return {
      granted: false,
      platform,
      reason: "macOS Accessibility permission check requires the Electron desktop app with Accessibility enabled.",
    };
  }
  if (platform === "linux") {
    try {
      await exec("which", ["xdotool"], { timeout: 3000 });
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        return { granted: false, platform, reason: "No graphical session (DISPLAY / WAYLAND_DISPLAY) is available." };
      }
      return { granted: true, platform };
    } catch {
      return { granted: false, platform, reason: "Install xdotool or enable AT-SPI to allow Linux native app fill." };
    }
  }
  return { granted: false, platform, reason: `Native app fill is not supported on ${platform}.` };
}

/**
 * Execute native app fill behind feature flag + OS permission check.
 * Never uses the clipboard.
 */
export async function runAppFill({ app, values, env = process.env, settings = {}, platform = process.platform, checkPermission = checkAppFillPermission, adapter = null }) {
  if (!isAppFillEnabled({ env, settings })) {
    throw new Error(
      "Native app credential fill (app_fill) is experimental and disabled by default. Set BOTKINS_ENABLE_APP_FILL=1 (or enable it in Settings) to opt in.",
    );
  }
  const cleanApp = String(app ?? "").trim();
  if (!cleanApp) throw new Error("Provide the target application name or bundle ID.");
  const perm = await checkPermission({ platform });
  if (!perm.granted) {
    throw new Error(perm.reason || "OS accessibility permission is required for native app fill.");
  }
  if (typeof adapter === "function") {
    return await adapter({ app: cleanApp, values, platform });
  }
  throw new Error(
    `Native app fill driver for ${platform} is scaffolded behind the experimental flag; no OS accessibility driver is attached in this build.`,
  );
}
