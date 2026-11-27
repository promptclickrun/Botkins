/**
 * Slack Socket Mode channel adapter (outbound WebSocket, no public URL).
 *
 * Credentials (stored in vault, never logged or persisted in workspace.json):
 *   - botToken: xoxb-... (Bot User OAuth Token)
 *   - appToken: xapp-... (App-Level Token with connections:write scope)
 *
 * Also exposes `handleWebhook` so Slack Events API webhook mode can be enabled
 * later through the link server's `webhooks/<routeId>` ingress without changing
 * the adapter contract.
 */

const SLACK_API_BASE = "https://slack.com/api";
const AUTH_ERROR_CODES = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "invalid_token",
]);

function authError(message) {
  const err = new Error(message);
  err.code = "CHANNEL_AUTH_ERROR";
  return err;
}

function isSlackAuthError(code) {
  return AUTH_ERROR_CODES.has(String(code || "").toLowerCase());
}

function stripBotMention(text, botUserId) {
  const raw = String(text ?? "");
  if (!botUserId) return raw.trim();
  const re = new RegExp(`<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>\\s*`, "g");
  return raw.replace(re, "").trim();
}

export function createSlackAdapter(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
  const apiBase = (options.apiBase || SLACK_API_BASE).replace(/\/+$/, "");
  const baseBackoffMs = Math.max(10, Number(options.baseBackoffMs ?? 1000));
  const maxBackoffMs = Math.max(baseBackoffMs, Number(options.maxBackoffMs ?? 30_000));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  let stopped = false;
  let activeWs = null;
  let reconnectTimer = null;
  let botUserId = "";
  let botId = "";
  let botToken = "";
  let appToken = "";
  const seenEvents = new Set();

  function rememberEvent(id) {
    if (!id) return false;
    if (seenEvents.has(id)) return true;
    seenEvents.add(id);
    if (seenEvents.size > 500) {
      const oldest = seenEvents.values().next().value;
      if (oldest) seenEvents.delete(oldest);
    }
    return false;
  }

  async function slackApi(method, token, body) {
    const res = await fetchImpl(`${apiBase}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body ?? {}),
    });
    if (res.status === 401 || res.status === 403) {
      throw authError(`Slack API ${method} rejected credentials (HTTP ${res.status}).`);
    }
    const data = await res.json();
    if (!data?.ok) {
      const code = data?.error || `http_${res.status}`;
      if (isSlackAuthError(code)) {
        throw authError(`Slack authentication error (${code}).`);
      }
      throw new Error(`Slack API ${method} failed: ${code}`);
    }
    return data;
  }

  function normalizeSlackEvent(ev, eventId) {
    if (!ev || (ev.type !== "message" && ev.type !== "app_mention")) return null;
    // Ignore edit/delete/join noise; allow standard messages and file_share.
    if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "bot_message") return null;
    if (eventId && rememberEvent(eventId)) return null;
    // Also deduplicate app_mention + message pair sharing channel+ts.
    const msgKey = ev.channel && ev.ts ? `${ev.channel}:${ev.ts}` : "";
    if (msgKey && rememberEvent(msgKey)) return null;

    const isSelf = Boolean((botUserId && ev.user === botUserId) || (botId && ev.bot_id === botId));
    const isBot = Boolean(ev.bot_id || ev.subtype === "bot_message");
    const channelId = String(ev.channel || "");
    const isDirect = ev.channel_type === "im" || ev.channel_type === "mpim" || channelId.startsWith("D");
    const rawText = String(ev.text ?? "");
    const mentionsBot =
      ev.type === "app_mention" || Boolean(botUserId && rawText.includes(`<@${botUserId}>`));
    const text = mentionsBot ? stripBotMention(rawText, botUserId) : rawText;

    // Preserve existing thread; in groups start a thread on the triggering message.
    const threadId = ev.thread_ts || (!isDirect && ev.ts ? String(ev.ts) : undefined);

    const files = Array.isArray(ev.files) ? ev.files : [];
    const attachments = files.map((file) => {
      const downloadUrl = file.url_private_download || file.url_private || "";
      return {
        name: String(file.name || file.title || "attachment"),
        contentType: String(file.mimetype || "application/octet-stream").toLowerCase(),
        size: Number(file.size) || 0,
        ...(downloadUrl && {
          fetchData: async () => {
            const resp = await fetchImpl(downloadUrl, {
              headers: { Authorization: `Bearer ${botToken}` },
            });
            if (!resp.ok) throw new Error(`Failed to download Slack attachment (HTTP ${resp.status}).`);
            return Buffer.from(await resp.arrayBuffer());
          },
        }),
      };
    });

    const tsMs = ev.ts ? Math.round(Number(ev.ts) * 1000) : Date.now();
    return {
      channel: "slack",
      conversationId: channelId,
      ...(threadId && { threadId }),
      sender: {
        id: String(ev.user || ev.bot_id || "unknown"),
        display: String(ev.user_profile?.display_name || ev.user_profile?.real_name || ev.username || ev.user || "Slack user"),
        ...(isBot && { isBot: true }),
      },
      isDirect,
      mentionsBot,
      ...(isSelf && { isSelf: true }),
      text,
      attachments,
      receivedAt: Number.isFinite(tsMs) && tsMs > 0 ? tsMs : Date.now(),
    };
  }

  return {
    capabilities: {
      maxLength: 3900,
      markdown: "slack_mrkdwn",
      markdownFlavor: "slack_mrkdwn",
      threads: true,
      files: true,
    },

    async start({ secrets, signal, onStatus, onMessage }) {
      stopped = false;
      botToken = String(secrets?.botToken || "").trim();
      appToken = String(secrets?.appToken || "").trim();
      if (!botToken || !appToken) {
        throw authError("Slack requires both a bot token (xoxb-...) and an app-level token (xapp-...).");
      }

      const auth = await slackApi("auth.test", botToken);
      botUserId = String(auth.user_id || "");
      botId = String(auth.bot_id || "");

      let attempt = 0;

      const scheduleReconnect = (reason, immediate = false) => {
        if (stopped || signal?.aborted) return;
        const delay = immediate ? 0 : Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt));
        attempt = immediate ? 0 : attempt + 1;
        onStatus?.({
          state: "reconnecting",
          detail: reason ? `${reason} (retrying in ${Math.round(delay)}ms)` : `Reconnecting in ${Math.round(delay)}ms`,
        });
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          connectSocket().catch((err) => {
            if (stopped || signal?.aborted) return;
            if (err?.code === "CHANNEL_AUTH_ERROR") {
              onStatus?.({ state: "auth_error", detail: err.message });
              return;
            }
            scheduleReconnect(err?.message || "Socket Mode reconnect failed");
          });
        }, delay);
      };

      const connectSocket = async () => {
        if (stopped || signal?.aborted) return;
        const openRes = await slackApi("apps.connections.open", appToken);
        const wsUrl = String(openRes.url || "");
        if (!wsUrl) throw new Error("Slack apps.connections.open returned no WebSocket URL.");

        const ws = createWebSocket(wsUrl);
        activeWs = ws;
        let refreshRequested = false;

        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
          };

          const onMessageFrame = (event) => {
            let frame;
            try {
              frame = JSON.parse(typeof event === "string" ? event : String(event?.data ?? ""));
            } catch {
              return;
            }
            if (frame.envelope_id && ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
              } catch {
                // Socket closing.
              }
            }
            if (frame.type === "hello") {
              attempt = 0;
              onStatus?.({ state: "connected", detail: auth.team ? `Socket Mode (${auth.team})` : "Socket Mode connected" });
              finish();
              return;
            }
            if (frame.type === "disconnect") {
              refreshRequested = true;
              try {
                ws.close();
              } catch {
                // ignore
              }
              return;
            }
            if (frame.type === "events_api" && frame.payload?.event) {
              const normalized = normalizeSlackEvent(frame.payload.event, frame.payload.event_id);
              if (normalized) {
                Promise.resolve(onMessage?.(normalized)).catch(() => {});
              }
            }
          };

          const onError = (err) => {
            finish(err instanceof Error ? err : new Error("Slack WebSocket error."));
          };

          const onClose = () => {
            if (activeWs === ws) activeWs = null;
            if (!settled) {
              finish(new Error("Slack WebSocket closed before hello."));
              return;
            }
            if (!stopped && !signal?.aborted) {
              scheduleReconnect(refreshRequested ? "Slack requested socket refresh" : "Socket Mode disconnected", refreshRequested);
            }
          };

          if (typeof ws.addEventListener === "function") {
            ws.addEventListener("message", onMessageFrame);
            ws.addEventListener("error", onError);
            ws.addEventListener("close", onClose);
          } else {
            ws.onmessage = onMessageFrame;
            ws.onerror = onError;
            ws.onclose = onClose;
          }
        });
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          this.stop().catch(() => {});
        }, { once: true });
      }

      await connectSocket();
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      if (activeWs) {
        try {
          activeWs.close();
        } catch {
          // ignore
        }
        activeWs = null;
      }
    },

    async send({ conversationId, threadId, text }) {
      if (!botToken) throw authError("Slack bot token is not configured.");
      const payload = {
        channel: conversationId,
        text: String(text ?? ""),
        mrkdwn: true,
        ...(threadId && { thread_ts: threadId }),
      };
      const res = await slackApi("chat.postMessage", botToken, payload);
      return { ok: true, id: res.ts || "" };
    },

    async test({ secrets }) {
      const testBot = String(secrets?.botToken || botToken || "").trim();
      const testApp = String(secrets?.appToken || appToken || "").trim();
      if (!testBot || !testApp) {
        return { ok: false, detail: "Missing Slack botToken or appToken." };
      }
      try {
        const auth = await slackApi("auth.test", testBot);
        await slackApi("apps.connections.open", testApp);
        return { ok: true, detail: `Connected as @${auth.user || auth.user_id} in ${auth.team || "Slack"}` };
      } catch (err) {
        return { ok: false, detail: err?.message || "Slack connection test failed." };
      }
    },

    async handleWebhook({ rawBody }) {
      let body;
      try {
        body = JSON.parse(String(rawBody || "{}"));
      } catch {
        return { status: 400, body: { error: "Invalid JSON" }, events: [] };
      }
      if (body?.type === "url_verification" && typeof body.challenge === "string") {
        return { status: 200, body: { challenge: body.challenge }, events: [] };
      }
      if (body?.type === "event_callback" && body.event) {
        const normalized = normalizeSlackEvent(body.event, body.event_id);
        return { status: 200, body: { ok: true }, events: normalized ? [normalized] : [] };
      }
      return { status: 200, body: { ok: true }, events: [] };
    },
  };
}
