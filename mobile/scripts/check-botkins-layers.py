# The comparison half of scripts/check-botkins-layers.mjs (run that). Stacks each head's layers in
# the given colors with "over", as the phone does, and compares with the kit's render, in
# premultiplied 0-255 units per channel over every pixel of the picture.
import json, os, sys
import numpy as np
from PIL import Image

jobs = json.load(open(sys.argv[1]))
layers_dir = sys.argv[2]
MEAN_LIMIT = 0.5     # average difference over the whole picture
P999_LIMIT = 8.0     # 99.9% of pixels are at most this far off; the rest are edges


def load(path):
    rgba = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float64) / 255.0
    return rgba[..., :3] * rgba[..., 3:4], rgba[..., 3]


def rgb(hex_color):
    return np.array([int(hex_color[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float64) / 255.0


def over(color, alpha, top_color, top_alpha):
    return top_color + color * (1 - top_alpha[..., None]), top_alpha + alpha * (1 - top_alpha)


def stack(head, colors, shape):
    color, alpha = np.zeros(shape + (3,)), np.zeros(shape)
    for name, target in (("shell", colors[0]), ("accent", colors[1]), ("paper", colors[2]), ("shade", None), ("rest", None)):
        path = os.path.join(layers_dir, head + "-" + name + ".webp")
        if not os.path.exists(path):
            continue
        layer, layer_alpha = load(path)
        if target is not None:  # tintColor: the target color, the mask's alpha
            layer = rgb(target) * layer_alpha[..., None]
        color, alpha = over(color, alpha, layer, layer_alpha)
    return color, alpha


worst = {"mean": 0, "p999": 0, "max": 0}
failed = []
means = []
for job in jobs:
    ref, ref_alpha = load(job["reference"])
    color, alpha = stack(job["head"], job["colors"], ref_alpha.shape)
    diff = np.abs(np.dstack([color, alpha]) - np.dstack([ref, ref_alpha])) * 255
    per_pixel = diff.max(axis=2)
    mean, p999, peak = float(diff.mean()), float(np.percentile(per_pixel, 99.9)), float(per_pixel.max())
    means.append(mean)
    for key, value in (("mean", mean), ("p999", p999), ("max", peak)):
        if value > worst[key]:
            worst[key] = value
            worst[key + "_at"] = job["head"] + "/" + job["palette"]
    if mean > MEAN_LIMIT or p999 > P999_LIMIT:
        failed.append("%s/%s mean %.3f p99.9 %.2f max %.1f" % (job["head"], job["palette"], mean, p999, peak))

print("%d pictures (%d heads x 6 palettes), differences in 0-255 units per channel:" % (len(jobs), len(jobs) // 6))
print("  mean over all pictures   %.3f" % (sum(means) / len(means)))
print("  worst picture mean       %.3f  (%s)" % (worst["mean"], worst.get("mean_at")))
print("  worst 99.9th percentile  %.2f  (%s)" % (worst["p999"], worst.get("p999_at")))
print("  worst single pixel       %.1f  (%s)" % (worst["max"], worst.get("max_at")))
if failed:
    print("FAILED:\n  " + "\n  ".join(failed))
    sys.exit(1)
print("OK: limits mean %.1f, 99.9th percentile %.1f" % (MEAN_LIMIT, P999_LIMIT))
