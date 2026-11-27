/**
 * Discord Gateway WebSocket adapter (v10, outbound WebSocket, no public URL).
 *
 * Uses the Message Content privileged intent (GUILDS | GUILD_MESSAGES |
 * DIRECT_MESSAGES | MESSAGE_CONTENT = 37377).
 *
 * Credentials (stored in vault, never logged or echoed):
 *   - botToken: Discord Bot Token
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";

// GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const FATAL_CLOSE_CODES = new Map([
  [4004, "Discord authentication failed: check your bot token."],
  [4010, "Discord Gateway rejected shard configuration."],
  [4011, "Discord Gateway requires sharding for this bot."],
  [4012, "Discord Gateway API version is invalid."],
  [4013, "Discord Gateway rejected intents."],
  [4014, "Disallowed intent: enable Message Content Intent in the Discord Developer Portal."],
]);

function authError(message) {
  const err = new Error(message);
  err.code = "CHANNEL_AUTH_ERROR";
  return err;
}

function stripDiscordMention(text, botUserId) {
  const raw = String(text ?? "");
  if (!botUserId) return raw.trim();
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(new RegExp(`<@!?${escaped}>\\s*`, "g"), "").trim();
}

export function createDiscordAdapter(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
  const apiBase = (options.apiBase || DISCORD_API_BASE).replace(/\/+$/, "");
  const baseBackoffMs = Math.max(10, Number(options.baseBackoffMs ?? 1000));
  const maxBackoffMs = Math.max(baseBackoffMs, Number(options.maxBackoffMs ?? 30_000));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;

  let stopped = false;
  let botToken = "";
  let botUserId = "";
  let botUsername = "";
  let activeWs = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let lastSeq = null;
  let sessionId = "";
  let resumeGatewayUrl = "";
  let gatewayUrl = "";

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function discordApi(method, path, token, body) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (res.status === 401 || res.status === 403) {
      throw authError(`Discord API ${path} rejected credentials (HTTP ${res.status}).`);
    }
    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = data?.message || `HTTP ${res.status}`;
      throw new Error(`Discord API ${method} ${path} failed: ${msg}`);
    }
    return data;
  }

  function normalizeMessage(d) {
    if (!d || !d.channel_id) return null;
    const isDirect = !d.guild_id;
    const isSelf = Boolean(botUserId && d.author?.id === botUserId);
    const isBot = Boolean(d.author?.bot);
    const rawText = String(d.content ?? "");
    const mentionedInList = Array.isArray(d.mentions) && d.mentions.some((m) => m?.id === botUserId);
    const mentionedInText = Boolean(
      botUserId && (rawText.includes(`<@${botUserId}>`) || rawText.includes(`<@!${botUserId}>`)),
    );
    const repliedToBot = Boolean(botUserId && d.referenced_message?.author?.id === botUserId);
    const mentionsBot = mentionedInList || mentionedInText || repliedToBot;
    const text = mentionsBot ? stripDiscordMention(rawText, botUserId) : rawText;

    const threadId = !isDirect && d.id ? `reply:${d.id}` : undefined;

    const attachments = (Array.isArray(d.attachments) ? d.attachments : []).map((att) => ({
      name: String(att.filename || "attachment"),
      contentType: String(att.content_type || "application/octet-stream").split(";")[0].trim().toLowerCase(),
      size: Number(att.size) || 0,
      ...(att.url && {
        fetchData: async () => {
          const resp = await fetchImpl(att.url);
          if (!resp.ok) throw new Error(`Failed to download Discord attachment (HTTP ${resp.status}).`);
          return Buffer.from(await resp.arrayBuffer());
        },
      }),
    }));

    const parsedTime = d.timestamp ? Date.parse(d.timestamp) : Date.now();
    return {
      channel: "discord",
      conversationId: String(d.channel_id),
      ...(threadId && { threadId }),
      sender: {
        id: String(d.author?.id || "unknown"),
        display: String(d.author?.global_name || d.author?.username || d.author?.id || "Discord user"),
        ...(isBot && { isBot: true }),
      },
      isDirect,
      mentionsBot,
      ...(isSelf && { isSelf: true }),
      text,
      attachments,
      receivedAt: Number.isFinite(parsedTime) ? parsedTime : Date.now(),
    };
  }

  return {
    capabilities: {
      maxLength: 1950,
      markdown: "discord_markdown",
      markdownFlavor: "discord_markdown",
      threads: true,
      files: true,
    },

    async start({ secrets, signal, onStatus, onMessage }) {
      stopped = false;
      botToken = String(secrets?.botToken || "").trim();
      if (!botToken) {
        throw authError("Discord requires a Bot Token.");
      }

      const gw = await discordApi("GET", "/gateway/bot", botToken);
      gatewayUrl = String(gw?.url || "wss://gateway.discord.gg").replace(/\/+$/, "");

      let attempt = 0;

      const scheduleReconnect = (reason, canResume = true) => {
        if (stopped || signal?.aborted) return;
        if (!canResume) {
          sessionId = "";
          resumeGatewayUrl = "";
          lastSeq = null;
        }
        const delay = Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt));
        attempt += 1;
        onStatus?.({
          state: "reconnecting",
          detail: reason ? `${reason} (retrying in ${Math.round(delay)}ms)` : `Reconnecting in ${Math.round(delay)}ms`,
        });
        reconnectTimer = setTimer(() => {
          reconnectTimer = null;
          connectGateway().catch((err) => {
            if (stopped || signal?.aborted) return;
            if (err?.code === "CHANNEL_AUTH_ERROR") {
              onStatus?.({ state: "auth_error", detail: err.message });
              return;
            }
            scheduleReconnect(err?.message || "Discord Gateway reconnect failed", false);
          });
        }, delay);
      };

      const connectGateway = async () => {
        if (stopped || signal?.aborted) return;
        const base = (sessionId && resumeGatewayUrl ? resumeGatewayUrl : gatewayUrl).replace(/\/+$/, "");
        const url = `${base}/?v=10&encoding=json`;
        const ws = createWebSocket(url);
        activeWs = ws;

        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve();
          };

          const sendFrame = (payload) => {
            if (ws.readyState === 1) {
              try {
                ws.send(JSON.stringify(payload));
              } catch {
                // Socket closing.
              }
            }
          };

          const onMessageFrame = (event) => {
            let frame;
            try {
              frame = JSON.parse(typeof event === "string" ? event : String(event?.data ?? ""));
            } catch {
              return;
            }
            if (frame.s != null) lastSeq = frame.s;

            if (frame.op === 10) {
              // HELLO: start heartbeat + IDENTIFY or RESUME.
              clearHeartbeat();
              const interval = Math.max(50, Number(frame.d?.heartbeat_interval || 41250));
              heartbeatTimer = setIntervalFn(() => {
                sendFrame({ op: 1, d: lastSeq });
              }, interval);

              if (sessionId && lastSeq != null) {
                sendFrame({
                  op: 6,
                  d: { token: botToken, session_id: sessionId, seq: lastSeq },
                });
              } else {
                sendFrame({
                  op: 2,
                  d: {
                    token: botToken,
                    intents: DISCORD_INTENTS,
                    properties: {
                      os: process.platform,
                      browser: "botkins",
                      device: "botkins",
                    },
                  },
                });
              }
              return;
            }

            if (frame.op === 1) {
              // Gateway requested immediate heartbeat.
              sendFrame({ op: 1, d: lastSeq });
              return;
            }

            if (frame.op === 7) {
              // RECONNECT: close and resume.
              try {
                ws.close(4000, "reconnect");
              } catch {
                // ignore
              }
              return;
            }

            if (frame.op === 9) {
              // INVALID_SESSION: d indicates whether session is resumable.
              const resumable = Boolean(frame.d);
              if (!resumable) {
                sessionId = "";
                resumeGatewayUrl = "";
                lastSeq = null;
              }
              try {
                ws.close(4000, "invalid_session");
              } catch {
                // ignore
              }
              return;
            }

            if (frame.op === 0) {
              if (frame.t === "READY") {
                attempt = 0;
                botUserId = String(frame.d?.user?.id || "");
                botUsername = String(frame.d?.user?.username || "");
                sessionId = String(frame.d?.session_id || "");
                resumeGatewayUrl = String(frame.d?.resume_gateway_url || "");
                onStatus?.({
                  state: "connected",
                  detail: botUsername ? `Gateway (@${botUsername})` : "Gateway connected",
                });
                finish();
                return;
              }
              if (frame.t === "RESUMED") {
                attempt = 0;
                onStatus?.({
                  state: "connected",
                  detail: botUsername ? `Gateway resumed (@${botUsername})` : "Gateway resumed",
                });
                finish();
                return;
              }
              if (frame.t === "MESSAGE_CREATE") {
                const normalized = normalizeMessage(frame.d);
                if (normalized) {
                  Promise.resolve(onMessage?.(normalized)).catch(() => {});
                }
              }
            }
          };

          const onError = (err) => {
            finish(err instanceof Error ? err : new Error("Discord WebSocket error."));
          };

          const onClose = (event) => {
            clearHeartbeat();
            if (activeWs === ws) activeWs = null;
            const code = Number(event?.code || 0);
            if (FATAL_CLOSE_CODES.has(code)) {
              const err = authError(FATAL_CLOSE_CODES.get(code));
              onStatus?.({ state: "auth_error", detail: err.message });
              finish(err);
              return;
            }
            if (!settled) {
              finish(new Error(`Discord Gateway closed before READY (code ${code || "unknown"}).`));
              return;
            }
            if (!stopped && !signal?.aborted) {
              scheduleReconnect(`Gateway closed (${code || "disconnect"})`, Boolean(sessionId));
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

      await connectGateway();
    },

    async stop() {
      stopped = true;
      clearHeartbeat();
      if (reconnectTimer) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      if (activeWs) {
        try {
          activeWs.close(1000, "shutdown");
        } catch {
          // ignore
        }
        activeWs = null;
      }
    },

    async send({ conversationId, threadId, text }) {
      if (!botToken) throw authError("Discord bot token is not configured.");
      const replyId = threadId && String(threadId).startsWith("reply:") ? String(threadId).slice(6) : "";
      const payload = {
        content: String(text ?? ""),
        allowed_mentions: { replied_user: false },
        ...(replyId && {
          message_reference: {
            message_id: replyId,
            fail_if_not_exists: false,
          },
        }),
      };
      const res = await discordApi("POST", `/channels/${encodeURIComponent(conversationId)}/messages`, botToken, payload);
      return { ok: true, id: String(res?.id || "") };
    },

    async typing({ conversationId }) {
      if (!botToken) return;
      await discordApi("POST", `/channels/${encodeURIComponent(conversationId)}/typing`, botToken);
    },

    async test({ secrets }) {
      const token = String(secrets?.botToken || botToken || "").trim();
      if (!token) return { ok: false, detail: "Missing Discord botToken." };
      try {
        const me = await discordApi("GET", "/users/@me", token);
        await discordApi("GET", "/gateway/bot", token);
        return { ok: true, detail: `Connected as ${me.username || me.id}` };
      } catch (err) {
        return { ok: false, detail: err?.message || "Discord connection test failed." };
      }
    },

    async handleWebhook({ rawBody }) {
      let body;
      try {
        body = JSON.parse(String(rawBody || "{}"));
      } catch {
        return { status: 400, body: { error: "Invalid JSON" }, events: [] };
      }
      if (body?.type === 1) {
        return { status: 200, body: { type: 1 }, events: [] };
      }
      return { status: 200, body: { ok: true }, events: [] };
    },
  };
}
