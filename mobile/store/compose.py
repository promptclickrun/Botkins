#!/usr/bin/env python3
"""App Store screenshot compositor for Botkins (iPhone 6.9", 1320x2868).

Reads approved captures from docs/screens (never writes there) and the design kit,
and writes flattened RGB PNGs to store/screenshots plus store/contact-sheet.png.

    python3 store/compose.py            # every panel
    python3 store/compose.py 1 3        # only panels 1 and 3
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SCREENS = ROOT / "docs/screens"
KIT = ROOT / "design/botkins-kit"
CHARS = ROOT / "assets/botkins"
OUT = ROOT / "store/screenshots"
W, H = 1320, 2868
SS = 4  # supersampling for masks

SERIF = KIT / "fonts/DejaVuSerif-Bold.ttf"
SANS = KIT / "fonts/OpenSans-Regular.ttf"

# Kit colors (theme/tokens.json), plus the clay action family.
OAT = "#FBF1DE"
CREAM = "#FFF8EA"
ESPRESSO = "#42291F"
MUTED = "#705746"
CLAY = "#A83519"
HONEY = "#E8A945"
FERN = "#70834B"
TIDE = "#548376"
ROSE = "#BB6776"
NIGHT = "#251E1A"
NIGHT_SURFACE = "#332820"
NIGHT_INK = "#FFF0D6"
NIGHT_MUTED = "#D3BDA3"
NIGHT_ACTION = "#EF9E78"
BEZEL = "#16110F"

# The demo bots and the Botkin each one wears in the captures.
BOT = {
    "mira": "tinker-terracotta",
    "patch": "pip-original",
    "scout": "posy-original",
    "quill": "pearl-original",
    "tally": "wicket-original",
}


# ---------- primitives ----------

def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    w, h = size
    big = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), radius * SS, fill=255)
    return big.resize((w, h), Image.LANCZOS)


def capture(name: str) -> Image.Image:
    return Image.open(SCREENS / name).convert("RGBA")


def character(name: str, size: int) -> Image.Image:
    im = Image.open(CHARS / f"{BOT.get(name, name)}.webp").convert("RGBA")
    return im.resize((size, size), Image.LANCZOS)


def shadow_under(layer: Image.Image, blur: int, offset: tuple[int, int], opacity: float, pad: int) -> Image.Image:
    """A neutral shadow from a layer's alpha, padded so the blur has room."""
    a = layer.split()[3]
    base = Image.new("L", (layer.width + pad * 2, layer.height + pad * 2), 0)
    base.paste(a, (pad + offset[0], pad + offset[1]))
    base = base.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * opacity))
    sh = Image.new("RGBA", base.size, (24, 14, 8, 0))
    sh.putalpha(base)
    return sh


def place(canvas: Image.Image, layer: Image.Image, xy: tuple[int, int], shadow: str | None = "device"):
    """Paste a layer with a layered, neutral shadow (tight contact + wide ambient)."""
    x, y = xy
    if shadow:
        pad = 160
        specs = {
            "device": [(70, (0, 60), 0.30), (18, (0, 14), 0.30)],
            "card": [(46, (0, 34), 0.26), (10, (0, 8), 0.22)],
            "dark": [(80, (0, 60), 0.70), (20, (0, 16), 0.55)],
        }[shadow]
        for blur, off, op in specs:
            sh = shadow_under(layer, blur, off, op, pad)
            _paste_clip(canvas, sh, x - pad, y - pad)
    _paste_clip(canvas, layer, x, y)


def _paste_clip(canvas: Image.Image, layer: Image.Image, x: int, y: int):
    # paste() clips at the canvas edge (alpha_composite refuses); the RGB result is the same blend.
    canvas.paste(layer, (x, y), layer)


def device(screen: Image.Image, width: int, light_frame: bool = False) -> Image.Image:
    """A phone: the capture inside rounded glass, a thin bezel and a soft edge highlight."""
    bez = max(14, width // 40)
    sw = width - bez * 2
    sh = round(screen.height * sw / screen.width)
    scr = screen.resize((sw, sh), Image.LANCZOS)
    h = sh + bez * 2
    r_out = int(width * 0.135)
    r_in = r_out - bez
    body = Image.new("RGBA", (width, h), BEZEL)
    body.putalpha(rounded_mask((width, h), r_out))
    # a restrained rim highlight
    rim = Image.new("RGBA", (width * SS, h * SS), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        (SS * 2, SS * 2, width * SS - SS * 3, h * SS - SS * 3), (r_out - 2) * SS,
        outline=(120, 104, 94, 200) if not light_frame else (200, 190, 180, 220), width=SS * 3)
    body.alpha_composite(rim.resize((width, h), Image.LANCZOS))
    glass = Image.new("RGBA", (sw, sh), (0, 0, 0, 0))
    glass.paste(scr, (0, 0), rounded_mask((sw, sh), r_in))
    body.alpha_composite(glass, (bez, bez))
    return body


def card(img: Image.Image, box: tuple[int, int, int, int], scale: float, radius: int = 44,
         border: str | None = None) -> Image.Image:
    """An enlarged crop of real UI on a rounded card."""
    c = img.crop(box)
    c = c.resize((round(c.width * scale), round(c.height * scale)), Image.LANCZOS)
    out = Image.new("RGBA", c.size, (0, 0, 0, 0))
    out.paste(c, (0, 0), rounded_mask(c.size, radius))
    if border:
        ring = Image.new("RGBA", (c.width * SS, c.height * SS), (0, 0, 0, 0))
        ImageDraw.Draw(ring).rounded_rectangle((0, 0, c.width * SS - 1, c.height * SS - 1), radius * SS,
                                               outline=border, width=SS * 3)
        out.alpha_composite(ring.resize(c.size, Image.LANCZOS))
    return out


def over_phone(src: Image.Image, phone_w: int, phone_xy: tuple[int, int], box, c: Image.Image) -> tuple[int, int]:
    """Where to put an enlarged crop `c` of `box` so it sits centered over that same region on the phone."""
    bez = max(14, phone_w // 40)
    k = (phone_w - 2 * bez) / src.width
    cx = phone_xy[0] + bez + (box[0] + box[2]) / 2 * k
    cy = phone_xy[1] + bez + (box[1] + box[3]) / 2 * k
    return round(cx - c.width / 2), round(cy - c.height / 2)


def blob(canvas: Image.Image, box, color: str, blur: int = 0, opacity: int = 255):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=color)
    if opacity < 255:
        layer.putalpha(layer.split()[3].point(lambda v: v * opacity // 255))
    if blur:
        layer = layer.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(layer)


def headline(canvas: Image.Image, lines: list[str], y: int, color: str, align: str = "center",
             size: int = 112, x: int = 96, sub: str | None = None, sub_color: str | None = None,
             rule: str | None = CLAY) -> int:
    """Two short serif lines, auto-fitted to the margin; an optional sans subline. Returns bottom y."""
    d = ImageDraw.Draw(canvas)
    maxw = W - 2 * 96
    while size > 60:
        f = font(SERIF, size)
        if all(d.textlength(t, font=f) <= maxw for t in lines):
            break
        size -= 2
    lead = int(size * 1.18)
    for i, t in enumerate(lines):
        tw = d.textlength(t, font=f)
        tx = (W - tw) / 2 if align == "center" else x
        d.text((tx, y + i * lead), t, font=f, fill=color)
    bottom = y + lead * (len(lines) - 1) + int(size * 1.05)
    # continuity mark: a short clay rule, the kit's one action color
    if rule:
        rw, rh = 120, 12
        rx = (W - rw) // 2 if align == "center" else x
        ry = bottom + 34
        d.rounded_rectangle((rx, ry, rx + rw, ry + rh), rh // 2, fill=rule)
        bottom = ry + rh
    if sub:
        sf = font(SANS, 50)
        sw = d.textlength(sub, font=sf)
        sx = (W - sw) / 2 if align == "center" else x
        d.text((sx, bottom + 34), sub, font=sf, fill=sub_color or color)
        bottom += 34 + 70
    return bottom


def canvas(color: str) -> Image.Image:
    return Image.new("RGBA", (W, H), color)


def grain(im: Image.Image, amount: int = 6) -> Image.Image:
    """The kit's paper texture, very faint, so flat fields feel like oat paper."""
    noise = Image.effect_noise((W, H), 40).convert("L").point(lambda v: 128 + (v - 128) * amount // 40)
    n = Image.merge("RGBA", (noise, noise, noise, Image.new("L", (W, H), 14)))
    im.alpha_composite(n)
    return im


# ---------- panels ----------

def p1_hero():
    im = canvas(OAT)
    grain(im)
    blob(im, (-260, 1500, 1580, 3300), "#F3DFBF")
    wm = Image.open(ROOT / "assets/images/wordmark.png").convert("RGBA")
    wm = wm.resize((560, round(560 * wm.height / wm.width)), Image.LANCZOS)
    im.alpha_composite(wm, ((W - wm.width) // 2, 150))
    bottom = headline(im, ["Your own team of bots,", "right on your phone"], 420, ESPRESSO,
                      sub="Pairs with Botkins on your computer.", sub_color=MUTED)
    phone = device(capture("home.png"), 980)
    row_y = bottom + 90
    py = row_y + 200
    place(im, phone, ((W - phone.width) // 2, py))
    # the whole team stands on the phone's top edge, Mira in the middle
    row = [("scout", 200), ("patch", 220), ("mira", 270), ("quill", 220), ("tally", 200)]
    xs = [W // 2 - 460, W // 2 - 240, W // 2, W // 2 + 240, W // 2 + 460]
    for (name, size), cx in zip(row, xs):
        c = character(name, size)
        sh = shadow_under(c, 14, (0, 10), 0.25, 40)
        top = py + 40 - size  # feet rest just inside the bezel
        im.alpha_composite(sh, (cx - size // 2 - 40, top - 40))
        im.alpha_composite(c, (cx - size // 2, top))
    return im


def p2_chat():
    im = canvas(NIGHT)
    blob(im, (380, -300, 1700, 1200), "#4A2B1E", blur=120)
    phone = device(capture("chat-ink-dark.png"), 880)
    phone = phone.rotate(-3, resample=Image.BICUBIC, expand=True)
    place(im, phone, (W - phone.width + 60, 110), shadow="dark")
    mira = character("mira", 300)
    im.alpha_composite(mira, (60, 1800))
    headline(im, ["Chat with any bot,", "from anywhere"], 2200, NIGHT_INK, align="left",
             sub="Steps, tables and code, as they happen.", sub_color=NIGHT_MUTED, rule=NIGHT_ACTION)
    return im


def p3_models():
    im = canvas(OAT)
    grain(im)
    blob(im, (520, 900, 1900, 2600), "#F1D4B8")
    bottom = headline(im, ["Pick the model", "for each bot"], 180, ESPRESSO, align="left",
                      sub="GitHub Copilot, ChatGPT, Claude and more.", sub_color=MUTED)
    src = capture("model-picker.png")
    # left-weighted and bleeding off the bottom only, where the sheet is blank
    pw = 900
    phone = device(src, pw)
    px, py = 70, bottom + 230
    place(im, phone, (px, py))
    # the thinking levels, enlarged from the same capture and laid over the phone's own row
    box = (0, 1600, 880, 1850)
    c = card(src, box, 1.12, radius=48, border="#E6D2B8")
    place(im, c, over_phone(src, pw, (px, py), box, c), shadow="card")
    t = character("mira", 250)
    im.alpha_composite(t, (W - 285, py + 160))
    return im


def p4_work():
    im = canvas("#F6E6C6")
    grain(im)
    blob(im, (500, 1700, 2200, 3400), "#EFD3A0")
    src = capture("work.png")
    phone = device(src, 900)
    px, py = 360, 980
    place(im, phone, (px, py))
    box = (40, 622, 764, 910)
    c = card(src, box, 1.30, radius=56, border="#E6D2B8")
    cx, cy = over_phone(src, 900, (px, py), box, c)
    place(im, c, (cx, cy), shadow="card")
    s = character("scout", 280)
    im.alpha_composite(s, (60, cy - 300))
    headline(im, ["Routines that run", "on your schedule"], 200, ESPRESSO, align="left",
             sub="And a list of what needs you.", sub_color=MUTED)
    return im


def p5_request():
    im = canvas(NIGHT)
    blob(im, (-300, 1000, 1000, 2600), "#4B2A1C", blur=140)
    bottom = headline(im, ["Bots ask", "before they act"], 200, NIGHT_INK,
                      sub="Secrets stay on your computer.", sub_color=NIGHT_MUTED, rule=NIGHT_ACTION)
    src = capture("request.png")
    phone = device(src, 880)
    py = bottom + 360
    place(im, phone, ((W - phone.width) // 2, py), shadow="dark")
    box = (24, 302, 780, 892)
    c = card(src, box, 1.30, radius=60)
    place(im, c, over_phone(src, 880, ((W - phone.width) // 2, py), box, c), shadow="dark")
    p = character("patch", 250)
    im.alpha_composite(p, (W - 300, py - 330))
    return im


def p6_market():
    im = canvas(OAT)
    grain(im)
    blob(im, (-500, 300, 1100, 1900), "#E9D9C0")
    src = capture("marketplace.png")
    phone = device(src, 960)
    place(im, phone, ((W - phone.width) // 2 + 40, 120))
    q = character("quill", 240)
    im.alpha_composite(q, (20, 60))
    # copy sits low, over a paper band, so this panel reads bottom-up
    band = Image.new("RGBA", (W, 760), OAT)
    fade = Image.linear_gradient("L").resize((W, 760))
    fade = fade.point(lambda v: min(255, v * 4))
    band.putalpha(fade)
    im.alpha_composite(band, (0, H - 900))
    ImageDraw.Draw(im).rectangle((0, H - 300, W, H), fill=OAT)
    headline(im, ["Connect your apps", "in a few taps"], H - 640, ESPRESSO,
             sub="Through your own Composio account.", sub_color=MUTED)
    return im


def p7_island():
    im = canvas(NIGHT)
    blob(im, (160, 700, 1160, 1700), "#5A2E1C", blur=160)
    bottom = headline(im, ["Know when a bot", "needs you"], 200, NIGHT_INK,
                      sub="Live Activities and notifications.", sub_color=NIGHT_MUTED, rule=NIGHT_ACTION)
    src = capture("dynamic-island-expanded.png")
    pill = src.crop((30, 30, 1290, 370))
    # keep only the Island itself: nothing of the app behind it
    m = Image.new("L", pill.size, 0)
    big = Image.new("L", (pill.width * SS, pill.height * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle((12 * SS, 12 * SS, (12 + 1236) * SS, (12 + 316) * SS), 150 * SS, fill=255)
    m = big.resize(pill.size, Image.LANCZOS)
    island = Image.new("RGBA", pill.size, (0, 0, 0, 0))
    island.paste(pill, (0, 0), m)
    s = 1.0
    island = island.resize((round(island.width * s), round(island.height * s)), Image.LANCZOS)
    ring = Image.new("RGBA", (island.width * SS, island.height * SS), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle((12 * SS, 12 * SS, (12 + 1236) * SS, (12 + 316) * SS), 150 * SS,
                                           outline=(120, 92, 78, 255), width=SS * 3)
    island.alpha_composite(ring.resize(island.size, Image.LANCZOS))
    iy = bottom + 260
    place(im, island, ((W - island.width) // 2, iy), shadow="dark")
    # Mira, large, waiting on the answer
    m = character("mira", 640)
    im.alpha_composite(m, ((W - 640) // 2, iy + 560))
    d = ImageDraw.Draw(im)
    f = font(SANS, 46)
    t = "Mira is waiting on you."
    d.text(((W - d.textlength(t, font=f)) / 2, iy + 1260), t, font=f, fill=NIGHT_MUTED)
    return im


def p8_screen():
    im = canvas(OAT)
    grain(im)
    blob(im, (200, 1100, 1700, 2900), "#F0D9B2")
    bottom = headline(im, ["Your computer's screen,", "in your pocket"], 200, ESPRESSO,
                      sub="See it, and use it when you allow it.", sub_color=MUTED)
    phone = device(capture("screen.png"), 900)
    phone = phone.rotate(5, resample=Image.BICUBIC, expand=True)
    place(im, phone, ((W - phone.width) // 2 + 60, bottom + 120))
    t = character("tally", 260)
    im.alpha_composite(t, (60, bottom + 1180))
    return im


PANELS = [
    ("01-your-team", p1_hero),
    ("02-chat", p2_chat),
    ("03-models", p3_models),
    ("04-routines", p4_work),
    ("05-ask-first", p5_request),
    ("06-connect-apps", p6_market),
    ("07-needs-you", p7_island),
    ("08-screen", p8_screen),
]


def contact_sheet(paths: list[Path], dest: Path):
    tw, th, gap, cols = 330, 717, 30, 4
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (gap + cols * (tw + gap), gap + rows * (th + gap)), "#D9C8AE")
    for i, p in enumerate(paths):
        r, c = divmod(i, cols)
        sheet.paste(Image.open(p).resize((tw, th), Image.LANCZOS), (gap + c * (tw + gap), gap + r * (th + gap)))
    sheet.save(dest)


def main(argv: list[str]):
    OUT.mkdir(parents=True, exist_ok=True)
    pick = {int(a) for a in argv} if argv else None
    for i, (name, fn) in enumerate(PANELS, 1):
        if pick and i not in pick:
            continue
        im = fn().convert("RGB")
        assert im.size == (W, H)
        im.save(OUT / f"{name}.png", optimize=True)
        print(OUT / f"{name}.png")
    contact_sheet(sorted(OUT.glob("*.png")), ROOT / "store/contact-sheet.png")


if __name__ == "__main__":
    main(sys.argv[1:])
