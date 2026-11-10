// Il processore multi-ciclo: ogni istruzione è spezzata in passi brevi, uno per colpo di clock.
// C'è una sola memoria per istruzioni e dati (le istruzioni a sinistra, i dati a destra) e una sola ALU, riusate
// a ogni passo; tra un passo e l'altro i risultati aspettano nei registri interni (IR, A, B, ALUOut, MDR).
// L'unità di controllo è una macchina a stati: le operazioni dell'ALU fanno 4 passi (IF ID EX WB), la LOAD 5,
// la STORE 4 (IF ID EX MEM). Il ritmo diventa un pattern: un colpo per passo, e passi di durata diversa.
// Il PC ha un incrementatore suo, come in molti processori veri (la ALU resta una sola per i calcoli).
import { makeRoute, createLayout, spineClock } from './route.js';
import { t, dec } from './i18n.js';
import { OP, OPS, encode, decode, alu, makeProgram } from './isa.js';

export const STATES = ['IF', 'ID', 'EX', 'MEM', 'WB'];
export const meta = {
  id: 'multiciclo', name: t('proc.multiciclo'), short: t('proc.multiciclo.short'),
  tag: t('proc.multiciclo.tag'),
  desc: t('proc.multiciclo.desc'),
  howto: t('proc.multiciclo.howto'),
  stages: STATES,
  chord: 'final',                                                   // l'accordo si chiude solo all'ultimo passo dell'istruzione
  look: {
    pkg: 'pga', ring: '#e2b85a',
    pal: {
      pkg: '#8b8794', die: '#1d5c5a', seal: '#62c8b8', plate: '#0e2c30', plinth: '#2a7672', cell: '#2e7e7a',
      fill: '#3a8c86', logic: '#8ee4d2', dec: '#58bcae', sense: '#a6f0e0', alu: '#baf6ea', pillar: '#3a8c86',
      wireD: '#ffb455', wireC: '#d8f0ff', via: '#ffc96c', pad: '#ffcc66', finger: '#e0a640', bond: '#ffe08a', pin: '#e6c66a',
      clock: '#c4f6ff', dot1: '#ff8a2a',
    },
  },
  freq: { unit: 'MHZ', k: 30 },
  power: { kind: 'heat', ref: 0.3, gain: 0.045, slow: 0.6 },
};

const SLICE = 0.06;                                                 // s per fetta di riporto
const MISS = 0.6;                                                   // s in più quando la memoria "manca" il dato
const V = 180, VC = 640, VB = 320, VW = 950;                       // tracce al secondo: dati, controllo, dato della STORE, bus lunghi
const bit = (v, i) => (v >> i) & 1;
const pathOf = op => (op === OP.LOAD ? STATES : op === OP.STORE ? ['IF', 'ID', 'EX', 'MEM'] : op === OP.NOP ? ['IF', 'ID'] : ['IF', 'ID', 'EX', 'WB']);
const lastOf = e => (e.ins ? pathOf(e.ins.op).at(-1) : null);
// le spie della macchina a stati: spenta, nel percorso dell'istruzione, al lavoro, finita
const LAMP = [[0.03, 0.04, 0.09], [0.3, 0.2, 0.05], [2.2, 1.1, 0.15], [0.35, 2.2, 0.55]];

// ---------- geometria ----------
// Da sinistra: banco dei registri, A e B, ALU, ALUOut, poi PC e memoria unica, IR e MDR, e il multiplexer
// della scrittura da cui parte l'anello che riporta il risultato ai registri. In alto l'unità di controllo.
export function buildCore() {
  const W = 101, H = 51;
  const L = createLayout(W, H), { C, data, ctrl, word, logic, cache } = L;

  const SP = { y: 5.2, h: 1.6 };
  const DEC0 = 16.4, DEC1 = 19.2, A1 = 42.6;
  const rowY = b => 20.8 + (11 - b) * 1.85;                       // 12 righe: i bit 8..11 servono solo alle istruzioni
  const OW = -0.6, OA = 0, OB = 0.6;
  const yr = b => 45.4 + b * 0.62;                                // canale dell'anello di scrittura
  const xw = b => 1.2 + (7 - b) * 0.55;                           // salite verso il banco dei registri
  const RX0 = 6.0, RCW = 1.75, rcx = r => RX0 + (r + 0.5) * RCW, RX1 = RX0 + 8 * RCW;
  const ABX = 21.4, FW = 1.6;
  const SRC = [23.8, 25.2], ALU = [26.2, 36.2], XC = 36.8, OUTX = 39.2;
  const INC = [41.0, 43.6], PCX = 44.4, MUX = [47.2, 48.8];
  const MX0 = 51.0, MCW = 0.95, mcx = k => MX0 + (k + 0.5) * MCW + (k >= 16 ? 0.8 : 0), MX1 = MX0 + 32 * MCW + 0.8;
  const SA = [82.8, 84.2], JOG = 84.6, IRX = 85.6, MDRX = 89.0, WBM = [92.8, 94.2];
  const xi = b => 87.8 + (11 - b) * 0.42, yi = b => 8.2 + b * 0.5;   // dall'IR all'unità di controllo (strato alto)
  const xd = b => 95.2 + b * 0.55;                                    // discese dell'anello
  const CU = { x: 54.0, y: 7.6, w: 22.0, h: 7.4 };
  const pcY = b => rowY(8 + b);
  const top = rowY(11) - 0.9, bottom = rowY(0) + 0.9, dataTop = rowY(7) - 0.9;
  const P = C.P;
  const dec = { y0: DEC0, y1: DEC1 };
  Object.assign(C.g, { DEC0, DEC1 });

  // ---------- banco dei registri: scrittura da sinistra, letture verso A e B ----------
  C.blocks.rdec = logic(RX0, DEC0, 8 * RCW, DEC1 - DEC0, 'dec', 51);
  C.arrays.R = { cols: 8, rows: 8, cx: rcx, cy: rowY, cw: 1.32, ch: 1.3, dec };
  P.rWord = [];
  for (let r = 0; r < 8; r++) P.rWord.push(makeRoute(word([[rcx(r), DEC1], [rcx(r), A1]])));
  P.rfA = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OA], [ABX, rowY(b) + OA]]));
  P.rfB = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OB], [ABX, rowY(b) + OB]]));
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    data([[RX0 - 0.3, y + OA], [ABX, y + OA]]);
    data([[RX0 - 0.3, y + OB], [ABX, y + OB]]);
    L.ff('A', ABX, y + OA, 0.5);
    L.ff('B', ABX, y + OB, 0.5);
  }
  C.foot.push({ x: RX0 - 0.6, y: DEC0 - 0.4, w: 8 * RCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });

  // ---------- ALU, con i multiplexer degli operandi e la catena del riporto ----------
  logic(SRC[0], dataTop, SRC[1] - SRC[0], bottom - dataTop, 'sense', 61);
  P.aluA = []; P.aluB = []; P.res = []; P.carry = []; C.blocks.alu = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    P.aluA.push(makeRoute(data([[ABX + FW, y + OA], [ALU[0] + 0.8, y + OA]])));
    P.aluB.push(makeRoute([[ABX + FW, y + OB], [ALU[0] + 0.8, y + OB]]));
    data([[ABX + FW, y + OB], [MX1 + 0.2, y + OB]]);              // B prosegue sotto l'ALU fino alla memoria (il dato della STORE)
    C.blocks.alu.push(logic(ALU[0], y - 0.82, ALU[1] - ALU[0], 1.64, 'alu', 62));
    data([[ALU[1], y], [XC, y]]);
    P.res.push(makeRoute(data([[ALU[1] - 1.4, y + OW], [OUTX, y + OW]])));
    L.ff('OUT', OUTX, y + OW, 0.5);
    if (b < 7) P.carry.push(makeRoute([[XC, y], [XC, rowY(b + 1)]]));
  }
  data([[XC, rowY(0)], [XC, rowY(7)]]);
  C.foot.push({ x: SRC[0] - 0.4, y: dataTop - 0.6, w: XC - SRC[0] + 1.0, h: bottom - dataTop + 1.2, kind: 'logic' });
  P.bMem = cache((k, b) => makeRoute([[ABX + FW, rowY(b) + OB], [mcx(k), rowY(b) + OB]]));

  // ---------- ALUOut: verso il multiplexer dell'indirizzo e verso quello della scrittura ----------
  P.out2mux = []; P.outAddr = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    P.out2mux.push(makeRoute(data([[OUTX + FW, y + OW], [WBM[0] + 0.7, y + OW]])));
    if (b < 4) P.outAddr.push(makeRoute([[OUTX + FW, y + OW], [MUX[0] + 0.7, y + OW]]));
  }

  // ---------- PC, incrementatore e multiplexer dell'indirizzo ----------
  C.blocks.inc = logic(INC[0], top, INC[1] - INC[0], rowY(8) + 0.9 - top, 'logic', 11);
  P.pcInc = []; P.pcMux = [];
  for (let b = 0; b < 4; b++) {
    L.ff('PC', PCX, pcY(b), 0.6, { bit: b });
    P.pcInc.push(makeRoute(data([[INC[1], pcY(b)], [PCX, pcY(b)]])));
    P.pcMux.push(makeRoute(data([[PCX + FW, pcY(b)], [MUX[0] + 0.7, pcY(b)]])));
  }
  C.blocks.mux = logic(MUX[0], top, MUX[1] - MUX[0], bottom - top, 'sense', 91);
  P.addrDec = [];
  for (let i = 0; i < 4; i++) {
    const x = MUX[0] + 0.35 + i * 0.35, y = 16.9 + i * 0.6;
    P.addrDec.push(makeRoute(data([[x, top], [x, y], [MX0 + 0.5, y]])));
  }

  // ---------- la memoria unica: 16 parole di istruzioni e 16 di dati ----------
  C.blocks.mdec = logic(MX0, DEC0, MX1 - MX0, DEC1 - DEC0, 'dec', 71);
  C.arrays.M = { cols: 32, rows: 12, cx: mcx, cy: rowY, cw: 0.72, ch: 1.3, dec };
  P.mWord = [];
  for (let k = 0; k < 32; k++) P.mWord.push(makeRoute(word([[mcx(k), DEC1], [mcx(k), A1]])));
  for (let b = 0; b < 12; b++) data([[MX0 - 0.3, rowY(b) + OA], [IRX, rowY(b) + OA]]);
  P.mRow = cache((k, b) => makeRoute([[mcx(k), rowY(b) + OA], [IRX, rowY(b) + OA]]));
  P.mdr = cache((k, b) => makeRoute([[mcx(k), rowY(b) + OA], [JOG, rowY(b) + OA], [JOG, rowY(b) + OB], [MDRX, rowY(b) + OB]]));
  logic(SA[0], top, SA[1] - SA[0], bottom - top, 'sense', 81);
  C.foot.push({ x: MX0 - 0.6, y: DEC0 - 0.4, w: MX1 - MX0 + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });

  // ---------- IR e MDR ----------
  for (let b = 0; b < 12; b++) L.ff('IR', IRX, rowY(b) + OA, 0.5);
  P.mdr2mux = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    data([[JOG, y + OA], [JOG, y + OB], [MDRX, y + OB]]);
    L.ff('MDR', MDRX, y + OB, 0.5);
    P.mdr2mux.push(makeRoute(data([[MDRX + FW, y + OB], [WBM[0] + 0.7, y + OB]])));
  }
  // l'istruzione sale all'unità di controllo sullo strato alto, a scalini per non incrociarsi
  P.irCtl = [];
  for (let b = 0; b < 12; b++) P.irCtl.push(makeRoute(ctrl([[IRX + FW, rowY(b) + OA], [xi(b), rowY(b) + OA], [xi(b), yi(b)], [CU.x + CU.w, yi(b)]])));

  // ---------- il multiplexer della scrittura e l'anello verso i registri ----------
  C.blocks.wbm = logic(WBM[0], dataTop, WBM[1] - WBM[0], bottom - dataTop, 'sense', 93);
  const wbPts = (b, xEnd) => {
    const y = rowY(b);
    return [[WBM[1], y + OA], [xd(b), y + OA], [xd(b), yr(b)], [xw(b), yr(b)], [xw(b), y + OW], [xEnd, y + OW]];
  };
  for (let b = 0; b < 8; b++) data(wbPts(b, RX1 + 0.3));
  P.wb = cache((r, b) => makeRoute(wbPts(b, rcx(r))));

  // ---------- l'unità di controllo, con le spie della macchina a stati sopra ----------
  C.blocks.cu = logic(CU.x, CU.y, CU.w, CU.h, 'logic', 41);
  C.foot.push({ x: CU.x - 0.4, y: CU.y - 0.4, w: CU.w + 0.8, h: CU.h + 0.8, kind: 'logic' });
  C.blocks.op = [C.blocks.cu];
  C.arrays.S = {
    cols: 5, rows: 1, cx: k => CU.x + 2.6 + k * 4.2, cy: () => CU.y + CU.h / 2, cw: 3.2, ch: 3.2, z: 1.5, lw: 0.84, lmax: 2.7,
    colors: LAMP,
  };
  // selezione dei registri (rs1, rs2 in lettura, rd in scrittura): escono a sinistra, a scalini
  P.sel = []; P.rdSel = [];
  for (let i = 0; i < 9; i++) {
    const x = RX0 + 1.0 + i * 1.5, y = 8.3 + i * 0.36;
    const r = makeRoute(ctrl([[CU.x, y], [x, y], [x, DEC0 + 0.4]]));
    (i < 6 ? P.sel : P.rdSel).push(r);
  }
  P.opAlu = [];
  for (let j = 0; j < 3; j++) {
    const x = 30.0 + j * 0.6, y = 12.0 + j * 0.4;
    P.opAlu.push(makeRoute(ctrl([[CU.x, y], [x, y], [x, dataTop]])));
  }
  P.iord = makeRoute(ctrl([[CU.x, 13.6], [MUX[0] + 0.8, 13.6], [MUX[0] + 0.8, top]]));
  P.memCtl = [0, 1].map(j => makeRoute(ctrl([[CU.x + 4 + j, CU.y + CU.h], [CU.x + 4 + j, DEC0 + 0.3]])));

  // ---------- clock: tutti i registri interni, il PC, la macchina a stati, banco e memoria ----------
  C.regs = { RF: 20.5, AB: 22.2, OUT: 40.0, PC: 45.2, MEM: 50.3, FSM: 65.0, IR: 86.4, MDR: 89.8 };
  spineClock(C, {
    x0: -4, x1: W + 4, y: SP.y, h: SP.h,
    branches: [
      { reg: 'RF', x: 20.5, y1: 16.0 }, { reg: 'AB', x: 22.2, y1: dataTop - 0.4 }, { reg: 'OUT', x: 40.0, y1: dataTop - 0.4 },
      { reg: 'PC', x: 45.2, y1: top - 0.4 }, { reg: 'MEM', x: 50.3, y1: 16.0 }, { reg: 'FSM', x: 65.0, y1: CU.y - 0.2 },
      { reg: 'IR', x: 86.4, y1: top - 0.4 }, { reg: 'MDR', x: 89.8, y1: dataTop - 0.4 },
    ],
  });

  // ---------- logica di contorno ----------
  logic(0.4, 7.8, 3.6, 7.4, 'fill', 101);
  logic(24.0, 17.6, 15.2, 6.2, 'fill', 102);
  logic(78.6, 7.8, 7.4, 6.8, 'fill', 103);
  logic(95.2, 7.8, 5.2, 18.0, 'fill', 104);
  logic(22.4, 8.0, 5.0, 2.4, 'fill', 105);
  logic(32.6, 8.0, 8.0, 3.0, 'fill', 106);
  return C;
}

// ---------- il processore simulato ----------
export function createCPU(rnd) {
  const program = makeProgram(rnd, 0);                              // un'istruzione alla volta: niente da evitare
  const regs = Array.from({ length: 8 }, () => (rnd() * 256) | 0);
  const data16 = Array.from({ length: 16 }, () => (rnd() * 256) | 0);
  const mem = [...program.map(encode), ...data16];                  // la memoria unica: 32 parole
  const bad = { regs: new Uint8Array(8), mem: new Uint8Array(32) };
  let pc = 0, seq = 0, cur = null;

  return {
    program, regs, mem, bad,
    get current() { return cur; },
    // l'istruzione si completa con il fronte che chiude il suo ultimo passo
    get retiring() { return cur && cur.state === lastOf(cur) ? cur : null; },
    step() {
      if (cur) {                                                    // il passo appena finito scrive il suo risultato
        if (cur.state === 'IF') pc = cur.next & 15;
        else if (cur.state === 'MEM' && cur.ins.op === OP.STORE) { mem[16 + cur.addr] = cur.B; bad.mem[16 + cur.addr] = cur.bad ? 1 : 0; }
        else if (cur.state === 'WB') { regs[cur.ins.rd] = cur.val; bad.regs[cur.ins.rd] = cur.bad ? 1 : 0; }
      }
      if (!cur || cur.state === lastOf(cur)) {                      // un'istruzione nuova…
        cur = { seq: seq++, pc, enc: mem[pc] & 0xfff, next: (pc + 1) & 15, state: 'IF', bad: false, ins: null };
      } else {                                                      // …o il passo dopo, scelto dalla macchina a stati
        const p = pathOf(cur.ins?.op ?? OP.NOP);
        cur.state = cur.state === 'IF' ? 'ID' : p[p.indexOf(cur.state) + 1];
      }
      const e = cur;                                                // cosa calcola la logica durante questo passo
      if (e.state === 'ID') { e.ins = decode(e.enc); e.A = regs[e.ins.rs1]; e.B = regs[e.ins.rs2]; }
      else if (e.state === 'EX') { const r = alu(e.ins.op, e.A, e.B); e.res = r.res; e.carries = r.carries; }
      else if (e.state === 'MEM') { e.addr = e.res & 15; if (e.ins.op === OP.LOAD) e.mdr = mem[16 + e.addr] & 255; }
      else if (e.state === 'WB') e.val = e.ins.op === OP.LOAD ? e.mdr : e.res;
      return { cur: e };
    },
    // un bit arrivato tardi: l'IR sbagliato cambia istruzione (e magari numero di passi), il PC sbagliato salta
    corrupt(entry, key, b) {
      entry.bad = true;
      if (key !== 'ctl') entry[key] ^= 1 << b;
    },
  };
}

export const initView = cpu => ({
  v: { M: cpu.mem.slice(), R: cpu.regs.slice(), S: [0, 0, 0, 0, 0] },
  bad: { M: new Uint8Array(32), R: new Uint8Array(8) }, pc: 0,
});
export function syncView(view, cpu) {
  view.v.M = cpu.mem.slice(); view.v.R = cpu.regs.slice();
  view.bad.M = cpu.bad.mem.slice(); view.bad.R = cpu.bad.regs.slice();
}
export const fills = { IR: 'IF', A: 'ID', B: 'ID', OUT: 'EX', MDR: 'MEM' };
export const latchValue = { PC: view => view.pc };

export function anchors(C) {
  const G = C.g, M = C.arrays.M;
  return {
    IF: { x: 86.4, y: G.DEC0 + 1, h: 3 }, ID: { x: 22.2, y: 26.0, h: 3 }, EX: { x: 40.0, y: 26.0, h: 3 },
    MEM: { x: (M.cx(16) + M.cx(31)) / 2, y: G.DEC0, h: 3 }, WB: { x: 13.0, y: G.DEC0, h: 3 },
    MEMD: { x: (M.cx(16) + M.cx(31)) / 2, y: G.DEC0 - 0.5, h: 2.5 },
  };
}

// l'occhio di bue: la memoria lavora nel prelievo e nell'accesso, il banco nella decodifica e nella scrittura;
// l'unità di controllo resta accesa finché qualcosa lavora
export function spots() {
  return {
    base: '*',
    rects: [
      { stages: ['ID', 'WB'], x1: 21.2 }, { stages: ['ID', 'EX'], x0: 21.2, x1: 23.4 }, { stages: ['EX'], x0: 23.4, x1: 40.8 },
      { stages: ['IF', 'MEM'], x0: 40.8, x1: 85.0 }, { stages: ['IF', 'ID'], x0: 85.0, x1: 88.6 }, { stages: ['MEM', 'WB'], x0: 88.6, x1: 92.6 },
      { stages: ['WB'], x0: 92.6 }, { stages: ['WB'], y0: 44.0 }, { stages: ['*'], x0: 53.4, x1: 76.6, y1: 15.6 },
    ],
  };
}

// alla fine: quanti colpi ci sono voluti, in media, per ogni istruzione
export function results(x) {
  if (!x.retired) return {};
  return { more: [[dec(x.cycles / x.retired, 2), t('proc.multiciclo.cpi')]] };
}

// ---------- un passo: cosa parte dopo il fronte, e quando arriva ----------
export function schedule(k, st, { missP }, res) {
  const { P, C, view } = k, hf = k.hf, e = st.cur, cap = k.cap, pulse = k.pulse, goV = k.goV;
  if (!e) return;
  const T = t => k.rel('FSM', t);
  const hue = k.hue(e), S = view.v.S, si = STATES.indexOf(e.state);
  const path = e.ins ? pathOf(e.ins.op) : ['IF'];
  for (let i = 0; i < 5; i++) S[i] = path.includes(STATES[i]) ? 1 : 0;   // le spie: il percorso di questa istruzione…
  S[si] = 2;                                                        // …e il passo al lavoro
  if (e.state === lastOf(e)) k.final();
  k.spark(C.blocks.cu, T(0.0), 0.05 * hf, hue, 6);
  let done = T(0.02);
  const track = p => { done = Math.max(done, p.t1); return p; };

  if (e.state === 'IF') {                                          // ---- prelievo: PC → memoria → IR; PC + 1 → PC ----
    for (let b = 0; b < 4; b++) pulse(P.pcMux[b], T(0.01), T(0.04), hue, bit(e.pc, b), { w: 0.8, stage: 'IF' });
    for (let i = 0; i < 4; i++) pulse(P.addrDec[i], T(0.04), T(0.09), hue, bit(e.pc, i), { w: 0.8, stage: 'IF' });
    pulse(P.iord, T(0.0), T(0.05), hue, 0, { w: 0.7 });
    for (let j = 0; j < 2; j++) pulse(P.memCtl[j], T(0.0), T(0.05), hue, j === 0, { w: 0.7 });
    k.spark(k.col('M', e.pc), T(0.08), 0.03 * hf, hue, 5);
    pulse(P.mWord[e.pc], T(0.09), T(0.13), hue, 1, { w: 0.9, tr: 3, stage: 'IF' });
    k.at(T(0.13), t => k.flash('M', e.pc, hue, t, false));
    for (let j = 0; j < 12; j++) track(goV(P.mRow(e.pc, j), T(0.12), V, hue, bit(e.enc, j), { hold: true, cap: cap(e, 'IF', 'enc', j) }));
    k.spark(C.blocks.inc, T(0.02), 0.1 * hf, hue, 6);
    for (let b = 0; b < 4; b++) track(pulse(P.pcInc[b], T(0.1), T(0.14), hue, bit(e.next, b), { w: 0.8, hold: true, cap: cap(e, 'IF', 'next', b) }));
  } else if (e.state === 'ID') {                                   // ---- decodifica: IR → controllo → registri → A, B ----
    let tCU = T(0.01);
    for (let j = 0; j < 12; j++) tCU = Math.max(tCU, goV(P.irCtl[j], T(0.01), VC, hue, bit(e.enc, j), { w: 0.7, stage: 'ID' }).t1);
    k.spark(C.blocks.cu, tCU, 0.06 * hf, hue, 14);
    k.at(tCU, t => k.say(`${OPS[e.ins.op]}!`, hue, t, k.anchor.ID, 9, 'op'));
    const sel = [e.ins.rs1, e.ins.rs2];
    let tSel = tCU;
    for (let i = 0; i < 6; i++) tSel = Math.max(tSel, goV(P.sel[i], tCU + 0.03 * hf, VC, hue, bit(sel[(i / 3) | 0], i % 3), { w: 0.7, stage: 'ID' }).t1);
    for (const r of new Set(sel)) {
      k.spark(k.col('R', r), tSel, 0.02 * hf, hue, 4);
      pulse(P.rWord[r], tSel, tSel + 0.03 * hf, hue, 1, { w: 0.9, tr: 3, stage: 'ID' });
      k.at(tSel + 0.03 * hf, t => k.flash('R', r, hue, t, false));
    }
    for (let b = 0; b < 8; b++) {
      track(goV(P.rfA(e.ins.rs1, b), tSel + 0.03 * hf, V, hue, bit(e.A, b), { hold: true, cap: cap(e, 'ID', 'A', b) }));
      track(goV(P.rfB(e.ins.rs2, b), tSel + 0.035 * hf, V, hue, bit(e.B, b), { hold: true, cap: cap(e, 'ID', 'B', b) }));
    }
  } else if (e.state === 'EX') {                                   // ---- esecuzione: A, B → ALU → ALUOut ----
    const op = e.ins.op;
    for (let b = 0; b < 8; b++) {
      pulse(P.aluA[b], T(0.01), T(0.04), hue, bit(e.A, b), { stage: 'EX' });
      pulse(P.aluB[b], T(0.01), T(0.04), hue, bit(e.B, b), { stage: 'EX' });
    }
    for (let j = 0; j < 3; j++) pulse(P.opAlu[j], T(0.0), T(0.06), hue, bit(op, j), { w: 0.7 });
    let run = 0;
    for (let b = 0; b < 8; b++) {
      const ts = e.carries ? T(0.1 + SLICE * (1 + run)) : T(0.16);
      k.spark(C.blocks.alu[b], ts - 0.03 * hf, 0.03 * hf, hue, 4);
      if (e.carries && b < 7) pulse(P.carry[b], ts, ts + SLICE * hf, hue, e.carries[b], { w: 0.85, tr: 2, stage: 'EX' });
      track(goV(P.res[b], ts + 0.01 * hf, V * 0.6, hue, bit(e.res, b), { hold: true, cap: cap(e, 'EX', 'res', b) }));
      run = e.carries && e.carries[b] ? run + 1 : 0;
    }
  } else if (e.state === 'MEM') {                                  // ---- memoria: ALUOut è l'indirizzo ----
    const a = 16 + e.addr, op = e.ins.op;
    for (let i = 0; i < 4; i++) pulse(P.outAddr[i], T(0.01), T(0.05), hue, bit(e.addr, i), { w: 0.8, stage: 'MEM' });
    for (let i = 0; i < 4; i++) pulse(P.addrDec[i], T(0.05), T(0.09), hue, bit(e.addr, i), { w: 0.8, stage: 'MEM' });
    pulse(P.iord, T(0.0), T(0.05), hue, 1, { w: 0.7 });
    for (let j = 0; j < 2; j++) pulse(P.memCtl[j], T(0.0), T(0.05), hue, j === (op === OP.STORE ? 1 : 0), { w: 0.7 });
    k.spark(k.col('M', a), T(0.08), 0.03 * hf, hue, 5);
    if (op === OP.LOAD) {
      const extra = k.rnd() < missP ? MISS : 0;                     // il dato non è pronto: si aspetta
      if (extra) {
        res.miss = true;
        k.at(T(0.09), t => k.say('MISS!', '#ffd23a', t, k.anchor.MEMD, 0.9));
        k.miss('M', a, T(0.09), T(0.09 + extra));
      }
      pulse(P.mWord[a], T(0.1 + extra), T(0.14 + extra), hue, 1, { w: 0.9, tr: 3, stage: 'MEM' });
      k.at(T(0.14 + extra), t => k.flash('M', a, hue, t, false));
      for (let b = 0; b < 8; b++) track(goV(P.mdr(a, b), T(0.13 + extra), V, hue, bit(e.mdr, b), { hold: true, cap: cap(e, 'MEM', 'mdr', b) }));
    } else {                                                        // STORE: B corre dal suo registro fino alla parola
      k.wait('M', a, 'MEM');
      let last = T(0.1);
      for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.bMem(a, b), T(0.02), VB, hue, bit(e.B, b), { cap: cap(e, 'MEM', 'B', b) }).t1);
      track(pulse(P.mWord[a], last, last + 0.05 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(e, 'MEM', 'ctl', 0) }));
      k.at(last + 0.05 * hf, t => { view.v.M[a] = e.B; view.bad.M[a] = e.bad ? 1 : 0; k.flash('M', a, hue, t, true); });
    }
  } else if (e.state === 'WB') {                                   // ---- scrittura: dall'MDR o da ALUOut, per l'anello ----
    const rd = e.ins.rd, src = e.ins.op === OP.LOAD ? P.mdr2mux : P.out2mux;
    k.wait('R', rd, 'WB');
    for (let j = 0; j < 3; j++) pulse(P.rdSel[j], T(0.0), T(0.07), hue, bit(rd, j), { w: 0.7, hold: true, stage: 'WB' });
    let last = T(0.05);
    for (let b = 0; b < 8; b++) {
      const t1 = goV(src[b], T(0.01), VW, hue, bit(e.val, b), { stage: 'WB' }).t1;
      last = Math.max(last, goV(P.wb(rd, b), t1, VW, hue, bit(e.val, b), { tr: 10, cap: cap(e, 'WB', 'val', b) }).t1);
    }
    k.spark(k.col('R', rd), last - 0.03 * hf, 0.03 * hf, hue, 4);
    track(pulse(P.rWord[rd], last, last + 0.04 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(e, 'WB', 'ctl', 0) }));
    k.at(last + 0.04 * hf, t => { view.v.R[rd] = e.val; view.bad.R[rd] = e.bad ? 1 : 0; k.flash('R', rd, hue, t, true); });
  }
  k.at(done, () => { if (view.v.S[si] === 2) view.v.S[si] = 3; });  // la spia diventa verde quando il passo ha finito
}

