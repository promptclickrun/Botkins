// On, as the desktop app is: only the agent you are with moves (its page, its chat, live voice), and
// only while that screen is shown and the app is in front (owner, 2026-11-24).
export const DEFAULT_AVATAR_ANIMATIONS = true;
export const AVATAR_ANIMATIONS_WARNING = "May consume battery faster on this phone";

/** A saved choice is kept; a phone that never chose gets the default. */
export function readAvatarAnimations(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_AVATAR_ANIMATIONS;
}
