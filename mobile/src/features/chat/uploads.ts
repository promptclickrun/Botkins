// Files a person attaches to a message: picked on the phone, sent to the computer in parts of at
// most 3 MB with `link.upload`, then named in `send`'s attachments.
import { File, FileMode } from "expo-file-system";
import type { UploadedFile } from "@/link/types";
import { api, holdBackgroundLink } from "@/state/link";

export const MAX_FILES = 10;
export const MAX_BYTES = 25 * 1024 * 1024;
const PART = 3 * 1024 * 1024;

export type Attachment = {
  key: string;
  name: string;
  uri: string;
  size: number;
  kind: "image" | "file";
  /** 0 to 1. */
  progress: number;
  status: "uploading" | "done" | "failed";
  /** Where the computer saved it, once uploaded. */
  path?: string;
  error?: string;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CODES = new Uint8Array(64);
for (let i = 0; i < 64; i++) CODES[i] = ALPHABET.charCodeAt(i);
const PAD = "=".charCodeAt(0);

/** Standard base64 with padding, built in a byte buffer so a 3 MB part stays quick. */
export function toBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = CODES[n >> 18];
    out[o++] = CODES[(n >> 12) & 63];
    out[o++] = CODES[(n >> 6) & 63];
    out[o++] = CODES[n & 63];
  }
  const left = bytes.length - i;
  if (left > 0) {
    const n = (bytes[i] << 16) | (left === 2 ? bytes[i + 1] << 8 : 0);
    out[o++] = CODES[n >> 18];
    out[o++] = CODES[(n >> 12) & 63];
    out[o++] = left === 2 ? CODES[(n >> 6) & 63] : PAD;
    out[o++] = PAD;
  }
  let text = "";
  for (let start = 0; start < out.length; start += 8192) text += String.fromCharCode.apply(null, out.subarray(start, start + 8192) as unknown as number[]);
  return text;
}

/** The size of a picked file, when the picker didn't say. */
export function sizeOf(uri: string): number {
  try {
    return new File(uri).size;
  } catch {
    return 0;
  }
}

// One file at a time, so several big files never sit in memory together.
let queue: Promise<unknown> = Promise.resolve();

/** Sends a file to the computer in parts. `stopped` is checked before each part; a stopped upload rejects. */
export function upload(uri: string, name: string, onProgress: (fraction: number) => void, stopped: () => boolean): Promise<UploadedFile> {
  const run = async () => {
    if (stopped()) throw new Error("Removed");
    const releaseHold = holdBackgroundLink("upload");
    const handle = new File(uri).open(FileMode.ReadOnly);
    try {
      const total = handle.size ?? 0;
      let sent = 0;
      let id: string | undefined;
      for (;;) {
        const bytes = await handle.readBytes(PART);
        const last = bytes.length < PART || (total > 0 && sent + bytes.length >= total);
        if (stopped()) throw new Error("Removed");
        const result = await api["link.upload"]({ ...(id ? { id } : {}), name, data: toBase64(bytes), last });
        id = result.id;
        sent += bytes.length;
        onProgress(total ? Math.min(1, sent / total) : 1);
        if (last) return result;
      }
    } finally {
      handle.close();
      releaseHold();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
