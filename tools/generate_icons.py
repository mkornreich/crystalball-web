"""Generate the add-in's ribbon/task-pane icons (a stylized crystal ball).

Usage: python3 tools/generate_icons.py
Writes assets/icon-16.png, icon-32.png, icon-64.png, icon-80.png.
"""
import os
from PIL import Image, ImageDraw

SIZES = [16, 32, 64, 80]
OUT = os.path.join(os.path.dirname(__file__), "..", "assets")


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size):
    # Supersample for smooth edges.
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-rect background with a vertical purple->blue gradient.
    top = (91, 63, 214)
    bot = (46, 124, 214)
    radius = int(s * 0.22)
    bg = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bgd = ImageDraw.Draw(bg)
    for y in range(s):
        bgd.line([(0, y), (s, y)], fill=lerp(top, bot, y / s) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.paste(bg, (0, 0), mask)

    # Crystal ball: a soft white sphere with a highlight.
    cx, cy, r = s * 0.5, s * 0.46, s * 0.30
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(245, 248, 255, 255))
    d.ellipse(
        [cx - r * 0.55, cy - r * 0.6, cx + r * 0.1, cy + r * 0.05],
        fill=(255, 255, 255, 230),
    )
    # Base stand.
    d.polygon(
        [
            (cx - r * 0.7, cy + r * 0.78),
            (cx + r * 0.7, cy + r * 0.78),
            (cx + r * 0.45, cy + r * 1.08),
            (cx - r * 0.45, cy + r * 1.08),
        ],
        fill=(30, 36, 60, 255),
    )

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f"icon-{size}.png")
        make(size).save(path)
        print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
