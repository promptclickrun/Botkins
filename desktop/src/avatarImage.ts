// A picture a person chose for themselves, made ready to send: the middle square of it, 256 pixels
// wide, as a JPEG data URL of at most 96 KB (the host refuses anything else: desktop/link/team.mjs).

export const AVATAR_SIDE = 256;
export const AVATAR_MAX = 96 * 1024;
/** The kinds of file the picker offers. HEIC opens only where the system can read it. */
export const AVATAR_TYPES = "image/png,image/jpeg,image/heic,image/heif,image/webp,.heic,.heif";

/** Where the middle square of a picture of this size is. */
export function centerSquare(width: number, height: number) {
  const side = Math.min(width, height);
  return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), side };
}

/** The base64 part of a data URL, which is what the 96 KB limit counts. */
export const payloadLength = (url: string) => url.length - url.indexOf(",") - 1;

async function decode(file: Blob): Promise<{ image: CanvasImageSource; width: number; height: number; done: () => void }> {
  try {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
  } catch {
    // Some pictures open only as an image element.
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("That picture can't be read. Choose a PNG or JPEG picture.");
    }
    return { image, width: image.naturalWidth, height: image.naturalHeight, done: () => URL.revokeObjectURL(url) };
  }
}

/** The picture as the host keeps it. Throws an Error with a sentence a person can read. */
export async function avatarFromFile(file: Blob): Promise<string> {
  const { image, width, height, done } = await decode(file);
  try {
    if (!width || !height) throw new Error("That picture can't be read. Choose a PNG or JPEG picture.");
    const { x, y, side } = centerSquare(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIDE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("That picture can't be read. Choose a PNG or JPEG picture.");
    // A JPEG has no see-through parts: a transparent picture sits on white.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, x, y, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    for (const quality of [0.85, 0.75, 0.6, 0.45]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.startsWith("data:image/jpeg;base64,") && payloadLength(url) <= AVATAR_MAX) return url;
    }
    throw new Error("That picture is too detailed to keep. Choose another one.");
  } finally {
    done();
  }
}
