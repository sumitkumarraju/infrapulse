"""Draws the PWA icons at public/icons/.

The mark is the app's own idea in one glyph: a road running to the horizon
with a bright pulse ring on it, in the cyan accent on the dark navy base. Drawn
here rather than exported from a design tool so the palette cannot drift from
src/design/tokens.css.

Run:  python scripts/make-icons.py
"""

import os

from PIL import Image, ImageDraw

VOID = (6, 11, 24)
ACCENT = (34, 211, 238)
ACCENT_BRIGHT = (103, 232, 249)
CRITICAL = (244, 63, 94)

OUT = "public/icons"
SIZES = [192, 512]


def draw(size: int, maskable: bool) -> Image.Image:
    # Maskable icons are cropped to a circle by the launcher, so everything
    # important has to sit inside the middle 80%.
    scale = 0.8 if maskable else 1.0
    image = Image.new("RGBA", (size, size), (*VOID, 255))
    canvas = ImageDraw.Draw(image)

    unit = size / 100
    center = size / 2

    def point(x: float, y: float) -> tuple[float, float]:
        return (center + (x - 50) * unit * scale, center + (y - 50) * unit * scale)

    # The road: a trapezoid narrowing toward the horizon.
    canvas.polygon(
        [point(18, 92), point(42, 26), point(58, 26), point(82, 92)],
        fill=(17, 26, 48, 255),
    )

    # Centre line, dashed, fading with distance.
    for i, (y0, y1) in enumerate([(86, 74), (68, 58), (53, 45), (41, 35)]):
        fade = 1 - i * 0.2
        width = max(1, int(unit * 3.4 * fade * scale))
        canvas.line(
            [point(50, y0), point(50, y1)],
            fill=(*ACCENT, int(230 * fade)),
            width=width,
        )

    # The pothole, and the pulse rings reading it. Each ring goes on its own
    # transparent layer: ImageDraw writes RGBA straight into the buffer rather
    # than blending, so drawing them directly would make every ring equally
    # opaque and lose the fade that makes it read as a pulse.
    canvas.ellipse([point(43, 60), point(57, 70)], fill=(*CRITICAL, 255))

    for radius, alpha in ((11, 190), (17, 105), (23, 55)):
        ring = Image.new("RGBA", image.size, (0, 0, 0, 0))
        ImageDraw.Draw(ring).ellipse(
            [
                point(50 - radius, 65 - radius * 0.6),
                point(50 + radius, 65 + radius * 0.6),
            ],
            outline=(*ACCENT_BRIGHT, alpha),
            width=max(1, int(unit * 1.3 * scale)),
        )
        image = Image.alpha_composite(image, ring)

    return image


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        draw(size, maskable=False).save(f"{OUT}/icon-{size}.png")
    draw(512, maskable=True).save(f"{OUT}/icon-maskable-512.png")
    draw(180, maskable=False).save(f"{OUT}/apple-touch-icon.png")
    print(f"Wrote icons to {OUT}")


if __name__ == "__main__":
    main()
