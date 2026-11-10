// La GPU: 16 corsie semplici che eseguono la stessa istruzione insieme, ognuna sul suo pixel (SIMT).
// Ogni colpo di clock manda un'istruzione a tutte le corsie; ognuna finisce quando può (la somma con più riporti,
// la corsia più lontana dalla memoria…) e il colpo dopo va dato quando è arrivata l'ultima.
// Il programma è un piccolo shader che colora una riga dell'immagine: legge la texture dalla memoria HBM,
// la colora (con un "if": le corsie che non lo eseguono restano spente, è la divergenza) e scrive i pixel
// nel framebuffer, sul chip. Otto righe fanno un'immagine (un frame). Un bit in ritardo è un pixel sbagliato:
// gli artefatti delle schede video overcloccate.
import { makeRoute, createLayout, spineClock } from './route.js';
import { t } from './i18n.js';

export const LANES = 16, ROWS = 8;
const STAGES = ['IS', ...Array.from({ length: LANES }, (_, i) => `L${i}`)];
export const meta = {
  id: 'gpu', name: t('proc.gpu'), short: t('proc.gpu.short'),
  tag: t('proc.gpu.tag'),
  desc: t('proc.gpu.desc'),
  howto: t('proc.gpu.howto'),
  stages: STAGES,
  glitchAt: 'LANES',                                                // un solo GLITCH! sopra le corsie, non sedici
  look: {
    pkg: 'bga', hbm: 2,
    pal: {
      pkg: '#5a6488', die: '#3a1f5e', seal: '#b07cff', plate: '#1a0c30', plinth: '#5a3290', cell: '#5e3896',
      fill: '#6a40a6', logic: '#c8a8ff', dec: '#9a76e0', sense: '#d8c0ff', alu: '#e6d6ff', core: '#7e54c4', pillar: '#6a40a6',
      wireD: '#5cf0d0', wireC: '#ffd6f4', via: '#8cf8e0', clock: '#c4f6ff', board: '#0f4038', pin: '#c8ccd8',
      hbm: '#6e7896', hbmTop: '#a8b2d0', ring: '#a8b0c4',
    },
  },
  freq: { unit: 'GHZ', k: 0.9 },
  power: { kind: 'heat', ref: 0.45, gain: 0.05, slow: 0.6 },
};

const SLICE = 0.05;                                                 // s per fetta di riporto
const MISS = 0.6;                                                   // s in più quando la texture non è nella cache
const V = 220, VC = 1000, VS = 380;                                  // tracce al secondo: dati, istruzione, scrittura dei pixel
const STAG = 0.008;                                                 // i bit di una corsia partono uno dietro l'altro
const OPN = { LD: 'LOAD', IF: 'ADD', ELSE: 'ADD', ST: 'STORE' };
const ENC = { LD: 0b101_001_000_000, IF: 0b000_010_001_011, ELSE: 0b000_010_001_100, ST: 0b110_000_000_010 };
const PROG = ['LD', 'IF', 'ELSE', 'ST'];

// la tavolozza dell'immagine, in colori lineari e sotto la soglia del bagliore: i pixel restano netti.
// Nella texture ci sono solo indici pari; nei frame dispari lo shader aggiunge 1 e ogni colore passa al suo
// gemello: per scafo, cabina e stelle il gemello è uguale, per la fiamma no (così tremola solo lei).
// 0 spento · 1-4 il cielo, dal blu notte al viola · 6/7 stelle · 8/9 scafo · 10/11 fiamma · 12/13 cabina · 14/15 artefatti
const hexes = ['#04060f', '#080c34', '#16105a', '#341468', '#5c1a62', '#120c26', '#d6cf9c', '#d6cf9c',
  '#e9ecf8', '#e9ecf8', '#ff7a14', '#ffd23a', '#38d4ff', '#38d4ff', '#ff2ad0', '#3aff6a'];
const lin = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * 0.82; }); };
const PALETTE = hexes.map(lin);

// la texture: un'astronave vista di lato, con le alette e la fiamma, e due stelle. 16 × 8, indici della tavolozza
const SHIP = [
  '.........6......',
  '...88...........',
  '....888.........',
  'A.8888888CC.....',
  'AA88888888888...',
  'A.8888888.......',
  '....888.........',
  '...88........6..',
];
const SKY = [1, 1, 2, 2, 3, 3, 4, 4];                              // il cielo per riga: la sera che scende

const bit = (v, i) => (v >> i) & 1;

// ---------- geometria ----------
// A sinistra lo scheduler (programma, registro dell'istruzione, decoder, spie dei warp) e la cache delle texture;
// al centro le 16 corsie in una griglia 4 × 4; a destra la ROP e il framebuffer. Le memorie HBM stanno fuori dal die.
export function buildCore() {
  const W = 106, H = 50;
  const L = createLayout(W, H), { C, data, ctrl, word, logic, cache } = L;
  const SP = { y: 5.2, h: 1.6 };
  const x0 = c => 21.0 + c * 12.6, y0 = r => 12.6 + r * 9.0;      // angolo di ogni corsia
  const lane = i => ({ r: i >> 2, c: i & 3, x: x0(i & 3), y: y0(i >> 2) });
  const chY = r => y0(r) + 8.0;                                     // canale sotto ogni fila di corsie
  const L1 = [15.6, 19.0], ROP = [72.6, 75.0];
  const fcx = x => 76.0 + (x + 0.5) * 1.9, fcy = y => 21.4 + y * 2.2;
  const P = C.P;
  P.lane = lane;

  // ---------- scheduler: il programma (4 istruzioni), il registro dell'istruzione, il decoder ----------
  const icx = k => 2.2 + k * 1.5, irow = j => 21.0 + (11 - j) * 0.86;
  C.arrays.I = { cols: 4, rows: 12, cx: icx, cy: irow, cw: 1.1, ch: 0.6, dec: { y0: 18.0, y1: 20.2 } };
  logic(1.4, 18.0, 6.2, 2.2, 'dec', 21);
  C.foot.push({ x: 1.0, y: 17.6, w: 7.0, h: 14.4, kind: 'array' });
  P.iWord = [0, 1, 2, 3].map(k => makeRoute(word([[icx(k), 20.2], [icx(k), 31.2]])));
  for (let j = 0; j < 12; j++) { data([[1.6, irow(j)], [8.6, irow(j)]]); L.ff('IR', 8.6, irow(j), 0.5); }
  P.iRow = cache((k, j) => makeRoute([[icx(k), irow(j)], [8.6, irow(j)]]));
  C.blocks.dec = logic(10.8, 18.6, 3.6, 13.4, 'logic', 31);
  for (let j = 0; j < 12; j++) data([[10.2, irow(j)], [10.8, irow(j)]]);
  for (let b = 0; b < 2; b++) L.ff('PC', 1.2, 15.0 - b * 1.1, 0.6, { bit: b });
  // le spie dei warp: una per riga dell'immagine
  C.blocks.sched = logic(1.0, 34.4, 13.4, 5.6, 'logic', 33);
  C.arrays.W = { cols: ROWS, rows: 1, cx: w => 2.0 + w * 1.6, cy: () => 37.2, cw: 1.2, ch: 1.6, z: 1.5, lw: 0.8, lmax: 1.3, colors: [[0.03, 0.03, 0.08], [0.25, 0.9, 0.35], [2.0, 1.1, 0.2], [0.1, 0.25, 0.6]] };
  C.blocks.op = [C.blocks.dec];

  // ---------- l'istruzione arriva a tutte le corsie: un albero sullo strato alto ----------
  P.bcast = cache(i => {
    const ln = lane(i), xb = ln.x + 6.2, pts = [[14.4, 25.4], [15.0, 25.4], [15.0, 11.2], [xb, 11.2], [xb, ln.y + 0.6]];
    pts.layer = 'c';
    return makeRoute(pts);
  });
  ctrl([[14.4, 25.4], [15.0, 25.4], [15.0, 11.2], [x0(3) + 6.2, 11.2]]);   // l'albero si disegna una volta sola, a pezzi
  for (let c = 0; c < 4; c++) ctrl([[x0(c) + 6.2, 11.2], [x0(c) + 6.2, y0(3) + 0.6]]);

  // ---------- la cache delle texture, la ROP e i canali tra le file di corsie ----------
  C.blocks.l1 = logic(L1[0], 12.0, L1[1] - L1[0], 36.6, 'sense', 41);
  C.blocks.rop = logic(ROP[0], 12.0, ROP[1] - ROP[0], 36.6, 'sense', 43);
  for (let r = 0; r < 4; r++) data([[L1[1], chY(r)], [ROP[0], chY(r)]]);
  // i controller di memoria sui due bordi, verso le HBM; la texture entra da sinistra
  C.blocks.mcL = logic(0.6, 41.4, 14.0, 6.6, 'port', 45);
  C.blocks.mcR = logic(96.0, 12.0, 9.4, 7.6, 'port', 47);
  P.hbm = makeRoute(data([[1.0, 44.6], [L1[0] + 0.4, 44.6]]));
  data([[ROP[1], 15.4], [96.0, 15.4]]);

  // ---------- le corsie ----------
  P.read = []; P.res = []; P.carry = []; P.texIn = []; C.blocks.alu = []; C.blocks.lanes = [];
  for (let i = 0; i < LANES; i++) {
    const ln = lane(i), x = ln.x, y = ln.y;
    // i 4 registri della corsia (r0 colonna del pixel, r1 texel, r2 colore, r3 libero): 4 colonne × 8 bit
    C.arrays[`R${i}`] = { cols: 4, rows: 8, cx: j => x + 0.9 + j * 0.85, cy: b => y + 0.8 + (7 - b) * 0.8, cw: 0.62, ch: 0.56 };
    C.foot.push({ x: x + 0.3, y: y + 0.2, w: 4.0, h: 6.8, kind: 'array' });
    const alu = logic(x + 4.4, y + 0.6, 3.6, 6.0, 'alu', 60 + i);
    C.blocks.alu.push(alu);
    C.blocks.lanes.push({ x: x - 0.2, y: y - 0.2, w: 11.4, h: 7.6 });
    P.read.push(makeRoute(data([[x + 3.6, y + 3.6], [x + 4.6, y + 3.6]])));
    P.res.push(makeRoute(data([[x + 7.4, y + 3.6], [x + 9.4, y + 3.6]])));
    const cx = x + 8.3, cy = b => y + 6.2 - b * 0.75;               // la catena del riporto, dal bit 0 in basso
    data([[cx, cy(0)], [cx, cy(7)]]);
    P.carry.push(Array.from({ length: 7 }, (_, b) => makeRoute([[cx, cy(b)], [cx, cy(b + 1)]])));
    L.ff(`L${i}`, x + 9.4, y + 3.6, 4.0, { w: 1.4 });
    data([[x + 9.4, y + 3.6], [x + 9.4, chY(ln.r)]]);
    P.texIn.push(makeRoute([[L1[1], chY(ln.r)], [x + 9.4, chY(ln.r)], [x + 9.4, y + 3.6]]));
  }
  // scrittura dei pixel: dal latch della corsia, lungo il canale, dentro la ROP e lungo la riga del framebuffer
  P.store = cache((i, y) => {
    const ln = lane(i);
    return makeRoute([[ln.x + 9.4, ln.y + 3.6], [ln.x + 9.4, chY(ln.r)], [ROP[0] + 1.2, chY(ln.r)], [ROP[0] + 1.2, fcy(y)], [fcx(i), fcy(y)]]);
  });
  for (let y = 0; y < ROWS; y++) data([[ROP[1], fcy(y)], [fcx(15) + 0.5, fcy(y)]]);

  // ---------- il framebuffer: l'immagine, pixel colorati ----------
  C.arrays.F = { cols: LANES, rows: ROWS, cx: fcx, cy: fcy, cw: 1.86, ch: 2.16, lw: 0.98, lmax: 2.12, colors: PALETTE };
  C.foot.push({ x: fcx(0) - 1.3, y: fcy(0) - 1.4, w: 16 * 1.9 + 0.7, h: 8 * 2.2 + 0.7, kind: 'array' });

  // ---------- clock: lo scheduler, le quattro colonne di corsie e la ROP ----------
  C.regs = { IS: 9.4, C0: x0(0) + 10.1, C1: x0(1) + 10.1, C2: x0(2) + 10.1, C3: x0(3) + 10.1, ROP: 73.8 };
  spineClock(C, {
    x0: -4, x1: W + 4, y: SP.y, h: SP.h,
    branches: [{ reg: 'IS', x: 9.4, y1: 17.4 }, ...[0, 1, 2, 3].map(c => ({ reg: `C${c}`, x: x0(c) + 10.1, y1: y0(3) + 1.4 })), { reg: 'ROP', x: 73.8, y1: 11.6 }],
  });

  // ---------- contorno ----------
  logic(0.6, 8.0, 13.6, 5.2, 'fill', 101);
  logic(77.0, 39.0, 18.4, 9.0, 'core', 103);
  logic(96.4, 39.0, 9.0, 9.0, 'fill', 104);
  logic(77.0, 8.0, 18.4, 4.2, 'fill', 105);
  return C;
}

// ---------- il processore simulato ----------
export function createCPU(rnd) {
  // la texture: indice della tavolozza nei 4 bit bassi, "rumore" in quelli alti (fa variare i riporti)
  const tex = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < LANES; x++) {
    const ch = SHIP[y][x], idx = ch === '.' ? 0 : parseInt(ch, 16);
    tex[y * LANES + x] = ((rnd() * 16) | 0) << 4 | idx;
  }
  const regs = Array.from({ length: LANES }, (_, i) => [i, 0, 0, (rnd() * 256) | 0]);
  const fb = new Array(LANES * ROWS).fill(0), badF = new Uint8Array(LANES * ROWS);
  let frame = 0, row = 0, step = -1, seq = 0, cur = null, rowProg = [], frameBad = 0;

  // le istruzioni di una riga: con le corsie in disaccordo sull'"if" servono entrambi i rami
  const planRow = () => {
    const sprite = [], sky = [];
    for (let x = 0; x < LANES; x++) (tex[row * LANES + ((x - frame) & 15)] & 15 ? sprite : sky).push(x);
    rowProg = ['LD', ...(sprite.length ? ['IF'] : []), ...(sky.length ? ['ELSE'] : []), 'ST'];
  };
  planRow();

  return {
    regs, fb, badF, tex,
    get frame() { return frame; }, get row() { return row; },
    get retiring() { return cur; },
    step() {
      let done = null;
      if (cur) {                                                    // l'istruzione finita scrive i risultati di ogni corsia
        for (let i = 0; i < LANES; i++) {
          if (!cur.mask[i]) continue;
          if (cur.kind === 'LD') regs[i][1] = cur.val[i];
          else if (cur.kind === 'IF' || cur.kind === 'ELSE') regs[i][2] = cur.val[i];
          else { fb[i * ROWS + cur.row] = cur.val[i] & 15; badF[i * ROWS + cur.row] = cur.badLane[i]; frameBad += cur.badLane[i]; }
        }
        if (cur.kind === 'ST' && cur.row === ROWS - 1) { done = { frame, bad: frameBad }; frameBad = 0; }
      }
      step++;
      if (step >= rowProg.length) {                                 // riga finita: il warp dopo, o un frame nuovo
        step = 0; row++;
        if (row >= ROWS) { row = 0; frame++; }
        planRow();
      }
      const kind = rowProg[step], e = { seq: seq++, kind, row, frame, step, mask: [], val: [], A: [], B: [], carries: [], badLane: new Uint8Array(LANES), bad: false };
      for (let i = 0; i < LANES; i++) {
        const texel = tex[row * LANES + ((i - frame) & 15)];
        const isSprite = (regs[i][1] & 15) !== 0;
        if (kind === 'LD') { e.mask[i] = 1; e.val[i] = texel; }
        else if (kind === 'IF' || kind === 'ELSE') {
          e.mask[i] = (kind === 'IF') === isSprite ? 1 : 0;
          // l'astronave scintilla nei frame dispari; il cielo prende il suo colore dalla riga
          const B = kind === 'IF' ? (((frame * 5 + row * 3 + i) & 15) << 4) | (frame & 1) : (((frame * 3 + i) & 15) << 4) | SKY[row];
          const A = regs[i][1];
          let c = 0, res = 0;
          const carries = [];
          for (let b = 0; b < 8; b++) { const a = bit(A, b), bb = bit(B, b); res |= (a ^ bb ^ c) << b; c = (a & bb) | (a & c) | (bb & c); carries.push(c); }
          e.A[i] = A; e.B[i] = B; e.val[i] = res & 255; e.carries[i] = carries;
        } else { e.mask[i] = 1; e.val[i] = regs[i][2]; }
      }
      cur = e;
      return { cur: e, done };
    },
    // un bit in ritardo: il valore della corsia esce sbagliato (e il pixel con lui)
    corrupt(entry, key, b) {
      if (key === 'fetch') return;                                  // il prelievo si rifà: costa il colpo, non i dati
      entry.bad = true;
      if (key === 'ctl') return;
      entry.badLane[key] = 1;
      entry.val[key] ^= 1 << b;
    },
  };
}

// ---------- quello che si vede ----------
export function initView(cpu) {
  const v = { I: PROG.map(k => ENC[k]), F: cpu.fb.slice(), W: new Array(ROWS).fill(0) };
  const bad = {};
  for (let i = 0; i < LANES; i++) { v[`R${i}`] = cpu.regs[i].slice(); bad[`R${i}`] = new Uint8Array(4); }
  return { v, bad, pc: 0 };
}
export function syncView(view, cpu) {
  for (let i = 0; i < LANES; i++) view.v[`R${i}`] = cpu.regs[i].slice();
  view.v.F = cpu.fb.slice();
  // i pixel sbagliati lampeggiano di un colore che non c'entra: magenta o verde, come gli artefatti veri
  for (let k = 0; k < view.v.F.length; k++) if (cpu.badF[k]) view.v.F[k] = 14 + (k & 1);
  view.v.W = Array.from({ length: ROWS }, (_, w) => (w === cpu.row ? 2 : w < cpu.row ? 1 : 0));
}
export const fills = Object.fromEntries([['IR', 'IS'], ...Array.from({ length: LANES }, (_, i) => [`L${i}`, `L${i}`])]);
export const latchValue = { PC: view => view.pc };

export function anchors(C) {
  const a = { IS: { x: 9.4, y: 17.0, h: 3 }, MEMD: { x: 8.0, y: 40.6, h: 2.5 }, LANES: { x: 46.0, y: 12.0, h: 3.4 } };
  for (let i = 0; i < LANES; i++) { const ln = C.P.lane(i); a[`L${i}`] = { x: ln.x + 6.0, y: ln.y + 0.4, h: 3.2 }; }
  return a;
}

// l'occhio di bue: ogni corsia ha la sua luce, e chi ha finito si spegne; resta accesa la più lenta
export function spots(C) {
  const rects = [{ stages: ['IS'], x1: 15.4, y1: 33.6 }];
  C.blocks.lanes.forEach((b, i) => rects.push({ stages: [`L${i}`], x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h }));
  rects.push({ stages: ['*'], x0: 72.2, y0: 12.0, y1: 48.6 });      // ROP e framebuffer: l'immagine resta in vista
  return { base: '*', rects };
}

export function results(x) {
  const more = [[String(x.frames || 0), t('proc.gpu.frames', { n: x.frames || 0 })]];
  more.push([String(x.artifacts || 0), t('proc.gpu.artifacts')]);
  return { more };
}

// mentre la texture arriva dalla memoria, le pile HBM si accendono
let hbmGlow = null;
export function write(k, now, fx) {
  if (!hbmGlow || now < hbmGlow.t0 || now > hbmGlow.t1 || !k.C.hbmBoxes) return;
  const a = 0.6 + 0.4 * Math.sin(now * 30);
  for (const b of k.C.hbmBoxes) fx.box((b[0] + b[3]) / 2, b[4] + 0.05, (b[2] + b[5]) / 2, b[3] - b[0], 0.1, b[5] - b[2], 0.3 * a, 1.6 * a, 1.3 * a);
}
export function onReset() { hbmGlow = null; }

// ---------- un'istruzione: parte da tutte le corsie, e si aspetta l'ultima ----------
export function schedule(k, st, { missP }, res) {
  const { P, C, view, cpu } = k, hf = k.hf, e = st.cur, cap = k.cap, pulse = k.pulse, goV = k.goV;
  if (!e) return;
  const T = t => k.rel('IS', t);
  const hue = k.hue(e), kind = e.kind;
  view.pc = e.step;
  view.v.W = Array.from({ length: ROWS }, (_, w) => (w === e.row ? 2 : w < e.row ? 1 : 0));

  if (st.done) {                                                    // con lo STORE dell'ultima riga l'immagine è completa
    k.notice(st.done.bad
      ? { type: 'bonus', pts: 100, text: t('proc.gpu.badFrame'), color: '#ff7aa0', stat: 'frames', sound: 'frame' }
      : { type: 'bonus', pts: 300, text: 'FRAME!', color: '#5cf0d0', stat: 'frames', sound: 'frame' });
    if (st.done.bad) k.notice({ type: 'info', stat: 'artifacts', count: st.done.bad });
    k.say(st.done.bad ? t('proc.gpu.badShort') : 'FRAME!', st.done.bad ? '#ff7aa0' : '#5cf0d0', T(0), { x: 91, y: 19.6, h: 2.6 }, 1.2);
  }

  // ---- lo scheduler preleva l'istruzione dopo (si sovrappone all'esecuzione) ----
  const nextK = PROG.indexOf(kind) < 3 ? PROG.indexOf(kind) + 1 : 0;
  k.spark(k.col('I', nextK), T(0.02), 0.03 * hf, hue, 4);
  pulse(P.iWord[nextK], T(0.03), T(0.06), hue, 1, { w: 0.9, tr: 3 });
  for (let j = 0; j < 12; j++) goV(P.iRow(nextK, j), T(0.06), V, hue, bit(ENC[PROG[nextK]], j), { hold: true, cap: cap(e, 'IS', 'fetch', j) });

  // ---- l'istruzione corrente va a tutte le corsie ----
  k.spark(C.blocks.dec, T(0.0), 0.05 * hf, hue, 10);
  k.at(T(0.03), t => k.say(kind === 'IF' ? 'IF ADD!' : kind === 'ELSE' ? 'ELSE ADD!' : `${OPN[kind]}!`, hue, t, k.anchor.IS, 9, 'op'));
  let extra = 0;
  if (kind === 'LD') {                                              // la texture arriva dalle HBM, attraverso la cache
    extra = k.rnd() < missP ? MISS : 0;
    if (extra) {
      res.miss = true;
      k.at(T(0.05), t => k.say('MISS!', '#ffd23a', t, k.anchor.MEMD, 0.9));
    }
    hbmGlow = { t0: T(0.03), t1: T(0.18 + extra) };
    pulse(P.hbm, T(0.04 + extra * 0.6), T(0.18 + extra), hue, 1, { w: 1.2, tr: 6 });
    k.spark(C.blocks.l1, T(0.17 + extra), 0.08 * hf, hue, 10);
  }
  for (let i = 0; i < LANES; i++) {
    if (!e.mask[i]) continue;                                       // corsia spenta: questo ramo non la riguarda
    const st_ = `L${i}`, tOp = goV(P.bcast(i), T(0.03), VC, hue, 1, { w: 0.7, stage: st_ }).t1;
    const v = e.val[i];
    if (kind === 'LD') {
      const t0 = Math.max(tOp, T(0.16 + extra));
      for (let b = 0; b < 8; b++) goV(P.texIn[i], t0 + b * STAG * hf, V, hue, bit(v, b), { w: 0.75, tr: 2, hold: b === 7, cap: cap(e, st_, i, b) });
    } else if (kind === 'ST') {
      const t0 = tOp + 0.02 * hf;
      let last = t0;
      for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.store(i, e.row), t0 + b * STAG * hf, VS, hue, bit(v, b), { w: 0.75, tr: 2, cap: cap(e, st_, i, b) }).t1);
      const px = i * ROWS + e.row;
      k.at(last, t => { view.v.F[px] = e.badLane[i] ? 14 + (px & 1) : v & 15; k.flash('F', i, hue, t, false); });
    } else {                                                        // la somma: ogni corsia ha i suoi riporti
      pulse(P.read[i], tOp, tOp + 0.04 * hf, hue, 1, { w: 0.8, stage: st_ });
      let run = 0, tEnd = tOp + 0.06 * hf;
      for (let b = 0; b < 8; b++) {
        const ts = tOp + (0.05 + SLICE * (1 + run)) * hf;
        if (b < 7 && e.carries[i][b]) pulse(P.carry[i][b], ts, ts + SLICE * hf, hue, 1, { w: 0.8, tr: 1.5, stage: st_ });
        tEnd = Math.max(tEnd, ts);
        run = e.carries[i][b] ? run + 1 : 0;
      }
      k.spark(C.blocks.alu[i], tOp + 0.04 * hf, tEnd - tOp, hue, 4);
      for (let b = 0; b < 8; b++) goV(P.res[i], tEnd + b * STAG * hf, V, hue, bit(v, b), { w: 0.75, tr: 2, hold: b === 7, cap: cap(e, st_, i, b) });
    }
  }
}
