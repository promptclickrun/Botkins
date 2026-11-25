import { fileURLToPath } from "node:url";
import { Failure } from "../link/tools.mjs";
import { VIDEO_FORMATS } from "../link/video.mjs";
import { ScreenVideo, videoLimits } from "./screen-video.mjs";

const page = new URL("./screen-recorder.html", import.meta.url);
const preload = fileURLToPath(new URL("./screen-recorder.cjs", import.meta.url));

/** A dedicated in-memory session. Each recording grants its own frame a single request for one physical screen. */
export function electronVideoRecorder({ WebContentsView, session, screen }) {
  const grants = new WeakMap();
  let privateSession;
  function getSession() {
    if (privateSession) return privateSession;
    privateSession = session.fromPartition("botkins-screen-video", { cache: false });
    privateSession.setPermissionCheckHandler(() => false);
    privateSession.setPermissionRequestHandler((contents, permission, answer, details) => {
      // Chromium asks for "media" with no camera or microphone types for getDisplayMedia().
      answer(permission === "media" && details.isMainFrame && details.requestingUrl === page.href &&
        details.mediaTypes?.length === 0 && grants.has(contents?.mainFrame));
    });
    privateSession.setDisplayMediaRequestHandler((request, answer) => {
      const source = grants.get(request.frame);
      if (!source || request.audioRequested || !request.videoRequested) return answer({});
      grants.delete(request.frame);
      answer({ video: source });
    }, { useSystemPicker: false });
    privateSession.webRequest.onBeforeRequest((request, answer) => answer({ cancel: request.url !== page.href }));
    return privateSession;
  }

  return async function recordVideo({ selectSource, target, maxWidth, fps, mimeTypes, signal }) {
    const offered = (Array.isArray(mimeTypes) ? mimeTypes : []).filter(type => VIDEO_FORMATS.includes(type));
    if (!offered.length) throw new Failure("There is no shared desktop video format.");
    const formats = offered.map(mimeType => {
      const limits = videoLimits(mimeType, maxWidth, fps);
      const { width, height } = target.size;
      const scale = Math.min(target.scaleFactor || 1, limits.width / width,
        limits.long / Math.max(width, height), limits.short / Math.min(width, height));
      return { mimeType, width: Math.max(2, Math.floor(width * scale / 2) * 2),
        height: Math.max(2, Math.floor(height * scale / 2) * 2), fps: limits.fps };
    });
    let view, frame;
    const removed = (_event, display) => {
      if (display.id === target.id) video.close(new Failure("That display isn't available."));
    };
    const video = new ScreenVideo(signal, () => {
      screen.off("display-removed", removed);
      if (frame) grants.delete(frame);
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
      view = null;
    });
    const ended = () => video.close(new Failure("The desktop video recorder stopped."));
    screen.on("display-removed", removed);
    async function start() {
      const source = await selectSource();
      if (video.error) return;
      // An unattached view cannot take focus, appear in a screen share or keep the app's window open.
      view = new WebContentsView({ webPreferences: {
        session: getSession(), preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, devTools: false,
      } });
      const contents = view.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", event => event.preventDefault());
      contents.once("render-process-gone", ended);
      contents.once("destroyed", ended);
      contents.ipc.on("screen-recorder-ended", ended);
      contents.ipc.handle("screen-recorder-bytes", (event, mimeType, bytes) => {
        if (event.senderFrame !== frame || !offered.includes(mimeType) || !(bytes instanceof ArrayBuffer)) return ended();
        video.push(mimeType, Buffer.from(bytes));
      });
      await contents.loadFile(fileURLToPath(page));
      if (video.error) return;
      frame = contents.mainFrame;
      grants.set(frame, source);
      await contents.executeJavaScript("window.botkinsScreenRecorder.start(" + JSON.stringify(formats) + ")", true);
    }
    start().catch(ended);
    return video.opening.promise;
  };
}
