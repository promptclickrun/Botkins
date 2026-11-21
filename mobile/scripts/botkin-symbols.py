#!/usr/bin/env python3
"""Each Botkin as a symbol, for the controls (Control Center, the Lock Screen, the Action button),
which can show only a symbol, not a picture.

    python3 scripts/botkin-symbols.py <renders folder> targets/widgets/symbols

The renders folder holds <head>.png: each head in its original colors with open eyes, on a clear
background (scripts/build-widget-assets.mjs makes them). The head's outline is filled, its cream
faceplate is cut out, and its eyes stay filled, so it reads as that Botkin at 20 points. The outline
is traced from the picture along its pixel edges and simplified, then written as an SF Symbols
template (Regular-S) that Xcode turns into a symbol set. Needs Pillow and numpy.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

SIZE = 128  # the grid the outline is traced on
TOLERANCE = 0.9  # how far (in grid cells) a simplified outline may stray from the traced one


def eyes_at(head):
    """Where the head's eyes are on a SIZE grid, from the kit (design/botkins-kit/avatars/<head>.svg)."""
    import re

    source = open(os.path.join("design/botkins-kit/avatars", head + ".svg")).read()
    tx, ty, scale = map(float, re.search(r'<g transform="translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.-]+)\)">', source).groups())
    left, right, y = map(float, re.search(r'data-anchors="([^"]+)"', source).group(1).split(","))
    return ((tx + scale * (left + right) / 2) / 256 * SIZE, (ty + scale * y) / 256 * SIZE)


def mask(path):
    """Filled where the head is and its faceplate isn't."""
    image = Image.open(path).convert("RGBA").resize((SIZE, SIZE), Image.LANCZOS)
    pixels = np.asarray(image).astype(int)
    r, g, b, a = pixels[..., 0], pixels[..., 1], pixels[..., 2], pixels[..., 3]
    head = a > 110
    # The faceplate is a light cream everywhere in the kit; shells are saturated or dark.
    cream = (r > 225) & (g > 195) & (b > 130) & head
    # Only the faceplate is cut out: the cream patch between the eyes. A cream hat, a paper boat or a spot stays filled.
    face = patch_at(np.asarray(Image.fromarray((cream * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(3))) > 127, eyes_at(os.path.basename(path)[:-4]))
    # The eyes sit inside the faceplate: they stay filled, as the faceplate's own holes.
    filled = head & ~face
    # Grain and edges: a little smoothing so the outline is the head's, not its texture.
    smooth = Image.fromarray((filled * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))
    return np.asarray(smooth) > 127


def patch_at(cells, point):
    """The connected patch of `cells` nearest `point` (x, y): the faceplate, around the eyes."""
    h, w = cells.shape
    ys, xs = np.nonzero(cells)
    out = np.zeros_like(cells)
    if not len(xs):
        return out
    nearest = int(np.argmin((xs - point[0]) ** 2 + (ys - point[1]) ** 2))
    stack = [(ys[nearest], xs[nearest])]
    out[stack[0]] = True
    while stack:
        y, x = stack.pop()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and cells[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                stack.append((ny, nx))
    return out


def loops(filled):
    """Closed outlines along pixel edges, filled cells on the left: outer ones and holes alike."""
    h, w = filled.shape
    pad = np.zeros((h + 2, w + 2), dtype=bool)
    pad[1:-1, 1:-1] = filled
    # Directed edges: for each filled cell, each side bordering an empty cell, walked clockwise.
    # Two edges can leave one corner where cells touch diagonally, so each corner keeps a list.
    starts = {}

    def edge(a, b):
        starts.setdefault(a, []).append(b)

    for y in range(1, h + 1):
        for x in range(1, w + 1):
            if not pad[y, x]:
                continue
            cx, cy = x - 1, y - 1
            if not pad[y - 1, x]:
                edge((cx, cy), (cx + 1, cy))  # top, left to right
            if not pad[y, x + 1]:
                edge((cx + 1, cy), (cx + 1, cy + 1))  # right, down
            if not pad[y + 1, x]:
                edge((cx + 1, cy + 1), (cx, cy + 1))  # bottom, right to left
            if not pad[y, x - 1]:
                edge((cx, cy + 1), (cx, cy))  # left, up
    result = []
    used = set()
    for start in list(starts):
        for first in starts[start]:
            if (start, first) in used:
                continue
            loop = [start]
            here, nxt = start, first
            while True:
                used.add((here, nxt))
                loop.append(nxt)
                if nxt == start:
                    break
                options = [e for e in starts.get(nxt, []) if (nxt, e) not in used]
                if not options:
                    break
                here, nxt = nxt, options[0]
            if len(loop) > 8 and loop[-1] == start:
                result.append(loop[:-1])
    return result


def simplify(points, tolerance):
    """Ramer-Douglas-Peucker on a closed outline."""
    if len(points) < 4:
        return points

    def rdp(seq):
        if len(seq) < 3:
            return seq
        (x1, y1), (x2, y2) = seq[0], seq[-1]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5 or 1.0
        worst, index = 0.0, 0
        for i in range(1, len(seq) - 1):
            px, py = seq[i]
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm
            if d > worst:
                worst, index = d, i
        if worst <= tolerance:
            return [seq[0], seq[-1]]
        return rdp(seq[: index + 1])[:-1] + rdp(seq[index:])

    # Split the loop at its farthest point from the first, so both halves are open runs.
    far = max(range(len(points)), key=lambda i: (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2)
    one = rdp(points[: far + 1])
    two = rdp(points[far:] + [points[0]])
    return one[:-1] + two[:-1]


TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<!-- Generated by scripts/botkin-symbols.py from design/botkins-kit. Do not edit by hand. -->
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="3300" height="2200">
 <g id="Notes">
  <rect height="2200" id="artboard" style="fill:white;opacity:1" width="3300" x="0" y="0"/>
  <text id="template-version" style="stroke:none;fill:black;font-family:sans-serif;font-size:13;" transform="matrix(1 0 0 1 3036 1933)">Template v.3.0</text>
 </g>
 <g id="Guides">
  <line id="Baseline-S" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="696" y2="696"/>
  <line id="Capline-S" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="625.541" y2="625.541"/>
  <line id="Baseline-M" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="1126" y2="1126"/>
  <line id="Capline-M" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="1055.54" y2="1055.54"/>
  <line id="Baseline-L" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="1556" y2="1556"/>
  <line id="Capline-L" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="1485.54" y2="1485.54"/>
{margins}
 </g>
 <g id="Symbols">
{glyphs}
 </g>
</svg>
"""


def symbol(path):
    filled = mask(path)
    ys, xs = np.nonzero(filled)
    if not len(xs):
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    # The head stands on the baseline and is a little taller than a capital letter, like a face symbol.
    height = 84.0
    scale = height / max(1, (y1 - y0))
    width = (x1 - x0) * scale
    if width > 110:  # a very wide head is kept within a symbol's usual width
        scale *= 110 / width
        width = 110
    parts = []
    for loop in loops(filled):
        points = simplify(loop, TOLERANCE)
        if len(points) < 3:
            continue
        coords = [((x - x0) * scale, (y - y1) * scale + 6) for x, y in points]
        parts.append("M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in coords) + " Z")
    d = " ".join(parts)
    # Xcode wants a Regular glyph at each scale (small, medium, large); each is the medium one, sized.
    margins, glyphs = [], []
    for size, baseline, factor in (("S", 696, 0.783), ("M", 1126, 1.0), ("L", 1556, 1.29)):
        left = 1391.3
        right = left + width * factor
        top, bottom = baseline - 95.2, baseline + 24.1
        margins.append(f'  <line id="left-margin-Regular-{size}" style="fill:none;stroke:#00AEEF;stroke-width:0.5;opacity:1.0;" x1="{left:.2f}" x2="{left:.2f}" y1="{top:.2f}" y2="{bottom:.2f}"/>')
        margins.append(f'  <line id="right-margin-Regular-{size}" style="fill:none;stroke:#00AEEF;stroke-width:0.5;opacity:1.0;" x1="{right:.2f}" x2="{right:.2f}" y1="{top:.2f}" y2="{bottom:.2f}"/>')
        glyphs.append(f'  <g id="Regular-{size}" transform="matrix({factor} 0 0 {factor} {left:.2f} {baseline})">\n   <path d="{d}" style="fill-rule:evenodd"/>\n  </g>')
    return TEMPLATE.format(margins="\n".join(margins), glyphs="\n".join(glyphs))


def main():
    source, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    made = 0
    for name in sorted(os.listdir(source)):
        if not name.endswith(".png"):
            continue
        svg = symbol(os.path.join(source, name))
        if svg:
            with open(os.path.join(out, "botkin." + name[:-4] + ".svg"), "w") as file:
                file.write(svg)
            made += 1
    print(f"{made} symbols in {out}")


if __name__ == "__main__":
    main()
