// An app's mark in the Marketplace: its brand glyph (Simple Icons, appIcons.generated.ts) on a tile
// that reads in light and dark, or its first letter on a tinted gradient when it has no mark.
// The same tile as the phone's (mobile/src/features/market/art.tsx).
import type { CSSProperties } from "react";
import { APP_ICONS } from "./appIcons.generated";
import { brandOf, hashOf, markStyle } from "./marketColors";

/** How much of a tile its glyph fills, and how round its corners are (of its size). */
const GLYPH = 0.56;
const CORNER = 0.24;

/** The official color of an app's brand, or a hue hashed from its name. */
export const brandColor = (id: string, name: string) => brandOf(name, APP_ICONS[id]?.hex);

/** An app with no mark: its first letter on a gradient tinted from its name. */
export function LetterTile({ name, letter, size = 48 }: { name: string; letter?: string; size?: number }) {
  const hue = hashOf(name.trim().toLowerCase()) % 360;
  const style = { width: size, height: size, borderRadius: Math.round(size * CORNER), fontSize: Math.round(size * 0.44), "--tile-hue": hue } as CSSProperties;
  return (
    <span className="app-logo app-letter-tile" style={style} aria-hidden="true">
      {(letter || name.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase()}
    </span>
  );
}

/** The mark of a catalog app. */
export function BrandIcon({ id, name, letter, size = 48 }: { id: string; name: string; letter?: string; size?: number }) {
  const icon = APP_ICONS[id];
  if (!icon) return <LetterTile name={name} letter={letter} size={size} />;
  const mark = markStyle(icon.hex);
  const style = { width: size, height: size, borderRadius: Math.round(size * CORNER), background: mark.tile } as CSSProperties;
  return (
    <span className="app-logo app-brand-tile" style={style} aria-hidden="true">
      <svg width={size * GLYPH} height={size * GLYPH} viewBox="0 0 24 24" fill={mark.glyph} focusable="false">
        <path d={icon.path} />
      </svg>
    </span>
  );
}
