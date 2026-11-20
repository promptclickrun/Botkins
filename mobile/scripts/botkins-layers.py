# Splits each head into the layers the app stacks for custom colors (see scripts/build-botkins.mjs).
#   python3 -I scripts/botkins-layers.py <coded pictures> <out dir> <head>...
# Reads <head>.<code>.png for the codes weights, cover, white, rest and own, writes
# <head>-<layer>.webp (lossless) and prints, as JSON, each head's layers and its fitted own colors.
#
# All pictures are premultiplied sums of path colors, w_p × c_p, where w_p is how much of path p
# shows at the pixel. With A_r = Σ w_p·k_p over role r (k: what the path keeps of its target),
# W = Σ w_p·amount over the tints, M the coverage of the roles and R the rest, the kit's result is
#   Σ_r T_r·A_r + W·white + R.
# The app draws masks x_r tinted T_r, then the shade layer (gray, alpha Sa), then the rest (alpha
# M_rest) with "over". Solving for x_r and the shade layer makes that stack equal the sum.
import json, os, sys
import numpy as np
from PIL import Image

src, out, heads = sys.argv[1], sys.argv[2], sys.argv[3:]
EPS = 1e-4


def premul(path):
    rgba = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float64) / 255.0
    alpha = rgba[..., 3]
    return rgba[..., :3] * alpha[..., None], alpha


def safe(num, den):
    return np.where(den > EPS, num / np.maximum(den, EPS), 0.0)


def save(path, rgb, alpha):
    rgba = np.dstack([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)])
    Image.fromarray(np.round(rgba * 255).astype(np.uint8), "RGBA").save(path, "WEBP", lossless=True, quality=100, method=4)


def hexof(rgb):
    return "#" + "".join("%02x" % int(round(min(255, max(0, c)))) for c in rgb)


report = {}
for head in heads:
    pic = lambda code: premul(os.path.join(src, head + "." + code + ".png"))
    weights, alpha = pic("weights")
    cover, _ = pic("cover")
    white, _ = pic("white")
    rest, _ = pic("rest")
    own, _ = pic("own")
    A = [weights[..., i] for i in range(3)]
    M = [cover[..., i] for i in range(3)]
    W = white[..., 0]
    roles = np.clip(sum(M), 0, 1)
    m_rest = np.clip(alpha - roles, 0, 1)
    d = 1 - m_rest
    sa = np.clip(safe(roles - sum(A), d), 0, 1)
    sc = np.clip(safe(W, d), 0, None)
    den = d * (1 - sa)
    B = [np.clip(safe(a, den), 0, 1) for a in A]
    # Masks go shell, accent, paper, bottom to top; each one under the next covers a little less.
    x_paper = B[2]
    x_accent = np.clip(safe(B[1], 1 - x_paper), 0, 1)
    x_shell = np.clip(safe(B[0], 1 - B[2] - B[1]), 0, 1)
    layers = []
    ones = np.ones(alpha.shape + (3,))
    for name, x in (("shell", x_shell), ("accent", x_accent), ("paper", x_paper)):
        if x.max() > 0.5 / 255:
            save(os.path.join(out, head + "-" + name + ".webp"), ones, x)
            layers.append(name)
    gray = np.clip(safe(sc, sa), 0, 1)
    save(os.path.join(out, head + "-shade.webp"), np.dstack([gray] * 3), sa)
    layers.append("shade")
    if m_rest.max() > 0.5 / 255:
        save(os.path.join(out, head + "-rest.webp"), safe(rest, m_rest[..., None]), m_rest)
        layers.append("rest")
    # The colors closest to Original: per role, the target T that best gives back the path colors,
    # T·k + white = own, over the pixels the role fully covers.
    fitted = []
    for i in range(3):
        where = M[i] > 0.99
        if not where.any():
            fitted.append("#788449")  # no paths of this role: the kit's Terracotta accent, so the slot still has a color
            continue
        k = A[i][where] / M[i][where]
        off = W[where] / M[i][where]
        target = [float(np.sum(k * (own[..., c][where] / M[i][where] - off)) / max(np.sum(k * k), EPS)) * 255 for c in range(3)]
        fitted.append(hexof(target))
    report[head] = {"layers": layers, "own": fitted}
    sys.stderr.write("+")
sys.stderr.write("\n")
print(json.dumps(report))
