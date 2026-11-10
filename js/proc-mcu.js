// Il microcontrollore: un piccolo computer che passa quasi tutto il tempo a dormire, a batteria.
// Si sveglia quando un piedino manda un interrupt (un pulsante, un byte sulla seriale, il timer, l'ADC):
// l'oscillatore riparte, il processore preleva la routine dell'interrupt e tu le dai il clock, istruzione per
// istruzione, prima che scada il tempo (OVERRUN). Con RETI torna a dormire da solo (sleep-on-exit): mentre dorme
// il clock è spento, e un colpo dato allora non fa niente, se non consumare batteria. Se intanto è arrivato un
// altro interrupt, la routine successiva parte subito (tail-chaining, come nei Cortex-M).
// Il nucleo è una pipeline a 2 stadi, come negli AVR: mentre un'istruzione si esegue, la prossima si preleva.
import { makeRoute, createLayout, spineClock } from './route.js';
import { t } from './i18n.js';

export const meta = {
  id: 'mcu', name: t('proc.mcu'), short: t('proc.mcu.short'),
  tag: t('proc.mcu.tag'),
  desc: t('proc.mcu.desc'),
  howto: t('proc.mcu.howto'),
  stages: ['IRQ', 'IF', 'EX', 'IO'],
  dim: 0.46,                                                        // addormentato il chip è quasi spento
  wasteText: t('proc.mcu.asleep'),
  look: {
    pkg: 'dip', pins: 14,
    pal: {
      pkg: '#2a2a36', die: '#4a2440', seal: '#e07ab0', plate: '#1e0c1a', plinth: '#6a3460', cell: '#743c68',
      fill: '#80466e', logic: '#f2b2d6', dec: '#cc80b0', sense: '#f8c8e2', alu: '#ffd8ee', port: '#a0d870', pillar: '#80466e',
      wireD: '#ffc75a', wireC: '#c8f0ff', via: '#ffd878', pad: '#ffd36b', finger: '#d6a24a', bond: '#ffe08a', pin: '#d4d8e2',
      clock: '#c4f6ff', dot1: '#ff8a2a',
    },
  },
  freq: { unit: 'MHZ', k: 4.8 },
  power: { kind: 'battery', ref: 0.35, cost: 0.0045, waste: 0.012, slow: 0.9 },
};

const OP = { ADD: 0, SUB: 1, XOR: 2, IN: 3, OUT: 4, LD: 5, ST: 6, RETI: 7 };
const OPS = ['ADD', 'SUB', 'XOR', 'IN', 'OUT', 'LD', 'ST', 'RETI'];
const PORT = ['PIND', 'UDR', 'ADCH', 'PORTB', 'OCR'];
const enc = (op, rd = 0, rs1 = 0, rs2 = 0) => (op << 9) | (rd << 6) | (rs1 << 3) | rs2;
const dec = e => ({ op: (e >> 9) & 7, rd: (e >> 6) & 7, rs1: (e >> 3) & 7, rs2: e & 7 });
// la flash: quattro routine di interrupt da 4 istruzioni, una dietro l'altra (il vettore è l'indirizzo della prima)
const FLASH = [
  enc(OP.IN, 1, 0), enc(OP.XOR, 2, 2, 1), enc(OP.OUT, 3, 2), enc(OP.RETI),        // pulsante: accende o spegne il LED
  enc(OP.IN, 3, 1), enc(OP.ST, 0, 4, 3), enc(OP.ADD, 4, 4, 5), enc(OP.RETI),       // seriale: il byte va nel buffer in SRAM
  enc(OP.LD, 6, 0), enc(OP.ADD, 6, 6, 5), enc(OP.ST, 0, 0, 6), enc(OP.RETI),       // timer: conta un tic in SRAM
  enc(OP.IN, 1, 2), enc(OP.SUB, 2, 1, 7), enc(OP.OUT, 4, 2), enc(OP.RETI),         // ADC: soglia e uscita PWM
];
// le sorgenti: chi le manda, il vettore, la scadenza (s) e il piedino (la periferica sul bordo in alto)
const SRC = {
  BTN: { vec: 0, d: 4.0, peri: 'PORTD', name: 'PULSANTE' },
  RX: { vec: 4, d: 3.4, peri: 'UART', name: 'SERIALE' },
  TMR: { vec: 8, d: 4.0, peri: 'TIMER', name: 'TIMER' },
  ADC: { vec: 12, d: 3.7, peri: 'ADC', name: 'ADC' },
};
const SOURCES = Object.keys(SRC);
const MSG = [...'OVERCLOCK '].map(c => c.charCodeAt(0));            // quello che arriva dalla seriale
const V = 320, VC = 800, VB = 520, VW = 1200;
const SLICE = 0.04;
const bit = (v, i) => (v >> i) & 1;

// ---------- geometria ----------
// In alto, lungo il bordo e vicino ai loro piedini, le periferiche e l'oscillatore, con il bus delle periferiche sotto.
// Sotto: controllore degli interrupt, PC, flash, IR, decoder, registri, ALU, SRAM e l'anello di scrittura.
export function buildCore() {
  const W = 101, H = 46;
  const L = createLayout(W, H), { C, data, ctrl, word, logic, cache } = L;
  const SP = { y: 4.4, h: 1.4 };
  const DEC0 = 21.6, DEC1 = 24.0;
  const OW = -0.55, OA = 0, OB = 0.55;
  const irow = j => 25.4 + (11 - j) * 1.0, IA1 = 37.0;
  const rowY = b => 25.0 + (7 - b) * 1.75, A1 = 38.4;
  const pcY = b => 17.4 + (3 - b) * 1.05;
  const PCX = 6.4, FW = 1.4;
  const IX0 = 10.0, ICW = 1.36, icx = k => IX0 + (k + 0.5) * ICW;
  const IRX = 34.2, DECX = [37.0, 43.0];
  const xr = b => 43.8 + (7 - b) * 0.5;
  const RX0 = 48.2, RCW = 1.7, rcx = r => RX0 + (r + 0.5) * RCW, RX1 = RX0 + 8 * RCW;
  const ALU = [64.4, 72.0], XC = 72.6;
  const xa = i => 73.4 + (3 - i) * 0.38, yDec = i => 23.6 - i * 0.5, XJ = 75.2;
  const DX0 = 76.0, DCW = 1.05, dcx = k => DX0 + (k + 0.5) * DCW, DX1 = DX0 + 16 * DCW;
  const xd = b => 94.4 + b * 0.5, yc = b => 40.2 + b * 0.6;
  const BUS = 15.2, STUB = 69.0;                                    // bus delle periferiche; dove scende verso l'ALU
  const P = C.P;
  const decb = { y0: DEC0, y1: DEC1 };
  Object.assign(C.g, { DEC0, DEC1 });

  // ---------- periferiche lungo il bordo in alto ----------
  const peri = { OSC: [1.6, 9.4], PORTB: [12.0, 22.0], TIMER: [25.0, 35.0], UART: [38.0, 48.0], ADC: [51.0, 61.0], PORTD: [64.0, 74.0], BOD: [78.0, 98.6] };
  C.peri = {};
  for (const [id, [x0, x1]] of Object.entries(peri)) C.peri[id] = { ...logic(x0, 7.4, x1 - x0, 6.0, id === 'OSC' || id === 'BOD' ? 'logic' : 'port', 200 + x0), cx: (x0 + x1) / 2, id };
  // i registri delle periferiche, una colonna di 8 bit sopra ognuna: PIND, UDR, ADCH, PORTB, OCR
  const portX = [C.peri.PORTD, C.peri.UART, C.peri.ADC, C.peri.PORTB, C.peri.TIMER].map(b => b.x + b.w - 1.8);
  C.arrays.P = { cols: 5, rows: 8, cx: k => portX[k], cy: j => 8.0 + (7 - j) * 0.68, cw: 1.2, ch: 0.52, z: 0.9, lw: 0.7 };
  // il bus delle periferiche e le prese di ognuna
  data([[8.6, BUS], [80.0, BUS]]); data([[8.6, BUS + 0.6], [80.0, BUS + 0.6]]);
  P.bus = cache((id, back) => {
    const b = C.peri[id], pts = [[b.cx, 13.4], [b.cx, BUS], [STUB, BUS], [STUB, rowY(7) - 0.9]];
    return makeRoute(back ? pts.slice().reverse() : pts);
  });
  for (const id of ['PORTB', 'TIMER', 'UART', 'ADC', 'PORTD']) data([[C.peri[id].cx, 13.4], [C.peri[id].cx, BUS]]);
  data([[STUB, BUS + 0.6], [STUB, rowY(7) - 0.9]]);
  P.busAddr = cache(id => makeRoute(ctrl([[DECX[0] + 1.0, DEC0 - 0.2], [DECX[0] + 1.0, BUS + 1.4], [C.peri[id].cx + 0.8, BUS + 1.4], [C.peri[id].cx + 0.8, 13.4]])));
  ctrl([[DECX[0] + 1.0, DEC0 - 0.2], [DECX[0] + 1.0, BUS + 1.4], [C.peri.PORTB.cx + 0.8, BUS + 1.4]]);
  ctrl([[DECX[0] + 1.0, BUS + 1.4], [C.peri.PORTD.cx + 0.8, BUS + 1.4]]);
  for (const id of ['PORTB', 'TIMER', 'UART', 'ADC', 'PORTD']) ctrl([[C.peri[id].cx + 0.8, BUS + 1.4], [C.peri[id].cx + 0.8, 13.4]]);
  // le linee degli interrupt: da ogni periferica al controllore, a sinistra
  P.irq = {};
  for (const id of ['TIMER', 'UART', 'ADC', 'PORTD']) {
    const b = C.peri[id], y = 14.0 + ['TIMER', 'UART', 'ADC', 'PORTD'].indexOf(id) * 0.2;
    P.irq[id] = makeRoute(ctrl([[b.x + 1.0, 13.4], [b.x + 1.0, y], [4.4 - ['TIMER', 'UART', 'ADC', 'PORTD'].indexOf(id) * 0.35, y], [4.4 - ['TIMER', 'UART', 'ADC', 'PORTD'].indexOf(id) * 0.35, 16.6]]));
  }

  // ---------- controllore degli interrupt, PC e oscillatore ----------
  C.blocks.nvic = logic(0.6, 16.6, 4.6, 11.4, 'logic', 11);
  P.osc = makeRoute(ctrl([[2.6, 16.6], [2.6, 13.4]]));
  P.vec = []; P.pcDec = []; P.ret = [];
  for (let b = 0; b < 4; b++) {
    L.ff('PC', PCX, pcY(b), 0.7, { bit: b, w: FW });
    P.vec.push(makeRoute(data([[5.2, pcY(b)], [PCX, pcY(b)]])));
    P.pcDec.push(makeRoute(data([[PCX + FW, pcY(b)], [9.4 + b * 0.8, pcY(b)], [9.4 + b * 0.8, DEC0 + 0.4]])));
  }
  // RETI: l'indirizzo di ritorno sale dalla pila in SRAM e torna al PC, sullo strato alto
  P.ret = makeRoute(ctrl([[dcx(14), DEC0], [dcx(14), 20.4], [8.2, 20.4], [8.2, pcY(0) + 0.5]]));

  // ---------- flash, IR e decoder ----------
  C.blocks.idec = logic(IX0, DEC0, 16 * ICW, DEC1 - DEC0, 'dec', 21);
  C.arrays.I = { cols: 16, rows: 12, cx: icx, cy: irow, cw: 1.06, ch: 0.74, dec: decb };
  P.iWord = [];
  for (let k = 0; k < 16; k++) P.iWord.push(makeRoute(word([[icx(k), DEC1], [icx(k), IA1]])));
  for (let j = 0; j < 12; j++) { data([[IX0 - 0.3, irow(j)], [IRX, irow(j)]]); L.ff('IR', IRX, irow(j), 0.6, { w: FW }); data([[IRX + FW, irow(j)], [DECX[0] + 0.6, irow(j)]]); }
  P.iRow = cache((k, j) => makeRoute([[icx(k), irow(j)], [IRX, irow(j)]]));
  P.irDec = Array.from({ length: 12 }, (_, j) => makeRoute([[IRX + FW, irow(j)], [DECX[0] + 0.6, irow(j)]]));
  logic(32.0, 24.8, 1.2, IA1 - 24.8, 'sense', 31);
  C.foot.push({ x: IX0 - 0.6, y: DEC0 - 0.4, w: 16 * ICW + 1.2, h: IA1 - DEC0 + 0.8, kind: 'array' });
  C.blocks.dec = logic(DECX[0], DEC0 - 0.6, DECX[1] - DECX[0], 16.4, 'logic', 41);
  C.blocks.op = [C.blocks.dec];

  // ---------- banco dei registri ----------
  C.blocks.rdec = logic(RX0, DEC0, 8 * RCW, DEC1 - DEC0, 'dec', 51);
  C.arrays.R = { cols: 8, rows: 8, cx: rcx, cy: rowY, cw: 1.28, ch: 1.24, dec: decb };
  P.rWord = [];
  for (let r = 0; r < 8; r++) P.rWord.push(makeRoute(word([[rcx(r), DEC1], [rcx(r), A1]])));
  P.sel = [];
  for (let i = 0; i < 6; i++) P.sel.push(makeRoute(ctrl([[DECX[1], 20.0 + i * 0.25], [RX0 + 0.8 + i * 0.4, 20.0 + i * 0.25], [RX0 + 0.8 + i * 0.4, DEC0 + 0.3]])));
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    data([[RX0 - 0.3, y + OA], [ALU[0] + 0.8, y + OA]]);
    data([[RX0 - 0.3, y + OB], [XJ, y + OB], [XJ, y + OA], [DX1 + 0.2, y + OA]]);
  }
  P.rfA = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OA], [ALU[0] + 0.8, rowY(b) + OA]]));
  P.rfB = cache((r, b) => makeRoute([[rcx(r), rowY(b) + OB], [ALU[0] + 0.8, rowY(b) + OB]]));
  P.dWrite = cache((r, k, b) => makeRoute([[rcx(r), rowY(b) + OB], [XJ, rowY(b) + OB], [XJ, rowY(b) + OA], [dcx(k), rowY(b) + OA]]));
  C.foot.push({ x: RX0 - 0.6, y: DEC0 - 0.4, w: 8 * RCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });

  // ---------- ALU ----------
  P.carry = []; C.blocks.alu = [];
  for (let b = 0; b < 8; b++) {
    const y = rowY(b);
    C.blocks.alu.push(logic(ALU[0], y - 0.78, ALU[1] - ALU[0], 1.56, 'alu', 61));
    data([[ALU[1], y], [XC, y]]);
    if (b < 7) P.carry.push(makeRoute([[XC, y], [XC, rowY(b + 1)]]));
  }
  data([[XC, rowY(0)], [XC, rowY(7)]]);
  C.foot.push({ x: ALU[0] - 0.4, y: rowY(7) - 1.4, w: ALU[1] - ALU[0] + 1.2, h: rowY(0) - rowY(7) + 2.8, kind: 'logic' });
  P.op = [0, 1, 2].map(j => makeRoute(ctrl([[DECX[1], 18.6 + j * 0.3], [66.0 + j * 0.5, 18.6 + j * 0.3], [66.0 + j * 0.5, rowY(7) - 0.8]])));

  // ---------- SRAM e l'anello di scrittura ----------
  P.addr = [];
  for (let i = 0; i < 4; i++) P.addr.push(makeRoute(data([[ALU[1] - 1.0, rowY(i) + OW], [xa(i), rowY(i) + OW], [xa(i), yDec(i)], [DX0 + 0.5, yDec(i)]])));
  C.blocks.ddec = logic(DX0, DEC0, 16 * DCW, DEC1 - DEC0, 'dec', 71);
  C.arrays.D = { cols: 16, rows: 8, cx: dcx, cy: b => rowY(b) - 0.2, cw: 0.8, ch: 1.2, dec: decb };
  P.dWord = [];
  for (let k = 0; k < 16; k++) P.dWord.push(makeRoute(word([[dcx(k), DEC1], [dcx(k), A1]])));
  logic(DX1 + 0.4, 24.2, 1.2, A1 - 24.2, 'sense', 81);
  C.foot.push({ x: DX0 - 0.6, y: DEC0 - 0.4, w: 16 * DCW + 1.2, h: A1 - DEC0 + 0.8, kind: 'array' });
  // il risultato dell'ALU (o il dato letto) fa il giro e torna ai registri
  const wbPts = (b, xs, ys, xEnd) => [[xs, ys], [xd(b), ys], [xd(b), yc(b)], [xr(b), yc(b)], [xr(b), rowY(b) + OW], [xEnd, rowY(b) + OW]];
  for (let b = 0; b < 8; b++) data(wbPts(b, ALU[1] - 1.0, rowY(b) + OW, RX1 + 0.3));
  for (let b = 0; b < 8; b++) data([[DX1, rowY(b) + OA], [xd(b), rowY(b) + OA]]);
  P.wbAlu = cache((r, b) => makeRoute(wbPts(b, ALU[1] - 1.0, rowY(b) + OW, rcx(r))));
  P.wbMem = cache((k, r, b) => makeRoute(wbPts(b, dcx(k), rowY(b) + OA, rcx(r))));

  // ---------- clock: nasce dall'oscillatore, in alto a sinistra ----------
  C.regs = { PC: 7.1, IR: 35.0, RF: 47.8, IO: 52.0, DM: 75.6 };
  spineClock(C, {
    x0: -4, x1: W + 4, y: SP.y, h: SP.h,
    branches: [{ reg: 'PC', x: 7.1, y1: 16.4 }, { reg: 'IR', x: 35.0, y1: 24.4 }, { reg: 'RF', x: 47.6, y1: 21.2 }, { reg: 'DM', x: 75.6, y1: 21.2 }],
  });

  // ---------- contorno ----------
  logic(0.6, 29.0, 8.4, 14.0, 'fill', 101);
  logic(10.0, 38.2, 32.0, 5.0, 'fill', 102);
  logic(80.0, 15.8, 18.6, 3.6, 'fill', 103);
  return C;
}

// ---------- il microcontrollore simulato ----------
export function createCPU(rnd) {
  const regs = [15, 0, 0, 0, 0, 1, 0, 128];                         // r0 = indirizzo del contatore, r4 = buffer, r5 = 1, r7 = soglia
  const mem = Array.from({ length: 16 }, () => (rnd() * 256) | 0);  // la SRAM all'accensione: valori a caso
  mem[15] = 0;
  const io = [0, 0, 0, 0, 0];                                       // PIND, UDR, ADCH, PORTB, OCR
  const bad = { regs: new Uint8Array(8), mem: new Uint8Array(16) };
  const future = [], pending = [];                                   // interrupt in arrivo; arrivati e non ancora serviti
  let exec = null, fetch = null, cur = null, seq = 0, msg = 0, nIrq = 0;
  let armed = false;

  const pick = () => SOURCES[(rnd() * SOURCES.length) | 0];
  const schedule = t => future.push({ t, src: pick() });
  const instr = (pc, irq) => ({ seq: seq++, pc, enc: FLASH[pc], irq, bad: false });

  const cpu = {
    regs, mem, io, bad, future, pending,
    get armed() { return armed; },
    get asleep() { return !exec && !fetch; },
    get current() { return cur; },
    get exec() { return exec; },
    get fetching() { return fetch; },
    get retiring() { return exec; },
    // gli interrupt ancora da finire, per le scadenze
    open: () => [...(cur ? [cur] : []), ...pending],
    arm(t) { armed = true; future.length = 0; schedule(t + 0.8); },
    // un interrupt arriva sul piedino: la periferica prepara il suo dato; a volte ne arriva un altro subito dopo
    arrive(q) {
      q.id = nIrq++; q.deadline = q.t + SRC[q.src].d; q.late = false;
      if (q.src === 'BTN') io[0] ^= 0b100;
      else if (q.src === 'RX') { io[1] = MSG[msg++ % MSG.length]; }
      else if (q.src === 'ADC') io[2] = (rnd() * 256) | 0;
      pending.push(q);
      if (!future.length && rnd() < 0.24) schedule(q.t + 0.9 + rnd() * 0.7);
      return q;
    },
    // il controllore degli interrupt manda il vettore: comincia il prelievo della prima istruzione della routine
    wake() { cur = pending.shift(); fetch = instr(SRC[cur.src].vec, cur); return cur; },
    step(now) {
      let done = null;
      const e = exec;
      if (e) {                                                      // lo stadio di esecuzione scrive i suoi risultati
        const { op, rd } = e.ins;
        if (op === OP.ST) { mem[e.addr] = e.val; bad.mem[e.addr] = e.bad ? 1 : 0; }
        else if (op === OP.OUT) io[rd % 5] = e.val;
        else if (op !== OP.RETI) { regs[rd] = e.val; bad.regs[rd] = e.bad ? 1 : 0; }
        if (op === OP.RETI) {                                       // la routine è finita; se c'era la catena, tocca alla prossima
          done = cur;
          cur = e.chain ? pending.shift() : null;
          if (!cur && !pending.length && !future.length) schedule(now + 0.7 + rnd() * 1.7);
        }
      }
      exec = fetch; fetch = null;
      if (exec) {                                                   // decodifica e calcolo dell'istruzione che entra
        const ins = exec.ins = dec(exec.enc), A = regs[ins.rs1], B = regs[ins.rs2];
        exec.A = A; exec.B = B; exec.carries = null;
        if (ins.op === OP.ADD || ins.op === OP.SUB) {
          const b = ins.op === OP.SUB ? (~B & 255) : B;
          let c = ins.op === OP.SUB ? 1 : 0, res = 0;
          exec.carries = [];
          for (let i = 0; i < 8; i++) { const ai = bit(A, i), bi = bit(b, i); res |= (ai ^ bi ^ c) << i; c = (ai & bi) | (ai & c) | (bi & c); exec.carries.push(c); }
          exec.val = res & 255;
        } else if (ins.op === OP.XOR) exec.val = A ^ B;
        else if (ins.op === OP.IN) exec.val = io[ins.rs1 % 5];
        else if (ins.op === OP.OUT) exec.val = A;
        else if (ins.op === OP.LD) { exec.addr = A & 15; exec.val = mem[exec.addr]; }
        else if (ins.op === OP.ST) { exec.addr = A & 15; exec.val = B; }
        else exec.val = mem[14];                                    // RETI: l'indirizzo di ritorno dalla pila
        // la prossima istruzione: la successiva della routine, o (se questa è RETI) la routine in attesa
        if (ins.op !== OP.RETI) fetch = instr((exec.pc + 1) & 15, cur);
        else if (pending.length) { fetch = instr(SRC[pending[0].src].vec, pending[0]); exec.chain = pending[0]; }
      }
      return { exec, fetch, done };
    },
    // un bit in ritardo: il valore scritto esce sbagliato; l'istruzione prelevata male diventa un'altra
    corrupt(entry, key, b) {
      entry.bad = true;
      if (key === 'enc') { entry.enc ^= 1 << b; }
      else if (key !== 'ctl') entry[key] ^= 1 << b;
    },
  };
  return cpu;
}

// addormentato: niente da eseguire né da prelevare (il motore lo chiede prima di dare un colpo)
export function asleep(cpu) { return cpu.asleep; }

export const initView = cpu => ({
  v: { I: FLASH.slice(), R: cpu.regs.slice(), D: cpu.mem.slice(), P: cpu.io.slice() },
  bad: { R: new Uint8Array(8), D: new Uint8Array(16) }, pc: 0,
});
export function syncView(view, cpu) {
  view.v.R = cpu.regs.slice(); view.v.D = cpu.mem.slice(); view.v.P = cpu.io.slice();
  view.bad.R = cpu.bad.regs.slice(); view.bad.D = cpu.bad.mem.slice();
}
export const fills = { IR: 'IF' };
export const latchValue = { PC: view => view.pc };

export function anchors(C) {
  const a = { IF: { x: 35.0, y: 23.0, h: 3 }, EX: { x: 68.2, y: 22.4, h: 3 }, IO: { x: 60.0, y: 16.2, h: 2.6 }, IRQ: { x: 3.0, y: 15.6, h: 3 }, CORE: { x: 40.0, y: 28.0, h: 2.2 } };
  for (const [s, d] of Object.entries(SRC)) a[s] = { x: C.peri[d.peri].cx, y: 7.0, h: 2.4 };
  return a;
}

export function spots() {
  return {
    base: '*',
    rects: [
      { stages: ['IRQ', 'IO'], y1: 16.2 }, { stages: ['IRQ', 'IF'], x1: 9.6, y0: 16.2 },
      { stages: ['IF'], x0: 9.6, x1: 36.0, y0: 16.2 }, { stages: ['EX'], x0: 36.0, y0: 16.2 },
    ],
  };
}

export function results(x) {
  const more = [[String(x.irqs || 0), t('proc.mcu.irqs')], [String(x.overruns || 0), t('proc.mcu.overruns')],
    [`${Math.round((x.battery ?? 1) * 100)}%`, t('proc.mcu.battery')], [String(x.wasted || 0), t('proc.mcu.wasted')]];
  return { more };
}

// ---------- gli eventi che non aspettano il clock: interrupt, scadenze, il sonno ----------
export function onPlay(k, t) { k.cpu.arm(t); }
export function update(k, now) {
  const cpu = k.cpu;
  if (!cpu.armed) return;
  while (cpu.future.length && now >= cpu.future[0].t) {             // un piedino si accende
    const q = cpu.arrive(cpu.future.shift());
    k.say('IRQ!', '#ffd23a', q.t, k.anchor[q.src], 0.9);
    k.notice({ type: 'info', sound: 'irq' });
  }
  if (cpu.asleep && cpu.pending.length) wake(k, now);               // il controllore sveglia il nucleo
  for (const q of cpu.open()) {                                     // le scadenze
    if (q.late || now <= q.deadline) continue;
    q.late = true;
    k.notice({ type: 'hurt', text: 'OVERRUN!', why: 'overrun', stat: 'overruns' });
    k.say('OVERRUN!', k.RED, now, k.anchor[q.src], 1.1);
  }
  if (cpu.asleep && !cpu.pending.length && now > zT) {             // dorme
    zT = now + 0.9;
    k.say('Z', '#9aa8ff', now, { ...k.anchor.CORE, x: k.anchor.CORE.x + ((now * 7) % 3) - 1.5 }, 1.6, 'float');
  }
}
let zT = 0, wakeT = -9;
export function onReset() { zT = 0; wakeT = -9; }
export function wasted(k, now) { k.spark(k.C.peri.OSC, now, 0.05, k.RED, 6); }

// il risveglio: il piedino avvisa il controllore, l'oscillatore riparte, il vettore va al PC e la flash
// preleva la prima istruzione della routine. Il primo colpo la carica nell'IR.
function wake(k, now) {
  const { P, C, cpu } = k, q = cpu.wake(), hf = k.hf, e = cpu.fetching;
  k.setBase(now);
  wakeT = now;
  const T = t => now + t * hf, hue = k.hue(e), peri = C.peri[SRC[q.src].peri];
  k.spark(peri, T(0.0), 0.06 * hf, hue, 8);
  if (P.irq[peri.id]) k.goV(P.irq[peri.id], T(0.02), VC, hue, 1, { w: 0.8, stage: 'IRQ' });
  k.spark(C.blocks.nvic, T(0.1), 0.08 * hf, hue, 10);
  k.pulse(P.osc, T(0.1), T(0.14), hue, 1, { w: 0.8, stage: 'IRQ' });
  k.spark(C.peri.OSC, T(0.14), 0.14 * hf, hue, 16);                  // il quarzo impiega un po' a ripartire
  for (let b = 0; b < 4; b++) k.pulse(P.vec[b], T(0.26), T(0.3), hue, bit(e.pc, b), { w: 0.8, stage: 'IRQ' });
  k.stage('IRQ', T(0.0), T(0.3));
  fetchWork(k, T(0.3), e);
}
// il prelievo di un'istruzione dalla flash: PC → decoder → parola → IR (la prossima battuta la cattura)
function fetchWork(k, t0, e) {
  const { P } = k, hf = k.hf, hue = k.hue(e);
  k.view.pc = e.pc;
  for (let b = 0; b < 4; b++) k.pulse(P.pcDec[b], t0, t0 + 0.05 * hf, hue, bit(e.pc, b), { w: 0.8, stage: 'IF' });
  k.spark(k.col('I', e.pc), t0 + 0.04 * hf, 0.03 * hf, hue, 5);
  k.pulse(P.iWord[e.pc], t0 + 0.05 * hf, t0 + 0.08 * hf, hue, 1, { w: 0.9, tr: 3, stage: 'IF' });
  k.at(t0 + 0.08 * hf, t => k.flash('I', e.pc, hue, t, false));
  for (let j = 0; j < 12; j++) k.goV(P.iRow(e.pc, j), t0 + 0.07 * hf, V, hue, bit(e.enc, j), { hold: true, cap: k.cap(e, 'IF', 'enc', j) });
}

// ---------- una battuta: si esegue l'istruzione nell'IR e si preleva la prossima ----------
export function schedule(k, st, opts, res) {
  const { P, C, view } = k, hf = k.hf, cap = k.cap, pulse = k.pulse, goV = k.goV;
  const T = t => k.rel('IR', t);
  if (st.done) {                                                    // RETI completata: la routine è servita
    const q = st.done;
    k.notice(q.late ? { type: 'info', text: t('proc.mcu.late'), color: '#ff8a2a' } : { type: 'bonus', pts: 150, text: 'IRQ OK', color: '#7dff6a', stat: 'irqs' });
  }
  const e = st.exec;
  if (st.fetch) fetchWork(k, T(0.02), st.fetch);
  if (!e) return;
  const hue = k.hue(e), { op, rd, rs1, rs2 } = e.ins;
  // IR → decoder
  for (let j = 0; j < 12; j++) pulse(P.irDec[j], T(0.01), T(0.04), hue, bit(e.enc, j), { stage: 'EX' });
  k.spark(C.blocks.dec, T(0.03), 0.05 * hf, hue, 12);
  k.at(T(0.04), t => k.say(op === OP.IN || op === OP.OUT ? `${OPS[op]} ${PORT[(op === OP.IN ? rs1 : rd) % 5]}!` : `${OPS[op]}!`, hue, t, k.anchor.EX, 9, 'op'));
  const tSel = T(0.06);
  const reads = op === OP.IN ? [] : op === OP.RETI ? [] : [rs1, rs2];
  for (let i = 0; i < 6; i++) if (reads.length) pulse(P.sel[i], T(0.035), tSel, hue, bit(reads[(i / 3) | 0], i % 3), { w: 0.7, stage: 'EX' });
  for (const r of new Set(reads)) {
    pulse(P.rWord[r], tSel, tSel + 0.03 * hf, hue, 1, { w: 0.9, tr: 3, stage: 'EX' });
    k.at(tSel + 0.03 * hf, t => k.flash('R', r, hue, t, false));
  }
  let tA = tSel + 0.03 * hf;
  if (reads.length) for (let b = 0; b < 8; b++) {
    tA = Math.max(tA, goV(P.rfA(rs1, b), tSel + 0.03 * hf, V, hue, bit(e.A, b), { stage: 'EX' }).t1);
    if (op !== OP.OUT && op !== OP.LD) goV(P.rfB(rs2, b), tSel + 0.035 * hf, V, hue, bit(e.B, b), { stage: 'EX' });
  }
  for (let j = 0; j < 3; j++) pulse(P.op[j], T(0.04), T(0.09), hue, bit(op, j), { w: 0.7 });
  const writeReg = (src, t0) => {                                   // il risultato fa il giro e torna nel registro rd
    k.wait('R', rd, 'EX');
    let last = t0;
    for (let b = 0; b < 8; b++) last = Math.max(last, goV(src(b), t0, VW, hue, bit(e.val, b), { tr: 8, cap: cap(e, 'EX', 'val', b) }).t1);
    pulse(P.rWord[rd], last, last + 0.04 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(e, 'EX', 'ctl', 0) });
    k.at(last + 0.04 * hf, t => { view.v.R[rd] = e.val; view.bad.R[rd] = e.bad ? 1 : 0; k.flash('R', rd, hue, t, true); });
  };

  if (op === OP.ADD || op === OP.SUB || op === OP.XOR) {          // ---- ALU, con i riporti ----
    let run = 0, tEnd = tA + 0.03 * hf;
    for (let b = 0; b < 8; b++) {
      const ts = e.carries ? tA + SLICE * (1 + run) * hf : tA + 0.03 * hf;
      k.spark(C.blocks.alu[b], ts - 0.02 * hf, 0.03 * hf, hue, 3);
      if (e.carries && b < 7) pulse(P.carry[b], ts, ts + SLICE * hf, hue, e.carries[b], { w: 0.85, tr: 2, stage: 'EX' });
      tEnd = Math.max(tEnd, ts);
      run = e.carries && e.carries[b] ? run + 1 : 0;
    }
    writeReg(b => P.wbAlu(rd, b), tEnd + 0.02 * hf);
  } else if (op === OP.IN) {                                        // ---- IN: l'indirizzo sul bus, il dato torna dalla periferica ----
    const pid = ['PORTD', 'UART', 'ADC', 'PORTB', 'TIMER'][rs1 % 5];
    const ta = goV(P.busAddr(pid), T(0.06), VC, hue, 1, { w: 0.8, stage: 'IO' }).t1;
    k.spark(C.peri[pid], ta, 0.05 * hf, hue, 6);
    k.at(ta, t => k.flash('P', rs1 % 5, hue, t, false));
    let tb = ta;
    for (let b = 0; b < 8; b++) tb = Math.max(tb, goV(P.bus(pid, false), ta + 0.03 * hf + b * 0.008 * hf, VB, hue, bit(e.val, b), { w: 0.8, tr: 3, stage: 'IO' }).t1);
    writeReg(b => P.wbAlu(rd, b), tb + 0.04 * hf);
  } else if (op === OP.OUT) {                                       // ---- OUT: dal registro alla periferica, lungo il bus ----
    const pid = ['PORTD', 'UART', 'ADC', 'PORTB', 'TIMER'][rd % 5];
    const tu = tA + 0.05 * hf;
    k.wait('P', rd % 5, 'IO');
    goV(P.busAddr(pid), T(0.06), VC, hue, 1, { w: 0.8, stage: 'IO' });
    let last = tu;
    for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.bus(pid, true), tu + b * 0.008 * hf, VB, hue, bit(e.val, b), { w: 0.8, tr: 3, cap: cap(e, 'IO', 'val', b) }).t1);
    k.at(last, t => { view.v.P[rd % 5] = e.val; k.flash('P', rd % 5, hue, t, true); k.spark(C.peri[pid], t, 0.05 * hf, hue, 8); });
  } else if (op === OP.LD || op === OP.ST) {                        // ---- SRAM: l'indirizzo esce dall'ALU ----
    const ta = tA + 0.04 * hf;
    for (let i = 0; i < 4; i++) pulse(P.addr[i], ta, ta + 0.05 * hf, hue, bit(e.addr, i), { w: 0.8, stage: 'EX' });
    k.spark(k.col('D', e.addr), ta + 0.04 * hf, 0.03 * hf, hue, 5);
    if (op === OP.LD) {
      pulse(P.dWord[e.addr], ta + 0.06 * hf, ta + 0.09 * hf, hue, 1, { w: 0.9, tr: 3, stage: 'EX' });
      k.at(ta + 0.09 * hf, t => k.flash('D', e.addr, hue, t, false));
      writeReg(b => P.wbMem(e.addr, rd, b), ta + 0.1 * hf);
    } else {
      k.wait('D', e.addr, 'EX');
      let last = ta + 0.06 * hf;
      for (let b = 0; b < 8; b++) last = Math.max(last, goV(P.dWrite(rs2, e.addr, b), tSel + 0.035 * hf, VB, hue, bit(e.val, b), { cap: cap(e, 'EX', 'val', b) }).t1);
      pulse(P.dWord[e.addr], last, last + 0.04 * hf, hue, 1, { w: 0.9, tr: 3, cap: cap(e, 'EX', 'ctl', 0) });
      k.at(last + 0.04 * hf, t => { view.v.D[e.addr] = e.val; view.bad.D[e.addr] = e.bad ? 1 : 0; k.flash('D', e.addr, hue, t, true); });
    }
  } else {                                                          // ---- RETI: l'indirizzo di ritorno dalla pila ----
    k.spark(k.col('D', 14), T(0.06), 0.03 * hf, hue, 4);
    pulse(P.dWord[14], T(0.08), T(0.11), hue, 1, { w: 0.9, tr: 3, stage: 'EX' });
    goV(P.ret, T(0.11), VW, hue, 1, { w: 0.8, cap: cap(e, 'EX', 'ctl', 1) });
    k.spark(C.blocks.nvic, T(0.12), 0.08 * hf, hue, 6);
  }
}

// ---------- luci tutte sue: l'oscillatore, i piedini che chiamano, il LED ----------
export function write(k, now, fx) {
  const { C, cpu } = k;
  if (!cpu || !C.legs) return;
  const osc = C.peri.OSC, awake = !cpu.asleep || cpu.pending.length;
  const ramp = Math.min(1, Math.max(0, (now - wakeT) / 0.3));
  if (awake) {                                                      // il quarzo vibra quando il chip è sveglio
    const a = (0.5 + 0.5 * Math.sin(now * 40)) * ramp;
    fx.box(osc.x + osc.w / 2, osc.top + 0.1, osc.y + osc.h / 2, osc.w * 0.6, 0.12, osc.h * 0.5, 1.6 * a, 1.2 * a, 0.3 * a);
  }
  const pinNear = x => C.legs.filter(l => l.dz < 0).reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
  const glow = (x, color, a) => { const p = pinNear(x); fx.box(p.x, -1.6, p.z - 0.9, 1.9, 0.5, 1.9, color[0] * a, color[1] * a, color[2] * a); };
  for (const q of cpu.open()) {                                     // il piedino che ha chiamato lampeggia, più in fretta vicino alla scadenza
    const left = Math.max(0, q.deadline - now), f = 6 + 18 * (1 - left / SRC[q.src].d);
    const a = q.late ? 1.4 : 0.8 + 0.8 * (Math.sin(now * f) > 0 ? 1 : 0);
    glow(C.peri[SRC[q.src].peri].cx, q.late ? [1.6, 0.1, 0.15] : [1.6, 1.2, 0.2], a);
  }
  if ((cpu.io[3] >> 2) & 1) glow(C.peri.PORTB.cx, [0.3, 1.8, 0.4], 1.2);   // il LED sulla porta B
  const pwm = cpu.io[4] / 255;
  if (pwm > 0.05) glow(C.peri.TIMER.cx, [0.3, 0.8, 1.8], 0.3 + pwm);         // l'uscita PWM del timer
}
