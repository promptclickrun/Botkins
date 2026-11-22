export const DEFAULT_AVATAR_ANIMATIONS = false;
export const AVATAR_ANIMATIONS_WARNING = "May consume battery faster on this phone";

/** Saved phone preferences before this choice existed keep battery use low. */
export function readAvatarAnimations(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_AVATAR_ANIMATIONS;
}
