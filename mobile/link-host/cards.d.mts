// Types for cards.mjs, for the phone's TypeScript (src/state/cards.ts) and the tests.
export const CARD_LINGER_MS: number;
export const CARD_CHATS: number;
export const SEALED_MAX: number;
export const CARD_AAD: string;
export const CHOICE_MAX: number;
export const DANGER: RegExp;

export type CardPhase = "needs-you" | "thinking" | "working" | "done" | "failed";
export type CardAsk = "approve" | "risky" | "question" | "open";
/** One chat on a card, as Apple sees it. */
export type CardChat = { id: string; phase: CardPhase; steps: number; startedAt: number; finishedAt?: number; provider?: string; ask?: CardAsk };
/** A card's state as Apple sees it (docs/live-cards.md, section 4). `sealed` is added when it is sent. */
export type CardState = { v: 1; phase: CardPhase; label: string; steps: number; startedAt: number; finishedAt?: number; chats: CardChat[]; more: number; sealed?: string };
/** A request as a card and a notification carry it (sealed). */
export type AskDetail = { id: string; k: string; t: string; p?: string; ch?: string[]; rm?: true; free?: true; x?: true };
export type CardStep = { k: string; l: string; d: 0 | 1 | 2; at?: number };
/** What only the phone sees of one chat (docs/live-cards.md, section 5). */
export type CardDetailChat = { id: string; t: string; l: string; m?: string; s?: CardStep[]; th?: string; r?: string; q?: AskDetail };
export type CardDetail = { c: CardDetailChat[] };
export type Card = { state: CardState; detail: CardDetail | null; relevance: number; expires: number | null };

/** The parts of a computer's state a card reads. */
export type CardWorld = {
  bots?: { id: string; model?: { provider?: string; model?: string } }[];
  chats?: { id: string; botId: string; botIds?: string[]; temporary?: boolean; panelId?: string; title: string; model?: { provider?: string; model?: string } }[];
  runs?: { id: string; chatId: string; status: string; time: number; finished?: number; detail?: string; ending?: string; scheduleId?: number | null; trigger?: string; panelId?: string; steps?: { name: string; label?: string; status: string; started?: number }[] }[];
  requests?: { id: string; chatId: string; kind: string; title: string; label?: string; preview?: string; choices?: string[]; freeform?: boolean; remember?: string }[];
  streams?: Record<string, unknown>;
  thinking?: Record<string, string | undefined>;
  intents?: Record<string, string | undefined>;
  settings?: { model?: { provider?: string; model?: string } };
};

export function firstLine(text: unknown): string;
export function latestThought(text: unknown, max?: number): string;
export function stepKind(name: unknown): string;
export function looksDangerous(request: { preview?: string; label?: string; title?: string } | undefined): boolean;
export function askOf(request: CardWorld["requests"] extends (infer R)[] | undefined ? R | undefined : never): CardAsk | undefined;
export function askDetail(request: NonNullable<CardWorld["requests"]>[number]): AskDetail;
export function endedWord(run: { status: string; detail?: string; ending?: string }): string;
export function cardRows(state: CardWorld, botId: string, options?: { now?: number; linger?: number; visible?: (chat: any) => boolean }): any[];
export function nextExpiry(rows: any[], linger?: number): number | null;
export function botCard(
  state: CardWorld,
  botId: string,
  options?: { previews?: boolean; now?: number; linger?: number; visible?: (chat: any) => boolean; reply?: (chat: any, run: any) => string | undefined },
): Card | null;
export function cardOver(state: CardState | null | undefined): boolean;
