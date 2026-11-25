// A photo made into a person's picture ("people-avatars-v1"): cut to the middle square, made 256 ×
// 256, and saved as a JPEG data URL of at most 96 KB of base64. It starts at quality 0.85 and steps
// down only when a busy photo would be too big. The image library is passed in, so
// tests/person-look.test.ts runs this without a phone.
import { AVATAR_MAX_BASE64, AVATAR_PREFIX, AVATAR_SIZE } from "@/features/chat/personLook";

/** The part of expo-image-manipulator this uses. */
export interface ManipulatorContext {
  crop(rect: { originX: number; originY: number; width: number; height: number }): ManipulatorContext;
  resize(size: { width?: number | null; height?: number | null }): ManipulatorContext;
  renderAsync(): Promise<{ saveAsync(options: { format?: unknown; compress?: number; base64?: boolean }): Promise<{ base64?: string }> }>;
}
export type Manipulator = { ImageManipulator: { manipulate(uri: string): ManipulatorContext }; SaveFormat: { JPEG: unknown } };

/** The qualities tried in turn; 0.85 first, as the computer expects. */
export const AVATAR_QUALITIES = [0.85, 0.7, 0.55, 0.4];

/** The middle square of a picture of this size. */
export function middleSquare(width: number, height: number) {
  const side = Math.max(1, Math.floor(Math.min(width, height)));
  return { originX: Math.max(0, Math.floor((width - side) / 2)), originY: Math.max(0, Math.floor((height - side) / 2)), width: side, height: side };
}

export class AvatarError extends Error {}

/** Makes the picture: a data URL that fits the limit, or an AvatarError with a sentence for the person. */
export async function makeAvatar(manipulator: Manipulator, uri: string, width: number, height: number): Promise<string> {
  if (!(width > 0 && height > 0)) throw new AvatarError("That photo couldn't be read.");
  const image = await manipulator.ImageManipulator.manipulate(uri).crop(middleSquare(width, height)).resize({ width: AVATAR_SIZE, height: AVATAR_SIZE }).renderAsync();
  for (const compress of AVATAR_QUALITIES) {
    const saved = await image.saveAsync({ format: manipulator.SaveFormat.JPEG, compress, base64: true });
    const base64 = (saved.base64 ?? "").replace(/\s+/g, "");
    if (!base64) throw new AvatarError("That photo couldn't be read.");
    if (base64.length <= AVATAR_MAX_BASE64) return AVATAR_PREFIX + base64;
  }
  throw new AvatarError("That photo is too detailed to use as a picture. Try another one.");
}
