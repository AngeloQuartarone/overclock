"""QR code minimo, solo libreria standard, per i link del gioco.

Modalità byte, correzione d'errore M (regge circa il 15% di moduli rovinati), versioni da 1 a 10: fino a 213 byte,
più che abbastanza per un indirizzo come http://192.168.1.28:8765/?sfida=ABCDE.
I passi sono quelli dello standard ISO/IEC 18004: dati, correzione d'errore Reed-Solomon, moduli fissi,
dati a zig-zag, maschera con meno penalità, informazioni di formato e di versione.
"""

# per ogni versione, al livello M: (numero di blocchi, codeword di correzione per blocco)
ECC_M = {1: (1, 10), 2: (1, 16), 3: (1, 26), 4: (2, 18), 5: (2, 24),
         6: (4, 16), 7: (4, 18), 8: (4, 22), 9: (5, 22), 10: (5, 26)}
MASKS = (
    lambda x, y: (x + y) % 2,
    lambda x, y: y % 2,
    lambda x, y: x % 3,
    lambda x, y: (x + y) % 3,
    lambda x, y: (x // 3 + y // 2) % 2,
    lambda x, y: x * y % 2 + x * y % 3,
    lambda x, y: (x * y % 2 + x * y % 3) % 2,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2,
)


def _raw_modules(ver):
    """Moduli liberi per dati e correzione, tolti quelli fissi."""
    n = (16 * ver + 128) * ver + 64
    if ver >= 2:
        k = ver // 7 + 2
        n -= (25 * k - 10) * k - 55
        if ver >= 7:
            n -= 36
    return n


def _gf_mul(x, y):
    """Prodotto nel campo GF(256) con il polinomio 0x11D."""
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree):
    res = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            res[j] = _gf_mul(res[j], root)
            if j + 1 < degree:
                res[j] ^= res[j + 1]
        root = _gf_mul(root, 2)
    return res


def _rs_remainder(data, divisor):
    res = [0] * len(divisor)
    for b in data:
        f = b ^ res.pop(0)
        res.append(0)
        for i, c in enumerate(divisor):
            res[i] ^= _gf_mul(c, f)
    return res


def _codewords(data):
    """Sceglie la versione più piccola e restituisce (versione, codeword già intrecciate)."""
    for ver in range(1, 11):
        blocks_n, ecc_n = ECC_M[ver]
        raw = _raw_modules(ver) // 8
        cap = raw - blocks_n * ecc_n
        count_bits = 8 if ver <= 9 else 16
        if 4 + count_bits + 8 * len(data) <= cap * 8:
            break
    else:
        raise ValueError('testo troppo lungo per il QR code')

    bits = []
    def put(val, n):
        bits.extend((val >> i) & 1 for i in reversed(range(n)))
    put(0b0100, 4)                                                          # modalità byte
    put(len(data), count_bits)
    for b in data:
        put(b, 8)
    put(0, min(4, cap * 8 - len(bits)))                                     # terminatore
    put(0, -len(bits) % 8)
    words = [int(''.join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(words) < cap:
        words.append(pad)
        pad ^= 0xEC ^ 0x11

    # divisione in blocchi (gli ultimi hanno una codeword di dati in più), correzione per blocco, poi intreccio
    short_n = blocks_n - raw % blocks_n
    short_len = raw // blocks_n
    div = _rs_divisor(ecc_n)
    blocks, k = [], 0
    for i in range(blocks_n):
        n = short_len - ecc_n + (0 if i < short_n else 1)
        dat = words[k:k + n]
        k += n
        ecc = _rs_remainder(dat, div)
        if i < short_n:
            dat.append(0)                                                   # segnaposto, saltato nell'intreccio
        blocks.append(dat + ecc)
    out = []
    for i in range(len(blocks[0])):
        for j, blk in enumerate(blocks):
            if i != short_len - ecc_n or j >= short_n:
                out.append(blk[i])
    return ver, out


def _draw_format(put, size, mask):
    data = mask                                                             # livello M = 00, poi la maschera
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    bits = (data << 10 | rem) ^ 0x5412
    bit = lambda i: (bits >> i) & 1 == 1
    for i in range(6):
        put(8, i, bit(i))
    put(8, 7, bit(6))
    put(8, 8, bit(7))
    put(7, 8, bit(8))
    for i in range(9, 15):
        put(14 - i, 8, bit(i))
    for i in range(8):
        put(size - 1 - i, 8, bit(i))
    for i in range(8, 15):
        put(8, size - 15 + i, bit(i))
    put(8, size - 8, True)                                                  # il modulo sempre scuro


def _penalty(m):
    n, p = len(m), 0
    for line in m + [list(col) for col in zip(*m)]:                         # righe e colonne
        run = 1
        for i in range(1, n):
            if line[i] == line[i - 1]:
                run += 1
            else:
                if run >= 5:
                    p += run - 2
                run = 1
        if run >= 5:
            p += run - 2
        s = ''.join('1' if v else '0' for v in line)
        p += 40 * (s.count('10111010000') + s.count('00001011101'))         # sembra un mirino
    for y in range(n - 1):
        for x in range(n - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                p += 3
    dark = sum(map(sum, m))
    p += 10 * (abs(dark * 100 // (n * n) - 50) // 5)
    return p


def encode(text):
    """Matrice del QR code: righe di booleani, True = modulo scuro."""
    ver, data = _codewords(text.encode('utf-8'))
    size = ver * 4 + 17
    m = [[False] * size for _ in range(size)]
    fixed = [[False] * size for _ in range(size)]

    def setf(x, y, dark):
        m[y][x] = dark
        fixed[y][x] = True

    for i in range(size):                                                   # linee di temporizzazione
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):                  # i tre mirini, con il bordo chiaro
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    if ver > 1:                                                             # allineamento
        n = ver // 7 + 2
        step = (ver * 4 + n * 2 + 1) // (n * 2 - 2) * 2
        pos = [6] + sorted(size - 7 - i * step for i in range(n - 1))
        for i, ay in enumerate(pos):
            for j, ax in enumerate(pos):
                if (i, j) in ((0, 0), (0, n - 1), (n - 1, 0)):
                    continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        setf(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)
    _draw_format(setf, size, 0)                                             # per ora prenota solo le celle
    if ver >= 7:                                                            # informazioni di versione
        rem = ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = ver << 12 | rem
        for i in range(18):
            b = (bits >> i) & 1 == 1
            a, c = size - 11 + i % 3, i // 3
            setf(a, c, b)
            setf(c, a, b)

    i, total = 0, len(data) * 8                                             # dati a zig-zag, due colonne alla volta
    for right in range(size - 1, 0, -2):
        if right <= 6:
            right -= 1                                                      # salta la colonna di temporizzazione
        up = ((right + 1) & 2) == 0
        for vert in range(size):
            y = size - 1 - vert if up else vert
            for x in (right, right - 1):
                if not fixed[y][x] and i < total:
                    m[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1

    best = None
    for mask in range(8):
        cand = [row[:] for row in m]
        for y in range(size):
            for x in range(size):
                if not fixed[y][x] and MASKS[mask](x, y) == 0:
                    cand[y][x] = not cand[y][x]
        _draw_format(lambda x, y, d: cand[y].__setitem__(x, d), size, mask)
        p = _penalty(cand)
        if best is None or p < best[0]:
            best = (p, cand)
    return best[1]


def svg(text, quiet=4):
    """QR code in SVG, nero su bianco con il margine chiaro attorno."""
    m = encode(text)
    n = len(m) + 2 * quiet
    d = []
    for y, row in enumerate(m):
        x = 0
        while x < len(row):
            if row[x]:
                s = x
                while x < len(row) and row[x]:
                    x += 1
                d.append(f'M{s + quiet} {y + quiet}h{x - s}v1h-{x - s}z')
            else:
                x += 1
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges">'
            f'<rect width="{n}" height="{n}" fill="#fff"/><path d="{"".join(d)}" fill="#000"/></svg>')


def terminal(text, quiet=4):
    """QR code da stampare nel terminale: due moduli per carattere, nero su bianco forzato con i colori ANSI."""
    m = encode(text)
    size, n = len(m), len(m) + 2 * quiet
    dark = lambda x, y: 0 <= x - quiet < size and 0 <= y - quiet < size and m[y - quiet][x - quiet]
    lines = []
    for y in range(0, n, 2):
        row = ''.join('█' if dark(x, y) and dark(x, y + 1) else '▀' if dark(x, y) else '▄' if dark(x, y + 1) else ' '
                      for x in range(n))
        lines.append(f'\033[38;5;16;48;5;231m{row}\033[0m')
    return '\n'.join(lines)


if __name__ == '__main__':
    import sys
    print(terminal(sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/'))
