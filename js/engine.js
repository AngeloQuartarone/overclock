// La regia del gioco. Il clock non batte più da solo: lo batte il giocatore con edge().
// Dopo ogni fronte i bit partono verso il registro successivo, con ritardi fisici in secondi;
// se il fronte arriva prima di un bit, quel latch cattura un valore sbagliato.
// Questa parte è uguale per tutti i processori: cosa parte e quando lo decide il modulo del processore
// (proc-*.js) con schedule(), usando gli attrezzi del "kit" qui sotto.
import { Y } from './scene.js';

export const HUES = ['#3fd6ff', '#ff5fb4', '#7dff6a', '#ffa23a', '#b39cff'];
export const RED = '#ff3348';
const K = 4;                                                        // pezzi della scia
const H = { d: Y.wireD[1] + 0.17, c: Y.wireC[1] + 0.13, w: Y.led[1] + 0.2 };   // altezza dei bit per strato

export const linear = hex => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map(v => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
};
const LED_ON = [0.36, 0.78, 1.0], LED_OFF = [0.022, 0.03, 0.085];
const BAD_ON = [1.0, 0.12, 0.16], BAD_OFF = [0.14, 0.01, 0.02];
const FF_IDLE = [0.05, 0.02, 0.03], FF_WAIT = [0.5, 0.22, 0.02], FF_READY = [0.25, 1.2, 0.4], FF_DONE = [0.35, 2.2, 0.6];
// corpo dei latch (moltiplica un materiale bianco): a riposo, al lavoro, registro completo
const BODY_IDLE = [0.16, 0.035, 0.06], BODY_BUSY = [0.8, 0.06, 0.1], BODY_DONE = [0.1, 0.75, 0.22];
const WHITE = [1.0, 0.96, 0.9], OFF = [0.2, 0.21, 0.46];

function pointAt(r, s, out) {
  const { pts, cum } = r;
  if (s <= 0) { out.x = pts[0][0]; out.y = pts[0][1]; return out; }
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i];
  const k = Math.min(1, (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1));
  out.x = a[0] + (b[0] - a[0]) * k;
  out.y = a[1] + (b[1] - a[1]) * k;
  return out;
}

// il tratto [s0, s1] di un percorso, come barrette luminose (una per ogni pezzo dritto)
function streak(fx, r, s0, s1, h, wd, ht, cr, cg, cb) {
  const { pts, cum } = r;
  for (let i = 1; i < pts.length; i++) {
    const a0 = Math.max(s0, cum[i - 1]), a1 = Math.min(s1, cum[i]);
    if (a1 - a0 <= 1e-4) continue;
    const L = (cum[i] - cum[i - 1]) || 1, p = pts[i - 1], q = pts[i];
    const u0 = (a0 - cum[i - 1]) / L, u1 = (a1 - cum[i - 1]) / L;
    const x0 = p[0] + (q[0] - p[0]) * u0, x1 = p[0] + (q[0] - p[0]) * u1;
    const z0 = p[1] + (q[1] - p[1]) * u0, z1 = p[1] + (q[1] - p[1]) * u1;
    fx.box((x0 + x1) / 2, h, (z0 + z1) / 2, Math.abs(x1 - x0) + wd, ht, Math.abs(z1 - z0) + wd, cr, cg, cb);
  }
}

// proc: il modulo del processore (buildCore, createCPU, schedule, initView, syncView, anchors…)
export function createEngine(C, S, proc) {
  const key = (x, y) => `${x.toFixed(2)},${y.toFixed(2)}`;
  const ffAt = new Map(C.ffs.map((f, i) => [key(f.x, f.y), i]));
  const endFF = r => { const e = r.pts[r.pts.length - 1]; return ffAt.get(key(e[0], e[1])) ?? -1; };
  const col = new Map();
  const rgb = hex => { if (!col.has(hex)) col.set(hex, linear(hex)); return col.get(hex); };
  const tmp = { x: 0, y: 0 };
  const clockAt = C.clock.at;
  const fills = proc.fills || {}, latchValue = proc.latchValue || {};
  const arrayIds = Object.keys(C.arrays);

  let cpu = null, view = null, tick = -Infinity, rnd = Math.random, hf = 1, base = -Infinity, final = false;
  let pulses = [], caps = [], sparks = [], events = [], labels = [], misses = [], waits = [], notices = [];
  const ffArr = new Float64Array(C.ffs.length);                    // quando arriva l'ultimo bit atteso da ogni latch
  const ffFlash = C.ffs.map(() => ({ t: -1e9, c: WHITE }));
  const stageT = {}, stageS = {};                                   // fine e inizio del lavoro di ogni stadio
  const colFlash = Object.fromEntries(arrayIds.map(id => [id, []]));
  const clearStages = () => { for (const s in stageT) delete stageT[s]; for (const s in stageS) delete stageS[s]; };
  const mark = (stage, t0, t1) => {
    stageT[stage] = Math.max(stageT[stage] ?? -Infinity, t1);
    if (stageS[stage] === undefined) stageS[stage] = base;           // di solito lo stadio parte al fronte
  };

  // ---------- il kit per la regia dei processori ----------
  const pulse = (r, t0, t1, hue, on, o = {}) => {
    const p = { r, t0, t1: Math.max(t1, t0 + 0.02), hue, on: !!on, w: o.w || 1, tr: o.tr || 6, hold: !!o.hold, cap: o.cap || null };
    pulses.push(p);
    if (p.cap) {                                                    // un bit che un latch deve catturare entro il prossimo fronte
      caps.push(p);
      mark(p.cap.stage, p.t0, p.t1);
      const i = endFF(r);
      if (i >= 0) ffArr[i] = Math.max(Number.isNaN(ffArr[i]) ? -Infinity : ffArr[i], p.t1);
    } else if (o.stage) mark(o.stage, p.t0, p.t1);                 // fa parte del lavoro di uno stadio, ma non va catturato
    return p;
  };
  const k = {
    C, P: C.P, Y, RED,
    get view() { return view; },
    get cpu() { return cpu; },
    get tick() { return tick; },
    get hf() { return hf; },
    rnd: () => rnd(),
    pulse,
    goV: (r, t0, v, hue, on, o) => pulse(r, t0, t0 + (r.len / v) * hf, hue, on, o),
    // quando il fronte arriva al registro reg, più t secondi di lavoro (rallentati dal calore)
    rel: (reg, t) => base + clockAt(C.regs[reg] ?? 0, 0) + t * hf,
    cap: (e, stage, kk, b) => ({ e, stage, key: kk, bit: b }),
    hue: e => (e.bad ? RED : HUES[e.seq % 5]),
    spark(b, t0, dur, hue, n) {
      for (let i = 0; i < n; i++) {
        sparks.push({ x: b.x + Math.random() * b.w, y: b.y + Math.random() * b.h, top: b.top, t: t0 + Math.random() * dur, hue, s: 0.7 + Math.random() * 0.9 });
      }
    },
    at: (t, fn) => events.push({ t, fn }),
    // la fascia del decoder sopra la colonna k di un array, dove si accendono le scintille
    col(id, kk) {
      const A = C.arrays[id], d = A.dec || { y0: A.cy(0) - A.ch, y1: A.cy(0) };
      return { x: A.cx(kk) - 0.6, y: d.y0, w: 1.2, h: d.y1 - d.y0, top: d.top ?? Y.blk.dec };
    },
    flash(id, kk, hue, t, strong) { colFlash[id][kk] = { t, dur: strong ? 0.6 : 0.4, s: strong ? 1 : 0.75, c: rgb(hue) }; },
    say: (text, hue, t, a, life = 0.9, kind = 'pop') => labels.push({ text, hue, t, x: a.x, y: a.y, h: a.h, life, kind }),
    miss: (id, kk, t0, t1) => misses.push({ id, k: kk, t0, t1 }),    // la colonna aspetta la memoria lenta: pulsa
    wait: (id, kk, stage) => waits.push({ id, k: kk, stage }),       // la colonna riceve il risultato di quello stadio
    span: (stage, t0) => { stageS[stage] = t0; },                    // lo stadio comincia a lavorare più tardi del fronte
    // un pezzo di lavoro di uno stadio che non corre su una pista (per esempio la logica dell'ALU)
    stage: (st, t0, t1) => { stageS[st] = Math.min(stageS[st] ?? Infinity, t0); stageT[st] = Math.max(stageT[st] ?? -Infinity, t1); },
    final: () => { final = true; },                                  // con questo passo l'istruzione finisce (multi-ciclo)
    notice: n => notices.push(n),                                    // un avviso per il gioco (interrupt, frame…)
    setBase: t => { base = t; },
    rgb,
  };
  k.anchor = proc.anchors ? proc.anchors(C) : {};

  const fizzle = (x, y, h, t) => {                                  // un bit troncato dal fronte: scintille rosse
    for (let i = 0; i < 3; i++) sparks.push({ x: x + (Math.random() - 0.5) * 0.8, y: y + (Math.random() - 0.5) * 0.8, top: h - 0.3, t, hue: RED, s: 0.9 + Math.random() * 0.6 });
  };
  const fresh = () => {
    pulses = []; caps = []; events = [];
    ffArr.fill(NaN);
    clearStages();
    waits = []; final = false;
  };

  return {
    kit: k,
    get labels() { return labels; },
    get tick() { return tick; },
    get view() { return view; },
    get cpu() { return cpu; },
    get final() { return final; },
    // quando l'ultimo bit atteso sarà arrivato (null se non c'è niente da aspettare)
    get ready() { let r = -Infinity; for (const p of caps) r = Math.max(r, p.t1); return caps.length ? r : null; },
    stageReady: s => stageT[s] ?? null,
    stageStart: s => stageS[s] ?? null,
    drain() { const n = notices; notices = []; return n; },

    reset(cpuNew, rand = Math.random) {
      cpu = cpuNew; rnd = rand;
      view = proc.initView(cpu);
      fresh();
      sparks = []; labels = []; misses = []; notices = [];
      tick = -Infinity; base = -Infinity; hf = 1;
      proc.onReset?.(k);
    },

    // il fronte di clock: si controlla chi è arrivato in tempo, poi tutto avanza
    edge(now, { hf: h = 1, missP = 0 } = {}) {
      const res = { kind: 'start', dt: 0, late: new Set(), retired: null, ok: false, required: 0, miss: false };
      if (!caps.length && proc.asleep?.(cpu)) {                     // processore addormentato: il colpo va a vuoto
        res.kind = 'sleep';
        proc.wasted?.(k, now, res);
        return res;
      }
      if (caps.length) {
        let R = -Infinity;
        for (const p of caps) R = Math.max(R, p.t1);
        res.required = R - tick;
        res.dt = now - R;
        for (const p of caps) {
          if (p.t1 <= now) continue;
          res.late.add(p.cap.stage);
          cpu.corrupt(p.cap.e, p.cap.key, p.cap.bit);
        }
        res.kind = res.late.size ? 'glitch' : 'ok';
        if (proc.meta?.glitchAt) { if (res.late.size) k.say('GLITCH!', RED, now, k.anchor[proc.meta.glitchAt], 0.9); }
        else for (const s of res.late) if (k.anchor[s]) k.say('GLITCH!', RED, now, k.anchor[s], 0.9);
      }
      for (const p of pulses) {                                     // i bit ancora in viaggio vengono troncati
        const prog = (now - p.t0) / (p.t1 - p.t0);
        if (prog > 0 && prog < 1) { pointAt(p.r, p.r.len * prog, tmp); fizzle(tmp.x, tmp.y, H[p.r.layer], now); }
      }
      C.ffs.forEach((f, i) => {                                     // ogni latch lampeggia: bianco se ha catturato in tempo
        if (Number.isNaN(ffArr[i])) return;
        ffFlash[i] = { t: now + clockAt(f.x, f.y), c: ffArr[i] <= now ? WHITE : rgb(RED) };
      });
      const w = cpu.retiring;
      if (w) { res.retired = w; res.ok = !w.bad; }

      const st = cpu.step(now);
      proc.syncView(view, cpu);
      sparks = sparks.filter(s => s.t <= now + 0.01);
      labels = labels.filter(l => l.kind !== 'op');
      fresh();
      tick = now; base = now; hf = h;
      proc.schedule(k, st, { hf: h, missP, now }, res);
      return res;
    },

    update(now) {
      proc.update?.(k, now);                                        // eventi che non aspettano il clock (interrupt)
      for (let i = events.length - 1; i >= 0; i--) {
        if (now >= events[i].t) { const ev = events[i]; events.splice(i, 1); ev.fn(ev.t); }
      }
      pulses = pulses.filter(p => p.hold || (now - p.t0) / (p.t1 - p.t0) <= 1 + p.tr / Math.max(p.r.len, 0.01));
      sparks = sparks.filter(s => now - s.t < 0.5);
      labels = labels.filter(l => now - l.t < l.life);
      misses = misses.filter(m => now < m.t1);
    },

    // scrive lo stato del fotogramma negli oggetti luminosi della scena
    write(now) {
      const { fx, leds } = S;
      fx.begin();
      if (!view) { fx.end(); return; }

      // bit memorizzati; in rosso le celle che hanno ricevuto un valore corrotto
      for (const id of arrayIds) {
        const A = C.arrays[id], vals = view.v[id], fl = colFlash[id], badc = view.bad[id];
        if (!vals) continue;
        if (A.colors) {                                             // un array di pixel colorati (il framebuffer della GPU)
          for (let kk = 0; kk < A.cols; kk++) for (let j = 0; j < A.rows; j++) {
            const c = A.colors[vals[kk * A.rows + j] & (A.colors.length - 1)];
            leds.set(id, kk, j, c[0], c[1], c[2]);
          }
          continue;
        }
        for (let kk = 0; kk < A.cols; kk++) {
          let fk = 0, hc = null;
          const f = fl[kk];
          if (f) {
            const age = now - f.t;
            if (age >= f.dur) fl[kk] = null;
            else if (age >= 0) { fk = (1 - age / f.dur) ** 2 * f.s; hc = f.c; }
          }
          let wait = 0, done = 0;                                   // la colonna in attesa della memoria lenta pulsa
          for (const ms of misses) if (ms.id === id && ms.k === kk && now >= ms.t0) wait = 0.5 + 0.5 * Math.sin(now * 22);
          for (const wt of waits) {                                 // la colonna che riceve il risultato
            if (wt.id !== id || wt.k !== kk || stageT[wt.stage] === undefined) continue;
            if (now < stageT[wt.stage]) wait = 0.25 + 0.25 * Math.sin(now * 22);
            else done = 1;
          }
          const isBad = badc && badc[kk];
          const on0 = A.on || LED_ON;
          for (let j = 0; j < A.rows; j++) {
            const on = (vals[kk] >> j) & 1;
            const b = isBad ? (on ? BAD_ON : BAD_OFF) : (on ? on0 : LED_OFF), a = fk * (on ? 2.5 : 0.5);
            leds.set(id, kk, j, b[0] + (hc ? hc[0] * a : 0) + wait * 0.9 + done * 0.12, b[1] + (hc ? hc[1] * a : 0) + wait * 0.6 + done * 0.7, b[2] + (hc ? hc[2] * a : 0) + done * 0.2);
          }
        }
      }
      // latch: mentre lo stadio lavora il corpo è rosso e ogni spia si accende quando arriva il suo bit
      // (ambra = aspetta, verde = arrivato); quando il registro ha tutti i bit la fila intera diventa verde.
      // Al fronte lampeggiano bianchi (catturato) o rossi (catturato male).
      C.ffs.forEach((f, i) => {
        const st = fills[f.reg], t = st ? stageT[st] : undefined;
        const full = t !== undefined && now >= t;
        let b, body;
        if (latchValue[f.reg]) { b = (latchValue[f.reg](view) >> f.bit) & 1 ? LED_ON : LED_OFF; body = BODY_BUSY; }
        else if (t === undefined) { b = FF_IDLE; body = BODY_IDLE; }
        else if (full) { b = FF_DONE; body = BODY_DONE; }
        else { b = Number.isNaN(ffArr[i]) ? FF_IDLE : now >= ffArr[i] ? FF_READY : FF_WAIT; body = BODY_BUSY; }
        const fl = ffFlash[i], age = now - fl.t;
        const kf = age >= 0 && age < 0.3 ? (1 - age / 0.3) ** 2 * 2.6 : 0;
        leds.ff(i, b[0] + fl.c[0] * kf, b[1] + fl.c[1] * kf, b[2] + fl.c[2] * kf);
        leds.ffBody(i, body[0] + fl.c[0] * kf * 0.3, body[1] + fl.c[1] * kf * 0.3, body[2] + fl.c[2] * kf * 0.3);
      });
      leds.end();

      for (const s of sparks) {                                    // scintille che salgono dai blocchi
        const age = now - s.t;
        if (age < 0) continue;
        const kk = 1 - age / 0.5, c = rgb(s.hue), z = 0.28 * s.s;
        fx.box(s.x, s.top + 0.15 + age * 2.2, s.y, z, z, z, c[0] * 2.6 * kk, c[1] * 2.6 * kk, c[2] * 2.6 * kk);
      }

      // bit in viaggio: testa bianca e scia colorata; i bit a 0 lasciano solo una traccia tenue
      for (const p of pulses) {
        const prog = (now - p.t0) / (p.t1 - p.t0);
        if (prog <= 0) continue;
        const len = p.r.len, head = len * Math.min(prog, 1 + p.tr / Math.max(len, 0.01)), seg = p.tr / K, h = H[p.r.layer];
        const c = p.on ? rgb(p.hue) : OFF;
        for (let j = 0; j < K; j++) {
          const s1 = Math.min(len, head - j * seg), s0 = Math.max(0, head - (j + 1) * seg);
          if (s1 - s0 <= 0.02) continue;
          const a = Math.pow(1 - j / K, 1.3);
          if (p.on) streak(fx, p.r, s0, s1, h, 0.42 * p.w, 0.24, c[0] * 2.4 * a, c[1] * 2.4 * a, c[2] * 2.4 * a);
          else streak(fx, p.r, s0, s1, h - 0.06, 0.13, 0.08, c[0] * a * 0.8, c[1] * a * 0.8, c[2] * a * 0.8);
        }
        if (prog < 1) {
          if (!p.on) continue;
          pointAt(p.r, len * prog, tmp);
          const z = 0.8 * p.w;
          fx.box(tmp.x, h, tmp.y, z, z, z, c[0] * 1.5 + 2.2, c[1] * 1.5 + 2.2, c[2] * 1.5 + 2.2);
        } else if (p.hold) {                                        // bit "parcheggiato" davanti al registro
          const e = p.r.pts[p.r.pts.length - 1];
          if (p.on) {
            const z = 0.5 * p.w, kk = 1.5 + 0.5 * Math.sin(now * 9 + e[1]);
            fx.box(e[0], h, e[1], z, z, z, c[0] * kk, c[1] * kk, c[2] * kk);
          } else fx.box(e[0], h - 0.05, e[1], 0.22, 0.12, 0.22, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7);
        }
      }

      // onda di clock sulla rete del clock: dorsali e rami
      if (Number.isFinite(tick)) {
        const dt = now - tick;
        for (const sg of C.clock.segs) {
          const L = Math.abs(sg.x1 - sg.x0) + Math.abs(sg.y1 - sg.y0);
          const s = (dt - sg.t0) * sg.v;                            // dove è arrivato il fronte lungo il tratto
          if (s < 0 || s - sg.trail > L) continue;
          const ys = sg.kind === 'spine' ? (Y.spine[0] + Y.spine[1]) / 2 : (Y.branch[0] + Y.branch[1]) / 2;
          const hs = sg.kind === 'spine' ? Y.spine[1] - Y.spine[0] + 0.1 : Y.branch[1] - Y.branch[0] + 0.1;
          const ux = Math.sign(sg.x1 - sg.x0), uy = Math.sign(sg.y1 - sg.y0);
          for (let j = 0; j < sg.n; j++) {
            const a0 = Math.max(0, s - sg.trail + j * sg.trail / sg.n), a1 = Math.min(L, s - sg.trail + (j + 1) * sg.trail / sg.n);
            if (a1 <= a0) continue;
            const a = ((j + 1) / sg.n) ** 1.6 * 2.6, m = (a0 + a1) / 2;
            const x = sg.x0 + ux * m, y = sg.y0 + uy * m;
            const sx = ux ? a1 - a0 : sg.w + 0.1, sz = uy ? a1 - a0 : sg.w + 0.1;
            fx.box(x, ys, y, sx, hs, sz, 0.8 * a, 0.95 * a, 1.0 * a);
          }
        }
      }
      proc.write?.(k, now, fx);                                     // le luci tutte sue del processore
      fx.end();
    },
  };
}
