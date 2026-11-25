// Pictures of this computer's screen, for a paired phone the person lets watch it.
// The phone link (desktop/link/screen.mjs) asks for them through this adapter, which it is given
// as `backend.screen` in desktop/main.mjs. Whether a phone may watch at all, and whether it may
// click and type, is the person's choice in Settings › Phone; the link checks it on every call.
// Clicks and typing are posted by the link itself (desktop/link/input.mjs).
//
// Built on Electron, so it works on macOS and Windows and knows every display:
//   displays()                               → [{ id, label, width, height, primary }]
//   capture({ display, maxWidth, quality })  → { jpeg: Buffer, width, height }
//   openVideo({ display, maxWidth, fps, mimeTypes, signal }) → { mimeType, read(), close() } when a recorder is present
//   pointer()                                → { display, x, y } in fractions, or null
//   permissions()                            → { screenRecording, accessibility }
// and, for the app's own page (Settings › Phone):
//   granted()                                → { system, screenRecording, accessibility }: what macOS has allowed so far
//   request("screenRecording" | "accessibility") → asks macOS, and opens the page of System Settings where it is switched on

import { Failure } from "./link/tools.mjs";

// The pages of System Settings › Privacy & Security where each permission is switched on.
const PANES = { screenRecording: "Privacy_ScreenCapture", accessibility: "Privacy_Accessibility" };

/**
 * @param electron  { screen, desktopCapturer, systemPreferences } from Electron, and
 *                  openExternal(url) to open System Settings.
 */
export function screenAdapter({ screen, desktopCapturer, systemPreferences, recordVideo, openExternal = async () => {}, platform = process.platform, sessionType = process.env.XDG_SESSION_TYPE }) {
  const x11 = platform === "linux" && sessionType !== "wayland";
  // The main display is "1", the others "2", "3"…: the link sends clicks to a display by that number,
  // so the order here has to be the order its input scripts use (desktop/link/input.mjs). On
  // Windows that is left to right; on macOS it is the system's own order, which Electron keeps.
  const list = () => {
    const main = screen.getPrimaryDisplay().id;
    const leftToRight = (a, b) => (platform === "win32" ? (a.bounds?.x ?? 0) - (b.bounds?.x ?? 0) : 0);
    return [...screen.getAllDisplays()]
      .sort((a, b) => Number(b.id === main) - Number(a.id === main) || leftToRight(a, b))
      .map((display, index) => ({
        id: String(index + 1),
        label: display.label || (display.id === main ? "Main display" : "Display " + (index + 1)),
        width: display.size.width,
        height: display.size.height,
        primary: display.id === main,
        display,
      }));
  };
  const permissions = () => {
    if (platform !== "darwin") return { screenRecording: true, accessibility: true };
    const recording = systemPreferences.getMediaAccessStatus("screen");
    return {
      // Not decided yet counts as allowed: the first capture is what makes macOS ask the person.
      screenRecording: recording !== "denied" && recording !== "restricted",
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    };
  };
  // For the page: only what macOS has really allowed. Other systems ask for nothing.
  const granted = () =>
    platform === "darwin"
      ? { system: true, screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted", accessibility: systemPreferences.isTrustedAccessibilityClient(false) }
      : { system: false, screenRecording: true, accessibility: true };
  /**
   * Asks macOS for one permission. Asking is what puts Botkins in the list in System Settings; the
   * page of System Settings with that list then opens, so all that is left is to switch Botkins on.
   */
  const request = async (kind) => {
    if (!Object.hasOwn(PANES, kind)) throw new Error("Unknown permission");
    if (platform !== "darwin" || granted()[kind]) return granted();
    if (kind === "screenRecording") {
      // The first capture is what makes macOS ask.
      await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    } else systemPreferences.isTrustedAccessibilityClient(true);
    if (!granted()[kind]) await openExternal("x-apple.systempreferences:com.apple.preference.security?" + PANES[kind]);
    return granted();
  };
  return {
    granted,
    request,
    displays: async () => list().map(({ display: _display, ...shown }) => shown),
    ...(screen?.getCursorScreenPoint && (platform !== "linux" || x11) && {
      async pointer() {
        try {
          const point = screen.getCursorScreenPoint();
          for (const { id, display: { bounds } } of list()) {
            const x = point.x - bounds.x;
            const y = point.y - bounds.y;
            if (x >= 0 && x < bounds.width && y >= 0 && y < bounds.height) {
              // xdotool scales onto [0, size - 1]. The native macOS and Windows injectors multiply by size.
              const edge = platform === "linux" ? 1 : 0;
              return { display: id, x: x / Math.max(1, bounds.width - edge), y: y / Math.max(1, bounds.height - edge) };
            }
          }
        } catch {}
        return null;
      },
    }),
    ...(x11 && {
      inputBounds(id) {
        const all = list();
        const target = all.find(entry => entry.id === String(id))?.display;
        if (!target) throw new Failure("That display isn't available.");
        const origin = target.nativeOrigin ?? (all.length === 1 ? { x: 0, y: 0 } : null);
        const ambiguous = all.some(({ display }) => display.id !== target.id &&
          (!display.nativeOrigin || (display.nativeOrigin.x === origin?.x && display.nativeOrigin.y === origin?.y)));
        const width = Math.round(target.size.width * (target.scaleFactor || 1));
        const height = Math.round(target.size.height * (target.scaleFactor || 1));
        if (ambiguous || !Number.isInteger(origin?.x) || !Number.isInteger(origin?.y) ||
            !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Failure("The coordinates for that display are unavailable.");
        return { x: origin.x, y: origin.y, width, height };
      },
    }),
    ...(recordVideo && { async openVideo(options) {
      options.signal?.throwIfAborted();
      const target = list().find(entry => entry.id === String(options.display))?.display;
      if (!target) throw new Error("That display isn't available.");
      const selectSource = async () => {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
        options.signal?.throwIfAborted();
        const displays = screen.getAllDisplays();
        if (!displays.some(d => d.id === target.id)) throw new Error("That display isn't available.");
        const match = sources.find(s => s.id.startsWith("screen:") && s.display_id === String(target.id));
        if (match) return match;
        // Some platforms omit display IDs. A single physical monitor and a single screen source are unambiguous.
        if (displays.length === 1 && sources.length === 1 && !sources[0].display_id && sources[0].id.startsWith("screen:")) return sources[0];
        throw new Error("That display couldn't be identified for video.");
      };
      return recordVideo({ ...options, target, selectSource });
    } }),
    async capture({ display, maxWidth, quality }) {
      const all = list();
      const index = all.findIndex((entry) => entry.id === String(display));
      if (index < 0) throw new Error("That display isn't available.");
      const target = all[index].display;
      // The picture is as sharp as the display, up to the width the phone asked for.
      const full = Math.round(target.size.width * (target.scaleFactor || 1));
      const width = Math.max(1, Math.min(Math.round(maxWidth) || full, full));
      const height = Math.max(1, Math.round((width * target.size.height) / target.size.width));
      const order = screen.getAllDisplays().map(d => d.id);
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
      const current = screen.getAllDisplays().map(d => d.id);
      if (!current.includes(target.id)) throw new Error("That display isn't available.");
      const isScreen = s => !s.id || s.id.startsWith("screen:");
      const named = sources.find(s => isScreen(s) && s.display_id === String(target.id));
      // Older systems supply screens in system order with no display IDs. Only use a complete, stable list.
      const byOrder = !named && sources.length === order.length && current.length === order.length &&
        current.every((id, n) => id === order[n]) && sources.every(s => isScreen(s) && !s.display_id);
      const source = named ?? (byOrder ? sources[order.indexOf(target.id)] : undefined);
      if (!source || source.thumbnail.isEmpty()) throw new Error(permissions().screenRecording ? "The screen couldn't be captured." : "Allow screen recording for Botkins in System Settings › Privacy & Security.");
      const size = source.thumbnail.getSize();
      return { jpeg: source.thumbnail.toJPEG(Math.min(100, Math.max(1, Math.round(quality) || 60))), width: size.width, height: size.height };
    },
    permissions: async () => permissions(),
  };
}

/** What Settings › Phone shows about the screen: the choice, who is watching, and what macOS has allowed. */
export function screenStatus(status, adapter, devices = []) {
  const mode = ["view", "control"].includes(status?.mode) ? status.mode : "off";
  const withPerson = (actor) => {
    const person = devices.find(device => device.id === actor.deviceId)?.person;
    return person ? { ...actor, name: person } : actor;
  };
  return {
    mode,
    ...(status?.setBy && { setBy: withPerson(status.setBy) }),
    viewers: Array.isArray(status?.viewers) ? status.viewers.map(withPerson) : [],
    permissions: adapter.granted(),
  };
}
