// This runs in Electron's workspace container. There is deliberately no reference
// to the public LinkHost, its pairing file, a display grant, or an owner signer.
import { randomUUID } from "node:crypto";
import { VideoStreams } from "../link/video.mjs";
import { injectorFor } from "../link/input.mjs";
import { REMOTE_METHODS } from "../link/methods.mjs";
import { callContext } from "./backend.mjs";
import { LOOK_LIMIT } from "./space-events.mjs";
import { listenWorkspace } from "./transport.mjs";

export function workspaceActions(backend, inject) {
  const epoch = randomUUID();
  const video = new VideoStreams();
  let revision = 0;
  const unsubscribe = backend.subscribe(() => revision++);
  const actions = {
    // `teamRev` is the revision of the team's cut that the link has now (desktop/headless/team-cut.mjs).
    // The answer says which one this workspace holds, so the link sends its cut when they differ.
    async state(known, teamRev) {
      const displays = await backend.screen.displays().catch(() => []);
      const version = epoch + "/" + revision;
      // What people did in a space since the last look: told once, then forgotten. One look takes at most LOOK_LIMIT; the rest wait for the next (headless/space-events.mjs).
      const spaceEvents = backend.takeSpaceEvents?.(LOOK_LIMIT) ?? [];
      const loginLookups = backend.loginLookups?.requests();
      return {
        superKey: true,
        ...(backend.screen.pointer && { pointer: true }),
        ...(backend.screen.openVideo && { video: true }),
        version, display: displays.some((d) => d.width > 0 && d.height > 0),
        team: backend.teamCut?.heard(teamRev) ?? null,
        ...(spaceEvents.length && { spaceEvents }),
        ...(loginLookups?.length && { loginLookups }),
        ...(version !== known && { snapshot: backend.snapshot(), capabilities: backend.capabilities }),
      };
    },
    // Who called comes with the call. What arrives on the socket is cut again here, and a call
    // with no person, or with one that cannot be read, is refused: it is never taken as the owner's.
    // The call names the link's revision of the team too. When this workspace holds another, it
    // drops what it holds before the call runs: a member's turn then gets the narrowest limits.
    call(method, args, context, teamRev) {
      if (!REMOTE_METHODS.has(method) || !Array.isArray(args)) throw new Error("Unknown workspace call.");
      const who = callContext(context);
      backend.teamCut?.heard(teamRev);
      return backend.call(method, args, who);
    },
    // The link tells the team: the whole cut, checked and taken whole or refused whole, kept in
    // memory only. Nothing about the team is ever answered here but the revision that was taken.
    team(cut, rev) {
      if (!backend.teamCut) throw new Error("Unknown workspace action.");
      return backend.teamCut.take(cut, rev);
    },
    loginNames: (id, entries) => backend.loginLookups?.answer(id, entries),
    // The app's own half of Spaces, asked by the link itself: a person's built-in spaces, what
    // stays to do when a member leaves, and the copy of a space that a link opens.
    spaces(name, ...args) {
      if (!["ensure", "release", "snapshot"].includes(name) || typeof backend.spaces?.[name] !== "function") throw new Error("Unknown workspace action.");
      return backend.spaces[name](...args);
    },
    setLook: (...args) => backend.setLook(...args),
    framePage: (id) => backend.frames.page(id),
    frameChat: (id) => backend.frames.chatFor(id),
    adoptMcpSignIn: (...args) => backend.extras.adoptMcpSignIn(...args),
    startMcpSignIn: (...args) => backend.extras.startMcpSignIn(...args),
    finishMcpSignIn: (...args) => backend.extras.finishMcpSignIn(...args),
    displays: () => backend.screen.displays(),
    permissions: () => backend.screen.permissions(),
    pointer: () => backend.screen.pointer?.() ?? null,
    async capture(options) {
      const shot = await backend.screen.capture(options);
      return { ...shot, jpeg: shot.jpeg.toString("base64") };
    },
    videoOpen: (id, options) => video.open(id, id, signal => backend.screen.openVideo({ ...options, signal })),
    videoRead: (id, seq) => video.read(id, id, seq),
    videoClose: id => video.close(id, id),
    input: (batch) => {
      const bounds = !batch.release && backend.screen.inputBounds?.(batch.display.id);
      return inject(bounds ? { ...batch, bounds } : batch);
    },
  };
  return {
    dispatch(method, args) {
      if (!Object.hasOwn(actions, method)) throw new Error("Unknown workspace action.");
      return actions[method](...args);
    },
    unsubscribe() { video.closeAll(); unsubscribe(); },
  };
}

export async function serveWorkspace(socket, backend) {
  const { inject, problem } = injectorFor(process.platform, ["/usr/bin", "/bin"]);
  if (!inject) throw new Error(problem);
  const actions = workspaceActions(backend, inject);
  const close = await listenWorkspace(socket, actions.dispatch);
  return () => { close(); actions.unsubscribe(); };
}
