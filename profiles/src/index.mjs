import { Failure, ORIGIN, bodyOf, currentDevice, ensure, json, key, stmt } from "./common.mjs";
import { accountAction, redeem } from "./account.mjs";
import { browserFlow, finish, start } from "./enroll.mjs";

const browserPaths = new Set(["open", "options", "verify", "email", "code"]);
const nativePaths = new Set([
  "home",
  "profile/update",
  "profile/delete",
  "devices/approve",
  "devices/revoke",
  "hosts/put",
  "hosts/remove",
  "proofs/issue",
]);

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const extensionPaths = new Set(["enroll/start", "enroll/finish", "home", "proofs/issue", "devices/revoke"]);

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/v1/health" && request.method === "GET")
        return json({ service: "botkins-profiles", version: 1 });
      ensure(request.method === "POST", 405, "Use POST for profile operations.");
      ensure(path.startsWith("/v1/"), 404);
      const action = path.slice(4),
        browser = action.startsWith("browser/"),
        origin = request.headers.get("Origin");
      if (browser) {
        ensure(origin === ORIGIN, 403, "Use the Botkins sign-in page.");
      } else if (origin) {
        const fromExtension = EXTENSION_ORIGIN.test(origin) && extensionPaths.has(action);
        ensure(origin === ORIGIN || fromExtension, 403, "Use the Botkins sign-in page.");
      }
      const ip = request.headers.get("CF-Connecting-IP") ?? "local";
      if (env.IP_LIMIT)
        ensure((await env.IP_LIMIT.limit({ key: ip })).success, 429, "Too many requests. Try again shortly.");
      const now = Date.now(),
        db = env.DB,
        input = await bodyOf(request);
      if (action === "enroll/start") return json(await start(db, input, now));
      if (action === "enroll/finish") return json(await finish(db, input, now));
      if (browser && browserPaths.has(action.slice(8)))
        return json(await browserFlow(env, action.slice(8), input, now));
      if (action === "proofs/redeem") return json(await redeem(db, input, now));
      if (action === "devices/status")
        return json({
          active: !!(await stmt(db, "SELECT 1 FROM devices WHERE status_key=?", key(input.statusKey)).first()),
        });
      ensure(nativePaths.has(action), 404, "Unknown profile operation.");
      const device = await currentDevice(db, request);
      return json(await accountAction(db, device, action, input, now));
    } catch (error) {
      return error instanceof Failure
        ? json({ error: error.message }, error.status)
        : json({ error: "The profile service could not complete that request." }, 503);
    }
  },
};
