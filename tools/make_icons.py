"""Generate the app icon set as PNGs. No third-party dependencies.

Renders a rounded-square gradient tile with a house roofline over an audio
waveform, supersampled 3x for smooth edges, then writes each required size.

Usage:  python tools/make_icons.py
"""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")
MARKETING_DIR = os.path.join(ROOT, "marketing")

# Sizes the manifest, the browser and PWABuilder/MSIX want.
SIZES = {
    "icon-32.png": 32,
    "icon-44.png": 44,
    "icon-48.png": 48,
    "icon-71.png": 71,
    "icon-150.png": 150,
    "icon-192.png": 192,
    "icon-256.png": 256,
    "icon-284.png": 284,
    # 1:1 App tile icon for the Store listing; Partner Center prefers this
    # over the icon inside the package when supplied.
    "store-tile-300.png": 300,
    "icon-512.png": 512,
    "icon-1024.png": 1024,
}

SS = 3  # supersampling factor
BASE = 512  # master render size

TOP = (0x5B, 0x5B, 0xF6)      # indigo
BOTTOM = (0x0E, 0xA5, 0xB5)   # teal
INK = (0xFF, 0xFF, 0xFF)


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect_contains(x, y, w, h, r):
    """True if (x, y) is inside a w*h rounded rectangle with corner radius r."""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def render(size, maskable):
    """Render one RGBA image at `size`, supersampled. Returns bytes rows."""
    n = size * SS
    # geometry, in supersampled units
    radius = n * (0.0 if maskable else 0.22)
    # maskable icons need their content inside the safe zone (inner 80%)
    inset = n * 0.10 if maskable else 0.0
    cw = n - 2 * inset

    # waveform bars: (x_centre_fraction, height_fraction) across the tile
    bars = [(-0.28, 0.15), (-0.14, 0.26), (0.0, 0.34), (0.14, 0.23), (0.28, 0.13)]
    bar_w = cw * 0.076
    bar_r = bar_w / 2.0
    baseline = inset + cw * 0.775      # bottom of the bars
    roof_y = inset + cw * 0.195        # apex of the roof
    roof_half = cw * 0.315             # half-width of the roof
    roof_thick = cw * 0.062
    eaves_y = inset + cw * 0.365

    acc = bytearray(size * size * 4)

    for py in range(size):
        for px in range(size):
            r_sum = g_sum = b_sum = a_sum = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    x = px * SS + sx + 0.5
                    y = py * SS + sy + 0.5

                    if not maskable and not rounded_rect_contains(x, y, n, n, radius):
                        continue

                    t = y / n
                    br = lerp(TOP[0], BOTTOM[0], t)
                    bg = lerp(TOP[1], BOTTOM[1], t)
                    bb = lerp(TOP[2], BOTTOM[2], t)

                    # subtle diagonal sheen
                    sheen = max(0.0, 1.0 - ((x / n) + (y / n)))
                    br = min(255.0, br + sheen * 22)
                    bg = min(255.0, bg + sheen * 22)
                    bb = min(255.0, bb + sheen * 22)

                    ink = False

                    # waveform bars (rounded capsules standing on the baseline)
                    for frac_x, frac_h in bars:
                        bx = inset + cw * 0.5 + cw * frac_x
                        bh = cw * frac_h
                        top = baseline - bh
                        if abs(x - bx) <= bar_r:
                            if top + bar_r <= y <= baseline - bar_r:
                                ink = True
                                break
                            for cy in (top + bar_r, baseline - bar_r):
                                dx, dy = x - bx, y - cy
                                if dx * dx + dy * dy <= bar_r * bar_r:
                                    ink = True
                                    break
                            if ink:
                                break

                    # roofline: two strokes meeting at the apex
                    if not ink and roof_y - roof_thick <= y <= eaves_y:
                        cx = inset + cw * 0.5
                        span = eaves_y - roof_y
                        # distance from the point to each roof edge, measured
                        # vertically then scaled to a perpendicular width
                        slope = span / roof_half
                        norm = math.sqrt(1.0 + slope * slope)
                        edge_y = roof_y + abs(x - cx) * slope
                        if abs(x - cx) <= roof_half + roof_thick:
                            if abs(y - edge_y) * (1.0 / norm) <= roof_thick * 0.5:
                                ink = True

                    if ink:
                        r_sum += INK[0]
                        g_sum += INK[1]
                        b_sum += INK[2]
                    else:
                        r_sum += br
                        g_sum += bg
                        b_sum += bb
                    a_sum += 255.0

            total = SS * SS
            if a_sum == 0:
                continue
            # premultiplied-safe average: colour over covered samples only
            covered = a_sum / 255.0
            idx = (py * size + px) * 4
            acc[idx] = int(round(r_sum / covered))
            acc[idx + 1] = int(round(g_sum / covered))
            acc[idx + 2] = int(round(b_sum / covered))
            acc[idx + 3] = int(round(a_sum / total))

    return bytes(acc)


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size in sorted(SIZES.items(), key=lambda kv: kv[1]):
        rgba = render(size, maskable=False)
        write_png(os.path.join(OUT_DIR, name), size, rgba)
        print("wrote", name, size)

    rgba = render(512, maskable=True)
    write_png(os.path.join(OUT_DIR, "icon-maskable-512.png"), 512, rgba)
    print("wrote icon-maskable-512.png 512")

    # Partner/ISV listing logos. 300x300 sits inside the usual 216-350 square
    # range. Two variants: the app's own rounded mark (transparent corners),
    # and a full-bleed square for forms that dislike transparency.
    os.makedirs(MARKETING_DIR, exist_ok=True)
    write_png(os.path.join(MARKETING_DIR, "logo-300.png"), 300,
              render(300, maskable=False))
    print("wrote marketing/logo-300.png 300")
    write_png(os.path.join(MARKETING_DIR, "logo-300-square.png"), 300,
              render(300, maskable=True))
    print("wrote marketing/logo-300-square.png 300")


if __name__ == "__main__":
    main()
