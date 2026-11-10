#!/usr/bin/env python3
"""Generate the Overclock app icons (pure stdlib: PNGs written with zlib + struct).

The artwork is a pixel-art processor drawn on a 31x31 grid (odd, so the chip, its pin rows and the
"OC" lettering all centre on a real pixel column), then scaled by an integer factor with
nearest-neighbour and centred on a navy tile. Palette and 5x7 glyphs come from the game
(index.html CSS variables, js/scene.js PAL, js/font.js).

    python3 tools/make_icons.py            # writes icons/*.png next to this repo
    python3 tools/make_icons.py OUT_DIR    # writes somewhere else
"""
import os
import struct
import sys
import zlib

# --- palette (index.html :root, js/scene.js PAL) --------------------------------------------------
BG = '#0a0f24'        # --bg
INK = '#05081a'       # --ink / outlines
LINE = '#2b3264'      # --line (panel borders)
PKG = '#262c66'       # package body
PKG_HI = '#3a43a0'    # lit edge of the package
PKG_LO = '#1b2348'    # shaded edge of the package
DIE = '#313a8c'       # silicon
SEAL = '#5059b4'      # seal ring around the die
PIN_HI = '#ffd877'    # pin tip (bond gold)
PIN = '#ffc75a'       # pin
PIN_LO = '#d69a3a'    # pin shoulder, against the body
ORANGE = '#ff8a2a'    # --orange: title colour, pin-1 dot
GOLD = '#ffd23a'      # --gold
CYAN = '#3fd6ff'      # --cyan: lit bits
CYAN_LO = '#1d4f8f'   # unlit bits

# 5x7 glyphs, copied from js/font.js
GLYPHS = {
    'O': '.###. #...# #...# #...# #...# #...# .###.',
    'C': '.###. #...# #.... #.... #.... #...# .###.',
}

N = 31          # art grid
C = N // 2      # centre column / row (15)


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def art():
    """Return the 31x31 artwork as a list of rows of '#rrggbb' or None (= tile background)."""
    g = [[None] * N for _ in range(N)]

    def rect(x0, y0, x1, y1, col):        # inclusive bounds
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                g[y][x] = col

    B0, B1 = 5, 25                        # package body (outline included)
    PIN_POS = range(7, 24, 2)             # 9 pins per side, 1 px wide, 1 px apart, centred on 15

    # pins on the four sides: shoulder (dark) against the body, then pin, then a bright tip
    for p in PIN_POS:
        for d, col in ((1, PIN_LO), (2, PIN), (3, PIN_HI)):
            g[B0 - d][p] = col            # top
            g[B1 + d][p] = col            # bottom
            g[p][B0 - d] = col            # left
            g[p][B1 + d] = col            # right

    # package: ink outline, body, lit top-left edge, shaded bottom-right edge
    rect(B0, B0, B1, B1, INK)
    rect(B0 + 1, B0 + 1, B1 - 1, B1 - 1, PKG)
    rect(B0 + 1, B0 + 1, B1 - 1, B0 + 1, PKG_HI)
    rect(B0 + 1, B0 + 1, B0 + 1, B1 - 1, PKG_HI)
    rect(B0 + 1, B1 - 1, B1 - 1, B1 - 1, PKG_LO)
    rect(B1 - 1, B0 + 1, B1 - 1, B1 - 1, PKG_LO)
    g[B0 + 2][B0 + 2] = ORANGE            # pin-1 marker, as on the game's packages

    # die with its seal ring
    D0, D1 = 8, 22
    rect(D0, D0, D1, D1, SEAL)
    rect(D0 + 1, D0 + 1, D1 - 1, D1 - 1, DIE)

    # "OC" in the game's 5x7 font, orange like the OVERCLOCK title
    text = 'OC'
    tw = len(text) * 6 - 1
    tx, ty = C - tw // 2, 11
    on = []
    for i, ch in enumerate(text):
        bits = GLYPHS[ch].replace(' ', '')
        for k, b in enumerate(bits):
            if b == '#':
                on.append((tx + i * 6 + k % 5, ty + k // 5))
    for x, y in on:
        g[y][x] = ORANGE

    # a register of 6 bits under the lettering: the bits that just arrived
    for i, lit in enumerate((1, 0, 1, 1, 0, 1)):
        g[19][C - 5 + 2 * i] = CYAN if lit else CYAN_LO
    return g


# --- PNG ------------------------------------------------------------------------------------------
def png(path, w, h, px, alpha=True):
    """px: function (x, y) -> (r, g, b, a). Writes an 8-bit RGBA (or RGB) non-interlaced PNG."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)                     # filter: none
        for x in range(w):
            p = px(x, y)
            raw.extend(p if alpha else p[:3])

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6 if alpha else 2, 0, 0, 0)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(data)


def render(path, size, scale, tile='round', alpha=True):
    """Scale the art by `scale` (nearest neighbour) onto a size x size canvas.

    tile='round': the canvas is a 32x32 grid of art pixels (size == 32 * scale). A 31x31 navy tile with
                  stepped pixel corners and a --line border holds the art, and casts a hard 1-cell ink
                  shadow down-right, like the menu panels in the game. Transparent outside.
    tile='full':  full-bleed navy, art centred (maskable / apple-touch: the OS applies its own mask).
    """
    g = art()
    bg, line, ink, clear = rgb(BG) + (255,), rgb(LINE) + (255,), rgb(INK) + (255,), (0, 0, 0, 0)

    if tile == 'full':
        off = (size - N * scale) // 2

        def px(x, y):
            ax, ay = x - off, y - off
            if 0 <= ax < N * scale and 0 <= ay < N * scale and g[ay // scale][ax // scale]:
                return rgb(g[ay // scale][ax // scale]) + (255,)
            return bg
    else:
        assert size == 32 * scale, (size, scale)
        steps = (3, 1, 1)                 # stepped corner: the first rows/cols are indented by 3, 1, 1 cells

        def in_tile(cx, cy):              # cell inside the 31x31 tile?
            if not (0 <= cx < N and 0 <= cy < N):
                return False
            ex, ey = min(cx, N - 1 - cx), min(cy, N - 1 - cy)
            return not (ey < len(steps) and ex < steps[ey])

        def edge(cx, cy):                 # cell on the tile's (stepped) outline?
            return any(not in_tile(cx + dx, cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1))

        def px(x, y):
            cx, cy = x // scale, y // scale
            if in_tile(cx, cy):
                if g[cy][cx]:
                    return rgb(g[cy][cx]) + (255,)
                return line if edge(cx, cy) else bg
            return ink if in_tile(cx - 1, cy - 1) else clear

    png(path, size, size, px, alpha)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out, exist_ok=True)
    jobs = [
        ('favicon-32.png', 32, 1, 'round', True),
        ('icon-192.png', 192, 6, 'round', True),
        ('icon-512.png', 512, 16, 'round', True),
        ('icon-maskable-512.png', 512, 12, 'full', True),    # 372 px of art inside the 410 px safe circle
        ('apple-touch-icon.png', 180, 5, 'full', False),     # iOS: opaque, it rounds the corners itself
    ]
    for name, size, scale, tile, alpha in jobs:
        path = os.path.join(out, name)
        render(path, size, scale, tile, alpha)
        print(f'{os.path.normpath(path)}  {size}x{size}  art x{scale}')


if __name__ == '__main__':
    main()
