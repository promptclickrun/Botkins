// Pictures of this computer's screen, for a paired phone the person lets watch it.
// The phone link (desktop/link/screen.mjs) asks for them through this adapter, which it is given
// as `backend.screen` in desktop/main.mjs. Whether a phone may watch at all, and whether it may
// click and type, is the person's choice in Settings › Phone; the link checks it on every call.
// Clicks and typing are posted by the link itself (desktop/link/input.mjs).
//
// Built on Electron, so it works on macOS and Windows and knows every display:
//   displays()                               → [{ id, label, width, height, primary }]
//   capture({ display, maxWidth, quality })  → { jpeg: Buffer, width, height }
//   permissions()                            → { screenRecording, accessibility }
// and, for the app's own page (Settings › Phone):
//   granted()                                → { system, screenRecording, accessibility }: what macOS has allowed so far
//   request("screenRecording" | "accessibility") → asks macOS, and opens the page of System Settings where it is switched on

// The pages of System Settings › Privacy & Security where each permission is switched on.
const PANES = { screenRecording: "Privacy_ScreenCapture", accessibility: "Privacy_Accessibility" };

/**
 * @param electron  { screen, desktopCapturer, systemPreferences } from Electron, and
 *                  openExternal(url) to open System Settings.
 */
export function screenAdapter({ screen, desktopCapturer, systemPreferences, openExternal = async () => {}, platform = process.platform }) {
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
    async capture({ display, maxWidth, quality }) {
      const all = list();
      const index = all.findIndex((entry) => entry.id === String(display));
      if (index < 0) throw new Error("That display isn't available.");
      const target = all[index].display;
      // The picture is as sharp as the display, up to the width the phone asked for.
      const full = Math.round(target.size.width * (target.scaleFactor || 1));
      const width = Math.max(1, Math.min(Math.round(maxWidth) || full, full));
      const height = Math.max(1, Math.round((width * target.size.height) / target.size.width));
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
      // Sources name their display where the system says which is which; otherwise they come in the system's order.
      const source = sources.find((s) => s.display_id === String(target.id)) ?? (sources.some((s) => s.display_id) ? undefined : sources[screen.getAllDisplays().findIndex((d) => d.id === target.id)]);
      if (!source || source.thumbnail.isEmpty()) throw new Error(permissions().screenRecording ? "The screen couldn't be captured." : "Allow screen recording for Botkins in System Settings › Privacy & Security.");
      const size = source.thumbnail.getSize();
      return { jpeg: source.thumbnail.toJPEG(Math.min(100, Math.max(1, Math.round(quality) || 60))), width: size.width, height: size.height };
    },
    permissions: async () => permissions(),
  };
}

/** What Settings › Phone shows about the screen: the choice, who is watching, and what macOS has allowed. */
export function screenStatus(status, adapter) {
  const mode = ["view", "control"].includes(status?.mode) ? status.mode : "off";
  return { mode, viewers: Array.isArray(status?.viewers) ? status.viewers : [], permissions: adapter.granted() };
}
