// Fixed command for checking a Git server's smart HTTPS read endpoint. The token is
// available only in this worker's environment and the request to the approved repository.
import { parentPort, workerData } from "node:worker_threads";

const endpoint = new URL(workerData);
endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/info/refs";
endpoint.searchParams.set("service", "git-upload-pack");
try {
  const response = await fetch(endpoint, {
    headers: { Authorization: "Bearer " + process.env.BOTKINS_GIT_BEARER },
    redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  parentPort.postMessage(response.ok && response.headers.get("content-type")?.split(";")[0] === "application/x-git-upload-pack-advertisement");
} catch {
  parentPort.postMessage(false);
}
