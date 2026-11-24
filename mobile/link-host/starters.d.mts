export type Starter = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly summary: string;
  readonly instructions: string;
  readonly look: { readonly head: string; readonly palette: string };
  /** Offer the Proactive agent once the bot is made. */
  readonly suggestProactive?: true;
};
export const STARTERS: readonly Starter[];
export function starterById(id: unknown): Starter | undefined;
