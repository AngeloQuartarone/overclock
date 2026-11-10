// Minimal QR code generator for the game links: a line-by-line port of qr.py, keep the two in sync
// (same version choice, masks and penalties, so svg() returns exactly the same string as qr.py's svg()).
// Byte mode on UTF-8 text, error correction level M (about 15% of damaged modules), versions 1 to 10:
// up to 213 bytes. Steps from ISO/IEC 18004: data, Reed-Solomon correction, fixed patterns,
// zig-zag data, mask with the lowest penalty, format and version information.

// per version, at level M: [number of blocks, correction codewords per block]
const ECC_M = { 1: [1, 10], 2: [1, 16], 3: [1, 26], 4: [2, 18], 5: [2, 24],
  6: [4, 16], 7: [4, 18], 8: [4, 22], 9: [5, 22], 10: [5, 26] };
const MASKS = [
  (x, y) => (x + y) % 2,
  (x, y) => y % 2,
  (x, y) => x % 3,
  (x, y) => (x + y) % 3,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2,
  (x, y) => x * y % 2 + x * y % 3,
  (x, y) => (x * y % 2 + x * y % 3) % 2,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2,
];

// modules left for data and correction once the fixed ones are removed
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const k = Math.floor(ver / 7) + 2;
    n -= (25 * k - 10) * k - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

// product in GF(256) with the polynomial 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >> 7) * 0x11d);
    z ^= ((y >> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const res = new Array(degree).fill(0);
  res[degree - 1] = 1;
  let root = 1;
  for (let k = 0; k < degree; k++) {
    for (let j = 0; j < degree; j++) {
      res[j] = gfMul(res[j], root);
      if (j + 1 < degree) res[j] ^= res[j + 1];
    }
    root = gfMul(root, 2);
  }
  return res;
}

function rsRemainder(data, divisor) {
  const res = new Array(divisor.length).fill(0);
  for (const b of data) {
    const f = b ^ res.shift();
    res.push(0);
    divisor.forEach((c, i) => { res[i] ^= gfMul(c, f); });
  }
  return res;
}

// picks the smallest version and returns [version, interleaved codewords]
function codewords(data) {
  let ver, blocksN, eccN, raw, cap, countBits;
  for (ver = 1; ver <= 10; ver++) {
    [blocksN, eccN] = ECC_M[ver];
    raw = Math.floor(rawModules(ver) / 8);
    cap = raw - blocksN * eccN;
    countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + 8 * data.length <= cap * 8) break;
  }
  if (ver > 10) throw new Error('testo troppo lungo per il QR code');

  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(0b0100, 4);                                                     // byte mode
  put(data.length, countBits);
  for (const b of data) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));                         // terminator
  put(0, (8 - bits.length % 8) % 8);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((w, b) => w << 1 | b, 0));
  for (let pad = 0xec; words.length < cap; pad ^= 0xec ^ 0x11) words.push(pad);

  // split into blocks (the last ones get one more data codeword), correction per block, then interleave
  const shortN = blocksN - raw % blocksN;
  const shortLen = Math.floor(raw / blocksN);
  const div = rsDivisor(eccN);
  const blocks = [];
  for (let i = 0, k = 0; i < blocksN; i++) {
    const n = shortLen - eccN + (i < shortN ? 0 : 1);
    const dat = words.slice(k, k + n);
    k += n;
    const ecc = rsRemainder(dat, div);
    if (i < shortN) dat.push(0);                                      // placeholder, skipped when interleaving
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => { if (i !== shortLen - eccN || j >= shortN) out.push(blk[i]); });
  }
  return [ver, out];
}

function drawFormat(put, size, mask) {
  const data = mask;                                                  // level M = 00, then the mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = (data << 10 | rem) ^ 0x5412;
  const bit = i => ((bits >> i) & 1) === 1;
  for (let i = 0; i < 6; i++) put(8, i, bit(i));
  put(8, 7, bit(6));
  put(8, 8, bit(7));
  put(7, 8, bit(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
  put(8, size - 8, true);                                             // the always-dark module
}

const count = (s, sub) => s.split(sub).length - 1;                    // non-overlapping, like str.count

function penalty(m) {
  const n = m.length;
  let p = 0;
  const lines = m.concat(m[0].map((_, x) => m.map(row => row[x])));  // rows and columns
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) p += run - 2;
        run = 1;
      }
    }
    if (run >= 5) p += run - 2;
    const s = line.map(v => (v ? '1' : '0')).join('');
    p += 40 * (count(s, '10111010000') + count(s, '00001011101'));    // looks like a finder
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  p += 10 * Math.floor(Math.abs(Math.floor(dark * 100 / (n * n)) - 50) / 5);
  return p;
}

// QR code matrix: array of rows of booleans, m[y][x] === true means a dark module
export function encode(text) {
  const [ver, data] = codewords(new TextEncoder().encode(text));
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const setf = (x, y, dark) => {
    m[y][x] = dark;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {                                    // timing lines
    setf(6, i, i % 2 === 0);
    setf(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {    // the three finders, with light border
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) setf(x, y, d !== 2 && d !== 4);
      }
    }
  }
  if (ver > 1) {                                                      // alignment
    const n = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 4 + n * 2 + 1) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let i = n - 2; i >= 0; i--) pos.push(size - 7 - i * step);
    pos.forEach((ay, i) => pos.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setf(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));
  }
  drawFormat(setf, size, 0);                                          // for now just reserves the cells
  if (ver >= 7) {                                                     // version information
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = ver << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >> i) & 1) === 1;
      const a = size - 11 + i % 3, c = Math.floor(i / 3);
      setf(a, c, b);
      setf(c, a, b);
    }
  }

  const total = data.length * 8;                                      // zig-zag data, two columns at a time
  let i = 0;
  for (let r = size - 1; r > 0; r -= 2) {
    const right = r <= 6 ? r - 1 : r;                                 // skip the timing column
    const up = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = up ? size - 1 - vert : vert;
      for (const x of [right, right - 1]) {
        if (!fixed[y][x] && i < total) {
          m[y][x] = ((data[i >> 3] >> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = m.map(row => row.slice());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fixed[y][x] && MASKS[mask](x, y) === 0) cand[y][x] = !cand[y][x];
      }
    }
    drawFormat((x, y, d) => { cand[y][x] = d; }, size, mask);
    const p = penalty(cand);
    if (best === null || p < best[0]) best = [p, cand];
  }
  return best[1];
}

// QR code as SVG, black on white with the light margin around it
export function svg(text, quiet = 4) {
  const m = encode(text);
  const n = m.length + 2 * quiet;
  let d = '';
  m.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x]) {
        const s = x;
        while (x < row.length && row[x]) x++;
        d += `M${s + quiet} ${y + quiet}h${x - s}v1h-${x - s}z`;
      } else {
        x++;
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
