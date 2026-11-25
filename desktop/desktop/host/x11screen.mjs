// Pictures of an X11 display for the terminal host (desktop/host/headless.mjs), with no Electron.
//
// A server that runs an X server (Xvnc, Xvfb, Xorg with the dummy driver) and gives the service
// DISPLAY (and XAUTHORITY when the server needs one) lets a paired phone watch it and, with xdotool,
// control it (desktop/link/input.mjs posts the input). The picture comes from a command-line tool:
//
//   ffmpeg   (x11grab)                     a single frame, or a continuous encoded video stream
//   import   (ImageMagick)                 otherwise
//
// The display's size comes from `xdotool getdisplaygeometry`, else from `xdpyinfo`. One display, "1".
import { spawn } from "node:child_process";
import { jpegSize } from "../link/screen.mjs";
import { Failure, findTool, runTool, searchDirs, toolEnv } from "../link/tools.mjs";
import { AVC_31, AVC_42 } from "../link/video.mjs";
import { ScreenVideo, videoLimits } from "./screen-video.mjs";

export const NEED_CAPTURE_TOOL = "Install ffmpeg or ImageMagick on this computer to show its screen.";

/** The tool argument lists for one JPEG of `display` at `width` pixels wide, on standard output. */
export function captureCommand(tool, { display, width, quality }) {
  const q = Math.min(100, Math.max(1, Math.round(quality) || 60));
  if (tool === "ffmpeg") {
    // ffmpeg's JPEG scale runs from 2 (best) to 31.
    const qscale = String(Math.round(31 - (q / 100) * 29));
    // x11grab takes the whole display at its current size. Raw video needs no stream probing.
    const scale = "scale='max(2,trunc(min(iw," + width + ")/2)*2)':-2";
    return ["-loglevel", "error", "-nostdin", "-f", "x11grab", "-probesize", "32", "-draw_mouse", "1", "-i", display, "-frames:v", "1", "-vf", scale, "-q:v", qscale, "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"];
  }
  return ["-silent", "-display", display, "-window", "root", "-resize", width + "x>", "-quality", String(q), "jpg:-"];
}

async function openX11Video(ffmpeg, display, env, { display: id, mimeTypes, maxWidth, fps, signal }) {
  if (String(id) !== "1") throw new Failure("That display isn't available.");
  const mimeType = Array.isArray(mimeTypes) && mimeTypes.find(type => type === AVC_42 || type === AVC_31);
  if (!mimeType) throw new Failure("There is no shared desktop video format.");
  const { width, long, short, fps: rate } = videoLimits(mimeType, maxWidth, fps);
  const landscape = "gte(iw,ih)";
  const scale = "scale=w='min(iw,min(" + width + ",if(" + landscape + "," + long + "," + short + ")))'" +
    ":h='min(ih,if(" + landscape + "," + short + "," + long + "))':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,setsar=1";
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "x11grab", "-probesize", "32",
    "-framerate", String(rate), "-draw_mouse", "1", "-i", display, "-an", "-filter_threads", "1", "-vf", scale,
    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-profile:v", "baseline", "-level:v", mimeType === AVC_31 ? "3.1" : "4.2", "-g", String(Math.ceil(rate / 2)),
    "-crf", "23", "-maxrate", mimeType === AVC_31 ? "3000k" : "6000k", "-bufsize", "1000k",
    "-f", "mp4", "-movflags", "+empty_moov+default_base_moof+frag_keyframe",
    "-frag_duration", "80000", "-flush_packets", "1", "pipe:1",
  ];
  let encoder;
  const video = new ScreenVideo(signal, () => {
    encoder?.stdout.destroy();
    encoder?.kill("SIGKILL");
  });
  const failed = () => video.close(new Failure("The desktop video encoder stopped."));
  try {
    encoder = spawn(ffmpeg, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    encoder.once("error", failed);
    encoder.once("close", failed);
    encoder.stdout.on("data", bytes => video.push(mimeType, bytes));
    encoder.stdout.once("error", failed);
  } catch { failed(); }
  return video.opening.promise;
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
    get openVideo() {
      const ffmpeg = findTool("ffmpeg", dirs);
      return ffmpeg ? options => openX11Video(ffmpeg, display, env(), options) : undefined;
    },
    async displays() {
      const { width, height } = await geometry();
      return [{ id: "1", label: "Display " + display, width, height, primary: true }];
    },
    async pointer() {
      const xdotool = findTool("xdotool", dirs);
      if (!xdotool) return null;
      const index = Number(/:\d+\.(\d+)$/.exec(display)?.[1] || 0);
      try {
        const result = await runTool("xdotool", xdotool, ["getmouselocation", "--shell", "getdisplaygeometry", "--screen", String(index)], { env: env(), timeout: 5000 });
        const match = /^X=(\d+)\nY=(\d+)\nSCREEN=(\d+)\n[\s\S]*?(\d+) (\d+)\s*$/.exec(String(result));
        if (!match) return null;
        const [x, y, current, width, height] = match.slice(1).map(Number);
        if (current !== index || x >= width || y >= height) return null;
        return { display: "1", x: x / Math.max(1, width - 1), y: y / Math.max(1, height - 1) };
      } catch { return null; }
    },
    async capture({ display: id, maxWidth, quality }) {
      if (String(id) !== "1") throw new Failure("That display isn't available.");
      const found = capturer();
      if (!found) throw new Failure(NEED_CAPTURE_TOOL);
      const width = Math.max(2, Math.round(maxWidth) || 1920);
      const jpeg = await runTool("Screen capture", found.path, captureCommand(found.tool, { display, width, quality }), { env: env(), timeout: 15_000, binary: true });
      const size = jpegSize(jpeg);
      if (!size) throw new Failure("The screen couldn't be captured.");
      return { jpeg, ...size };
    },
    // X11 asks for no permission: whoever may open the display may read it and post input to it.
    permissions: async () => ({ screenRecording: true, accessibility: true }),
    granted: () => ({ system: false, screenRecording: true, accessibility: true }),
    request: async () => ({ system: false, screenRecording: true, accessibility: true }),
  };
}
