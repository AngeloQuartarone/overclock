// Il "look" 8 bit (copia del gioco, con calore e lampo del glitch): la scena 3D viene disegnata a bassa risoluzione, poi un unico passaggio
// aggiunge contorni scuri e bordi chiari (dalla profondità), ravviva i colori, riduce la palette con un dithering
// ordinato di Bayer e mette i puntini sullo sfondo. Il browser ingrandisce a pixel netti.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MAXR = 24;                                                // rettangoli dell'occhio di bue

const FINAL = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    #include <packing>
    #define MAXR ${MAXR}
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform vec2 res;
    uniform float cNear, cFar, levels, edgeT, heat, hurt, sat, fade;
    uniform vec3 bg, edgeCol, rimCol, dotCol;
    // occhio di bue: luce per zona del chip, decisa dalla posizione ricostruita dalla profondità.
    // Le zone sono rettangoli nelle coordinate del core; quelle dopo coprono quelle prima, con bordi morbidi
    uniform mat4 invProj, camWorld;
    uniform vec2 origin;
    uniform vec4 die;
    uniform vec4 rects[MAXR];
    uniform float rlit[MAXR];
    uniform int nr;
    uniform float lit0, litPkg;
    varying vec2 vUv;

    float spot(float d) {
      vec4 v = invProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec3 wp = (camWorld * vec4(v.xyz / v.w, 1.0)).xyz;
      vec2 p = vec2(wp.x + origin.x, wp.z + origin.y);           // coordinate del core
      float L = lit0;
      for (int i = 0; i < MAXR; i++) {
        if (i >= nr) break;
        vec4 r = rects[i];
        float k = smoothstep(r.x - 0.8, r.x + 0.8, p.x) * (1.0 - smoothstep(r.y - 0.8, r.y + 0.8, p.x))
                * smoothstep(r.z - 0.8, r.z + 0.8, p.y) * (1.0 - smoothstep(r.w - 0.8, r.w + 0.8, p.y));
        L = mix(L, rlit[i], k);
      }
      float inDie = step(die.x, p.x) * step(p.x, die.y) * step(die.z, p.y) * step(p.y, die.w);
      return mix(litPkg, L, inDie);
    }

    // 1/z varia in modo lineare sullo schermo lungo una superficie piana:
    // il suo laplaciano è zero sulle facce e diverso da zero solo sui bordi veri
    float wAt(vec2 uv) { return -1.0 / perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cNear, cFar); }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    // le luci molto forti si "schiacciano" verso il bianco senza tagliare la tinta
    vec3 knee(vec3 c) { const float k = 0.7; return mix(c, k + (1.0 - k) * (1.0 - exp(-(c - k) / (1.0 - k))), step(k, c)); }
    float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
    float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

    void main() {
      vec2 px = 1.0 / res;
      float d0 = texture2D(tDepth, vUv).x;
      bool isBg = d0 >= 0.999999;
      float w0 = wAt(vUv);
      float wl = wAt(vUv - vec2(px.x, 0.0)), wr = wAt(vUv + vec2(px.x, 0.0));
      float wu = wAt(vUv + vec2(0.0, px.y)), wd = wAt(vUv - vec2(0.0, px.y));
      float lap = (wl + wr + wu + wd - 4.0 * w0) / w0;

      vec3 c = toSRGB(knee(max(texture2D(tColor, vUv).rgb, 0.0)));
      if (!isBg) {                                                                          // colori più vivi
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = max(mix(vec3(l), c, sat), 0.0);
        c = mix(c, vec3(l) * 0.55, fade);                                                   // chip spento o senza batteria
      }
      if (!isBg && lap < -edgeT && wu < w0 * (1.0 - edgeT * 0.5)) c = mix(c, rimCol, 0.42);  // bordo superiore
      if (lap > edgeT) c = mix(c, edgeCol, 0.88);                                             // contorno
      if (!isBg) c *= spot(d0);                                                               // occhio di bue
      if (!isBg) c = mix(c, c * vec3(1.35, 0.72, 0.5) + vec3(0.05, 0.0, 0.0), heat * 0.65);    // il chip si scalda
      if (isBg && lap <= edgeT && distance(c, bg) < 0.04 && hurt < 0.02) {
        vec2 g = mod(gl_FragCoord.xy, 7.0);
        c = (g.x < 1.0 && g.y < 1.0) ? dotCol : bg;                                           // sfondo a puntini
      } else {
        float v = length((vUv - 0.5) * vec2(1.0, res.y / res.x) * 1.6);
        c *= 1.0 - 0.2 * pow(v, 3.0);                                                         // vignettatura
        c = mix(c, vec3(1.0, 0.16, 0.22), hurt * 0.32);                                       // lampo rosso del glitch
        c = floor(c * levels + bayer4(gl_FragCoord.xy)) / levels;                             // palette ridotta
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
};

const srgb = hex => new THREE.Color(hex).convertLinearToSRGB();
const BIG = 1e5;

export function createPixelRenderer(canvas, pal) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;              // ombre a scalini, senza sfumature
  renderer.setClearColor(new THREE.Color(pal.bg), 1);

  const mat = new THREE.ShaderMaterial({
    ...FINAL,
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, res: { value: new THREE.Vector2(1, 1) },
      cNear: { value: 1 }, cFar: { value: 100 }, levels: { value: 9 }, edgeT: { value: 0.0016 }, heat: { value: 0 }, hurt: { value: 0 },
      sat: { value: 1.22 }, fade: { value: 0 },
      invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, origin: { value: new THREE.Vector2() },
      die: { value: new THREE.Vector4(-1e9, 1e9, -1e9, 1e9) },
      rects: { value: Array.from({ length: MAXR }, () => new THREE.Vector4(BIG, BIG, BIG, BIG)) }, rlit: { value: new Float32Array(MAXR).fill(1) },
      nr: { value: 0 }, lit0: { value: 1 }, litPkg: { value: 1 },
      bg: { value: srgb(pal.bg) }, edgeCol: { value: srgb(pal.edge) }, rimCol: { value: srgb(pal.rim) }, dotCol: { value: srgb(pal.dot) },
    },
    depthTest: false, depthWrite: false,
  });
  const quad = new FullScreenQuad(mat);
  const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.9, 0, 0.95);
  // alone stretto: contano soprattutto i livelli fini, quelli larghi creerebbero macchie sullo sfondo
  bloom.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.7, 0.3, 0.08, 0.0];
  let rt = null;

  return {
    renderer,
    // effetti di gioco: calore del chip (0..1), lampo rosso dopo un glitch (0..1), chip spento (0..1)
    setFx(heat, hurt, fade = 0) { const u = mat.uniforms; u.heat.value = heat; u.hurt.value = hurt; u.fade.value = fade; },
    setSat(v) { mat.uniforms.sat.value = v; },
    // dove stanno le zone del chip (una volta per processore): origine del core, die e rettangoli
    setRegions({ OX, OZ, die, rects }) {
      const u = mat.uniforms;
      u.origin.value.set(OX, OZ);
      u.die.value.set(die.x0, die.x1, die.y0, die.y1);
      u.nr.value = Math.min(MAXR, rects.length);
      rects.slice(0, MAXR).forEach((r, i) => u.rects.value[i].set(r.x0 ?? -BIG, r.x1 ?? BIG, r.y0 ?? -BIG, r.y1 ?? BIG));
    },
    // luce della zona di base, di ogni rettangolo e del contenitore
    setSpot(camera, base, L, pkg) {
      const u = mat.uniforms;
      u.invProj.value.copy(camera.projectionMatrixInverse);
      u.camWorld.value.copy(camera.matrixWorld);
      u.lit0.value = base;
      for (let i = 0; i < L.length && i < MAXR; i++) u.rlit.value[i] = L[i];
      u.litPkg.value = pkg;
    },
    setSize(w, h) {
      renderer.setSize(w, h, false);
      rt?.dispose();
      rt?.depthTexture?.dispose();
      rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthTexture: new THREE.DepthTexture(w, h), generateMipmaps: false,
      });
      bloom.setSize(w, h);
      mat.uniforms.res.value.set(w, h);
      mat.uniforms.tColor.value = rt.texture;
      mat.uniforms.tDepth.value = rt.depthTexture;
    },
    render(scene, camera) {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      bloom.render(renderer, null, rt, 0, false);                // il bagliore dei bit, sommato sul colore
      mat.uniforms.cNear.value = camera.near;
      mat.uniforms.cFar.value = camera.far;
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
  };
}
