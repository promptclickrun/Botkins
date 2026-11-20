// This runs in Electron's workspace container. There is deliberately no reference
// to the public LinkHost, its pairing file, a display grant, or an owner signer.
import { randomUUID } from "node:crypto";
import { injectorFor } from "../link/input.mjs";
import { REMOTE_METHODS } from "../link/methods.mjs";
import { listenWorkspace } from "./transport.mjs";

export function workspaceActions(backend, inject) {
  const epoch = randomUUID();
  let revision = 0;
  const unsubscribe = backend.subscribe(() => revision++);
  const actions = {
    async state(known) {
      const displays = await backend.screen.displays().catch(() => []);
      const version = epoch + "/" + revision;
      return {
        version, display: displays.some((d) => d.width > 0 && d.height > 0),
        ...(version !== known && { snapshot: backend.snapshot(), capabilities: backend.capabilities }),
      };
    },
    call(method, args) {
      if (!REMOTE_METHODS.has(method) || !Array.isArray(args)) throw new Error("Unknown workspace call.");
      return backend.call(method, args);
    },
    setLook: (...args) => backend.setLook(...args),
    framePage: (id) => backend.frames.page(id),
    frameChat: (id) => backend.frames.chatFor(id),
    adoptMcpSignIn: (...args) => backend.extras.adoptMcpSignIn(...args),
    displays: () => backend.screen.displays(),
    permissions: () => backend.screen.permissions(),
    async capture(options) {
      const shot = await backend.screen.capture(options);
      return { ...shot, jpeg: shot.jpeg.toString("base64") };
    },
    input: (batch) => inject(batch),
  };
  return {
    dispatch(method, args) {
      if (!Object.hasOwn(actions, method)) throw new Error("Unknown workspace action.");
      return actions[method](...args);
    },
    unsubscribe,
  };
}

export async function serveWorkspace(socket, backend) {
  const { inject, problem } = injectorFor(process.platform, ["/usr/bin", "/bin"]);
  if (!inject) throw new Error(problem);
  const actions = workspaceActions(backend, inject);
  const close = await listenWorkspace(socket, actions.dispatch);
  return () => { close(); actions.unsubscribe(); };
}
