// La scena 3D: un integrato con il coperchio tolto e il core in vista, costruito estrudendo in altezza
// la geometria del processore (proc-*.js). Il contenitore cambia con il processore:
//   qfp: piatto con le gambe sui quattro lati (la pipeline)       dip: due file di piedini (ciclo singolo, microcontrollore)
//   pga: ceramica con i piedini a griglia sotto (multi-ciclo)    bga: substrato con memorie HBM e niente fili d'oro (GPU)
// Coordinate del core: x lungo il flusso, y2d verso il fondo. In 3D: X = x, Y = altezza, Z = y2d.
import * as THREE from 'three';
import { rng } from './route.js';

export const PAL = {
  bg: '#0a0f24', edge: '#03050e', rim: '#e4e8ff', dot: '#1b2348',
  pkg: '#262c66', die: '#313a8c', seal: '#7482dc', pad: '#ffc75a', finger: '#d69a3a', bond: '#ffd877', pin: '#c8d0f5',
  wireD: '#e3a94e', wireC: '#bdc8ff', via: '#f0c466', plate: '#151b48', plinth: '#3a43a0', cell: '#3f4bb0',
  fill: '#5059b4', logic: '#9aa6f0', dec: '#7480d6', sense: '#b0baf8', alu: '#b6c0ff',
  ff: '#e8465a', pillar: '#4a55b4', clock: '#a8ecff', stripe: '#ff8a2a', dot1: '#ff8a2a',
  extra: '#ffd23a', board: '#16504a', hbm: '#7c86a8', hbmTop: '#aab2cc', cap: '#c9a46a', capEnd: '#d9dde8', ring: '#9aa3b8',
};

// altezze (Y) dei vari strati, condivise con la regia
export const Y = {
  wireD: [0, 0.2], wireC: [0.74, 0.88], cell: [0, 0.24], led: [0.24, 0.31], ff: [0, 1.3], ffLed: [1.3, 1.37],
  spine: [2.75, 3.25], branch: [2.3, 2.65], blk: { fill: 0.45, logic: 1.5, dec: 0.7, sense: 0.9, alu: 2.0, core: 1.1, port: 0.9 },
};

const NEAREST = { magFilter: THREE.NearestFilter, minFilter: THREE.NearestMipmapNearestFilter };

// trame a pixel per le facce superiori (in grigio: il colore viene dal materiale)
function texture(kind, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = rng(seed);
  const tone = v => `rgb(${v},${v},${v})`;
  if (kind === 'cells') {                                           // righe di celle standard
    g.fillStyle = tone(170); g.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 8) {
      g.fillStyle = tone(120); g.fillRect(0, y, 64, 1);
      for (let x = 0; x < 64;) {
        const w = 2 + ((r() * 7) | 0);
        g.fillStyle = tone([255, 220, 190, 236][(r() * 4) | 0]);
        g.fillRect(x, y + 2, w - 1, 5);
        if (r() < 0.45) { g.fillStyle = tone(110); g.fillRect(x + ((r() * (w - 1)) | 0), y + 3 + ((r() * 3) | 0), 1, 1); }
        x += w;
      }
    }
  } else if (kind === 'stripes') {                                  // decodificatori e amplificatori
    g.fillStyle = tone(150); g.fillRect(0, 0, 64, 64);
    for (let x = 0; x < 64; x += 4) {
      g.fillStyle = tone(235); g.fillRect(x, 0, 2, 64);
      for (let y = 0; y < 64; y += 6) if (r() < 0.5) { g.fillStyle = tone(120); g.fillRect(x, y, 2, 2); }
    }
  } else if (kind === 'grid') {                                     // core ripetuti: una griglia fitta (GPU, periferiche)
    g.fillStyle = tone(160); g.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 4) for (let x = 0; x < 64; x += 4) {
      g.fillStyle = tone(r() < 0.7 ? 230 : 200); g.fillRect(x, y, 3, 3);
    }
  } else {                                                          // silicio: grana e griglia di instradamento
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const v = 225 + ((r() * 30) | 0) - ((x % 8 === 0 || y % 8 === 0) ? 22 : 0);
      g.fillStyle = tone(Math.min(255, v)); g.fillRect(x, y, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  Object.assign(t, NEAREST);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildScene(C, look = {}) {
  const pal = { ...PAL, ...(look.pal || {}) };
  const style = look.pkg || 'qfp';
  const scene = new THREE.Scene();
  const DIE = C.die || { x0: -5, x1: C.W + 5, y0: 1, y1: C.H + 3 };
  const OX = (DIE.x0 + DIE.x1) / 2, OZ = (DIE.y0 + DIE.y1) / 2;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const lam = (hex, map) => new THREE.MeshLambertMaterial({ color: hex, map: map || null });
  const tex = { cells: texture('cells', 7), stripes: texture('stripes', 9), die: texture('die', 3), grid: texture('grid', 5) };
  const tiled = (t, w, d) => { const c = t.clone(); c.repeat.set(w / 16, d / 16); c.needsUpdate = true; return c; };
  let lo = -3.9;                                                    // il punto più basso (per inquadrare)

  // un parallelepipedo nelle coordinate del core: [x0, y0, z0, x1, y1, z1] con y = altezza
  const solid = (mat, b, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    m.position.set((b[0] + b[3]) / 2 - OX, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2 - OZ);
    m.castShadow = cast; m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  const m4 = new THREE.Matrix4();
  const many = (mat, list, cast = true) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((b, i) => {
      m4.makeScale(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      m4.setPosition((b[0] + b[3]) / 2 - OX, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2 - OZ);
      im.setMatrixAt(i, m4);
    });
    im.castShadow = cast; im.receiveShadow = true;
    scene.add(im);
    return im;
  };
  const topMat = (hex, t, w, d) => { const s = lam(hex); const top = lam(hex, tiled(t, w, d)); return [s, s, top, s, s, s]; };
  const fix = b => [Math.min(b[0], b[3]), b[1], Math.min(b[2], b[5]), Math.max(b[0], b[3]), b[4], Math.max(b[2], b[5])];
  const side = (n, fn) => { for (let i = 0; i < n; i++) fn((i + 0.5) / n); };

  // ---------- il contenitore ----------
  let PKG;
  const pins = [];
  const cavityFrame = (cav, mat, top = 0.6) => {                     // il bordo rialzato attorno alla cavità
    for (const b of [
      [PKG.x0, -0.9, PKG.y0, PKG.x1, top, cav.y0], [PKG.x0, -0.9, cav.y1, PKG.x1, top, PKG.y1],
      [PKG.x0, -0.9, cav.y0, cav.x0, top, cav.y1], [cav.x1, -0.9, cav.y0, PKG.x1, top, cav.y1],
    ]) solid(mat, b);
  };
  const cav = { x0: DIE.x0 - 3, x1: DIE.x1 + 3, y0: DIE.y0 - 3, y1: DIE.y1 + 3 };
  let bonded = true;                                                // fili d'oro dal die alla cavità (non nella GPU)

  if (style === 'qfp') {
    PKG = { x0: DIE.x0 - 6.5, x1: DIE.x1 + 6.5, y0: DIE.y0 - 6.5, y1: DIE.y1 + 6.5 };
    solid(lam(pal.pkg), [PKG.x0, -3.0, PKG.y0, PKG.x1, -0.9, PKG.y1]);
    cavityFrame(cav, lam(pal.pkg));
    solid(lam(pal.dot1), [PKG.x0 + 2, 0.6, PKG.y0 + 2, PKG.x0 + 3.4, 0.7, PKG.y0 + 3.4]);   // il pallino del pin 1
    const leg = (x, z, dx, dz) => {                                 // gamba "ad ala di gabbiano"
      const seg = (a0, a1, y0, y1) => pins.push(fix(dx
        ? [x + a0 * dx, y0, z - 0.5, x + a1 * dx, y1, z + 0.5]
        : [x - 0.5, y0, z + a0 * dz, x + 0.5, y1, z + a1 * dz]));
      seg(-0.2, 1.4, -2.3, -1.9); seg(1.0, 1.4, -3.7, -1.9); seg(1.0, 2.7, -3.9, -3.5);
    };
    const nx = Math.floor((PKG.x1 - PKG.x0 - 8) / 2.6), nz = Math.floor((PKG.y1 - PKG.y0 - 8) / 2.6);
    side(nx, u => { const x = PKG.x0 + 4 + u * (PKG.x1 - PKG.x0 - 8); leg(x, PKG.y1, 0, 1); leg(x, PKG.y0, 0, -1); });
    side(nz, u => { const z = PKG.y0 + 4 + u * (PKG.y1 - PKG.y0 - 8); leg(PKG.x1, z, 1, 0); leg(PKG.x0, z, -1, 0); });
    PKG = { ...PKG, ox: 3, oz: 3 };
  } else if (style === 'dip') {
    // due file di piedini lungo i lati lunghi, dritti verso il basso (si infilano nella scheda)
    PKG = { x0: DIE.x0 - 9, x1: DIE.x1 + 9, y0: DIE.y0 - 7, y1: DIE.y1 + 7 };
    const body = lam(pal.pkg);
    solid(body, [PKG.x0, -3.2, PKG.y0, PKG.x1, -0.9, PKG.y1]);
    cavityFrame(cav, body, 0.9);
    if (look.ring) many(lam(look.ring), [                          // l'anello d'oro dove era saldato il coperchio
      [cav.x0 - 1.2, 0.9, cav.y0 - 1.2, cav.x1 + 1.2, 1.0, cav.y0 - 0.2], [cav.x0 - 1.2, 0.9, cav.y1 + 0.2, cav.x1 + 1.2, 1.0, cav.y1 + 1.2],
      [cav.x0 - 1.2, 0.9, cav.y0 - 0.2, cav.x0 - 0.2, 1.0, cav.y1 + 0.2], [cav.x1 + 0.2, 0.9, cav.y0 - 0.2, cav.x1 + 1.2, 1.0, cav.y1 + 0.2],
    ], false);
    // la tacca sul lato corto, che dice dov'è il piedino 1
    solid(lam(pal.edge), [PKG.x0 - 0.01, 0.2, (PKG.y0 + PKG.y1) / 2 - 2.2, PKG.x0 + 1.6, 0.92, (PKG.y0 + PKG.y1) / 2 + 2.2], false);
    solid(lam(pal.dot1), [PKG.x0 + 3.2, 0.9, PKG.y1 - 4.4, PKG.x0 + 4.6, 1.0, PKG.y1 - 3.0]);
    const n = look.pins || 20;
    C.legs = [];                                                    // dove stanno i piedini: il microcontrollore li accende
    const leg = (x, z, dz) => {
      C.legs.push({ x, z, dz });
      pins.push(fix([x - 0.9, -2.3, z, x + 0.9, -1.8, z + dz * 1.8]));               // la spalla
      pins.push(fix([x - 0.9, -6.2, z + dz * 1.3, x + 0.9, -1.8, z + dz * 1.8]));    // la gamba larga
      pins.push(fix([x - 0.4, -8.2, z + dz * 1.3, x + 0.4, -6.2, z + dz * 1.8]));    // la punta sottile
    };
    side(n, u => { const x = PKG.x0 + 5 + u * (PKG.x1 - PKG.x0 - 10); leg(x, PKG.y1, 1); leg(x, PKG.y0, -1); });
    lo = -8.3;
    PKG = { ...PKG, ox: 0.5, oz: 2.5 };
  } else if (style === 'pga') {
    // ceramica quadrata, con una foresta di piedini sotto
    PKG = { x0: DIE.x0 - 8, x1: DIE.x1 + 8, y0: DIE.y0 - 8, y1: DIE.y1 + 8 };
    const body = lam(pal.pkg);
    solid(body, [PKG.x0, -3.4, PKG.y0, PKG.x1, -0.9, PKG.y1]);
    cavityFrame(cav, body, 0.9);
    if (look.ring) many(lam(look.ring), [
      [cav.x0 - 1.4, 0.9, cav.y0 - 1.4, cav.x1 + 1.4, 1.0, cav.y0 - 0.3], [cav.x0 - 1.4, 0.9, cav.y1 + 0.3, cav.x1 + 1.4, 1.0, cav.y1 + 1.4],
      [cav.x0 - 1.4, 0.9, cav.y0 - 0.3, cav.x0 - 0.3, 1.0, cav.y1 + 0.3], [cav.x1 + 0.3, 0.9, cav.y0 - 0.3, cav.x1 + 1.4, 1.0, cav.y1 + 0.3],
    ], false);
    solid(lam(pal.dot1), [PKG.x0 + 1.6, 0.0, PKG.y0 + 1.6, PKG.x0 + 4.6, 0.95, PKG.y0 + 4.6]);   // l'angolo smussato del pin 1
    for (let r = 0; r < 3; r++) {                                   // tre giri di piedini lungo il bordo
      const m = 1.3 + r * 2.4;
      for (let x = PKG.x0 + m; x <= PKG.x1 - m + 0.01; x += 2.4) {
        for (const z of [PKG.y0 + m, PKG.y1 - m]) pins.push([x - 0.3, -7.8, z - 0.3, x + 0.3, -3.4, z + 0.3]);
      }
      for (let z = PKG.y0 + m + 2.4; z <= PKG.y1 - m - 2.4 + 0.01; z += 2.4) {
        for (const x of [PKG.x0 + m, PKG.x1 - m]) pins.push([x - 0.3, -7.8, z - 0.3, x + 0.3, -3.4, z + 0.3]);
      }
    }
    lo = -7.9;
    PKG = { ...PKG, ox: 0.5, oz: 0.5 };
  } else {                                                          // bga: la GPU
    bonded = false;
    const hbm = look.hbm ?? 2;                                      // pile di memoria per lato
    const HW = 15, gapX = 3;
    PKG = { x0: DIE.x0 - gapX - HW - 9, x1: DIE.x1 + gapX + HW + 9, y0: DIE.y0 - 9, y1: DIE.y1 + 9 };
    solid(lam(pal.board), [PKG.x0, -2.4, PKG.y0, PKG.x1, -1.5, PKG.y1]);                     // il substrato
    const IP = { x0: DIE.x0 - gapX - HW - 2.5, x1: DIE.x1 + gapX + HW + 2.5, y0: DIE.y0 - 2.5, y1: DIE.y1 + 2.5 };
    solid(lam(pal.pkg, tiled(tex.die, IP.x1 - IP.x0, IP.y1 - IP.y0)), [IP.x0, -1.5, IP.y0, IP.x1, -0.9, IP.y1]);   // l'interposer di silicio
    many(lam(pal.ring), [                                           // l'anello d'acciaio che tiene dritto il substrato
      [PKG.x0 + 0.8, -1.5, PKG.y0 + 0.8, PKG.x1 - 0.8, -0.7, PKG.y0 + 3.2], [PKG.x0 + 0.8, -1.5, PKG.y1 - 3.2, PKG.x1 - 0.8, -0.7, PKG.y1 - 0.8],
      [PKG.x0 + 0.8, -1.5, PKG.y0 + 3.2, PKG.x0 + 3.2, -0.7, PKG.y1 - 3.2], [PKG.x1 - 3.2, -1.5, PKG.y0 + 3.2, PKG.x1 - 0.8, -0.7, PKG.y1 - 3.2],
    ]);
    // le memorie HBM: pile di chip una sull'altra, con il chip di base più largo
    const layers = [], tops = [];
    const dd = (DIE.y1 - DIE.y0 - 2) / hbm;
    for (const sx of [-1, 1]) for (let i = 0; i < hbm; i++) {
      const x0 = sx < 0 ? DIE.x0 - gapX - HW : DIE.x1 + gapX, x1 = x0 + HW;
      const z0 = DIE.y0 + 1 + i * dd + 0.8, z1 = z0 + dd - 1.6;
      layers.push([x0, -0.9, z0, x1, -0.5, z1]);
      for (let l = 0; l < 6; l++) layers.push([x0 + 0.5, -0.5 + l * 0.42, z0 + 0.5, x1 - 0.5, -0.5 + l * 0.42 + 0.34, z1 - 0.5]);
      tops.push([x0 + 0.5, 2.02, z0 + 0.5, x1 - 0.5, 2.1, z1 - 0.5]);
    }
    many(lam(pal.hbm), layers);
    many(lam(pal.hbmTop, tiled(tex.grid, HW, dd)), tops, false);
    C.hbmBoxes = tops;                                              // la regia accende le pile quando legge la memoria
    // i condensatori sul substrato
    const caps = [], ends = [];
    const capAt = (x, z) => { caps.push([x - 0.7, -1.5, z - 0.45, x + 0.7, -0.9, z + 0.45]); ends.push([x - 1.0, -1.5, z - 0.5, x - 0.7, -0.85, z + 0.5], [x + 0.7, -1.5, z - 0.5, x + 1.0, -0.85, z + 0.5]); };
    for (let x = IP.x0 + 2; x < IP.x1 - 1; x += 3.4) { capAt(x, IP.y0 - 2.4); capAt(x, IP.y1 + 2.4); }
    many(lam(pal.cap), caps, false);
    many(lam(pal.capEnd), ends, false);
    // le sfere di saldatura sotto, che si vedono sul bordo
    for (let x = PKG.x0 + 1.5; x < PKG.x1 - 1; x += 2.4) for (const z of [PKG.y0 + 1.5, PKG.y1 - 1.5]) pins.push([x - 0.55, -3.3, z - 0.55, x + 0.55, -2.4, z + 0.55]);
    for (let z = PKG.y0 + 3.9; z < PKG.y1 - 3; z += 2.4) for (const x of [PKG.x0 + 1.5, PKG.x1 - 1.5]) pins.push([x - 0.55, -3.3, z - 0.55, x + 0.55, -2.4, z + 0.55]);
    lo = -3.4;
    PKG = { ...PKG, ox: 1, oz: 1 };
  }
  many(lam(pal.pin), pins);

  solid(lam(pal.die, tiled(tex.die, DIE.x1 - DIE.x0, DIE.y1 - DIE.y0)), [DIE.x0, -0.9, DIE.y0, DIE.x1, 0, DIE.y1]);
  const ring = [];
  const r0 = 0.4, r1 = 0.9;
  ring.push([DIE.x0 + r0, 0, DIE.y0 + r0, DIE.x1 - r0, 0.08, DIE.y0 + r1], [DIE.x0 + r0, 0, DIE.y1 - r1, DIE.x1 - r0, 0.08, DIE.y1 - r0]);
  ring.push([DIE.x0 + r0, 0, DIE.y0 + r1, DIE.x0 + r1, 0.08, DIE.y1 - r1], [DIE.x1 - r1, 0, DIE.y0 + r1, DIE.x1 - r0, 0.08, DIE.y1 - r1]);
  many(lam(pal.seal), ring, false);

  // contatti sul bordo del die, collegati con un filo d'oro ad arco alle piste della cavità
  const pads = [], fingers = [], bonds = [];
  C.pads = [];
  if (bonded) {
    const bond = (pts) => { for (let i = 1; i < pts.length; i++) bonds.push([pts[i - 1], pts[i]]); };
    const padAt = (x, z, ox, oz) => {                               // (ox, oz): verso l'esterno
      pads.push([x - 0.6, 0, z - 0.6, x + 0.6, 0.12, z + 0.6]);
      C.pads.push({ x, z, ox, oz });
      const e = ox ? (ox > 0 ? DIE.x1 : DIE.x0) : (oz > 0 ? DIE.y1 : DIE.y0);
      const along = ox ? z : x;
      const at = (d, h) => ox ? [e + ox * d, h, along] : [along, h, e + oz * d];
      const f0 = at(0.9, -0.9), f1 = at(2.8, -0.8);
      fingers.push(fix(ox ? [f0[0], -0.9, along - 0.35, f1[0], -0.8, along + 0.35] : [along - 0.35, -0.9, f0[2], along + 0.35, -0.8, f1[2]]));
      bond([[x, 0.12, z], at(-1.0, 1.0), at(0.5, 1.3), at(1.6, 0.3), at(2.2, -0.8)]);
    };
    // le dorsali del clock che escono dal die passano sopra i contatti dei lati corti: lì non se ne mettono
    const skip = C.clock.segs.filter(s => s.kind === 'spine' && s.y0 === s.y1).map(s => [s.y0 - s.w / 2 - 0.6, s.y0 + s.w / 2 + 0.6]);
    const step = look.padStep || 3;
    for (let x = DIE.x0 + 4; x <= DIE.x1 - 4; x += step) { padAt(x, DIE.y0 + 1.8, 0, -1); padAt(x, DIE.y1 - 1.8, 0, 1); }
    for (let z = DIE.y0 + 4; z <= DIE.y1 - 4; z += step) {
      if (skip.some(([a, b]) => z > a && z < b)) continue;
      padAt(DIE.x0 + 1.8, z, -1, 0); padAt(DIE.x1 - 1.8, z, 1, 0);
    }
  }
  many(lam(pal.pad), pads, false);
  many(lam(pal.finger), fingers, false);
  if (bonds.length) {
    const im = new THREE.InstancedMesh(geo, lam(pal.bond), bonds.length);
    const q = new THREE.Quaternion(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    const X = new THREE.Vector3(1, 0, 0), s = new THREE.Vector3();
    bonds.forEach(([p, r], i) => {
      a.set(p[0] - OX, p[1], p[2] - OZ); b.set(r[0] - OX, r[1], r[2] - OZ);
      d.subVectors(b, a);
      q.setFromUnitVectors(X, d.clone().normalize());
      s.set(d.length() + 0.12, 0.14, 0.14);
      m4.compose(a.add(b).multiplyScalar(0.5), q, s);
      im.setMatrixAt(i, m4);
    });
    im.castShadow = true;
    scene.add(im);
  }

  // ---------- il core ----------
  for (const f of C.foot) {
    if (f.kind === 'array') solid(lam(pal.plate), [f.x, 0, f.y, f.x + f.w, 0.05, f.y + f.h], false);
    else solid(lam(pal.plinth), [f.x, 0, f.y, f.x + f.w, 0.12, f.y + f.h], false);
  }

  const segs = (list, w, y) => {
    const out = [];
    for (const pts of list) {
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        out.push([Math.min(ax, bx) - w / 2, y[0], Math.min(az, bz) - w / 2, Math.max(ax, bx) + w / 2, y[1], Math.max(az, bz) + w / 2]);
      }
    }
    return out;
  };
  many(lam(pal.wireD), segs(C.wires, 0.34, Y.wireD), false);
  many(lam(pal.wireC), segs(C.ctrl, 0.26, Y.wireC), true);
  const vd = [], vc = [];
  for (const [x, z, layer] of C.vias) {
    if (layer === 'c') vc.push([x - 0.17, 0, z - 0.17, x + 0.17, Y.wireC[1], z + 0.17]);
    else if (layer === 'd') vd.push([x - 0.3, 0, z - 0.3, x + 0.3, 0.27, z + 0.3]);
  }
  many(lam(pal.via), vd, false);
  many(lam(pal.wireC), vc, true);

  // blocchi di logica, con la loro trama a pixel; la regia usa .top per le scintille
  for (const b of C.logic) {
    const h = b.top ?? Y.blk[b.kind] ?? Y.blk.logic;
    b.top = h;
    const t = b.kind === 'dec' || b.kind === 'sense' ? tex.stripes : b.kind === 'core' || b.kind === 'port' ? tex.grid : tex.cells;
    solid(topMat(pal[b.kind] || pal.logic, t, b.w, b.h), [b.x, 0, b.y, b.x + b.w, h, b.y + b.h]);
  }
  for (const alu of C.blocks.alu || []) {                          // una fascia arancio su ogni fetta dell'ALU
    solid(lam(pal.stripe), [alu.x + alu.w - 1.6, alu.top, alu.y + 0.3, alu.x + alu.w - 0.8, alu.top + 0.12, alu.y + alu.h - 0.3], false);
  }

  // celle delle memorie: una piastrella e, sopra, un "led" che mostra il bit memorizzato
  const tiles = [], ledBoxes = [], ledBase = {};
  for (const id of Object.keys(C.arrays)) {
    const A = C.arrays[id];
    ledBase[id] = ledBoxes.length;
    const up = A.z || 0;                                            // celle appoggiate sopra un blocco (le spie della macchina a stati)
    for (let k = 0; k < A.cols; k++) for (let j = 0; j < A.rows; j++) {
      const x = A.cx(k), z = A.cy(j);
      tiles.push([x - A.cw / 2, Y.cell[0] + up, z - A.ch / 2, x + A.cw / 2, Y.cell[1] + up, z + A.ch / 2]);
      const lw = A.cw * (A.lw ?? 0.56), ld = Math.min(A.ch * (A.lw ?? 0.6), A.lmax ?? 0.9);
      ledBoxes.push([x - lw / 2, Y.led[0] + up, z - ld / 2, x + lw / 2, Y.led[1] + up, z + ld / 2]);
    }
  }
  many(lam(pal.cell), tiles, false);
  const glow = () => new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ledMesh = many(glow(), ledBoxes, false);
  ledMesh.receiveShadow = false;
  ledMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ledBoxes.length * 3), 3);

  // registri di pipeline: file di "latch" con una spia grande sopra. Nel gioco sono loro a dire
  // quando toccare: il corpo passa dal rosso al verde quando il registro ha ricevuto tutti i bit
  const ffBody = many(lam('#ffffff'), C.ffs.map(f => [f.x, Y.ff[0], f.y - f.h / 2, f.x + f.w, Y.ff[1], f.y + f.h / 2]));
  ffBody.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(C.ffs.length * 3), 3);
  const ffMesh = many(glow(), C.ffs.map(f => [f.x + 0.15, Y.ffLed[0], f.y - f.h * 0.42, f.x + f.w - 0.15, Y.ffLed[1], f.y + f.h * 0.42]), false);
  ffMesh.receiveShadow = false;
  ffMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(C.ffs.length * 3), 3);

  // rete del clock: dorsali sopraelevate, rami sopra i registri, pilastri
  const clockMat = lam(pal.clock), pil = [];
  for (const sg of C.clock.segs) {
    const hy = sg.kind === 'spine' ? Y.spine : Y.branch;
    const b = [Math.min(sg.x0, sg.x1) - (sg.y0 === sg.y1 ? 0 : sg.w / 2), hy[0], Math.min(sg.y0, sg.y1) - (sg.y0 === sg.y1 ? sg.w / 2 : 0),
      Math.max(sg.x0, sg.x1) + (sg.y0 === sg.y1 ? 0 : sg.w / 2), hy[1], Math.max(sg.y0, sg.y1) + (sg.y0 === sg.y1 ? sg.w / 2 : 0)];
    solid(clockMat, b);
    if (sg.kind === 'spine') {                                      // pilastri lungo la dorsale
      if (sg.y0 === sg.y1) for (let x = Math.min(sg.x0, sg.x1) + 0.4; x < Math.max(sg.x0, sg.x1); x += 15.5) pil.push([x - 0.3, 0, sg.y0 - 0.3, x + 0.3, Y.spine[0], sg.y0 + 0.3]);
      else for (let z = Math.min(sg.y0, sg.y1) + 0.4; z < Math.max(sg.y0, sg.y1); z += 15.5) pil.push([sg.x0 - 0.3, 0, z - 0.3, sg.x0 + 0.3, Y.spine[0], z + 0.3]);
    } else if (sg.y0 !== sg.y1) {                                   // un pilastro in fondo a ogni ramo
      pil.push(fix([sg.x1 - 0.25, 0, sg.y1 - 0.5 * Math.sign(sg.y1 - sg.y0), sg.x1 + 0.25, Y.branch[0], sg.y1]));
    } else pil.push(fix([sg.x1 - 0.5 * Math.sign(sg.x1 - sg.x0), 0, sg.y1 - 0.25, sg.x1, Y.branch[0], sg.y1 + 0.25]));
  }
  many(lam(pal.pillar), pil);

  // ---------- luci ----------
  scene.add(new THREE.HemisphereLight(0x9aa6ff, 0x1a1842, 1.35));
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.3);
  sun.position.set(-75, 85, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const ext = style === 'qfp' ? 95 : Math.max(PKG.x1 - PKG.x0, (PKG.y1 - PKG.y0) * 1.4) / 2 + 20;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext * 0.74, bottom: -ext * 0.74, near: 20, far: 320 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---------- oggetti luminosi che si muovono: bit, scie, scintille, onda di clock ----------
  const CAP = 9000;
  const dyn = new THREE.InstancedMesh(geo, glow(), CAP);
  dyn.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dyn.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
  dyn.instanceColor.setUsage(THREE.DynamicDrawUsage);
  dyn.frustumCulled = false;
  dyn.count = 0;
  scene.add(dyn);
  const DM = dyn.instanceMatrix.array, DC = dyn.instanceColor.array;
  let n = 0;
  const fx = {
    begin() { n = 0; },
    // centro (x, altezza, z) e misure nelle coordinate del core; colore lineare, anche > 1 (si accende il bagliore)
    box(x, y, z, sx, sy, sz, r, g, b) {
      if (n >= CAP) return;
      const o = n * 16, c = n * 3;
      DM[o] = sx; DM[o + 5] = sy; DM[o + 10] = sz;
      DM[o + 12] = x - OX; DM[o + 13] = y; DM[o + 14] = z - OZ;
      DC[c] = r; DC[c + 1] = g; DC[c + 2] = b;
      n++;
    },
    end() {
      dyn.count = n;
      for (const a of [dyn.instanceMatrix, dyn.instanceColor]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    },
  };
  const LC = ledMesh.instanceColor.array, FC = ffMesh.instanceColor.array, BC = ffBody.instanceColor.array;
  const leds = {
    set(id, k, j, r, g, b) { const i = (ledBase[id] + k * C.arrays[id].rows + j) * 3; LC[i] = r; LC[i + 1] = g; LC[i + 2] = b; },
    ff(i, r, g, b) { FC[i * 3] = r; FC[i * 3 + 1] = g; FC[i * 3 + 2] = b; },
    ffBody(i, r, g, b) { BC[i * 3] = r; BC[i * 3 + 1] = g; BC[i * 3 + 2] = b; },
    end() { for (const m of [ledMesh, ffMesh, ffBody]) m.instanceColor.needsUpdate = true; },
  };

  const bounds = new THREE.Box3(
    new THREE.Vector3(PKG.x0 - PKG.ox - OX, lo, PKG.y0 - PKG.oz - OZ),
    new THREE.Vector3(PKG.x1 + PKG.ox - OX, Y.spine[1], PKG.y1 + PKG.oz - OZ),
  );
  const toWorld = (x, h, z, v = new THREE.Vector3()) => v.set(x - OX, h, z - OZ);
  // per l'occhio di bue: dove sta l'origine del core, e il rettangolo del die
  const regions = { OX, OZ, die: DIE };
  return { scene, fx, leds, bounds, toWorld, regions, pal };
}
