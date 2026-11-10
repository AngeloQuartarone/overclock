// Suoni 8 bit sintetizzati al volo con Web Audio: nessun file audio.
// Il browser li permette solo dopo un gesto dell'utente, quindi ensure() va chiamato al primo tocco.

const SCALE = [523, 587, 659, 784, 880, 1047, 1175, 1319];         // pentatonica, sale con la combo
const PENTA2 = [392, 440, 523, 587, 659, 784, 880, 1047, 1175, 1319];

export function createSfx() {
  const KEY = 'overclock-muted';
  let ac = null, out = null, muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch { /* audio acceso */ }
  const remember = () => { try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* solo per questa volta */ } };

  const ensure = () => {
    if (!ac) {
      try {
        ac = new AudioContext();
        out = ac.createGain();
        out.gain.value = 0.5;
        out.connect(ac.destination);
      } catch { ac = null; }
    }
    if (ac && ac.state === 'suspended') ac.resume();
  };
  const tone = (freq, dur, { type = 'square', vol = 0.12, slide = 1, delay = 0 } = {}) => {
    if (!ac || muted) return;
    const t = ac.currentTime + delay;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  };
  const noise = (dur, vol = 0.2) => {
    if (!ac || muted) return;
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = ac.createBufferSource(), g = ac.createGain();
    s.buffer = buf;
    g.gain.value = vol;
    s.connect(g).connect(out);
    s.start();
  };

  return {
    ensure,
    get muted() { return muted; },
    toggle() { muted = !muted; remember(); return muted; },
    set(m) { muted = !!m; remember(); },
    tick: () => tone(110, 0.06, { slide: 0.5, vol: 0.18 }),       // il colpo di clock, come una cassa
    ui: () => tone(660, 0.035, { vol: 0.035 }),                    // i pulsanti del menu
    // uno stadio ha finito: IF, ID, EX, MEM, WB hanno ciascuno la sua nota; con tanti stadi (le corsie
    // della GPU) le note salgono su due ottave della stessa scala, più piano
    stage: (i, n = 5) => (n <= 5
      ? tone([392, 440, 523, 587, 659][i], 0.08, { type: 'triangle', vol: 0.07 })
      : tone(PENTA2[Math.round((i * (PENTA2.length - 1)) / Math.max(1, n - 1))], 0.06, { type: 'triangle', vol: 0.035 })),
    // l'ultimo stadio ha finito: l'accordo si chiude, è il momento di toccare
    allDone: () => { tone(784, 0.12, { type: 'triangle', vol: 0.06 }); tone(1047, 0.16, { type: 'triangle', vol: 0.07 }); },
    perfect: combo => tone(SCALE[combo % SCALE.length] * (combo >= SCALE.length ? 2 : 1), 0.09, { vol: 0.07 }),
    good: () => tone(440, 0.06, { type: 'triangle', vol: 0.08 }),
    slow: () => tone(196, 0.08, { type: 'triangle', vol: 0.06 }),
    glitch: () => { noise(0.18, 0.22); tone(160, 0.18, { type: 'sawtooth', slide: 0.4, vol: 0.08 }); },
    miss: () => tone(330, 0.12, { type: 'square', slide: 0.7, vol: 0.05 }),
    // un colpo mentre il processore dorme: un tonfo sordo
    waste: () => tone(140, 0.09, { type: 'square', slide: 0.6, vol: 0.06 }),
    // un premio che non è un colpo (interrupt servito, immagine finita)
    bonus: () => { tone(988, 0.06, { vol: 0.06 }); tone(1319, 0.09, { vol: 0.06, delay: 0.06 }); },
    // un interrupt sul piedino: due bip acuti
    irq: () => { tone(1568, 0.04, { vol: 0.05 }); tone(1568, 0.04, { vol: 0.05, delay: 0.08 }); },
    // un'immagine completa
    frame: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.08, { vol: 0.055, delay: i * 0.05 })),
    heart: () => { tone(784, 0.07, { vol: 0.07 }); tone(1047, 0.1, { vol: 0.07, delay: 0.07 }); },
    count: last => tone(last ? 880 : 440, last ? 0.25 : 0.12, { vol: 0.1 }),
    over: crash => {
      if (crash) { noise(0.5, 0.25); tone(220, 0.6, { type: 'sawtooth', slide: 0.25, vol: 0.1 }); }
      else [659, 784, 1047].forEach((f, i) => tone(f, 0.16, { vol: 0.08, delay: i * 0.12 }));
    },
  };
}
