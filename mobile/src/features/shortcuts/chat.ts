// A shortcut owns its link for the duration of the call. It never changes the chat or computer
// on screen. The same code runs against the demo computer in tests/shortcuts.test.ts.
import type { LinkClient } from "@/link/client";
import type { Bot, ChatDetail, Live, Meta, ModelInfo, Preferences, ProviderStatus } from "@/link/types";
import { chooseModel, effectiveModel, findModel, modelKey, providerName } from "@/state/models";

type Link = Pick<LinkClient, "call">;
type News = { epoch: string; v: Record<string, number> | null; parts: Record<string, unknown> };
type Context = { bots?: Bot[]; settings?: Preferences; meta?: Meta };

export type ShortcutSend = { bot?: string; prompt: string; model?: string; effort?: string; wait: boolean; notify: boolean };
const sync = (link: Link, options = {}) => link.call<News>("link.sync", { steps: "light", appends: {}, ...options });

function selectedBot(bots: Bot[] = [], id?: string) {
  const bot = id ? bots.find(item => item.id === id && !item.hidden) : bots.find(item => !item.hidden);
  if (!bot) throw new Error(id ? "This bot is no longer available on your computer." : "Add a bot in Botkins first.");
  return bot;
}

async function modelOptions(link: Link) {
  const [all, providers] = await Promise.all([link.call<ModelInfo[]>("models"), link.call<ProviderStatus[]>("providers")]);
  return { models: all.filter(item => item.available), defaultProvider: providers.find(item => item.default)?.id };
}

/** Picker data comes from the paired computer, including a provider's current thinking levels. */
export async function shortcutCatalog(link: Link, withModels: boolean) {
  const { parts } = await sync(link);
  const { bots, settings } = parts as Context;
  const { models, defaultProvider } = withModels ? await modelOptions(link) : { models: [], defaultProvider: undefined };
  return {
    bots: (bots ?? []).filter(bot => !bot.hidden).map(bot => {
      const model = findModel(models, effectiveModel(settings, bot), defaultProvider);
      return { id: bot.id, name: bot.name, ...(model && { model: modelKey(model) }) };
    }),
    models: models.map(model => ({ key: modelKey(model), name: model.name, provider: model.provider ?? "", label: model.providerName ?? providerName(model.provider), efforts: model.efforts })),
  };
}

export function shortcutReply(detail: ChatDetail, runId: string): string | undefined {
  const run = detail.runs.find(item => item.id === runId);
  if (!run || run.status === "Working") return undefined;
  if (run.status !== "Completed") throw new Error(run.detail || "The turn ended: " + run.status + ".");
  const reply = detail.messages.filter(message => message.runId === runId && message.role === "assistant" && !message.interim).map(message => message.text).join("\n\n");
  if (!reply.trim()) throw new Error("The bot finished without a written reply.");
  return reply;
}

export async function sendShortcut(link: Link, input: ShortcutSend, signal: AbortSignal): Promise<string> {
  if (!input.prompt.trim()) throw new Error("Enter a prompt for the bot.");
  if (input.prompt.length > 32_000) throw new Error("Use a prompt of up to 32,000 characters.");
  const initial = await sync(link);
  const { bots, settings, meta } = initial.parts as Context;
  const bot = selectedBot(bots, input.bot);
  if (!input.notify && !meta?.capabilities.includes("quiet-replies-v1")) throw new Error("Update Botkins on your computer to send without a reply notification.");
  let choice;
  if (input.model || input.effort) {
    const { models, defaultProvider } = await modelOptions(link);
    const model = input.model ? models.find(item => modelKey(item) === input.model) : findModel(models, effectiveModel(settings, bot), defaultProvider);
    if (!model) throw new Error("That model is no longer available. Choose a model in the shortcut.");
    if (input.effort && !model.efforts.includes(input.effort)) throw new Error("Choose a thinking level this model supports.");
    choice = chooseModel(model, input.effort);
  }
  signal.throwIfAborted();
  const chat = await link.call<string>("createChat", bot.id);
  signal.throwIfAborted();
  if (choice) await link.call("setModel", "chat", chat, choice);
  signal.throwIfAborted();
  await link.call("send", chat, input.prompt, input.notify ? {} : { notify: false });
  if (!input.wait) return "";

  // The first user message identifies this turn even if another device starts the next one.
  const first = await link.call<ChatDetail>("link.messages", chat, 1, 1);
  const runId = first?.messages[0]?.runId;
  if (!runId) throw new Error("The message was sent. Open its chat to see the reply.");
  let { epoch, v: have } = initial;
  while (!signal.aborted) {
    const news = await sync(link, { epoch, have, watch: [chat], wait: 15_000 });
    epoch = news.epoch;
    if (news.v) have = news.v;
    const detail = news.parts["chat:" + chat] as ChatDetail | undefined;
    if (detail) {
      const result = shortcutReply(detail, runId);
      if (result !== undefined) return result;
    }
    if ((news.parts.live as Live | undefined)?.requests.some(request => request.chatId === chat)) throw new Error("The bot needs your answer. Open the chat in Botkins.");
  }
  throw new Error("The shortcut stopped waiting. The chat is in Botkins.");
}
