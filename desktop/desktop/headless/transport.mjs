// The only shared endpoint is a Unix socket *served by the workspace*. The
// grant authority connects out to it. No agent gets an RPC port on the authority.
import { createServer, request } from "node:http";
import { chmod, lstat, unlink } from "node:fs/promises";

async function jsonBody(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Workspace message is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function listenWorkspace(socketPath, dispatch) {
  const prior = await lstat(socketPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (prior) {
    if (!prior.isSocket()) throw new Error("Expected a workspace socket.");
    await unlink(socketPath);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (req.method !== "POST" || req.url !== "/" || req.headers["content-type"] !== "application/json") {
        throw new Error("Unknown workspace request.");
      }
      const { method, args } = await jsonBody(req, 8 * 1024 * 1024);
      if (typeof method !== "string" || !Array.isArray(args)) throw new Error("Invalid workspace request.");
      res.end(JSON.stringify({ value: await dispatch(method, args) }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  return () => {
    server.close();
    server.closeAllConnections();
  };
}

export function workspaceRequest(socketPath, method, args = []) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "POST", path: "/", headers: { "content-type": "application/json" } }, async (res) => {
      try {
        const { value, error } = await jsonBody(res, 128 * 1024 * 1024);
        if (res.statusCode !== 200) throw new Error(error || "Workspace request failed.");
        resolve(value);
      } catch (error) { reject(error); }
    });
    req.setTimeout(method === "state" || method === "loginNames" ? 5000 : 120000, () => req.destroy(new Error("The workspace did not answer.")));
    req.on("error", reject);
    req.end(JSON.stringify({ method, args }));
  });
}
