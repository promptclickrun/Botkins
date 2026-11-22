// Pictures of an X11 display for the terminal host (desktop/host/headless.mjs), with no Electron.
//
// A server that runs an X server (Xvnc, Xvfb, Xorg with the dummy driver) and gives the service
// DISPLAY (and XAUTHORITY when the server needs one) lets a paired phone watch it and, with xdotool,
// control it (desktop/link/input.mjs posts the input). The picture comes from a command-line tool:
//
//   ffmpeg   (x11grab)                     tried first: one frame, scaled and encoded in one run
//   import   (ImageMagick)                 otherwise
//
// The display's size comes from `xdotool getdisplaygeometry`, else from `xdpyinfo`. One display, "1".
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jpegSize } from "../link/screen.mjs";
import { Failure, findTool, runTool, searchDirs, toolEnv } from "../link/tools.mjs";

export const NEED_CAPTURE_TOOL = "Install ffmpeg or ImageMagick on this computer to show its screen.";

/** The tool argument lists for one JPEG of `display` at `width` pixels wide, written to `file`. */
export function captureCommand(tool, { display, screen, width, quality, file }) {
  const q = Math.min(100, Math.max(1, Math.round(quality) || 60));
  if (tool === "ffmpeg") {
    // ffmpeg's JPEG scale runs from 2 (best) to 31.
    const qscale = String(Math.round(31 - (q / 100) * 29));
    return ["-loglevel", "error", "-nostdin", "-y", "-f", "x11grab", "-draw_mouse", "1", "-video_size", screen.width + "x" + screen.height, "-i", display, "-frames:v", "1", "-vf", "scale=" + width + ":-2", "-q:v", qscale, "-f", "image2", "-c:v", "mjpeg", file];
  }
  return ["-silent", "-display", display, "-window", "root", "-resize", width + "x", "-quality", String(q), "jpg:" + file];
}

/**
 * @param options.display     The X display (DISPLAY), such as ":20".
 * @param options.xauthority  The X authority file (XAUTHORITY), when the server needs one.
 * @param options.dirs        Where tools are looked for (desktop/link/tools.mjs, searchDirs).
 */
export function x11Screen({ display, xauthority, dirs = searchDirs() }) {
  const env = () => toolEnv(dirs, { DISPLAY: display, ...(xauthority && { XAUTHORITY: xauthority }) });
  const geometry = async () => {
    const xdotool = findTool("xdotool", dirs);
    if (xdotool) {
      const [width, height] = String(await runTool("xdotool", xdotool, ["getdisplaygeometry"], { env: env(), timeout: 5000 })).trim().split(/\s+/).map(Number);
      if (width > 0 && height > 0) return { width, height };
    }
    const xdpyinfo = findTool("xdpyinfo", dirs);
    if (xdpyinfo) {
      const match = /dimensions:\s+(\d+)x(\d+)/.exec(String(await runTool("xdpyinfo", xdpyinfo, ["-display", display], { env: env(), timeout: 5000 })));
      if (match) return { width: Number(match[1]), height: Number(match[2]) };
    }
    throw new Failure(xdotool || xdpyinfo ? "The X display " + display + " couldn't be read." : "Install xdotool on this computer to show its screen.");
  };
  const capturer = () => {
    for (const tool of ["ffmpeg", "import"]) {
      const path = findTool(tool, dirs);
      if (path) return { tool, path };
    }
    return null;
  };
  return {
    async displays() {
      const { width, height } = await geometry();
      return [{ id: "1", label: "Display " + display, width, height, primary: true }];
    },
    async capture({ display: id, maxWidth, quality }) {
      if (String(id) !== "1") throw new Failure("That display isn't available.");
      const found = capturer();
      if (!found) throw new Failure(NEED_CAPTURE_TOOL);
      const screen = await geometry();
      // Even widths keep ffmpeg's encoder happy.
      const width = Math.max(2, Math.min(Math.round(maxWidth) || screen.width, screen.width)) & ~1;
      const folder = mkdtempSync(join(tmpdir(), "botkins-screen-"));
      const file = join(folder, "screen.jpg");
      try {
        await runTool("Screen capture", found.path, captureCommand(found.tool, { display, screen, width, quality, file }), { env: env(), timeout: 15_000 });
        const jpeg = readFileSync(file);
        const size = jpegSize(jpeg);
        if (!size) throw new Failure("The screen couldn't be captured.");
        return { jpeg, ...size };
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
    // X11 asks for no permission: whoever may open the display may read it and post input to it.
    permissions: async () => ({ screenRecording: true, accessibility: true }),
    granted: () => ({ system: false, screenRecording: true, accessibility: true }),
    request: async () => ({ system: false, screenRecording: true, accessibility: true }),
  };
}
