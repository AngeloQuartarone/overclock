// Il set di istruzioni comune ai processori "classici" (ciclo singolo, multi-ciclo, pipeline):
// 8 registri da 8 bit, istruzioni da 12 bit con codice operativo, destinazione e due sorgenti.

export const OP = { ADD: 0, SUB: 1, XOR: 2, AND: 3, OR: 4, LOAD: 5, STORE: 6, NOP: 7 };
export const OPS = ['ADD', 'SUB', 'XOR', 'AND', 'OR', 'LOAD', 'STORE', 'NOP'];

export const encode = ins => (ins.op << 9) | (ins.rd << 6) | (ins.rs1 << 3) | ins.rs2;
export const decode = enc => ({ op: (enc >> 9) & 7, rd: (enc >> 6) & 7, rs1: (enc >> 3) & 7, rs2: enc & 7 });
export const writesReg = ins => ins.op !== OP.STORE && ins.op !== OP.NOP;
export const usesAdder = op => op === OP.ADD || op === OP.SUB || op === OP.LOAD || op === OP.STORE;

// l'ALU: un sommatore a propagazione del riporto (per LOAD e STORE l'indirizzo è A + 0) e tre porte logiche.
// carries[i] è il riporto che esce dalla fetta i: una lunga fila di 1 vuol dire una somma lenta.
export function alu(op, A, B) {
  if (usesAdder(op)) {
    const b = op === OP.ADD ? B : op === OP.SUB ? (~B & 255) : 0;
    let c = op === OP.SUB ? 1 : 0, res = 0;
    const carries = [];
    for (let i = 0; i < 8; i++) {
      const ai = (A >> i) & 1, bi = (b >> i) & 1;
      res |= (ai ^ bi ^ c) << i;
      c = (ai & bi) | (ai & c) | (bi & c);
      carries.push(c);
    }
    return { res: res & 255, carries };
  }
  if (op === OP.XOR) return { res: A ^ B, carries: null };
  if (op === OP.AND) return { res: A & B, carries: null };
  if (op === OP.OR) return { res: A | B, carries: null };
  return { res: 0, carries: null };                                   // istruzione illeggibile: non fa nulla
}

// la fila di riporti più lunga: quante fette devono aspettare quella sotto
export function carryRun(carries) {
  let run = 0, best = 0;
  if (!carries) return 0;
  for (const c of carries) { run = c ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

// un programma di 16 istruzioni in loop. Con gap > 0 gli operandi non vengono dalle `gap` istruzioni
// precedenti (anche a cavallo del loop): è così che la pipeline evita stalli e inoltri.
export function makeProgram(rnd, gap = 3) {
  const pickOp = () => {
    const r = rnd();
    return r < 0.24 ? OP.ADD : r < 0.38 ? OP.SUB : r < 0.52 ? OP.XOR : r < 0.6 ? OP.AND
      : r < 0.68 ? OP.OR : r < 0.85 ? OP.LOAD : OP.STORE;
  };
  const program = Array.from({ length: 16 }, () => ({ op: pickOp(), rd: (rnd() * 8) | 0, rs1: 0, rs2: 0 }));
  for (let i = 0; i < 16; i++) {
    const banned = new Set();
    for (let d = 1; d <= gap; d++) {
      const prev = program[(i - d + 16) % 16];
      if (prev.op !== OP.STORE) banned.add(prev.rd);
    }
    const ok = [0, 1, 2, 3, 4, 5, 6, 7].filter(r => !banned.has(r));
    program[i].rs1 = ok[(rnd() * ok.length) | 0];
    program[i].rs2 = ok[(rnd() * ok.length) | 0];
  }
  return program;
}
