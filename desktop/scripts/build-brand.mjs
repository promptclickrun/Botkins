#!/usr/bin/env node
// Builds the app's icons and marks from the Botkins artwork in assets/brand (the same files the
// phone app uses: botkins assets/brand and assets/images):
//   assets/icon-mac.png        the app icon as macOS draws icons: a rounded square with room around it
//   assets/icon-win.png        the app icon for Windows: the full square, lightly rounded
//   public/icon.png            the app icon as the app shows it of itself (About, the welcome)
//   public/tray.png            the tray icon in color (Windows)
//   public/trayTemplate.png    the menu bar icon, one color, which macOS tints itself (and @2x)
//   public/wordmark.png        the logo for light backgrounds, and wordmark-dark.png for dark ones
//   public/mark.png            the two Botkins alone
//   public/welcome.jpg         the welcome illustration
// Needs Python with Pillow.   node scripts/build-brand.mjs
import { execFileSync } from "node:child_process";

execFileSync(
  "python3",
  [
    "-I",
    "-c",
    `
from PIL import Image, ImageDraw, ImageFilter
B = "assets/brand/"

def rounded(size, radius):
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius * 4, fill=255)
    return mask.resize((size, size), Image.LANCZOS)

icon = Image.open(B + "icon.png").convert("RGBA")

# macOS: an 824-pixel rounded square in a 1024 canvas, with a soft shadow under it.
body = icon.resize((824, 824), Image.LANCZOS)
body.putalpha(rounded(824, 185))
shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
shade = Image.new("RGBA", (824, 824), (0, 0, 0, 70))
shade.putalpha(rounded(824, 185).point(lambda v: v * 70 // 255))
shadow.paste(shade, (100, 112), shade)
mac = shadow.filter(ImageFilter.GaussianBlur(14))
mac.alpha_composite(body, (100, 100))
mac.save("assets/icon-mac.png")

win = icon.resize((1024, 1024), Image.LANCZOS)
win.putalpha(rounded(1024, 180))
win.save("assets/icon-win.png")
win.resize((256, 256), Image.LANCZOS).save("public/icon.png", optimize=True)
tray = icon.resize((64, 64), Image.LANCZOS)
tray.putalpha(rounded(64, 14))
tray.save("public/tray.png")

# The two Botkins alone. In the menu bar they are one color: the heads solid, the eyes cut out.
mark = Image.open(B + "mark.png").convert("RGBA")
mark = mark.crop(mark.getbbox())
mark.resize((mark.width * 256 // mark.height, 256), Image.LANCZOS).save("public/mark.png")
r, g, b, a = mark.split()
light = Image.merge("RGB", (r, g, b)).convert("L").point(lambda v: 255 if v > 128 else 0)
solid = Image.composite(a, Image.new("L", mark.size, 0), light)
for scale, name in ((1, "trayTemplate.png"), (2, "trayTemplate@2x.png")):
    height = 16 * scale
    width = round(mark.width * height / mark.height)
    shape = solid.resize((width, height), Image.LANCZOS)
    out = Image.new("RGBA", (width + 2 * scale, 18 * scale), (0, 0, 0, 0))
    black = Image.new("RGBA", (width, height), (0, 0, 0, 255))
    black.putalpha(shape)
    out.paste(black, (scale, scale), black)
    out.save("public/" + name)

for name in ("wordmark.png", "wordmark-dark.png"):
    art = Image.open(B + name).convert("RGBA")
    art = art.crop(art.getbbox())
    art.resize((round(art.width * 144 / art.height), 144), Image.LANCZOS).save("public/" + name, optimize=True)

Image.open(B + "welcome.jpg").convert("RGB").save("public/welcome.jpg", quality=86, optimize=True)
`,
  ],
  { stdio: "inherit" },
);
console.log("Icons and marks written to assets/ and public/.");
