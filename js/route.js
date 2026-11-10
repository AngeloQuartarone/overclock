// Percorsi a tratti ortogonali su cui corrono i bit, un generatore pseudo-casuale con seme
// e gli attrezzi comuni per disegnare un core.
// Un percorso ricorda lo strato su cui sta: 'd' dati, 'c' controllo, 'w' linee di parola.

export function makeRoute(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]));
  }
  return { pts, cum, len: cum[cum.length - 1], layer: pts.layer || 'd' };
}

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Il foglio su cui si disegna un core. Unità: tracce; x nel verso del flusso, y verso il fondo del chip.
// - piste: data/ctrl/word aggiungono una pista disegnata (e i via sugli angoli) e restituiscono i punti;
// - ff: un latch (o un bit di registro) che il clock fa scattare; reg dice a quale registro appartiene;
// - logic: un blocco di logica (kind: fill, logic, dec, sense, alu…), con il seme della sua trama;
// - cache: percorsi calcolati la prima volta che servono (per esempio "dal registro r, bit b").
export function createLayout(W, H) {
  const C = {
    W, H, wires: [], ctrl: [], words: [], vias: [], logic: [], arrays: {}, ffs: [], foot: [],
    P: {}, blocks: {}, g: {}, regs: {}, clock: { segs: [], at: () => 0 },
  };
  const add = (list, pts, layer) => {
    pts.layer = layer;
    list.push(pts);
    for (let i = 1; i < pts.length - 1; i++) C.vias.push([pts[i][0], pts[i][1], layer]);
    return pts;
  };
  return {
    C,
    data: pts => add(C.wires, pts, 'd'),
    ctrl: pts => add(C.ctrl, pts, 'c'),
    word: pts => add(C.words, pts, 'w'),
    ff: (reg, x, y, h, o = {}) => { const f = { reg, x, y, w: o.w ?? 1.6, h, bit: o.bit ?? 0 }; C.ffs.push(f); return f; },
    logic: (x, y, w, h, kind, seed) => { const r = { x, y, w, h, kind, seed }; C.logic.push(r); return r; },
    cache: fn => {
      const m = new Map();
      return (...a) => { const k = a.join(','); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); };
    },
  };
}

// una dorsale di clock orizzontale con i rami verticali verso i registri: il fronte la percorre
// in `span` secondi da sinistra a destra e scende lungo ogni ramo a `vb` tracce al secondo
export function spineClock(C, { x0, x1, y, h, branches, span = 0.05, vb = 260 }) {
  const v = (x1 - x0) / span;
  const at = x => (x - x0) / v;
  C.clock = {
    at: (x) => at(x),
    segs: [
      { kind: 'spine', x0, y0: y + h / 2, x1, y1: y + h / 2, w: h, t0: 0, v, trail: 14, n: 6 },
      ...branches.map(b => ({ kind: 'branch', reg: b.reg, x0: b.x, y0: y + h - 0.2, x1: b.x, y1: b.y1, w: b.w ?? 0.8, t0: at(b.x), v: vb, trail: 10, n: 5 })),
    ],
  };
  return C.clock;
}
