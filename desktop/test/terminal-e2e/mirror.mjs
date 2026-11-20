// A stand-in for the project's release pages on GitHub, for test/terminal-e2e/units.sh and
// macos-update.sh: it answers the two questions an update asks, the way GitHub answers them.
//
//   node mirror.mjs <folder> <port> [<address>]
//
//   /releases/latest                      a redirect to /releases/tag/v<version>, where <version>
//                                         is the one line of <folder>/latest
//   /releases/download/v<version>/<file>  the file <folder>/v<version>/<file>, or 404
//
// Everything else is 404, the API's address among them, so an update here finds its release the
// way it does first on a real computer: from the release page. Connections are kept open, as
// GitHub keeps them.
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [folder, port, address = "127.0.0.1"] = process.argv.slice(2);
if (!folder || !port) throw new Error("node mirror.mjs <folder> <port> [<address>]");

createServer((request, response) => {
  const none = () => response.writeHead(404, { "Content-Length": 0 }).end();
  if (!["GET", "HEAD"].includes(request.method)) return none();
  const path = new URL(request.url, "http://mirror").pathname;
  if (path === "/releases/latest") {
    let version = "";
    try {
      version = readFileSync(join(folder, "latest"), "utf8").trim();
    } catch {
      return none();
    }
    return response.writeHead(302, { Location: "http://" + request.headers.host + "/releases/tag/v" + version, "Content-Length": 0 }).end();
  }
  const file = /^\/releases\/download\/(v\d+\.\d+\.\d+)\/([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(path);
  if (!file) return none();
  const local = join(folder, file[1], file[2]);
  let size;
  try {
    const stat = statSync(local);
    if (!stat.isFile()) return none();
    size = stat.size;
  } catch {
    return none();
  }
  response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size });
  if (request.method === "HEAD") return response.end();
  createReadStream(local).pipe(response);
}).listen(Number(port), address);
