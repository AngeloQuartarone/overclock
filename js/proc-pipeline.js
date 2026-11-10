// La pipeline a 5 stadi, il processore originale del gioco: prelievo → decodifica → esecuzione → memoria → scrittura.
// Cinque istruzioni lavorano insieme, una per stadio, e tra uno stadio e l'altro c'è una fila di latch:
// si tocca quando tutte le file hanno ricevuto i loro bit.
// Qui c'è tutto quello che la distingue: la geometria del core, il processore simulato e i tempi dei bit.
import { makeRoute, createLayout, spineClock } from './route.js';
import { t } from './i18n.js';
import { OP, OPS, encode, decode, writesReg, alu, makeProgram } from './isa.js';

export const meta = {
  id: 'pipeline', name: t('proc.pipeline'), short: t('proc.pipeline.short'),
  tag: t('proc.pipeline.tag'),
  desc: t('proc.pipeline.desc'),
  stages: ['IF', 'ID', 'EX', 'MEM', 'WB'],
  look: { pkg: 'qfp' },
  freq: { unit: 'GHZ', k: 1.6 },
  power: { kind: 'heat', ref: 0.45, gain: 0.05, slow: 0.6 },
};

const SLICE = 0.08;                                                 // s per fetta di riporto
const MISS = 0.7;                                                   // s in più quando la memoria "manca" il dato
const bit = (v, i) => (v >> i) & 1;

// ---------- geometria del core ----------
// Nessuna pista dati si incrocia sullo stesso strato: i fasci girano "a scalino" come nei chip veri.
export function buildCore() {
  const W = 125.8, H = 51;
  const L = createLayout(W, H), { C, data, ctrl, word, logic, cache } = L;
  const ff = (reg, x, y, h, b = 0) => L.ff(reg, x, y, h, { bit: b });

  // ---------- coordinate verticali ----------
  const SP = { y: 5.2, h: 1.6 };                  // dorsale del clock (metallo alto)
  const yRet = k => 9.3 - k * 0.55;               // ritorno del registro di destinazione (k = 0..2)
  const yCtl = k => 10.6 + k * 0.55;              // canale di controllo: rd (0..2), operazione (3..5)
  const DEC0 = 16.6, DEC1 = 19.4;                 // decoder di colonna degli array
  const rowY = b => 22.2 + (7 - b) * 2.6;         // righe dei bit dei dati (bit 7 in alto)
  const OW = -0.75, OA = 0, OB = 0.75;            // sotto-piste: scrittura/risultato, A, B
  const irow = j => 20.9 + (11 - j) * 0.98;       // righe dei bit delle istruzioni
  const A1 = 41.8, IA0 = 20.3, IA1 = 32.3;
  const yc = b => 44.0 + b * 0.8;                 // canale del write-back
  const pcY = b => 10.4 + (3 - b) * 1.15;

  // ---------- coordinate orizzontali ----------
  const PCX = 2.2, FW = 1.6;
  const IX0 = 8.6, ICW = 1.45, icx = k => IX0 + (k + 0.5) * ICW;
  const ISA = 32.1, IFID = 35.6, DEC = [39.4, 48.2];
  const xr = b => 48.8 + (7 - b) * 0.8;           // salite del write-back
  const RX0 = 55.2, RCW = 1.75, rcx = r => RX0 + (r + 0.5) * RCW, RX1 = RX0 + 8 * RCW;
  const IDEX = 71.0, xop = k => 73.4 + (5 - k) * 0.55;
  const ALU = [75.6, 85.8], XC = 86.4, EXMEM = 89.2;
  const xa = i => 91.6 + (3 - i) * 0.55, yDec = i => 19.2 - i * 0.55, XJ = 94.0;
  const DX0 = 94.6, DCW = 1.05, dcx = k => DX0 + (k + 0.5) * DCW, DX1 = DX0 + 16 * DCW;
  const DSA = 111.7, MUX = [113.8, 115.0], MEMWB = 116.4;
  const xd = b => 118.8 + b * 0.8, xret = k => 118.6 + k * 0.55, xrd = k => 61.0 - k * 0.55;
  const xm = k => 97.0 + (5 - k) * 0.55, xc = k => 41.0 + k * 1.1, ySel = i => 16.9 + i * 0.42;

  Object.assign(C.g, { DEC0, DEC1, pcY, PCX, FW });
  const P = C.P;
  const dec = { y0: DEC0, y1: DEC1 };

  // ---------- PC e incrementatore ----------
  P.pcDec = []; P.pcFb = [];
  for (let b = 0; b < 4; b++) {
    ff('PC', PCX, pcY(b), 0.72, b);
    P.pcDec.push(makeRoute(data([[PCX + FW, pcY(b)], [9.6 + b * 0.9, pcY(b)], [9.6 + b * 0.9, DEC0 + 0.4]])));
    const x = 1.75 - b * 0.38;
    P.pcFb.push(makeRoute(data([[x, 15.4], [x, pcY(b)], [PCX, pcY(b)]])));
  }
  C.blocks.inc = logic(0.4, 15.4, 5.2, 4.0, 'logic', 11);

  // ---------- IF: memoria istruzioni ----------
  C.blocks.idec = logic(IX0, DEC0, 16 * ICW, DEC1 - DEC0, 'dec', 21);
  C.arrays.I = { cols: 16, rows: 12, cx: icx, cy: irow, cw: 1.12, ch: 0.76, dec };
  P.iWord = [];
  for (let k = 0; k < 16; k++) P.iWord.push(makeRoute(word([[icx(k), DEC1], [icx(k), IA1]])));
  for (let j = 0; j < 12; j++) { data([[IX0 - 0.3, irow(j)], [IFID, irow(j)]]); ff('IFID', IFID, irow(j), 0.6); }
  P.iRow = cache((k, j) => makeRoute([[icx(k), irow(j)], [IFID, irow(j)]]));
  logic(ISA, IA0, 1.6, IA1 - IA0, 'sense', 31);
  C.foot.push({ x: IX0 - 0.6, y: DEC0 - 0.4, w: 16 * ICW + 1.2, h: IA1 - DEC0 + 0.8, kind: 'array' });

  // ---------- ID: decodifica e lettura dei registri ----------
  P.ifidDec = [];
  for (let j = 0; j < 12; j++) P.ifidDec.push(makeRoute(data([[IFID + FW, irow(j)], [DEC[0] + 0.8, irow(j)]])));
  C.blocks.dec = logic(DEC[0], 15.6, DEC[1] - DEC[0], 18.4, 'logic', 41);
  C.foot.push({ x: DEC[0] - 0.4, y: 15.2, w: DEC[1] - DEC[0] + 0.8, h: 19.2, kind: 'logic' });
  P.sel = [];
  for (let i = 0; i < 6; i++) P.sel.push(makeRoute(ctrl([[DEC[1] - 0.6, ySel(i)], [RX0 + 0.6, ySel(i)]])));
  C.blocks.rdec = logic(RX0, DEC0, 8 * RCW, DEC1 - DEC0, 'dec', 51);
  P.ctrlDec = [];
  for (let k = 0; k < 6; k++) {
    P.ctrlDec.push(makeRoute(ctrl([[xc(k), 16.2], [xc(k), yCtl(k)], [IDEX, yCtl(k)]])));
    ff('IDEX', IDEX, yCtl(k), 0.42);
  }
  C.arrays.R = { cols: 8, rows: 8, cx: rcx, cy: rowY, cw: 1.32, ch: 2.05, dec };
  P.rfWord = [];
  for (let r = 0; r < 8; r++) P.rfWord.push(makeRoute(word([[rcx(r), DEC1], [rcx(r), A1]])));
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    data([[RX0 - 0.3, y + OA], [IDEX, y + OA]]);
    data([[RX0 - 0.3, y + OB], [IDEX, y + OB]]);
    ff('IDEX', IDEX, y + OA, 0.56);
    ff('IDEX', IDEX, y + OB, 0.56);
  }
  P.rfA = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OA], [IDEX, rowY(b) + OA]]));
  P.rfB = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OB], [IDEX, rowY(b) + OB]]));
  C.foot.push({ x: RX0 - 0.6, y: DEC0 - 0.4, w: 8 * RCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });

  // ---------- EX: ALU a 8 fette identiche, con la catena del riporto ----------
  P.aluA = []; P.aluB = []; P.bPass = []; P.res = []; P.carry = []; C.blocks.alu = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    P.aluA.push(makeRoute(data([[IDEX + FW, y + OA], [ALU[0] + 0.9, y + OA]])));
    P.bPass.push(makeRoute(data([[IDEX + FW, y + OB], [EXMEM, y + OB]])));
    P.aluB.push(makeRoute([[IDEX + FW, y + OB], [ALU[0] + 0.9, y + OB]]));
    C.blocks.alu.push(logic(ALU[0], y - 1.18, ALU[1] - ALU[0], 2.36, 'alu', 61));
    data([[ALU[1], y], [XC, y]]);
    P.res.push(makeRoute(data([[ALU[1] - 1.4, y + OW], [EXMEM, y + OW]])));
    ff('EXMEM', EXMEM, y + OW, 0.6);
    ff('EXMEM', EXMEM, y + OB, 0.6);
    if (b < 7) P.carry.push(makeRoute([[XC, y], [XC, rowY(b + 1)]]));
  }
  data([[XC, rowY(0)], [XC, rowY(7)]]);
  C.foot.push({ x: ALU[0] - 0.4, y: rowY(7) - 1.6, w: ALU[1] - ALU[0] + 1.4, h: rowY(0) - rowY(7) + 3.2, kind: 'logic' });
  C.blocks.op = C.blocks.alu;                                       // la scritta dell'istruzione va sopra l'ALU
  P.opAlu = [];
  for (let k = 3; k < 6; k++) P.opAlu.push(makeRoute(ctrl([[IDEX + FW, yCtl(k)], [xop(k), yCtl(k)], [xop(k), A1]])));
  P.ctrlEx = [];
  for (let k = 0; k < 6; k++) {
    P.ctrlEx.push(makeRoute(ctrl([[IDEX + FW, yCtl(k)], [EXMEM, yCtl(k)]])));
    ff('EXMEM', EXMEM, yCtl(k), 0.42);
  }

  // ---------- MEM: memoria dati, scorciatoia e multiplexer ----------
  P.byp = []; P.addr = []; P.opMem = []; P.ctrlMem = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    P.byp.push(makeRoute(data([[EXMEM + FW, y + OW], [MUX[0] + 0.6, y + OW], [MUX[0] + 0.6, y + OA], [MEMWB, y + OA]])));
    data([[EXMEM + FW, y + OB], [XJ, y + OB], [XJ, y + OA], [DX1 + 0.2, y + OA]]);
    data([[DX1, y + OA], [MEMWB, y + OA]]);
    ff('MEMWB', MEMWB, y + OA, 0.6);
  }
  P.dWrite = cache((k, b) => makeRoute([[EXMEM + FW, rowY(b) + OB], [XJ, rowY(b) + OB], [XJ, rowY(b) + OA], [dcx(k), rowY(b) + OA]]));
  P.dRead = cache((k, b) => makeRoute([[dcx(k), rowY(b) + OA], [MEMWB, rowY(b) + OA]]));
  for (let i = 0; i < 4; i++) {
    const y = rowY(i) + OW;
    P.addr.push(makeRoute(data([[EXMEM + FW, y], [xa(i), y], [xa(i), yDec(i)], [DX0 + 0.6, yDec(i)]])));
  }
  C.blocks.ddec = logic(DX0, DEC0, 16 * DCW, DEC1 - DEC0, 'dec', 71);
  C.arrays.D = { cols: 16, rows: 8, cx: dcx, cy: b => rowY(b) - 0.32, cw: 0.8, ch: 1.5, dec };
  P.dWord = [];
  for (let k = 0; k < 16; k++) P.dWord.push(makeRoute(word([[dcx(k), DEC1], [dcx(k), A1]])));
  logic(DSA, 20.6, 1.6, A1 - 20.6, 'sense', 81);
  logic(MUX[0], 20.6, MUX[1] - MUX[0], A1 - 20.6, 'sense', 91);
  C.foot.push({ x: DX0 - 0.6, y: DEC0 - 0.4, w: 16 * DCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });
  for (let k = 3; k < 6; k++) P.opMem.push(makeRoute(ctrl([[EXMEM + FW, yCtl(k)], [xm(k), yCtl(k)], [xm(k), DEC0 + 0.5]])));
  for (let k = 0; k < 3; k++) {
    P.ctrlMem.push(makeRoute(ctrl([[EXMEM + FW, yCtl(k)], [MEMWB, yCtl(k)]])));
    ff('MEMWB', MEMWB, yCtl(k), 0.42);
  }

  // ---------- WB: il lungo anello che riporta il risultato ai registri ----------
  const wbPts = (b, xEnd) => {
    const y = rowY(b);
    return [[MEMWB + FW, y + OA], [xd(b), y + OA], [xd(b), yc(b)], [xr(b), yc(b)], [xr(b), y + OW], [xEnd, y + OW]];
  };
  for (let b = 0; b < 8; b++) data(wbPts(b, RX1 + 0.3));
  P.wb = cache((r, b) => makeRoute(wbPts(b, rcx(r))));
  P.rdRet = [];
  for (let k = 0; k < 3; k++) {
    P.rdRet.push(makeRoute(ctrl([[MEMWB + FW, yCtl(k)], [xret(k), yCtl(k)], [xret(k), yRet(k)], [xrd(k), yRet(k)], [xrd(k), DEC0 + 0.5]])));
  }

  // ---------- clock: dorsale e rami verso i registri di pipeline ----------
  C.regs = { PC: 4.7, IFID: 34.4, IDEX: 70.1, EXMEM: 88.3, MEMWB: 115.6 };
  spineClock(C, {
    x0: -4, x1: W + 4, y: SP.y, h: SP.h,
    branches: Object.entries(C.regs).map(([reg, x]) => ({ reg, x, y1: reg === 'PC' ? 15.0 : 42.6 })),
  });

  // ---------- logica di contorno (riempimento) ----------
  logic(0.4, 20.6, 7.4, 22.0, 'fill', 101);
  logic(8.6, 33.4, 25.1, 9.4, 'fill', 102);
  logic(35.6, 35.0, 12.6, 7.8, 'fill', 103);
  logic(13.2, 8.2, 25.0, 7.4, 'fill', 104);
  logic(38.6, 7.6, 20.0, 2.4, 'fill', 105);
  logic(75.6, 14.1, 20.8, 2.0, 'fill', 106);
  logic(99.0, 14.1, 14.0, 2.0, 'fill', 107);
  logic(119.4, 12.4, 6.0, 8.6, 'fill', 108);

  return C;
}

// ---------- il processore simulato ----------
// 8 registri da 8 bit, 16 byte di memoria dati e un programma di 16 istruzioni in loop.
// Le scritture (registri e memoria) avvengono sul fronte del clock, quando il giocatore tocca;
// un bit arrivato tardi a un latch viene catturato sbagliato (corrupt): il valore sbagliato
// prosegue davvero nella pipeline e finisce nei registri o in memoria.
export function createCPU(rnd) {
  const program = makeProgram(rnd, 3);                              // niente dipendenze tra istruzioni vicine
  const regs = Array.from({ length: 8 }, () => (rnd() * 256) | 0);
  const mem = Array.from({ length: 16 }, () => (rnd() * 256) | 0);
  const bad = { regs: new Uint8Array(8), mem: new Uint8Array(16) };  // contengono un valore corrotto
  const pipe = { IF: null, ID: null, EX: null, MEM: null, WB: null };
  let pc = 0, seq = 0;

  return {
    program, regs, mem, bad, pipe,
    get retiring() { return pipe.WB; },                             // l'istruzione che si completa a questo fronte

    // un fronte di clock: si scrivono i risultati del ciclo appena finito, poi tutto avanza di uno stadio
    step() {
      const w = pipe.WB;
      if (w && writesReg(w.ins)) { regs[w.ins.rd] = w.val; bad.regs[w.ins.rd] = w.bad ? 1 : 0; }
      const s = pipe.MEM;
      if (s && s.ins.op === OP.STORE) { mem[s.addr] = s.B; bad.mem[s.addr] = s.bad ? 1 : 0; }

      pipe.WB = pipe.MEM; pipe.MEM = pipe.EX; pipe.EX = pipe.ID; pipe.ID = pipe.IF;
      const ins = program[pc];
      pipe.IF = { seq: seq++, pc, ins: { ...ins }, enc: encode(ins), bad: false };
      pc = (pc + 1) & 15;

      const m = pipe.MEM;                                      // accesso alla memoria
      if (m) {
        m.addr = m.res & 15;
        m.val = m.ins.op === OP.LOAD ? mem[m.addr] : m.res;
      }
      const e = pipe.EX;                                       // calcolo nell'ALU
      if (e) { const r = alu(e.ins.op, e.A, e.B); e.res = r.res; e.carries = r.carries; }
      const d = pipe.ID;                                       // lettura dei registri
      if (d) { d.A = regs[d.ins.rs1]; d.B = regs[d.ins.rs2]; }
      return { ...pipe };
    },

    // un bit arrivato dopo il fronte: il latch lo cattura sbagliato
    // (semplificazione: il bit si inverte sempre; 'ctl' segna solo l'istruzione come guasta)
    corrupt(entry, key, b) {
      entry.bad = true;
      if (key === 'enc') { entry.enc ^= 1 << b; entry.ins = decode(entry.enc); }
      else if (key !== 'ctl') entry[key] ^= 1 << b;
    },
  };
}

// ---------- quello che si vede: valori negli array, scritte, luci ----------
export const initView = cpu => ({
  v: { I: cpu.program.map(encode), R: cpu.regs.slice(), D: cpu.mem.slice() },
  bad: { R: new Uint8Array(8), D: new Uint8Array(16) }, pc: 0,
});
export function syncView(view, cpu) {
  view.v.R = cpu.regs.slice(); view.v.D = cpu.mem.slice();
  view.bad.R = cpu.bad.regs.slice(); view.bad.D = cpu.bad.mem.slice();
}
// quale stadio riempie ogni fila di latch; i latch del PC mostrano il suo valore
export const fills = { IFID: 'IF', IDEX: 'ID', EXMEM: 'EX', MEMWB: 'MEM' };
export const latchValue = { PC: view => view.pc };

// dove compaiono le scritte di ogni stadio (sopra il registro che deve catturare)
export function anchors(C) {
  const alu = C.blocks.alu, G = C.g, mid = (lo, hi) => (lo + hi) / 2;
  return {
    ALU: { x: alu[0].x + alu[0].w / 2, y: Math.min(...alu.map(b => b.y)) - 0.5, h: 3.5 },
    MEMD: { x: mid(C.arrays.D.cx(0), C.arrays.D.cx(15)), y: G.DEC0 - 0.5, h: 2.5 },
    IF: { x: C.regs.IFID + 1.2, y: G.DEC0, h: 3 }, ID: { x: C.regs.IDEX + 1.2, y: G.DEC0, h: 3 },
    EX: { x: C.regs.EXMEM + 1.2, y: G.DEC0, h: 3 }, MEM: { x: C.regs.MEMWB + 1.2, y: G.DEC0, h: 3 },
    WB: { x: mid(C.arrays.R.cx(0), C.arrays.R.cx(7)), y: G.DEC0, h: 3 },
  };
}

// l'occhio di bue: gli stadi finiscono ai registri di pipeline; il write-back è anche la fascia di piste sul davanti
export function spots(C) {
  const edge = reg => Math.max(...C.ffs.filter(f => f.reg === reg).map(f => f.x + f.w));
  const [a, b, c, d] = ['IFID', 'IDEX', 'EXMEM', 'MEMWB'].map(edge);
  return {
    base: 'IF',
    rects: [
      { stages: ['ID'], x0: a }, { stages: ['EX'], x0: b }, { stages: ['MEM'], x0: c }, { stages: ['WB'], x0: d },
      { stages: ['WB'], x0: 47.5, y0: 43.2 },
    ],
  };
}

// ---------- un ciclo: cosa parte dopo il fronte, e quando arriva ----------
export function schedule(k, st, { missP }, res) {
  const { P, C, view } = k, hf = k.hf;
  const rel = k.rel, goV = k.goV, pulse = k.pulse, cap = k.cap;

  const f = st.IF;                                               // ---- prelievo ----
  if (f) {
    const hue = k.hue(f);
    view.pc = f.pc;
    for (let b = 0; b < 4; b++) pulse(P.pcDec[b], rel('PC', 0.02), rel('PC', 0.09), hue, bit(f.pc, b), { w: 0.8 });
    k.spark(k.col('I', f.pc), rel('PC', 0.08), 0.03 * hf, hue, 5);
    pulse(P.iWord[f.pc], rel('PC', 0.09), rel('PC', 0.13), hue, 1, { w: 0.9, tr: 3 });
    k.at(rel('PC', 0.13), t => k.flash('I', f.pc, hue, t, false));
    for (let j = 0; j < 12; j++) {
      goV(P.iRow(f.pc, j), rel('PC', 0.12), 110, hue, bit(f.enc, j), { hold: true, cap: cap(f, 'IF', 'enc', j) });
    }
    k.spark(C.blocks.inc, rel('PC', 0.03), 0.15 * hf, hue, 8);
    const nx = (f.pc + 1) & 15;
    for (let b = 0; b < 4; b++) pulse(P.pcFb[b], rel('PC', 0.16), rel('PC', 0.26), hue, bit(nx, b), { w: 0.8, hold: true });
  }

  const d = st.ID;                                               // ---- decodifica ----
  if (d) {
    const hue = k.hue(d);
    for (let j = 0; j < 12; j++) pulse(P.ifidDec[j], rel('IFID', 0.02), rel('IFID', 0.07), hue, bit(d.enc, j));
    k.spark(C.blocks.dec, rel('IFID', 0.07), 0.12 * hf, hue, 24);
    const sel = [d.ins.rs1, d.ins.rs2];
    for (let i = 0; i < 6; i++) pulse(P.sel[i], rel('IFID', 0.14), rel('IFID', 0.19), hue, bit(sel[(i / 3) | 0], i % 3), { w: 0.75 });
    for (const r of new Set(sel)) {
      k.spark(k.col('R', r), rel('IFID', 0.18), 0.02 * hf, hue, 4);
      pulse(P.rfWord[r], rel('IFID', 0.19), rel('IFID', 0.22), hue, 1, { w: 0.9, tr: 3 });
      k.at(rel('IFID', 0.22), t => k.flash('R', r, hue, t, false));
    }
    for (let b = 0; b < 8; b++) {
      goV(P.rfA(d.ins.rs1, b), rel('IFID', 0.2), 110, hue, bit(d.A, b), { hold: true, cap: cap(d, 'ID', 'A', b) });
      goV(P.rfB(d.ins.rs2, b), rel('IFID', 0.21), 110, hue, bit(d.B, b), { hold: true, cap: cap(d, 'ID', 'B', b) });
    }
    for (let j = 0; j < 6; j++) {
      const v = j < 3 ? d.ins.rd : d.ins.op;
      goV(P.ctrlDec[j], rel('IFID', 0.1), 220, hue, bit(v, j % 3), { w: 0.7, hold: true, cap: cap(d, 'ID', 'ctl', j) });
    }
  }

  const e = st.EX;                                               // ---- esecuzione ----
  if (e) {
    const hue = k.hue(e);
    for (let b = 0; b < 8; b++) {
      pulse(P.aluA[b], rel('IDEX', 0.02), rel('IDEX', 0.07), hue, bit(e.A, b));
      pulse(P.aluB[b], rel('IDEX', 0.02), rel('IDEX', 0.07), hue, bit(e.B, b));
    }
    for (let j = 0; j < 3; j++) pulse(P.opAlu[j], rel('IDEX', 0.02), rel('IDEX', 0.08), hue, bit(e.ins.op, j), { w: 0.7 });
    k.at(rel('IDEX', 0.07), t => k.say(`${OPS[e.ins.op]}!`, hue, t, k.anchor.ALU, 9, 'op'));
    let run = 0;
    for (let b = 0; b < 8; b++) {
      // somma: ogni fetta si assesta quando le arriva il riporto, e una lunga catena di riporti
      // rallenta tutta la somma; operazioni logiche: tutte le fette insieme
      const ts = e.carries ? rel('IDEX', 0.1 + SLICE * (1 + run)) : rel('IDEX', 0.13);
      k.spark(C.blocks.alu[b], ts, 0.03 * hf, hue, 5);
      if (e.carries && b < 7) pulse(P.carry[b], ts, ts + SLICE * hf, hue, e.carries[b], { w: 0.85, tr: 2 });
      goV(P.res[b], ts + 0.01 * hf, 80, hue, bit(e.res, b), { hold: true, cap: cap(e, 'EX', 'res', b) });
      run = e.carries && e.carries[b] ? run + 1 : 0;
    }
    if (e.ins.op === OP.STORE) {
      for (let b = 0; b < 8; b++) goV(P.bPass[b], rel('IDEX', 0.03), 80, hue, bit(e.B, b), { hold: true, cap: cap(e, 'EX', 'B', b) });
    }
    for (let j = 0; j < 6; j++) {
      const v = j < 3 ? e.ins.rd : e.ins.op;
      goV(P.ctrlEx[j], rel('IDEX', 0.03), 100, hue, bit(v, j % 3), { w: 0.7, hold: true, cap: cap(e, 'EX', 'ctl', j) });
    }
  }

  const m = st.MEM;                                              // ---- memoria ----
  if (m) {
    const hue = k.hue(m), op = m.ins.op;
    if (op === OP.LOAD || op === OP.STORE) {
      for (let i = 0; i < 4; i++) pulse(P.addr[i], rel('EXMEM', 0.02), rel('EXMEM', 0.1), hue, bit(m.addr, i), { w: 0.8 });
      for (let j = 0; j < 3; j++) pulse(P.opMem[j], rel('EXMEM', 0.02), rel('EXMEM', 0.1), hue, bit(op, j), { w: 0.7 });
      k.spark(k.col('D', m.addr), rel('EXMEM', 0.09), 0.03 * hf, hue, 5);
    }
    if (op === OP.LOAD) {
      const extra = k.rnd() < missP ? MISS : 0;                   // il dato non è pronto: si aspetta
      if (extra) {
        res.miss = true;
        k.at(rel('EXMEM', 0.1), t => k.say('MISS!', '#ffd23a', t, k.anchor.MEMD, 0.9));
        k.miss('D', m.addr, rel('EXMEM', 0.1), rel('EXMEM', 0.1 + extra));
      }
      pulse(P.dWord[m.addr], rel('EXMEM', 0.11 + extra), rel('EXMEM', 0.15 + extra), hue, 1, { w: 0.9, tr: 3 });
      k.at(rel('EXMEM', 0.15 + extra), t => k.flash('D', m.addr, hue, t, false));
      for (let b = 0; b < 8; b++) goV(P.dRead(m.addr, b), rel('EXMEM', 0.16 + extra), 80, hue, bit(m.val, b), { hold: true, cap: cap(m, 'MEM', 'val', b) });
    } else if (op === OP.STORE) {
      let last = 0;
      for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.dWrite(m.addr, b), rel('EXMEM', 0.03), 80, hue, bit(m.B, b), { cap: cap(m, 'MEM', 'B', b) }).t1);
      pulse(P.dWord[m.addr], last, last + 0.05 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(m, 'MEM', 'ctl', 0) });
      k.at(last + 0.05 * hf, t => { view.v.D[m.addr] = m.B; view.bad.D[m.addr] = m.bad ? 1 : 0; k.flash('D', m.addr, hue, t, true); });
    } else {
      for (let b = 0; b < 8; b++) goV(P.byp[b], rel('EXMEM', 0.03), 110, hue, bit(m.val, b), { hold: true, cap: cap(m, 'MEM', 'val', b) });
    }
    for (let j = 0; j < 3; j++) goV(P.ctrlMem[j], rel('EXMEM', 0.03), 110, hue, bit(m.ins.rd, j), { w: 0.7, hold: true, cap: cap(m, 'MEM', 'ctl', j) });
  }

  const w = st.WB;                                               // ---- scrittura ----
  if (w && w.ins.op !== OP.STORE && w.ins.op !== OP.NOP) {
    const hue = k.hue(w), rd = w.ins.rd;
    k.wait('R', rd, 'WB');                                        // il registro che riceve il risultato
    let last = 0;
    for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.wb(rd, b), rel('MEMWB', 0.03), 700, hue, bit(w.val, b), { tr: 10, cap: cap(w, 'WB', 'val', b) }).t1);
    for (let j = 0; j < 3; j++) goV(P.rdRet[j], rel('MEMWB', 0.03), 700, hue, bit(rd, j), { w: 0.7, tr: 8, cap: cap(w, 'WB', 'ctl', j) });
    k.spark(k.col('R', rd), last - 0.03 * hf, 0.03 * hf, hue, 4);
    pulse(P.rfWord[rd], last, last + 0.04 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(w, 'WB', 'ctl', 3) });
    k.at(last + 0.04 * hf, t => { view.v.R[rd] = w.val; view.bad.R[rd] = w.bad ? 1 : 0; k.flash('R', rd, hue, t, true); });
  }
}
