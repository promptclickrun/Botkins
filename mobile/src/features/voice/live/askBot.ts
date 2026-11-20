// The one tool live voice may call: `ask_bot`. The voice model is only the bot's voice; real work
// goes to the bot in its chat. The message is sent, the turn is waited out, and the reply's text is
// what the voice hears. Every transport runs tools through here. Pure, for the tests.

export const ASK_BOT = "ask_bot";
export const MAX_REPLY = 4000;
export const CUT_NOTE = " (The reply was cut here. The rest is in the chat.)";
export const LOOK_AT_PHONE = "The bot needs the person to answer something first. Ask them to look at the Botkins app on their phone and answer there, then ask again.";
export const STILL_WORKING = "The bot is still working on it. Tell the person the answer will be in the chat.";
export const NO_REPLY = "The bot finished without a written reply.";

export type ChatMessage = { role: "assistant" | "user" | "command"; text: string };
/** What the phone knows about the chat right now. */
export type ChatSnapshot = {
  /** A turn is running or queued. */
  busy: boolean;
  /** The bot is waiting for the person (an approval, a question or a form). */
  asking: boolean;
  /** How many messages the chat has. */
  total: number;
  /** The messages from index `from` on, as far as they are known. */
  after(from: number): ChatMessage[];
};
export type ChatAccess = {
  send(text: string): Promise<void>;
  snapshot(): ChatSnapshot;
  subscribe(listener: () => void): () => void;
};

/** The reply's text, cut to `MAX_REPLY` characters with a note when it was longer. */
export function replyText(messages: ChatMessage[]): string {
  // The bot's messages after the person's last one (a group chat can answer more than once).
  let start = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") start = index + 1;
  });
  const text = messages
    .slice(start)
    .filter((message) => message.role === "assistant" && message.text.trim())
    .map((message) => message.text.trim())
    .join("\n\n");
  if (!text) return NO_REPLY;
  if (text.length <= MAX_REPLY) return text;
  return text.slice(0, MAX_REPLY - CUT_NOTE.length).trimEnd() + CUT_NOTE;
}

export async function askBot(message: string, chat: ChatAccess, options: { timeoutMs?: number; settleMs?: number } = {}): Promise<string> {
  const text = message.trim();
  if (!text) return "Say what to ask the bot.";
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const settleMs = options.settleMs ?? 800;
  const before = chat.snapshot().total;
  try {
    await chat.send(text);
  } catch (error) {
    return "The message didn't reach the bot: " + (error instanceof Error && error.message ? error.message : "your computer didn't answer.");
  }
  return new Promise((resolve) => {
    let settled = false;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(limit);
      if (settle) clearTimeout(settle);
      resolve(answer);
    };
    const finished = (snapshot: ChatSnapshot) => {
      if (snapshot.busy || snapshot.total < before + 2) return false;
      const after = snapshot.after(before);
      const last = after[after.length - 1];
      return !!last && last.role === "assistant" && after.some((item) => item.role === "user");
    };
    const check = () => {
      const snapshot = chat.snapshot();
      if (snapshot.asking) return finish(LOOK_AT_PHONE);
      if (!finished(snapshot)) {
        if (settle) clearTimeout(settle);
        settle = null;
        return;
      }
      // A moment of quiet, in case another reply follows (a group chat).
      if (settle) return;
      settle = setTimeout(() => {
        settle = null;
        const now = chat.snapshot();
        if (now.asking) finish(LOOK_AT_PHONE);
        else if (finished(now)) finish(replyText(now.after(before)));
      }, settleMs);
    };
    const unsubscribe = chat.subscribe(check);
    const limit = setTimeout(() => finish(STILL_WORKING), timeoutMs);
    check();
  });
}

/** The runner every transport uses: `ask_bot` goes to the chat; anything else is refused. */
export function chatTools(chat: ChatAccess, onBusy?: (busy: boolean) => void) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name !== ASK_BOT) return "There is no tool named " + name + ".";
    onBusy?.(true);
    try {
      return await askBot(typeof args.message === "string" ? args.message : "", chat);
    } finally {
      onBusy?.(false);
    }
  };
}
