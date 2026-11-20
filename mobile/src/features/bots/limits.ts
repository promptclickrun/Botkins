// What the computer accepts for a bot's text.
export const LIMITS = { name: 48, role: 90, summary: 240, instructions: 30_000, clarification: 4000 } as const;

/** "28,410 / 30,000" once text is near its limit; nothing before that. */
export function counter(text: string, limit: number) {
  return text.length >= limit * 0.9 ? text.length.toLocaleString() + " / " + limit.toLocaleString() : undefined;
}
