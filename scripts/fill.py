#!/usr/bin/env python3
"""Body fill per slide: how much of each frame's body height the content spans.

  python3 scripts/fill.py deck.pdf [theme]

The theme defaults to the one named in theme.tex next to the PDF. Each page is rendered with pdftoppm,
the background is the most common colour on the page, and a pixel is content when a channel differs from
it by more than 40 (so trigon's pale corner triangle and chart grid lines don't count). Fill is the height
of the content's bounding box inside the body band, as a share of that band. Page 1 (the title) is skipped.
"""
import re, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

PDFTOPPM = '/opt/homebrew/bin/pdftoppm'
# body band (top, bottom) as fractions of page height: below the frame title, above the footline.
# Measured from a frame holding a rule at its top and another pushed to its foot with \vfill,
# under a one-line frame title; re-measure after changing a theme's title bar or footline.
BODY = {
    'paper': (0.229, 0.920), 'midnight': (0.292, 0.912), 'metropolis': (0.205, 0.898),
    'moloch': (0.215, 0.933), 'focus': (0.209, 0.928), 'trigon': (0.239, 0.918), 'madrid': (0.198, 0.928),
}
DPI, TOL = 72, 40


def fill(img, top, bottom):
    img = img.convert('RGB')
    w, h = img.size
    bg = max(img.getcolors(w * h), key=lambda c: c[0])[1]
    y0, y1 = round(top * h), round(bottom * h)
    px = img.load()
    rows = [y for y in range(y0, y1)
            if any(max(abs(a - b) for a, b in zip(px[x, y], bg)) > TOL for x in range(w))]
    return (rows[-1] - rows[0] + 1) / (y1 - y0) if rows else 0.0


def main():
    pdf = Path(sys.argv[1])
    theme = sys.argv[2] if len(sys.argv) > 2 else None
    if not theme:
        m = re.search(r'devreport-([a-z]+)\}', (pdf.parent / 'theme.tex').read_text())
        theme = m and m.group(1)
    if theme not in BODY:
        sys.exit(f'unknown theme {theme!r}: pass one of {", ".join(BODY)}')
    with tempfile.TemporaryDirectory() as d:
        subprocess.run([PDFTOPPM, '-r', str(DPI), '-png', str(pdf), f'{d}/p'], check=True)
        pages = sorted(Path(d).glob('p-*.png'), key=lambda p: int(p.stem.split('-')[1]))
        res = [fill(Image.open(p), *BODY[theme]) for p in pages[1:]]
    print(theme, ' '.join(f'{i + 2}:{r:.0%}' for i, r in enumerate(res)), f'min {min(res):.0%}' if res else '')


if __name__ == '__main__':
    # self-check: a block spanning the middle half of the band reads as 50%
    t = Image.new('RGB', (100, 100), 'white')
    t.paste((0, 0, 0), (10, 25, 90, 75))
    assert abs(fill(t, 0.0, 1.0) - 0.5) < 0.02
    main()
