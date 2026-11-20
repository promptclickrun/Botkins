// The control socket: how the `botkins` command line (and its dashboard) talks to the running
// service. A Unix socket in the service's own folder, <root>/run/botkins.sock.
//
// Who may use it. The socket is made with mode 0600 inside a folder of mode 0700, both owned by
// the user the service runs as. So only that user, and root, can connect: the kernel checks it on
// every connection, and there is nothing else to check, no token to leak and no port on any
// network. Whoever can connect is the owner, and may do everything the desktop app's own window
// may do (pair a phone, change a bot, read a chat).
//
// What it carries. Plain HTTP, one call per request, JSON both ways:
//
//   POST /v1/call   { "method": "status", "args": [] }
//   200             { "ok": true, "value": … }
//   200             { "ok": false, "error": { "message": "…", "code": "…" } }
//
// A call may wait (the log's next lines, a reply as it streams): the server answers when there is
// something to say or after about 25 seconds with nothing new, and the caller asks again. A
// caller that goes away ends its call's wait (`context.signal`).
//
// GET /v1/hello answers { app, version, pid, api }, so a command line can tell a service of
// another version, or something that is not Botkins at all, before it sends anything.
import { createServer, request } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_SOCKET_PATH } from "./paths.mjs";

/** Raised when the calls a command line knows change in a way an older service can't answer. */
export const API = 1;
const MAX_BODY = 8 * 1024 * 1024;

/** An error with a `code` a script can test: "NOT_RUNNING", "DENIED", "UNKNOWN_METHOD", … */
export class ControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

async function body(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new ControlError("That request is too large.", "TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True when something answers on the socket. */
function answers(socketPath) {
  return new Promise((resolve) => {
    const req = request({ socketPath, method: "GET", path: "/v1/hello" }, (res) => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(2000, () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * Listens on the control socket.
 * @param socketPath  Where. Its folder is made 0700 when it is missing.
 * @param dispatch    (method, args, { signal }) → the value, or a promise of it.
 * @param info        () → what /v1/hello adds to { app, api }: { version, pid }.
 * @returns close(): stops listening and removes the socket.
 */
export async function listenControl(socketPath, dispatch, info = () => ({})) {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new ControlError("The control socket's path is too long for this system (" + socketPath + "). Choose a shorter data folder, or name a socket with BOTKINS_SOCKET.", "SOCKET_PATH");
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) throw new ControlError(socketPath + " is in the way of the control socket and is not a socket.", "SOCKET_PATH");
    if (await answers(socketPath)) throw new ControlError("Botkins is already running on this data folder.", "ALREADY_RUNNING");
    // Left by a service that was killed: nothing listens on it.
    unlinkSync(socketPath);
  }
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      if (res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === "GET" && req.url === "/v1/hello") return reply(200, { app: "botkins", api: API, ...info() });
      if (req.method !== "POST" || req.url !== "/v1/call") return reply(404, { ok: false, error: { message: "Unknown request.", code: "UNKNOWN_REQUEST" } });
      const { method, args = [] } = JSON.parse(await body(req, MAX_BODY));
      if (typeof method !== "string" || !Array.isArray(args)) throw new ControlError("A call names a method and a list of arguments.", "BAD_REQUEST");
      // A caller that hangs up stops waiting for its answer.
      const gone = new AbortController();
      res.on("close", () => !res.writableEnded && gone.abort());
      const value = await dispatch(method, args, { signal: gone.signal });
      reply(200, { ok: true, value: value === undefined ? null : value });
    } catch (error) {
      reply(200, { ok: false, error: { message: String(error?.message ?? error), ...(typeof error?.code === "string" && { code: error.code }) } });
    }
  });
  // No call waits forever on a half-open connection, and a slow one can't hold the socket.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  // The socket is born 0600: the mask covers the moment between bind and chmod.
  const mask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(mask);
  }
  chmodSync(socketPath, 0o600);
  return async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone.
    }
  };
}

function exchange(socketPath, { method, path, payload, timeout }) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: payload ? { "content-type": "application/json" } : {} }, async (res) => {
      try {
        resolve(JSON.parse(await body(res, 256 * 1024 * 1024)));
      } catch (error) {
        reject(new ControlError("The service sent an answer that isn't JSON (" + error.message + "). Is something else listening on " + socketPath + "?", "BAD_ANSWER"));
      }
    });
    req.setTimeout(timeout, () => req.destroy(new ControlError("The service didn't answer in time.", "TIMEOUT")));
    req.on("error", (error) => {
      if (error instanceof ControlError) return reject(error);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return reject(new ControlError("Botkins isn't running here (no service answers on " + socketPath + "). Start it with `botkins service start`, or `botkins serve` in another terminal.", "NOT_RUNNING"));
      if (error.code === "EACCES" || error.code === "EPERM") return reject(new ControlError("This user may not talk to the Botkins service (" + socketPath + " belongs to the user the service runs as). Run the command as that user, for example with `sudo -u botkins`, or as root.", "DENIED"));
      reject(new ControlError("The service can't be reached: " + error.message, "UNREACHABLE"));
    });
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

/**
 * The service on a socket, for the command line.
 * @returns { hello(), call(method, ...args), running() }: `call` resolves with the value or
 *   rejects with a ControlError carrying the service's own sentence.
 */
export function controlClient(socketPath, { timeout = 60_000 } = {}) {
  return {
    socket: socketPath,
    hello: () => exchange(socketPath, { method: "GET", path: "/v1/hello", timeout: 5000 }),
    async running() {
      try {
        return (await this.hello()).app === "botkins";
      } catch {
        return false;
      }
    },
    async call(method, ...args) {
      const answer = await exchange(socketPath, { method: "POST", path: "/v1/call", payload: { method, args }, timeout });
      if (answer?.ok) return answer.value;
      throw new ControlError(answer?.error?.message ?? "The service refused that call.", answer?.error?.code ?? "FAILED");
    },
  };
}
