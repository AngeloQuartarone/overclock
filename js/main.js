// Overclock: sei tu il clock. Tocca quando tutti i bit sono arrivati ai registri.
// Troppo presto e i latch catturano bit sbagliati (glitch); troppo tardi e perdi punti.
// Correre scalda il chip (o scarica la batteria), e il silicio caldo è più lento.
// I processori (proc-*.js) hanno ognuno il suo chip e la sua regola; qui c'è quello che hanno in comune:
// stati di gioco, input, punteggio, HUD, telecamera.
import * as THREE from 'three';
import { rng } from './route.js';
import { createEngine, RED } from './engine.js';
import { buildScene, PAL } from './scene.js';
import { createPixelRenderer } from './pixel.js';
import { drawText, measure } from './font.js';
import { createSfx } from './sfx.js';
import { MODES } from './modes.js';
import { PROCS, DEFAULT, lastProc, rememberProc } from './procs.js';
import { createMenu } from './menu.js';
import * as api from './api.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const pxParam = Math.max(0, Math.min(12, Number(params.get('px')) || 0));
const durata = Math.max(0, Number(params.get('durata')) || 0);   // solo per provare: con una durata diversa la partita non si salva
const forceHelp = params.has('aiuto');                            // spie degli stadi in basso in tutte le modalità
const WD = { start: 1.0, step: 0.012, min: 0.28 };               // sopravvivenza: ritardo concesso dal watchdog, in secondi
const COL = { text: '#e8ebff', dim: '#7f89c6', dark: '#2b3264', gold: '#ffd23a', orange: '#ff8a2a', green: '#7dff6a', cyan: '#3fd6ff' };

const sfx = createSfx();
const gl = $('gl'), ui = $('ui'), stage = $('scene');
const g = ui.getContext('2d');
const pix = createPixelRenderer(gl, PAL);
const camera = new THREE.PerspectiveCamera(26, 1, 5, 1500);
let lw = 1, lh = 1, px = 2, portrait = false;

// ---------- il processore in scena: si costruisce la prima volta che serve, poi resta pronto ----------
const built = new Map();
let mod = null, C = null, S = null, engine = null, spots = null;
const spot = {};                                                  // luce di ogni stadio, che insegue quella voluta
function use(id) {
  if (!PROCS[id]) id = DEFAULT;
  if (mod?.meta.id === id) return;
  if (!built.has(id)) {
    const m = PROCS[id], c = m.buildCore(), s = buildScene(c, m.meta.look);
    built.set(id, { m, C: c, S: s, engine: createEngine(c, s, m), spots: m.spots(c) });
  }
  ({ m: mod, C, S, engine, spots } = built.get(id));
  pix.setRegions({ ...S.regions, rects: spots.rects });
  for (const k in spot) delete spot[k];
  for (const st of mod.meta.stages) spot[st] = 1;
  corners.length = 0;
  const b = S.bounds;
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z));
  local.length = 0;
  corners.forEach(() => local.push(new THREE.Vector3()));
  placeCamera();
  measureOp();
}

// ---------- telecamera fissa, che inquadra il chip lasciando spazio all'HUD ----------
const corners = [], local = [];
function fit(th, tv, D, mx, my) {
  let lx = -Infinity, hx = Infinity, ly = -Infinity, hy = Infinity;
  for (const p of local) {
    const ax = mx * th * (D - p.z), ay = my * tv * (D - p.z);
    lx = Math.max(lx, p.x - ax); hx = Math.min(hx, p.x + ax);
    ly = Math.max(ly, p.y - ay); hy = Math.min(hy, p.y + ay);
  }
  return lx <= hx && ly <= hy ? [(lx + hx) / 2, (ly + hy) / 2] : null;
}
function placeCamera() {
  if (!corners.length) return;
  const az = portrait ? Math.PI / 2 + 0.1 : 0.07, el = portrait ? 1.1 : 0.95;
  const dummy = new THREE.Camera();
  dummy.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  dummy.lookAt(0, 0, 0);
  const qInv = dummy.quaternion.clone().invert();
  corners.forEach((p, i) => local[i].copy(p).applyQuaternion(qInv));
  const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), th = tv * camera.aspect;
  const mx = 0.96, my = portrait ? 0.8 : 0.72;                    // in alto e in basso c'è l'HUD
  let a = 1, b = 4000;
  for (let i = 0; i < 26; i++) { const m = (a + b) / 2; if (fit(th, tv, m, mx, my)) b = m; else a = m; }
  const [ox, oy] = fit(th, tv, b, mx, my);
  camera.quaternion.copy(dummy.quaternion);
  camera.position.set(ox, oy, b).applyQuaternion(dummy.quaternion);
  camera.updateMatrixWorld();
}

function resize() {
  const W = innerWidth, Hh = innerHeight;
  px = pxParam || Math.max(2, Math.round(Math.min(Hh, W * 0.75) / 330));
  lw = Math.ceil(W / px); lh = Math.ceil(Hh / px);
  pix.setSize(lw, lh);
  ui.width = lw; ui.height = lh;
  for (const c of [gl, ui]) { c.style.width = `${lw * px}px`; c.style.height = `${lh * px}px`; }
  camera.aspect = lw / lh;
  camera.updateProjectionMatrix();
  portrait = Hh > W * 1.15;
  placeCamera();
  measureOp();
}

// ---------- stato della partita ----------
let state = 'menu', stateT = 0, paused = false, shown = false;    // menu | count | play | over
let run = null;                                                   // { cpu, mode, seed, challenge, custom } della partita in corso
let frozen = false;                                               // solo per ?debug: ferma il tempo senza velo
let clock = 0, last = 0, real = 0, G = null, fb = null, shakeT = -9, hurtT = -9, lastCount = -1;

// ---------- occhio di bue e note: il chip stesso dice a che punto è il ciclo ----------
const working = st => {                                           // lo stadio sta lavorando adesso
  const t = engine.stageReady(st), s0 = engine.stageStart(st);
  return t !== null && clock < t && (s0 === null || clock >= s0);
};
function updateSpot(dt) {
  // chi lavora resta in luce, chi ha finito (o deve ancora cominciare) si abbassa; l'ultimo al lavoro si accende un po' di più
  const stages = mod.meta.stages, busy = stages.filter(working), n = busy.length, k = 1 - Math.exp(-dt * 14);
  const dimmed = mod.meta.dim ?? 0.58;
  for (const st of stages) {
    const target = state === 'over' ? 1 : busy.includes(st) ? (n === 1 ? 1.15 : 1) : dimmed;
    spot[st] += (target - spot[st]) * k;
  }
  // '*': una zona che resta accesa finché qualcuno lavora (l'unità di controllo del multi-ciclo)
  spot['*'] = (spot['*'] ?? 1) + ((state === 'over' || n ? 1 : dimmed) - (spot['*'] ?? 1)) * k;
  const lit = r => Math.max(...r.stages.map(st => spot[st] ?? dimmed));
  pix.setSpot(camera, spot[spots.base] ?? dimmed, spots.rects.map(lit), stages.reduce((a, st) => a + spot[st], 0) / stages.length);
}
let notesTick = null;
const played = new Set();
function stageNotes() {
  // ogni stadio che finisce suona la sua nota; quando finisce l'ultimo l'accordo si chiude
  if (state !== 'play') return;
  if (engine.tick !== notesTick) { notesTick = engine.tick; played.clear(); }
  const stages = mod.meta.stages, now = [];
  let pending = 0;
  stages.forEach((st, i) => {
    const t = engine.stageReady(st);
    if (t === null) return;
    if (clock < t) pending++;
    else if (!played.has(st)) { played.add(st); now.push(i); }
  });
  if (!now.length) return;
  // più stadi nello stesso istante suonano insieme; nel multi-ciclo l'accordo arriva solo alla fine dell'istruzione
  if (pending || (mod.meta.chord === 'final' && !engine.final)) now.forEach(i => sfx.stage(i, stages.length));
  else sfx.allDone();
}

function freshCPU(seed = (Math.random() * 1e9) | 0) {
  engine.reset(mod.createCPU(rng(seed)), rng(seed ^ 0x9e3779b9));
}
function attract() { freshCPU(); mod.onPlay?.(engine.kit, clock); state = 'menu'; stateT = clock; G = null; run = null; paused = false; }
// stesso seme = stesso programma, stessi dati e stessi MISS: è così che le sfide sono uguali per tutti
function start({ cpu = mod.meta.id, mode, seed = (Math.random() * 1e9) | 0, challenge = null }) {
  use(cpu);
  rememberProc(mod.meta.id);
  const M = MODES[mode];
  run = { cpu: mod.meta.id, mode, seed, challenge, custom: mode === 'classica' && durata > 0 && !challenge };
  freshCPU(seed);
  const total = run.custom ? Math.max(10, durata) : M.time ?? Infinity;
  G = {
    M, total, left: total, played: 0, score: 0, combo: 0, bestCombo: 0, hearts: M.lives, heat: 0, battery: 1,
    ok: 0, perfect: 0, good: 0, slow: 0, glitches: 0, ghz: 0, peak: 0, lastEdge: null, end: null, why: null, wd: WD.start,
    edges: 0, cycles: 0, worst: 0, span: 0, retired: 0, extra: {},
  };
  state = 'count'; stateT = clock; lastCount = -1; fb = null; paused = false; shown = false;
}
const help = () => forceHelp || !!G?.M.help;
function gameOver(end) {                                          // end: crash | time | done
  state = 'over'; stateT = clock; G.end = end;
  sfx.over(end === 'crash');
}
function summary() {
  // le voci tutte sue del processore (CPI, interrupt, immagini…), che non vanno al server
  const x = mod.results?.({ ...G.extra, edges: G.edges, cycles: G.cycles, worst: G.worst, span: G.span, retired: G.retired, ok: G.ok, played: G.played, battery: G.battery }) ?? {};
  return {
    cpu: run.cpu, mode: run.mode, seed: run.seed, challenge: run.challenge, custom: run.custom, end: G.end, why: G.why,
    score: G.score, time_ms: Math.round(G.played * 1000), finished: G.end !== 'crash', crashed: G.end === 'crash',
    ok: G.ok, perfect: G.perfect, good: G.good, slow: G.slow, glitches: G.glitches, combo: G.bestCombo,
    peak: Math.round(G.peak * 10) / 10, more: x.more || [], notes: x.notes || [],
  };
}
const feedback = (text, color) => { fb = { text, color, t: real }; };
// la memoria a volte "manca" il dato, ma non subito: dopo un terzo della partita, o dopo un po' di istruzioni
function missP() {
  const M = G.M;
  const on = M.target ? G.ok >= 15 : M.watchdog ? G.ok >= 10 : G.played > (Number.isFinite(G.total) ? G.total / 3 : 20);
  return on ? 0.35 : 0;
}
const loseLife = () => { if (Number.isFinite(G.hearts)) G.hearts--; return G.hearts <= 0; };
const pw = () => mod.meta.power;
// quanto rallenta il chip: il silicio caldo è più lento, e con la batteria scarica la tensione cala
const slowdown = () => (pw().kind === 'battery' ? 1 + pw().slow * (1 - G.battery) ** 2 : 1 + pw().slow * G.heat);
function drain(cost) {                                            // microcontrollore: ogni colpo costa batteria
  G.battery = Math.max(0, G.battery - cost);
  if (G.battery <= 0) { G.why = 'battery'; gameOver('crash'); return true; }
  return false;
}

// il tocco del giocatore: un fronte di clock
function clockEdge() {
  const r = engine.edge(clock, { hf: slowdown(), missP: missP() });
  sfx.tick();
  if (r.kind === 'sleep') {                                       // il processore dorme: il colpo non serve a niente
    G.combo = 0;
    G.extra.wasted = (G.extra.wasted || 0) + 1;
    feedback(mod.meta.wasteText || 'A VUOTO', COL.orange);
    sfx.waste();
    if (pw().kind === 'battery') drain(pw().waste);
    notices();
    return;
  }
  G.edges++;
  if (r.retired) G.retired++;
  if (G.lastEdge !== null) {
    const period = Math.max(0.05, clock - G.lastEdge);
    if (r.kind !== 'start') G.span += clock - G.lastEdge;          // il tempo passato dentro i cicli veri
    if (pw().kind === 'battery') { if (drain(pw().cost * (0.5 + 0.5 * (pw().ref / period) ** 2))) return; }
    else G.heat = Math.min(1, G.heat + pw().gain * (pw().ref / period) ** 2);   // più alta la frequenza, più calore
    const ghz = mod.meta.freq.k / period;                          // equivalenza giocosa, non una misura vera
    G.ghz = G.ghz ? G.ghz * 0.6 + ghz * 0.4 : ghz;
  }
  G.lastEdge = clock;
  if (r.retired && r.ok) G.ok++;
  if (r.miss) sfx.miss();
  G.wd = Math.max(WD.min, WD.start - WD.step * G.ok);
  notices();
  if (state !== 'play') return;
  if (r.kind === 'start') return;
  G.cycles++;
  G.worst = Math.max(G.worst, r.required);

  if (r.kind === 'glitch') {
    G.combo = 0; G.glitches++;
    feedback('GLITCH!', RED);
    shakeT = real; hurtT = real;
    sfx.glitch();
    G.why = 'glitch';
    if (loseLife()) return gameOver('crash');
  } else {
    G.peak = Math.max(G.peak, G.ghz);
    let pts;
    if (r.dt < 0.1) { G.combo++; G.perfect++; pts = 100; feedback('PERFETTO!', COL.green); sfx.perfect(G.combo); }
    else if (r.dt < 0.3) { G.combo++; G.good++; pts = 50; feedback('BUONO', COL.cyan); sfx.good(); }
    else { G.combo = 0; G.slow++; pts = 10; feedback('LENTO', COL.dim); sfx.slow(); }
    G.bestCombo = Math.max(G.bestCombo, G.combo);
    G.score += pts * mult();
    if (G.combo > 0 && G.combo % 20 === 0 && G.hearts < G.M.lives) { G.hearts++; sfx.heart(); feedback('+1 VITA', RED); }
  }
  if (G.M.target && G.ok >= G.M.target) gameOver('done');
}
// sopravvivenza: se il clock tarda troppo dopo che i bit sono arrivati, il watchdog lo dà al posto tuo e costa una vita
function watchdog() {
  const r = engine.edge(clock, { hf: slowdown(), missP: missP() });
  G.lastEdge = clock;
  if (r.retired && r.ok) G.ok++;
  G.combo = 0;
  feedback('WATCHDOG!', RED);
  shakeT = real; hurtT = real;
  sfx.tick(); sfx.glitch();
  G.why = 'watchdog';
  notices();
  if (state === 'play' && loseLife()) gameOver('crash');
}
const mult = () => Math.min(4, 1 + Math.floor(G.combo / 8));

// avvisi del processore che non sono un semplice colpo: interrupt serviti o persi, immagini finite…
function notices() {
  for (const n of engine.drain()) {
    if (state !== 'play' || !G) continue;
    if (n.stat) G.extra[n.stat] = (G.extra[n.stat] || 0) + (n.count ?? 1);
    if (n.type === 'bonus') {
      G.score += n.pts * mult();
      if (n.text) feedback(n.text, n.color || COL.gold);
      sfx[n.sound || 'bonus']?.();
    } else if (n.type === 'hurt') {                               // un errore che costa una vita (una scadenza mancata)
      G.combo = 0;
      feedback(n.text, RED);
      shakeT = real; hurtT = real;
      sfx.glitch();
      G.why = n.why;
      if (loseLife()) { gameOver('crash'); return; }
    } else if (n.type === 'info') {
      if (n.text) feedback(n.text, n.color || COL.cyan);
      if (n.sound) sfx[n.sound]?.();
    }
  }
}

// ---------- menu, pausa e input ----------
const menu = createMenu({
  sfx,
  onPlay: opts => { menu.hide(); start(opts); },
  onResume: resume,
  onRestart: () => { menu.hide(); start(run); },
  onHome: () => { attract(); menu.home(); },
  onPreview: id => { if (state === 'menu' && PROCS[id] && id !== mod.meta.id) { use(id); attract(); } },
});
function pause() { if (paused) return; paused = true; menu.show('pause'); }
function resume() { menu.hide(); paused = false; }

function press() {
  sfx.ensure();
  if (state === 'play' && !paused) clockEdge();
}
stage.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
stage.addEventListener('contextmenu', e => e.preventDefault());
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (e.target.closest?.('input, textarea')) {                    // si sta scrivendo: le lettere non sono comandi
    if (e.key === 'Escape') { e.target.blur(); menu.escape(); }
    return;
  }
  if (menu.visible) {                                             // spazio e invio premono il pulsante selezionato
    if (e.key === 'Escape' || (k === 'p' && menu.screen === 'pause')) { e.preventDefault(); menu.escape(); }
    else if (k === 'm') sfx.toggle();
    else if (k === 'f') toggleFs();
    return;
  }
  if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!e.repeat) press(); }
  else if (k === 'p' || e.key === 'Escape') { if (state === 'play' || state === 'count') pause(); }
  else if (k === 'm') sfx.toggle();
  else if (k === 'f') toggleFs();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && (state === 'play' || state === 'count')) pause(); });
let resizeTimer = 0;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); });

// ---------- HUD a pixel ----------
const T = (text, x, y, s, fill, align = 'l') => {
  const w = measure(text, s);
  drawText(g, text, align === 'c' ? Math.round(x - w / 2) : align === 'r' ? x - w : x, y, s, fill);
  return w;
};
const big = () => (lh >= 220 ? 2 : 1);
const fitScale = (text, max, frac = 0.85) => Math.max(1, Math.min(max, Math.floor((lw * frac) / measure(text, 1))));
const blink = (on, off) => (real % (on + off)) < on;
const dim = (() => {                                               // velo a scacchiera, per i testi sopra la scena
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const x = c.getContext('2d');
  x.fillStyle = PAL.bg; x.fillRect(0, 0, 2, 2); x.clearRect(1, 1, 1, 1);   // 3 pixel su 4
  return c;
})();
const veil = () => { g.fillStyle = g.createPattern(dim, 'repeat'); g.fillRect(0, 0, lw, lh); };
const v3 = new THREE.Vector3();

// dove sta l'unità di calcolo sullo schermo: la scritta dell'istruzione va subito sopra, senza coprirla
let opScreen = null;
function measureOp() {
  const a = C?.blocks.op;
  if (!a?.length) { opScreen = null; return; }
  let top = Infinity, l = Infinity, r = -Infinity;
  for (const b of a) for (const x of [b.x, b.x + b.w]) for (const y of [b.y, b.y + b.h]) for (const h of [0, b.top ?? 1]) {
    S.toWorld(x, h, y, v3).project(camera);
    const sx = (v3.x + 1) / 2 * lw, sy = (1 - v3.y) / 2 * lh;
    top = Math.min(top, sy); l = Math.min(l, sx); r = Math.max(r, sx);
  }
  opScreen = { x: (l + r) / 2, top };
}

function worldLabels() {
  const s = big();
  for (const L of engine.labels) {
    const age = clock - L.t;
    if (age < 0 || (L.kind !== 'op' && age > L.life - 0.3 && ((age * 14) | 0) % 2)) continue;
    const w = measure(L.text, s), rise = L.kind === 'float' ? Math.round(age * 8) : age < 0.08 ? 2 : Math.min(6, Math.round(age * 10));
    let x, y;
    if (L.kind === 'op' && opScreen) { x = opScreen.x; y = opScreen.top - 3; }
    else {
      S.toWorld(L.x, L.h, L.y, v3).project(camera);
      if (v3.z > 1) continue;
      x = (v3.x + 1) / 2 * lw; y = (1 - v3.y) / 2 * lh;
    }
    drawText(g, L.text, Math.round(x - w / 2), Math.round(y - 7 * s - 2 - rise), s, L.hue, '#05081a', '#05081a');
  }
}

// su schermi stretti (telefono in verticale) i GHz si rimpiccioliscono e il calore va sopra le spie
const narrow = () => lw < 330;
const comboY = () => (narrow() ? 13 + 7 * big() + 5 : 4 + 7 * big() + 5);
const fbY = () => comboY() + 12;

const dec = (v, d) => v.toFixed(d).replace('.', ',');
function topBar() {
  const s = big(), M = G.M;
  if (M.target) { T('ISTRUZIONI', 5, 4, 1, COL.dim); T(`${G.ok}/${M.target}`, 5, 13, s, COL.text); }
  else { T('PUNTI', 5, 4, 1, COL.dim); T(String(G.score).padStart(6, '0'), 5, 13, s, COL.text); }
  if (Number.isFinite(M.lives)) for (let i = 0; i < M.lives; i++) T('*', 5 + i * 8, 13 + 7 * s + 5, 1, i < G.hearts ? RED : COL.dark);
  if (Number.isFinite(G.total)) {
    T('TEMPO', lw - 5, 4, 1, COL.dim, 'r');
    T(String(Math.ceil(G.left)), lw - 5, 13, s, G.left < 10 && blink(0.3, 0.2) ? RED : COL.text, 'r');
  } else if (!M.practice) {
    T('TEMPO', lw - 5, 4, 1, COL.dim, 'r');
    T(M.target ? dec(G.played, 1) : String(Math.floor(G.played)), lw - 5, 13, s, COL.text, 'r');
  } else T('ESC MENU', lw - 5, 4, 1, COL.dim, 'r');
  if (M.watchdog) T(`${narrow() ? 'WD' : 'WATCHDOG'} ${dec(G.wd, 2)}`, lw - 5, 13 + 7 * s + 5, 1, G.wd < 0.45 ? COL.orange : COL.dim, 'r');
  const hot = pw().kind === 'battery' ? G.battery < 0.25 : G.heat > 0.75;
  const f = mod.meta.freq;
  T(`${dec(G.ghz, f.d ?? 1)} ${f.unit}`, lw / 2, narrow() ? 6 : 4, narrow() ? 1 : s, hot ? COL.orange : COL.text, 'c');
  if (G.combo >= 2) T(`COMBO ${G.combo}  x${mult()}`, lw / 2, comboY(), 1, COL.gold, 'c');
}

function bottomBar() {
  const y = lh - 12;
  (pw().kind === 'battery' ? batteryBar : heatBar)(narrow() ? Math.round(lw / 2 - 45) : 5, narrow() && help() ? y - 20 : y);
  if (sfx.muted && !narrow()) T('AUDIO NO', lw - 5, y, 1, COL.dim, 'r');
  mod.hud?.({ T, g, lw, lh, y, G, engine, clock, COL, narrow: narrow() });
  if (!help()) return;
  // solo con ?aiuto o in allenamento: spie degli stadi (grigio = vuoto, ambra = aspetta bit, verde = tutti arrivati)
  const stages = mod.meta.stages, many = stages.length > 6;
  const color = st => { const t = engine.stageReady(st); return t === null ? COL.dark : clock >= t ? COL.green : COL.orange; };
  if (many) {                                                     // tante corsie (GPU): solo quadratini
    const w = stages.length * 6 - 2;
    let x = Math.round(lw / 2 - w / 2);
    for (const st of stages) {
      g.fillStyle = '#05081a'; g.fillRect(x - 1, y, 6, 7);
      g.fillStyle = color(st); g.fillRect(x, y + 1, 4, 5);
      x += 6;
    }
    return;
  }
  const gap = 8, labels = stages.map(st => measure(st, 1));
  const total = labels.reduce((a, b) => a + b, 0) + gap * (stages.length - 1);
  let x = Math.round(lw / 2 - total / 2);
  stages.forEach((st, i) => {
    const c = color(st);
    g.fillStyle = '#05081a'; g.fillRect(x + labels[i] / 2 - 4, y - 7, 8, 5);
    g.fillStyle = c; g.fillRect(x + labels[i] / 2 - 3, y - 6, 6, 3);
    T(st, x, y, 1, c === COL.dark ? COL.dim : c);
    x += labels[i] + gap;
  });
}

// calore: la barra si riempie se corri troppo
function heatBar(x, y) {
  const w = T('CALORE', x, y, 1, COL.dim), bx = x + w + 3, bw = 50;
  g.fillStyle = '#05081a'; g.fillRect(bx, y + 1, bw + 2, 7);
  const n = Math.round(bw * G.heat);
  for (let i = 0; i < n; i++) {
    const k = i / bw;
    g.fillStyle = k < 0.5 ? '#ffd23a' : k < 0.75 ? '#ff8a2a' : '#ff3348';
    g.fillRect(bx + 1 + i, y + 2, 1, 5);
  }
}
// batteria: si svuota a ogni colpo, di più se corri; quando è quasi scarica il chip rallenta
function batteryBar(x, y) {
  const w = T('BATTERIA', x, y, 1, COL.dim), bx = x + w + 3, bw = 50;
  g.fillStyle = '#05081a'; g.fillRect(bx, y + 1, bw + 2, 7); g.fillRect(bx + bw + 2, y + 3, 2, 3);
  const n = Math.round(bw * G.battery), c = G.battery > 0.5 ? COL.green : G.battery > 0.25 ? '#ffd23a' : (blink(0.3, 0.2) ? '#ff3348' : '#7a1820');
  g.fillStyle = c; g.fillRect(bx + 1, y + 2, n, 5);
}

function hud() {
  g.clearRect(0, 0, lw, lh);
  worldLabels();
  if (state === 'menu') { veil(); return; }
  topBar();
  bottomBar();
  if (state === 'count') {
    const n = Math.floor((clock - stateT) / 0.6);
    const text = ['3', '2', '1'][n] || '';
    const s = fitScale('3', 6, 0.2);
    if (text) drawText(g, text, Math.round(lw / 2 - measure(text, s) / 2), Math.round(lh / 2 - 7 * s / 2), s, COL.gold, '#05081a', '#05081a');
  }
  if (state === 'play') {
    if (clock - stateT < 0.6) {
      const s = fitScale('VIA!', 6, 0.3);
      drawText(g, 'VIA!', Math.round(lw / 2 - measure('VIA!', s) / 2), Math.round(lh / 2 - 7 * s / 2), s, COL.green, '#05081a', '#05081a');
    }
    if (fb && real - fb.t < 0.5) {
      const s = big(), y = fbY() + (real - fb.t < 0.06 ? -1 : 0);
      drawText(g, fb.text, Math.round(lw / 2 - measure(fb.text, s) / 2), y, s, fb.color, '#05081a', '#05081a');
    }
    if (paused) veil();
  }
  if (state === 'over') {
    veil();
    if (shown) return;                                             // sopra c'è già la schermata dei risultati
    const [head, color] = G.end === 'crash' ? [G.why === 'battery' ? 'BROWN-OUT!' : 'CRASH!', RED] : G.end === 'done' ? ['FINITO!', COL.green] : ['TEMPO SCADUTO', COL.orange];
    const ts = fitScale(head, 5, 0.8);
    drawText(g, head, Math.round(lw / 2 - measure(head, ts) / 2), Math.round(lh / 2 - 7 * ts / 2), ts, color, '#05081a', '#05081a');
  }
}

// ---------- ciclo ----------
function frame(ms) {
  real = ms / 1000;
  const dt = Math.min(0.05, real - (last || real));
  last = real;
  if (!paused && !frozen) {
    clock += dt;
    if (state === 'menu') {                                        // dimostrazione: un clock automatico, sempre puntuale
      const R = engine.ready;
      if (R === null ? !mod.asleep?.(engine.cpu) : clock >= R + 0.08) engine.edge(clock, { missP: 0.15 });
      engine.drain();
    } else if (state === 'count') {
      const n = Math.floor((clock - stateT) / 0.6);
      if (n !== lastCount && n < 3) sfx.count(false);
      lastCount = n;
      if (clock - stateT >= 1.8) { state = 'play'; stateT = clock; sfx.count(true); mod.onPlay?.(engine.kit, clock); }
    } else if (state === 'play') {
      G.played += dt;
      G.left -= dt;
      G.heat = Math.max(0, G.heat - dt * (0.02 + 0.12 * G.heat));  // si raffredda da solo, più in fretta se è caldo
      if (G.left <= 0) { G.left = 0; gameOver('time'); }
      else if (G.M.watchdog && G.lastEdge !== null && engine.ready !== null && clock > engine.ready + G.wd) watchdog();
    } else if (state === 'over' && !shown && clock - stateT > 1.2) {
      shown = true;
      const s = summary();
      attract();                                                   // dietro ai risultati il chip riparte da solo
      menu.results(s);
    }
    engine.update(clock);
    if (state === 'play') notices(); else if (state !== 'over') engine.drain();
    stageNotes();
  }
  engine.write(clock);
  updateSpot(frozen ? 0 : dt);
  const hurt = Math.max(0, 1 - (real - hurtT) / 0.35);
  const playing = G && state !== 'menu';
  pix.setFx(playing && pw().kind === 'heat' ? G.heat : 0, hurt, playing && pw().kind === 'battery' ? Math.max(0, 0.3 - G.battery) * 1.6 : 0);
  const sh = real - shakeT < 0.25 ? px * 2 : 0;                    // scossone dopo un glitch
  stage.style.transform = sh ? `translate(${Math.round((Math.random() * 2 - 1)) * sh}px, ${Math.round((Math.random() * 2 - 1)) * sh}px)` : '';
  pix.render(S.scene, camera);
  hud();
  requestAnimationFrame(frame);
}

if (params.has('debug')) {
  window.__dbg = {
    get engine() { return engine; }, menu, api, get state() { return state; }, get G() { return G; }, get clock() { return clock; },
    press, start, sfx, use: id => { use(id); attract(); }, pix, freeze: v => { frozen = v; },
  };
}

use(PROCS[params.get('cpu')] ? params.get('cpu') : lastProc());
resize();
attract();
menu.home();
api.connect().then(() => {                                        // con il server ci sono account, classifiche e sfide
  const code = params.get('sfida');
  if (state !== 'menu' || !menu.visible) return;
  if (code && api.account.online) menu.show('challenge', code.trim().toUpperCase());
  else menu.refresh();
});
requestAnimationFrame(t => {
  last = t / 1000;
  requestAnimationFrame(frame);
  $('veil').classList.add('gone');
});
