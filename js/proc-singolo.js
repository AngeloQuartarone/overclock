// Il processore a ciclo singolo: un'istruzione intera per ogni colpo di clock.
// È lo stesso percorso dei dati della pipeline, ma senza i registri tra gli stadi: dopo il fronte un'onda sola
// attraversa tutto il chip, dalla memoria istruzioni fino ai registri, e il colpo dopo va dato quando è arrivata in fondo.
// Per questo è lento: il periodo è la somma di tutti gli stadi, e in un chip vero il clock è fisso e tarato
// sull'istruzione più lenta (la LOAD). Qui il clock lo dai tu, e puoi accorciarlo quando l'istruzione è veloce.
import { makeRoute, createLayout, spineClock } from './route.js';
import { t, dec } from './i18n.js';
import { OP, OPS, encode, writesReg, alu, makeProgram } from './isa.js';

export const meta = {
  id: 'singolo', name: t('proc.singolo'), short: t('proc.singolo.short'),
  tag: t('proc.singolo.tag'),
  desc: t('proc.singolo.desc'),
  howto: t('proc.singolo.howto'),
  stages: ['IF', 'ID', 'EX', 'MEM', 'WB'],
  look: {
    pkg: 'dip', pins: 20, ring: '#e8b54a',
    pal: {
      pkg: '#ddd5c4', die: '#7d6135', seal: '#e0b860', plate: '#2e2312', plinth: '#8c6c38', cell: '#9c7a40',
      fill: '#a8884c', logic: '#f6dc98', dec: '#d0ae64', sense: '#fae6a8', alu: '#fff0c4', pillar: '#9c7a40',
      wireD: '#ffd25c', wireC: '#d8ecff', via: '#ffe28c', pad: '#ffd25c', finger: '#e8aa40', bond: '#ffe68c', pin: '#dfe1ea',
      clock: '#c4f4ff', dot1: '#3fd6ff',
    },
  },
  dim: 0.68,                                                        // gli stadi fermi restano un po' più accesi: si segue l'onda
  freq: { unit: 'MHZ', k: 2 },
  power: { kind: 'heat', ref: 1.0, gain: 0.05, slow: 0.6 },
};

const SLICE = 0.06;                                                 // s per fetta di riporto
const MISS = 0.6;                                                   // s in più quando la memoria "manca" il dato
const V = 260, VW = 1000;                                           // tracce al secondo: piste dei dati e anello di scrittura
const bit = (v, i) => (v >> i) & 1;

// ---------- geometria: il percorso della pipeline, senza le quattro file di latch ----------
export function buildCore() {
  const W = 125.8, H = 51;
  const L = createLayout(W, H), { C, data, ctrl, word, logic, cache } = L;

  const SP = { y: 5.2, h: 1.6 };
  const yRet = k => 9.3 - k * 0.55;
  const yCtl = k => 10.6 + k * 0.55;
  const DEC0 = 16.6, DEC1 = 19.4;
  const rowY = b => 22.2 + (7 - b) * 2.6;
  const OW = -0.75, OA = 0, OB = 0.75;
  const irow = j => 20.9 + (11 - j) * 0.98;
  const A1 = 41.8, IA0 = 20.3, IA1 = 32.3;
  const yc = b => 44.0 + b * 0.8;
  const pcY = b => 10.4 + (3 - b) * 1.15;
  const PCX = 2.2, FW = 1.6;
  const IX0 = 8.6, ICW = 1.45, icx = k => IX0 + (k + 0.5) * ICW;
  const ISA = 32.1, DEC = [39.4, 48.2];
  const xr = b => 48.8 + (7 - b) * 0.8;
  const RX0 = 55.2, RCW = 1.75, rcx = r => RX0 + (r + 0.5) * RCW, RX1 = RX0 + 8 * RCW;
  const xop = k => 73.4 + (5 - k) * 0.55;
  const ALU = [75.6, 85.8], XC = 86.4;
  const xa = i => 91.6 + (3 - i) * 0.55, yDec = i => 19.2 - i * 0.55, XJ = 94.0;
  const DX0 = 94.6, DCW = 1.05, dcx = k => DX0 + (k + 0.5) * DCW, DX1 = DX0 + 16 * DCW;
  const DSA = 111.7, MUX = [113.8, 115.0], MX = 116.4;
  const xd = b => 118.8 + b * 0.8, xrd = k => 61.0 - k * 0.55;
  const xm = k => 97.0 + (5 - k) * 0.55, xc = k => 41.0 + k * 1.1, ySel = i => 16.9 + i * 0.42;
  const RES = ALU[1] - 1.4;                                         // dove esce il risultato dell'ALU

  Object.assign(C.g, { DEC0, DEC1, pcY, PCX, FW });
  const P = C.P;
  const dec = { y0: DEC0, y1: DEC1 };

  // ---------- PC e incrementatore (il solo registro, oltre al banco e alla memoria) ----------
  P.pcDec = []; P.pcFb = [];
  for (let b = 0; b < 4; b++) {
    L.ff('PC', PCX, pcY(b), 0.72, { bit: b });
    P.pcDec.push(makeRoute(data([[PCX + FW, pcY(b)], [9.6 + b * 0.9, pcY(b)], [9.6 + b * 0.9, DEC0 + 0.4]])));
    const x = 1.75 - b * 0.38;
    P.pcFb.push(makeRoute(data([[x, 15.4], [x, pcY(b)], [PCX, pcY(b)]])));
  }
  C.blocks.inc = logic(0.4, 15.4, 5.2, 4.0, 'logic', 11);

  // ---------- memoria istruzioni: i bit vanno dritti al decoder ----------
  C.blocks.idec = logic(IX0, DEC0, 16 * ICW, DEC1 - DEC0, 'dec', 21);
  C.arrays.I = { cols: 16, rows: 12, cx: icx, cy: irow, cw: 1.12, ch: 0.76, dec };
  P.iWord = [];
  for (let k = 0; k < 16; k++) P.iWord.push(makeRoute(word([[icx(k), DEC1], [icx(k), IA1]])));
  for (let j = 0; j < 12; j++) data([[IX0 - 0.3, irow(j)], [DEC[0] + 0.8, irow(j)]]);
  P.iDec = cache((k, j) => makeRoute([[icx(k), irow(j)], [DEC[0] + 0.8, irow(j)]]));
  logic(ISA, IA0, 1.6, IA1 - IA0, 'sense', 31);
  C.foot.push({ x: IX0 - 0.6, y: DEC0 - 0.4, w: 16 * ICW + 1.2, h: IA1 - DEC0 + 0.8, kind: 'array' });

  // ---------- decodifica e banco dei registri ----------
  C.blocks.dec = logic(DEC[0], 15.6, DEC[1] - DEC[0], 18.4, 'logic', 41);
  C.foot.push({ x: DEC[0] - 0.4, y: 15.2, w: DEC[1] - DEC[0] + 0.8, h: 19.2, kind: 'logic' });
  P.sel = [];
  for (let i = 0; i < 6; i++) P.sel.push(makeRoute(ctrl([[DEC[1] - 0.6, ySel(i)], [RX0 + 0.6, ySel(i)]])));
  C.blocks.rdec = logic(RX0, DEC0, 8 * RCW, DEC1 - DEC0, 'dec', 51);
  C.arrays.R = { cols: 8, rows: 8, cx: rcx, cy: rowY, cw: 1.32, ch: 2.05, dec };
  P.rfWord = [];
  for (let r = 0; r < 8; r++) P.rfWord.push(makeRoute(word([[rcx(r), DEC1], [rcx(r), A1]])));
  // le due letture vanno dritte all'ALU; la seconda prosegue sotto l'ALU fino alla memoria (il dato della STORE)
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    data([[RX0 - 0.3, y + OA], [ALU[0] + 0.9, y + OA]]);
    data([[RX0 - 0.3, y + OB], [XJ, y + OB], [XJ, y + OA], [DX1 + 0.2, y + OA]]);
  }
  P.rfA = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OA], [ALU[0] + 0.9, rowY(b) + OA]]));
  P.rfB = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OB], [ALU[0] + 0.9, rowY(b) + OB]]));
  C.foot.push({ x: RX0 - 0.6, y: DEC0 - 0.4, w: 8 * RCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });
  // il controllo: operazione all'ALU e alla memoria, registro di destinazione al decoder di scrittura
  P.opAlu = []; P.opMem = []; P.rdSel = [];
  for (let k = 3; k < 6; k++) {
    P.opAlu.push(makeRoute(ctrl([[xc(k), 16.2], [xc(k), yCtl(k)], [xop(k), yCtl(k)], [xop(k), A1]])));
    P.opMem.push(makeRoute(ctrl([[xop(k), yCtl(k)], [xm(k), yCtl(k)], [xm(k), DEC0 + 0.5]])));
  }
  for (let k = 0; k < 3; k++) P.rdSel.push(makeRoute(ctrl([[xc(k), 16.2], [xc(k), yRet(k)], [xrd(k), yRet(k)], [xrd(k), DEC0 + 0.5]])));

  // ---------- ALU a 8 fette, con la catena del riporto ----------
  P.carry = []; C.blocks.alu = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    C.blocks.alu.push(logic(ALU[0], y - 1.18, ALU[1] - ALU[0], 2.36, 'alu', 61));
    data([[ALU[1], y], [XC, y]]);
    if (b < 7) P.carry.push(makeRoute([[XC, y], [XC, rowY(b + 1)]]));
  }
  data([[XC, rowY(0)], [XC, rowY(7)]]);
  C.foot.push({ x: ALU[0] - 0.4, y: rowY(7) - 1.6, w: ALU[1] - ALU[0] + 1.4, h: rowY(0) - rowY(7) + 3.2, kind: 'logic' });
  C.blocks.op = C.blocks.alu;

  // ---------- memoria dati e multiplexer ----------
  P.byp = []; P.addr = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    P.byp.push(makeRoute(data([[RES, y + OW], [MUX[0] + 0.6, y + OW], [MUX[0] + 0.6, y + OA], [MX, y + OA]])));
    data([[DX1, y + OA], [MX, y + OA]]);
  }
  P.dWrite = cache((r, k, b) => makeRoute([[rcx(r), rowY(b) + OB], [XJ, rowY(b) + OB], [XJ, rowY(b) + OA], [dcx(k), rowY(b) + OA]]));
  P.dRead = cache((k, b) => makeRoute([[dcx(k), rowY(b) + OA], [MX, rowY(b) + OA]]));
  for (let i = 0; i < 4; i++) {
    const y = rowY(i) + OW;
    P.addr.push(makeRoute(data([[RES, y], [xa(i), y], [xa(i), yDec(i)], [DX0 + 0.6, yDec(i)]])));
  }
  C.blocks.ddec = logic(DX0, DEC0, 16 * DCW, DEC1 - DEC0, 'dec', 71);
  C.arrays.D = { cols: 16, rows: 8, cx: dcx, cy: b => rowY(b) - 0.32, cw: 0.8, ch: 1.5, dec };
  P.dWord = [];
  for (let k = 0; k < 16; k++) P.dWord.push(makeRoute(word([[dcx(k), DEC1], [dcx(k), A1]])));
  logic(DSA, 20.6, 1.6, A1 - 20.6, 'sense', 81);
  C.blocks.mux = logic(MUX[0], 20.6, MUX[1] - MUX[0], A1 - 20.6, 'sense', 91);
  C.foot.push({ x: DX0 - 0.6, y: DEC0 - 0.4, w: 16 * DCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });

  // ---------- l'anello che riporta il risultato ai registri ----------
  const wbPts = (b, xEnd) => {
    const y = rowY(b);
    return [[MX, y + OA], [xd(b), y + OA], [xd(b), yc(b)], [xr(b), yc(b)], [xr(b), y + OW], [xEnd, y + OW]];
  };
  for (let b = 0; b < 8; b++) data(wbPts(b, RX1 + 0.3));
  P.wb = cache((r, b) => makeRoute(wbPts(b, rcx(r))));

  // ---------- clock: solo il PC, il banco dei registri e la memoria lo ricevono ----------
  C.regs = { PC: 4.7, RF: 54.4, DM: 93.2 };
  spineClock(C, {
    x0: -4, x1: W + 4, y: SP.y, h: SP.h,
    branches: [{ reg: 'PC', x: 4.7, y1: 15.0 }, { reg: 'RF', x: 54.4, y1: 16.2 }, { reg: 'DM', x: 93.2, y1: 16.2 }],
  });

  // ---------- logica di contorno ----------
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

// ---------- il processore simulato: tutto si calcola subito, si scrive al fronte ----------
export function createCPU(rnd) {
  const program = makeProgram(rnd, 0);                              // un'istruzione alla volta: niente da evitare
  const regs = Array.from({ length: 8 }, () => (rnd() * 256) | 0);
  const mem = Array.from({ length: 16 }, () => (rnd() * 256) | 0);
  const bad = { regs: new Uint8Array(8), mem: new Uint8Array(16) };
  let pc = 0, seq = 0, cur = null;

  return {
    program, regs, mem, bad,
    get retiring() { return cur; },
    step() {
      if (cur && writesReg(cur.ins)) { regs[cur.ins.rd] = cur.val; bad.regs[cur.ins.rd] = cur.bad ? 1 : 0; }
      if (cur && cur.ins.op === OP.STORE) { mem[cur.addr] = cur.B; bad.mem[cur.addr] = cur.bad ? 1 : 0; }
      const ins = program[pc];
      const e = { seq: seq++, pc, ins: { ...ins }, enc: encode(ins), bad: false };
      pc = (pc + 1) & 15;
      e.A = regs[ins.rs1]; e.B = regs[ins.rs2];
      const r = alu(ins.op, e.A, e.B);
      e.res = r.res; e.carries = r.carries;
      e.addr = e.res & 15;
      e.val = ins.op === OP.LOAD ? mem[e.addr] : e.res;
      cur = e;
      return { cur: e };
    },
    // un bit arrivato dopo il fronte: il registro (o la memoria) lo scrive sbagliato
    corrupt(entry, key, b) {
      entry.bad = true;
      if (key !== 'ctl') entry[key] ^= 1 << b;
    },
  };
}

export const initView = cpu => ({
  v: { I: cpu.program.map(encode), R: cpu.regs.slice(), D: cpu.mem.slice() },
  bad: { R: new Uint8Array(8), D: new Uint8Array(16) }, pc: 0,
});
export function syncView(view, cpu) {
  view.v.R = cpu.regs.slice(); view.v.D = cpu.mem.slice();
  view.bad.R = cpu.bad.regs.slice(); view.bad.D = cpu.bad.mem.slice();
}
export const latchValue = { PC: view => view.pc };

export function anchors(C) {
  const alu = C.blocks.alu, G = C.g, mid = (lo, hi) => (lo + hi) / 2;
  return {
    ALU: { x: alu[0].x + alu[0].w / 2, y: Math.min(...alu.map(b => b.y)) - 0.5, h: 3.5 },
    MEMD: { x: mid(C.arrays.D.cx(0), C.arrays.D.cx(15)), y: G.DEC0 - 0.5, h: 2.5 },
    MEM: { x: mid(C.arrays.D.cx(0), C.arrays.D.cx(15)), y: G.DEC0, h: 3 },
    WB: { x: mid(C.arrays.R.cx(0), C.arrays.R.cx(7)), y: G.DEC0, h: 3 },
  };
}

// l'occhio di bue segue l'onda: è acceso solo lo stadio in cui si trova
export function spots() {
  return {
    base: 'IF',
    rects: [
      { stages: ['ID'], x0: 38.4 }, { stages: ['EX'], x0: 73.0 }, { stages: ['MEM'], x0: 89.6 }, { stages: ['WB'], x0: 117.4 },
      { stages: ['WB'], x0: 47.5, y0: 43.2 },
    ],
  };
}

// alla fine della partita: quanto ci avrebbe messo un clock fisso, tarato sul caso peggiore
export function results(x) {
  if (x.cycles < 3 || !x.worst || !x.span) return {};
  const fixed = x.cycles * x.worst, gain = Math.round((1 - x.span / fixed) * 100);
  return {
    notes: [t('proc.singolo.note', { worst: dec(x.worst), cycles: x.cycles, fixed: dec(fixed), span: dec(x.span), gain: gain > 0 ? t('proc.singolo.gain', { g: gain }) : '' })],
  };
}

// ---------- un ciclo: l'onda parte dal PC e arriva fino ai registri ----------
export function schedule(k, st, { missP }, res) {
  const { P, C, view } = k, hf = k.hf, e = st.cur;
  if (!e) return;
  const T = t => k.rel('PC', t);                                    // tutto parte dal fronte al PC
  const hue = k.hue(e), op = e.ins.op, cap = k.cap, pulse = k.pulse, goV = k.goV;
  view.pc = e.pc;

  // ---- prelievo: il PC sceglie la parola, i 12 bit dell'istruzione corrono al decoder ----
  k.span('IF', T(0));
  for (let b = 0; b < 4; b++) pulse(P.pcDec[b], T(0.01), T(0.05), hue, bit(e.pc, b), { w: 0.8, stage: 'IF' });
  k.spark(k.col('I', e.pc), T(0.04), 0.03 * hf, hue, 5);
  pulse(P.iWord[e.pc], T(0.05), T(0.08), hue, 1, { w: 0.9, tr: 3, stage: 'IF' });
  k.at(T(0.08), t => k.flash('I', e.pc, hue, t, false));
  let tIF = 0;
  for (let j = 0; j < 12; j++) tIF = Math.max(tIF, goV(P.iDec(e.pc, j), T(0.08), V, hue, bit(e.enc, j), { stage: 'IF' }).t1);
  k.spark(C.blocks.inc, T(0.03), 0.15 * hf, hue, 8);
  const nx = (e.pc + 1) & 15;
  for (let b = 0; b < 4; b++) pulse(P.pcFb[b], T(0.16), T(0.26), hue, bit(nx, b), { w: 0.8, hold: true });

  // ---- decodifica: si scelgono i registri, i due operandi corrono all'ALU ----
  k.span('ID', tIF);
  k.spark(C.blocks.dec, tIF, 0.1 * hf, hue, 20);
  const sel = [e.ins.rs1, e.ins.rs2];
  for (let i = 0; i < 6; i++) pulse(P.sel[i], tIF + 0.02 * hf, tIF + 0.05 * hf, hue, bit(sel[(i / 3) | 0], i % 3), { w: 0.75, stage: 'ID' });
  for (const r of new Set(sel)) {
    k.spark(k.col('R', r), tIF + 0.04 * hf, 0.02 * hf, hue, 4);
    pulse(P.rfWord[r], tIF + 0.04 * hf, tIF + 0.07 * hf, hue, 1, { w: 0.9, tr: 3, stage: 'ID' });
    k.at(tIF + 0.07 * hf, t => k.flash('R', r, hue, t, false));
  }
  for (let j = 0; j < 3; j++) pulse(P.opAlu[j], tIF + 0.02 * hf, tIF + 0.12 * hf, hue, bit(op, j), { w: 0.7, stage: 'ID' });
  for (let j = 0; j < 3; j++) pulse(P.rdSel[j], tIF + 0.02 * hf, tIF + 0.07 * hf, hue, bit(e.ins.rd, j), { w: 0.7, hold: true });
  let tID = 0;
  for (let b = 0; b < 8; b++) {
    tID = Math.max(tID, goV(P.rfA(e.ins.rs1, b), tIF + 0.06 * hf, V, hue, bit(e.A, b), { stage: 'ID' }).t1);
    tID = Math.max(tID, goV(P.rfB(e.ins.rs2, b), tIF + 0.065 * hf, V, hue, bit(e.B, b), { stage: 'ID' }).t1);
  }

  // ---- esecuzione: la somma aspetta il riporto, fetta dopo fetta ----
  k.span('EX', tID);
  k.at(tID, t => k.say(`${OPS[op]}!`, hue, t, k.anchor.ALU, 9, 'op'));
  let run = 0, tEX = tID;
  for (let b = 0; b < 8; b++) {
    const ts = e.carries ? tID + SLICE * (1 + run) * hf : tID + 0.03 * hf;
    k.spark(C.blocks.alu[b], ts - 0.02 * hf, 0.03 * hf, hue, 4);
    if (e.carries && b < 7) pulse(P.carry[b], ts, ts + SLICE * hf, hue, e.carries[b], { w: 0.85, tr: 2, stage: 'EX' });
    tEX = Math.max(tEX, ts + 0.02 * hf);
    k.stage('EX', tID, tEX);
    run = e.carries && e.carries[b] ? run + 1 : 0;
  }

  // ---- memoria: la LOAD legge, la STORE scrive (e finisce lì), le altre passano dal multiplexer ----
  k.span('MEM', tEX);
  let tMEM = tEX;
  if (op === OP.LOAD || op === OP.STORE) {
    for (let i = 0; i < 4; i++) pulse(P.addr[i], tEX, tEX + 0.07 * hf, hue, bit(e.addr, i), { w: 0.8, stage: 'MEM' });
    for (let j = 0; j < 3; j++) pulse(P.opMem[j], tIF + 0.12 * hf, tIF + 0.3 * hf, hue, bit(op, j), { w: 0.7, hold: true });
    k.spark(k.col('D', e.addr), tEX + 0.06 * hf, 0.03 * hf, hue, 5);
  }
  if (op === OP.LOAD) {
    const extra = k.rnd() < missP ? MISS : 0;                       // il dato non è pronto: si aspetta
    const t0 = tEX + 0.08 * hf;
    if (extra) {
      res.miss = true;
      k.at(t0, t => k.say('MISS!', '#ffd23a', t, k.anchor.MEMD, 0.9));
      k.miss('D', e.addr, t0, t0 + extra * hf);
    }
    pulse(P.dWord[e.addr], t0 + extra * hf, t0 + (extra + 0.04) * hf, hue, 1, { w: 0.9, tr: 3, stage: 'MEM' });
    k.at(t0 + (extra + 0.04) * hf, t => k.flash('D', e.addr, hue, t, false));
    for (let b = 0; b < 8; b++) tMEM = Math.max(tMEM, goV(P.dRead(e.addr, b), t0 + (extra + 0.05) * hf, V, hue, bit(e.val, b), { stage: 'MEM' }).t1);
  } else if (op === OP.STORE) {
    // il dato B è partito dal banco dei registri insieme agli operandi, sotto l'ALU
    k.wait('D', e.addr, 'MEM');
    let last = tEX;
    for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.dWrite(e.ins.rs2, e.addr, b), tIF + 0.065 * hf, V, hue, bit(e.B, b), { cap: cap(e, 'MEM', 'B', b) }).t1);
    last = Math.max(last, tEX + 0.08 * hf);
    pulse(P.dWord[e.addr], last, last + 0.05 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(e, 'MEM', 'ctl', 0) });
    k.at(last + 0.05 * hf, t => { view.v.D[e.addr] = e.B; view.bad.D[e.addr] = e.bad ? 1 : 0; k.flash('D', e.addr, hue, t, true); });
    return;                                                         // la STORE non scrive nessun registro
  } else {
    for (let b = 0; b < 8; b++) tMEM = Math.max(tMEM, goV(P.byp[b], tEX, V, hue, bit(e.val, b), { stage: 'MEM' }).t1);
  }

  // ---- scrittura: il risultato fa il giro e arriva al registro di destinazione ----
  if (!writesReg(e.ins)) return;
  const rd = e.ins.rd;
  k.span('WB', tMEM);
  k.wait('R', rd, 'WB');
  let last = tMEM;
  for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.wb(rd, b), tMEM, VW, hue, bit(e.val, b), { tr: 10, cap: cap(e, 'WB', 'val', b) }).t1);
  k.spark(k.col('R', rd), last - 0.03 * hf, 0.03 * hf, hue, 4);
  pulse(P.rfWord[rd], last, last + 0.04 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(e, 'WB', 'ctl', 0) });
  k.at(last + 0.04 * hf, t => { view.v.R[rd] = e.val; view.bad.R[rd] = e.bad ? 1 : 0; k.flash('R', rd, hue, t, true); });
}
