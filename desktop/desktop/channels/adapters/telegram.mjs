/**
 * Telegram Bot API long-polling adapter (`getUpdates`, outbound HTTPS, no public URL).
 *
 * Credentials (stored in vault, never logged or echoed):
 *   - botToken: BotFather token
 *
 * Also supports `handleWebhook` so webhook mode can be plugged into the link
 * server later without changing the adapter interface.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

function authError(message) {
  const err = new Error(message);
  err.code = "CHANNEL_AUTH_ERROR";
  return err;
}

function redactToken(text, token) {
  const raw = String(text ?? "");
  if (!token) return raw;
  return raw.split(token).join("[REDACTED]");
}

function stripTelegramMention(text, username) {
  const raw = String(text ?? "");
  if (!username) return raw.trim();
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(new RegExp(`@${escaped}\\b\\s*`, "gi"), "").trim();
}

export function createTelegramAdapter(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase || TELEGRAM_API_BASE).replace(/\/+$/, "");
  const pollTimeoutSec = Math.max(0, Number(options.pollTimeoutSec ?? 25));
  const baseBackoffMs = Math.max(10, Number(options.baseBackoffMs ?? 1000));
  const maxBackoffMs = Math.max(baseBackoffMs, Number(options.maxBackoffMs ?? 30_000));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  let stopped = false;
  let botToken = "";
  let botId = 0;
  let botUsername = "";
  let offset = 0;
  let pollAbort = null;
  let backoffTimer = null;
  let pollPromise = null;

  async function tgApi(method, token, body, signal) {
    const url = `${apiBase}/bot${token}/${method}`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body ?? {}),
        ...(signal && { signal }),
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new Error(redactToken(err?.message || `Telegram ${method} request failed`, token));
    }

    if (res.status === 401 || res.status === 403) {
      throw authError(`Telegram Bot API rejected credentials (HTTP ${res.status}).`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Telegram ${method} returned non-JSON response (HTTP ${res.status}).`);
    }

    if (!data?.ok) {
      const code = Number(data?.error_code || res.status);
      const desc = redactToken(data?.description || `http_${res.status}`, token);
      if (code === 401 || code === 403) {
        throw authError(`Telegram authentication error: ${desc}`);
      }
      const err = new Error(`Telegram API ${method} failed (${code}): ${desc}`);
      if (data?.parameters?.retry_after) {
        err.retryAfterMs = Number(data.parameters.retry_after) * 1000;
      }
      throw err;
    }
    return data.result;
  }

  function makeAttachment(fileId, name, contentType, size) {
    return {
      name: String(name || "attachment"),
      contentType: String(contentType || "application/octet-stream").toLowerCase(),
      size: Number(size) || 0,
      fetchData: async () => {
        const info = await tgApi("getFile", botToken, { file_id: fileId });
        const filePath = info?.file_path;
        if (!filePath) throw new Error("Telegram getFile returned no file_path.");
        const fileUrl = `${apiBase}/file/bot${botToken}/${filePath}`;
        const resp = await fetchImpl(fileUrl);
        if (!resp.ok) {
          throw new Error(`Failed to download Telegram attachment (HTTP ${resp.status}).`);
        }
        return Buffer.from(await resp.arrayBuffer());
      },
    };
  }

  function normalizeUpdate(update) {
    const msg = update?.message;
    if (!msg || !msg.chat) return null;

    const rawText = String(msg.text ?? msg.caption ?? "");
    const chatType = String(msg.chat.type || "");
    const isDirect = chatType === "private";
    const isSelf = Boolean(botId && msg.from?.id === botId);
    const isBot = Boolean(msg.from?.is_bot);

    const entities = Array.isArray(msg.entities) ? msg.entities : Array.isArray(msg.caption_entities) ? msg.caption_entities : [];
    const mentionedInEntities = Boolean(
      botUsername &&
        entities.some((e) => {
          if (e.type !== "mention") return false;
          const slice = rawText.slice(e.offset, e.offset + e.length).toLowerCase();
          return slice === `@${botUsername.toLowerCase()}`;
        }),
    );
    const mentionedInText = Boolean(
      botUsername && rawText.toLowerCase().includes(`@${botUsername.toLowerCase()}`),
    );
    const repliedToBot = Boolean(botId && msg.reply_to_message?.from?.id === botId);
    const mentionsBot = mentionedInEntities || mentionedInText || repliedToBot;
    const text = mentionsBot ? stripTelegramMention(rawText, botUsername) : rawText;

    let threadId;
    if (msg.message_thread_id != null) {
      threadId = `topic:${msg.message_thread_id}`;
    } else if (!isDirect && msg.message_id != null) {
      threadId = `reply:${msg.message_id}`;
    }

    const attachments = [];
    if (msg.document?.file_id) {
      attachments.push(
        makeAttachment(
          msg.document.file_id,
          msg.document.file_name || "document",
          msg.document.mime_type || "application/octet-stream",
          msg.document.file_size,
        ),
      );
    } else if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      if (largest?.file_id) {
        attachments.push(makeAttachment(largest.file_id, "photo.jpg", "image/jpeg", largest.file_size));
      }
    }

    const senderDisplay =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
      msg.from?.username ||
      String(msg.from?.id ?? "Telegram user");

    return {
      channel: "telegram",
      conversationId: String(msg.chat.id),
      ...(threadId && { threadId }),
      sender: {
        id: String(msg.from?.id ?? msg.chat.id),
        display: senderDisplay,
        ...(isBot && { isBot: true }),
      },
      isDirect,
      mentionsBot,
      ...(isSelf && { isSelf: true }),
      text,
      attachments,
      receivedAt: msg.date ? Number(msg.date) * 1000 : Date.now(),
    };
  }

  function threadFields(threadId) {
    if (!threadId) return {};
    const str = String(threadId);
    if (str.startsWith("topic:")) {
      const id = Number(str.slice(6));
      return Number.isFinite(id) ? { message_thread_id: id } : {};
    }
    if (str.startsWith("reply:")) {
      const id = Number(str.slice(6));
      return Number.isFinite(id) ? { reply_parameters: { message_id: id } } : {};
    }
    const num = Number(str);
    return Number.isFinite(num) ? { message_thread_id: num } : {};
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (stopped || signal?.aborted) return resolve();
      const onAbort = () => {
        if (backoffTimer) {
          clearTimer(backoffTimer);
          backoffTimer = null;
        }
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      backoffTimer = setTimer(() => {
        backoffTimer = null;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    });
  }

  return {
    capabilities: {
      maxLength: 4000,
      markdown: "telegram_html",
      markdownFlavor: "telegram_html",
      threads: true,
      files: true,
    },

    async start({ secrets, signal, onStatus, onMessage }) {
      stopped = false;
      botToken = String(secrets?.botToken || "").trim();
      if (!botToken) {
        throw authError("Telegram requires a BotFather bot token.");
      }

      const me = await tgApi("getMe", botToken, {}, signal);
      botId = Number(me?.id || 0);
      botUsername = String(me?.username || "");
      onStatus?.({
        state: "connected",
        detail: botUsername ? `Long polling (@${botUsername})` : "Long polling connected",
      });

      const runLoop = async () => {
        let attempt = 0;
        let degraded = false;

        while (!stopped && !signal?.aborted) {
          pollAbort = new AbortController();
          const onParentAbort = () => pollAbort?.abort();
          signal?.addEventListener("abort", onParentAbort, { once: true });
          try {
            const updates = await tgApi(
              "getUpdates",
              botToken,
              {
                offset,
                timeout: pollTimeoutSec,
                allowed_updates: ["message"],
              },
              pollAbort.signal,
            );
            signal?.removeEventListener("abort", onParentAbort);
            pollAbort = null;

            if (degraded) {
              degraded = false;
              attempt = 0;
              onStatus?.({
                state: "connected",
                detail: botUsername ? `Long polling (@${botUsername})` : "Long polling connected",
              });
            }

            if (Array.isArray(updates)) {
              for (const update of updates) {
                if (typeof update?.update_id === "number") {
                  offset = Math.max(offset, update.update_id + 1);
                }
                const normalized = normalizeUpdate(update);
                if (normalized) {
                  await Promise.resolve(onMessage?.(normalized)).catch(() => {});
                }
              }
            }
          } catch (err) {
            signal?.removeEventListener("abort", onParentAbort);
            pollAbort = null;
            if (stopped || signal?.aborted || err?.name === "AbortError") break;
            if (err?.code === "CHANNEL_AUTH_ERROR") {
              onStatus?.({ state: "auth_error", detail: err.message });
              break;
            }
            degraded = true;
            const delay = err?.retryAfterMs
              ? Math.min(maxBackoffMs, err.retryAfterMs)
              : Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt));
            attempt += 1;
            onStatus?.({
              state: "reconnecting",
              detail: `${redactToken(err?.message || "Poll failed", botToken)} (retrying in ${Math.round(delay)}ms)`,
            });
            await sleep(delay, signal);
          }
        }
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          this.stop().catch(() => {});
        }, { once: true });
      }

      pollPromise = runLoop();
    },

    async stop() {
      stopped = true;
      if (backoffTimer) {
        clearTimer(backoffTimer);
        backoffTimer = null;
      }
      if (pollAbort) {
        try {
          pollAbort.abort();
        } catch {
          // ignore
        }
        pollAbort = null;
      }
      if (pollPromise) {
        await pollPromise.catch(() => {});
        pollPromise = null;
      }
    },

    async send({ conversationId, threadId, text }) {
      if (!botToken) throw authError("Telegram bot token is not configured.");
      const extra = threadFields(threadId);
      try {
        const res = await tgApi("sendMessage", botToken, {
          chat_id: conversationId,
          text: String(text ?? ""),
          parse_mode: "HTML",
          ...extra,
        });
        return { ok: true, id: String(res?.message_id ?? "") };
      } catch (err) {
        if (/can't parse entities/i.test(err?.message || "")) {
          const res = await tgApi("sendMessage", botToken, {
            chat_id: conversationId,
            text: String(text ?? ""),
            ...extra,
          });
          return { ok: true, id: String(res?.message_id ?? "") };
        }
        throw err;
      }
    },

    async typing({ conversationId, threadId }) {
      if (!botToken) return;
      const extra = threadId?.startsWith("topic:")
        ? { message_thread_id: Number(threadId.slice(6)) }
        : {};
      await tgApi("sendChatAction", botToken, {
        chat_id: conversationId,
        action: "typing",
        ...extra,
      });
    },

    async test({ secrets }) {
      const token = String(secrets?.botToken || botToken || "").trim();
      if (!token) return { ok: false, detail: "Missing Telegram botToken." };
      try {
        const me = await tgApi("getMe", token);
        return { ok: true, detail: `Connected as @${me.username || me.id}` };
      } catch (err) {
        return { ok: false, detail: redactToken(err?.message || "Telegram test failed.", token) };
      }
    },

    async handleWebhook({ rawBody }) {
      let update;
      try {
        update = JSON.parse(String(rawBody || "{}"));
      } catch {
        return { status: 400, body: { error: "Invalid JSON" }, events: [] };
      }
      const normalized = normalizeUpdate(update);
      return { status: 200, body: { ok: true }, events: normalized ? [normalized] : [] };
    },
  };
}
