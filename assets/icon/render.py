"""Render the mailwarden icon (shield with an envelope inside) at any size.

The geometry lives on a 1000-unit grid and matches icon.svg; this renders it with Pillow,
supersampled, so that every PNG in this folder is the same shape. Run from the repo root:

    python assets/icon/render.py            # rewrites the PNGs here and .claude-plugin/icon.png
"""
import os
import sys

from PIL import Image, ImageDraw

SS = 4  # supersampling factor
BG = "#1E293B"  # slate ground
FG = "#FFFFFF"  # strokes


def quad(p0, p1, p2, n=200):
    return [
        ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0],
         (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1])
        for t in (i / n for i in range(n + 1))
    ]


def shield(cx, top, w, h):
    """Flat top, straight shoulders, curved to a bottom point — same path as icon.svg."""
    x0, x1 = cx - w / 2, cx + w / 2
    shoulder = top + h * 0.48
    bottom = (cx, top + h)
    pts = [(x0, top), (x1, top), (x1, shoulder)]
    pts += quad((x1, shoulder), (x1, top + h * 0.88), bottom)[1:]
    pts += quad(bottom, (x0, top + h * 0.88), (x0, shoulder))[1:]
    return pts + [(x0, top)]


def stroke(d, pts, width, fill, closed=True):
    if closed:
        pts = list(pts) + [pts[0]]
    d.line(pts, fill=fill, width=int(width), joint="curve")
    r = width / 2
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def render(size, bg=BG, fg=FG, ground=True):
    S = size * SS
    u = S / 1000.0
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if ground:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(220 * u), fill=bg)
    stroke(d, shield(500 * u, 150 * u, 620 * u, 700 * u), 58 * u, fg)
    x0, y0, x1, y1 = 330 * u, 360 * u, 670 * u, 590 * u
    stroke(d, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], 46 * u, fg)
    stroke(d, [(x0, y0), (500 * u, 500 * u), (x1, y0)], 46 * u, fg, closed=False)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    out = lambda name: os.path.join(here, name)
    render(1024).save(os.path.join(root, ".claude-plugin", "icon.png"))
    for s in (512, 1024, 2048):
        render(s).save(out(f"icon-{s}.png"))
    render(1024, fg="#1E293B", ground=False).save(out("glyph-slate.png"))
    render(1024, fg="#FFFFFF", ground=False).save(out("glyph-white.png"))
    # No favicon.ico: the plugin directory's validator cannot read an ICO and holds the plugin
    # for review over it. A page that wants one renders it from icon.svg on its own side.
    render(32).save(out("favicon-32.png"))
    render(180).save(out("apple-touch-icon.png"))
    print("rendered", file=sys.stderr)
