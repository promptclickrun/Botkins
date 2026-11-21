/** A QR code as one SVG path in a square of `size` units, quiet zone included. */
export function qrPath(text: string, options?: { margin?: number; level?: "L" | "M" | "Q" | "H" }): { size: number; d: string };
