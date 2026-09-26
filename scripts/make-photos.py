"""Regenerates public/mock-photos/*.svg and src/data/mock/photoBoxes.ts.

The demo needs road photographs with potholes in them, and stock imagery brings
licensing questions a hackathon does not need. These are drawn procedurally:
asphalt noise, cracks, scattered debris and one irregular dark blob standing in
for the damage. The script also records each blob's bounding box, so the fake
detector in the reports screen can point at the damage that is really there —
a box floating over clean asphalt is the fastest way to lose an audience.

Deterministic: the seed is fixed, so re-running reproduces the same eight
images. Run with:  python scripts/make-photos.py
"""

import json
import math
import os
import random

random.seed(7)

OUT_IMAGES = "public/mock-photos"
OUT_BOXES = "src/data/mock/photoBoxes.ts"
COUNT = 8
WIDTH, HEIGHT = 800, 600

TEMPLATE = '''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <filter id="grain{i}"><feTurbulence type="fractalNoise" baseFrequency="{bf}" numOctaves="4" seed="{seed}"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="{grain}"/></feComponentTransfer></filter>
    <radialGradient id="hole{i}" cx="50%" cy="45%"><stop offset="0%" stop-color="#15171a"/><stop offset="60%" stop-color="#26292e"/><stop offset="100%" stop-color="#3b4046"/></radialGradient>
    <linearGradient id="light{i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.10"/><stop offset="100%" stop-color="#000000" stop-opacity="0.28"/></linearGradient>
  </defs>
  <rect width="800" height="600" fill="{asphalt}"/>
  <rect width="800" height="600" filter="url(#grain{i})" opacity="0.55"/>
  {marking}
  <g>{cracks}</g>
  <path d="{hole}" fill="url(#hole{i})"/>
  <path d="{hole}" fill="none" stroke="#0d0f11" stroke-opacity="0.75" stroke-width="3"/>
  {debris}
  <rect width="800" height="600" fill="url(#light{i})"/>
</svg>
'''


def blob(cx, cy, r, jitter, points=14):
    """An irregular closed polygon, wider than it is tall for perspective."""
    pts = []
    for k in range(points):
        a = 2 * math.pi * k / points
        rr = r * (1 + random.uniform(-jitter, jitter))
        pts.append((cx + rr * math.cos(a) * 1.25, cy + rr * math.sin(a) * 0.8))
    d = f"M {pts[0][0]:.0f} {pts[0][1]:.0f} "
    for k in range(1, len(pts)):
        d += f"L {pts[k][0]:.0f} {pts[k][1]:.0f} "
    return d + "Z", pts


def main():
    os.makedirs(OUT_IMAGES, exist_ok=True)
    boxes = []

    for i in range(1, COUNT + 1):
        asphalt = random.choice(["#4a4e54", "#53575d", "#45484d", "#5b5f66"])
        cx, cy = random.randint(280, 520), random.randint(250, 380)
        radius = random.randint(60, 130)

        cracks = ""
        for _ in range(random.randint(3, 7)):
            x, y = random.randint(0, WIDTH), random.randint(0, HEIGHT)
            path = f"M {x} {y} "
            for _ in range(random.randint(2, 5)):
                x += random.randint(-120, 120)
                y += random.randint(-90, 90)
                path += f"L {x} {y} "
            cracks += (
                f'<path d="{path}" fill="none" stroke="#2a2d31" '
                f'stroke-opacity="0.55" stroke-width="{random.choice([2, 3, 4])}" '
                'stroke-linecap="round"/>'
            )

        marking = ""
        if i % 3 == 0:
            marking = (
                f'<rect x="0" y="{random.randint(60, 140)}" width="800" height="14" '
                'fill="#d8d3c4" opacity="0.55"/>'
            )

        debris = ""
        for _ in range(random.randint(6, 14)):
            debris += (
                f'<circle cx="{cx + random.randint(-160, 160)}" '
                f'cy="{cy + random.randint(-110, 110)}" '
                f'r="{random.randint(2, 6)}" fill="#33363a" opacity="0.6"/>'
            )

        hole, points = blob(cx, cy, radius, 0.28)

        svg = TEMPLATE.format(
            i=i,
            bf=round(random.uniform(0.6, 0.95), 2),
            seed=random.randint(1, 99),
            grain=round(random.uniform(0.22, 0.4), 2),
            asphalt=asphalt,
            marking=marking,
            cracks=cracks,
            hole=hole,
            debris=debris,
        )

        with open(f"{OUT_IMAGES}/road-{i}.svg", "w", encoding="utf-8") as handle:
            handle.write(svg)

        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        pad = 12
        x0 = max(0, min(xs) - pad)
        x1 = min(WIDTH, max(xs) + pad)
        y0 = max(0, min(ys) - pad)
        y1 = min(HEIGHT, max(ys) + pad)

        boxes.append(
            {
                "x": round(x0 / WIDTH, 4),
                "y": round(y0 / HEIGHT, 4),
                "w": round((x1 - x0) / WIDTH, 4),
                "h": round((y1 - y0) / HEIGHT, 4),
            }
        )

    body = json.dumps(boxes, indent=2)
    for key in ("x", "y", "w", "h"):
        body = body.replace(f'"{key}"', key)

    with open(OUT_BOXES, "w", encoding="utf-8") as handle:
        handle.write(
            "/* Generated by scripts/make-photos.py — do not edit by hand.\n"
            " *\n"
            " * Each entry is the normalised bounding box of the damage actually drawn\n"
            " * in that image, so the fake detector points at something real.\n"
            " */\n\n"
            "export interface PhotoBox {\n"
            "  x: number\n"
            "  y: number\n"
            "  w: number\n"
            "  h: number\n"
            "}\n\n"
            f"export const PHOTO_BOXES: PhotoBox[] = {body}\n"
        )

    print(f"Wrote {COUNT} photos to {OUT_IMAGES} and boxes to {OUT_BOXES}")


if __name__ == "__main__":
    main()
