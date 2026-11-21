// The QR code maker the computer uses for its pairing code (link-host/qr.mjs, plain JavaScript
// with its types), so the phone draws the same code.
import { qrPath as hostQrPath } from "../../link-host/qr.mjs";

/** The code as one SVG path in a square of `size` units, quiet zone included. */
export const qrPath: (text: string, options?: { margin?: number; level?: "L" | "M" | "Q" | "H" }) => { size: number; d: string } = hostQrPath;
