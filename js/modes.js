// Le modalità di gioco. Le tre da classifica hanno regole fisse per tutti, così i risultati si confrontano.
export const SPRINT = 50;

export const MODES = {
  classica: {
    name: 'Classica', rank: 'score', time: 60, lives: 3,
    desc: '60 secondi e 3 vite: fai più punti che puoi.',
  },
  sprint: {
    name: 'Sprint 50', rank: 'time', target: SPRINT, lives: 3,
    desc: `${SPRINT} istruzioni corrette nel minor tempo possibile.`,
  },
  sopravvivenza: {
    name: 'Sopravvivenza', rank: 'score', lives: 3, watchdog: true,
    desc: 'Niente tempo limite, ma il watchdog concede sempre meno ritardo: se tardi troppo perdi una vita.',
  },
  allenamento: {
    name: 'Allenamento', lives: Infinity, help: true, practice: true,
    desc: 'Senza vite né tempo, con le spie degli stadi in basso. Non si salva.',
  },
};
export const RANKED = ['classica', 'sprint', 'sopravvivenza'];

const num = (v, d) => v.toFixed(d).replace('.', ',');
export const fmtTime = ms => `${num(ms / 1000, 2)} s`;
export const fmtValue = (mode, v) => (v == null ? '—' : MODES[mode]?.rank === 'time' ? fmtTime(v) : `${v} punti`);
export const better = (mode, a, b) => b == null || (MODES[mode].rank === 'time' ? a < b : a > b);
// il valore che conta in classifica: i punti, o il tempo dello sprint se è arrivato in fondo
export const valueOf = s => (MODES[s.mode].rank === 'time' ? (s.finished ? s.time_ms : null) : s.score);

// record di questo browser, per chi gioca come ospite: { processore: { modalità: valore } }
const KEY = 'overclock-best';
function readBests() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}'), o = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number') (o.pipeline ||= {})[k] = v;       // prima dei processori: { modalità: valore }, era la pipeline
      else if (v && typeof v === 'object') o[k] = { ...o[k], ...v };
    }
    const old = Number(localStorage.getItem('overclock-record'));  // il record della prima versione
    if (old && o.pipeline?.classica == null) (o.pipeline ||= {}).classica = old;
    return o;
  } catch { return {}; }
}
export const localBests = cpu => readBests()[cpu] || {};
export function saveLocalBest(cpu, mode, v) {
  const o = readBests();
  if (v == null || !better(mode, v, o[cpu]?.[mode])) return false;
  (o[cpu] ||= {})[mode] = v;
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* niente salvataggi: pazienza */ }
  return true;
}
