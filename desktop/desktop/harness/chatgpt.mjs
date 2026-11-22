// A ChatGPT plan as the model behind the Copilot runtime.
//
// The Copilot runtime writes each model request in OpenAI's Responses format. With the sign-in the
// person made in Codex (Botkins' ChatGPT sign-in is Codex's own), the request is sent to the
// ChatGPT plan's Responses endpoint, the one Codex itself uses, and the stream comes back. The
// request says who it is from (originator "botkins"), and usage counts against the person's plan.
//
// That endpoint differs from the public API in four ways, which are evened out here:
//   - it takes the system prompt as `instructions`, never as a system message;
//   - it takes a function tool that doesn't say `strict` as strict, and refuses the whole request
//     when one schema isn't strict-ready (an MCP tool's `"format": "strip"`, measured). Pi leaves
//     `strict` out, so such a tool is sent as not strict;
//   - it streams without saying so in a header;
//   - its last event can leave `output` empty although the items went by one at a time, and the
//     runtime reads the reply from that last event.
//
// The sign-in is Codex's file (auth.json in the Codex home). It is read when a request needs it,
// used for that request and kept nowhere. When the token is about to end, Codex is asked to renew
// it (its own "account/read" with refreshToken), and the file is read again.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { PlanError } from "./claude.mjs";

export const CHATGPT_URL = "https://chatgpt.com/backend-api/codex/responses";
const SOON = 5 * 60_000;

/** When a token ends, read from the token itself. 0 when it doesn't say. */
function endOf(token) {
  try {
    return (JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

/**
 * The ChatGPT sign-in Codex keeps: { token, account, expiresAt }.
 * Throws PlanError when there is none, or when Codex is set up with an API key instead of a plan.
 */
export function chatgptSignIn({ home = process.env.CODEX_HOME || join(homedir(), ".codex"), read = readFileSync } = {}) {
  let saved;
  try {
    saved = JSON.parse(read(join(home, "auth.json"), "utf8"));
  } catch {
    throw new PlanError(401, "authentication_error", "ChatGPT isn't signed in. Sign in to ChatGPT under Settings › Model providers.");
  }
  const token = saved?.tokens?.access_token;
  if (typeof token !== "string" || !token) throw new PlanError(401, "authentication_error", "Codex is set up with an API key, not a ChatGPT plan. Sign in to ChatGPT under Settings › Model providers.");
  return { token, account: typeof saved.tokens.account_id === "string" ? saved.tokens.account_id : "", expiresAt: endOf(token) };
}

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : "");

/**
 * The request as the plan's endpoint takes it: system messages become `instructions`, a function
 * tool that doesn't say whether it is strict is not, nothing is stored, and it streams.
 */
export function planRequest(body) {
  const out = { ...body, store: false, stream: true };
  if (Array.isArray(out.tools)) out.tools = out.tools.map((tool) => (tool?.type === "function" && typeof tool.strict !== "boolean" ? { ...tool, strict: false } : tool));
  if (Array.isArray(out.input)) {
    const system = out.input.filter((item) => item?.role === "system" && (item.type === "message" || item.type === undefined));
    out.instructions = [typeof out.instructions === "string" ? out.instructions : "", ...system.map((item) => textOf(item.content))].filter(Boolean).join("\n\n");
    out.input = out.input.filter((item) => !system.includes(item));
  }
  // The endpoint wants instructions on every request. The runtime always sends its own; a request
  // without any is refused, never given words nobody wrote.
  if (typeof out.instructions !== "string" || !out.instructions) throw new PlanError(400, "invalid_request_error", "A request to a ChatGPT plan needs instructions (a system prompt), and this one has none.");
  return out;
}

/**
 * Puts the reply's items back into the last event when the endpoint left them out of it.
 * @param seen  Optional: told the finished response, for a caller that wants it whole.
 */
export function completeOutput(seen = () => {}) {
  const items = [];
  let pending = "";
  const fix = (block) => {
    const name = /^event: (.+)$/m.exec(block)?.[1]?.trim();
    const at = block.indexOf("data: ");
    if (at < 0 || (name !== "response.output_item.done" && name !== "response.completed")) return block;
    const end = block.indexOf("\n", at);
    try {
      const json = JSON.parse(block.slice(at + 6, end < 0 ? undefined : end));
      if (name === "response.output_item.done" && json.item) items[json.output_index ?? items.length] = json.item;
      else if (json.response) {
        if (!(json.response.output ?? []).length && items.some(Boolean)) json.response.output = items.filter(Boolean);
        seen(json.response);
        return block.slice(0, at + 6) + JSON.stringify(json) + (end < 0 ? "" : block.slice(end));
      }
    } catch {
      // Not JSON: passed on as it came.
    }
    return block;
  };
  // The stream is cut into chunks anywhere: in the middle of a character, or between the two
  // halves of a line ending. A character is put together before it is read, and a line ending's
  // first half waits for its second.
  const decoder = new StringDecoder("utf8");
  let held = "";
  const take = (text) => {
    text = held + text;
    held = text.endsWith("\r") ? "\r" : "";
    pending += (held ? text.slice(0, -1) : text).replace(/\r\n/g, "\n");
  };
  return new Transform({
    transform(chunk, _encoding, done) {
      take(decoder.write(chunk));
      let out = "";
      for (let cut = pending.indexOf("\n\n"); cut >= 0; cut = pending.indexOf("\n\n")) {
        out += fix(pending.slice(0, cut)) + "\n\n";
        pending = pending.slice(cut + 2);
      }
      done(null, out);
    },
    flush(done) {
      take(decoder.end());
      pending += held;
      done(null, pending ? fix(pending) : "");
    },
  });
}

/**
 * Sends one Responses request to the person's ChatGPT plan.
 * @param options.signIn   () => { token, account, expiresAt } (chatgptSignIn).
 * @param options.renew    async () => void: asks Codex to renew its token.
 * @param options.version  Botkins' version, for the request's own name.
 * @returns the endpoint's answer (a fetch Response). Throws PlanError when there is no sign-in.
 */
export async function chatgptTurn(body, { signIn = chatgptSignIn, renew = async () => {}, fetch: fetcher = globalThis.fetch, version = "", signal, url = CHATGPT_URL } = {}) {
  const send = (auth) =>
    fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: "Bearer " + auth.token,
        ...(auth.account && { "chatgpt-account-id": auth.account }),
        "openai-beta": "responses=experimental",
        originator: "botkins",
        "user-agent": "Botkins" + (version ? "/" + version : ""),
      },
      body: JSON.stringify(planRequest(body)),
      signal,
    });
  let auth = signIn();
  if (auth.expiresAt && auth.expiresAt - Date.now() < SOON) {
    await renew().catch(() => {});
    auth = signIn();
  }
  let answer = await send(auth);
  if (answer.status === 401) {
    // Turned down: Codex renews the token once, and the request is sent again.
    await answer.body?.cancel().catch(() => {});
    await renew().catch(() => {});
    const again = signIn();
    if (again.token !== auth.token) answer = await send(again);
  }
  return answer;
}
