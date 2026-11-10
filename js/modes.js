// Le modalità di gioco. Le tre da classifica hanno regole fisse per tutti, così i risultati si confrontano.
import { t, dec } from './i18n.js';
import { sha256 } from './sha256.js';

export const SPRINT = 50;

export const MODES = {
  classica: { name: t('mode.classica'), rank: 'score', time: 60, lives: 3, desc: t('mode.classica.desc') },
  sprint: { name: t('mode.sprint'), rank: 'time', target: SPRINT, lives: 3, desc: t('mode.sprint.desc', { n: SPRINT }) },
  sopravvivenza: { name: t('mode.sopravvivenza'), rank: 'score', lives: 3, watchdog: true, desc: t('mode.sopravvivenza.desc') },
  allenamento: { name: t('mode.allenamento'), lives: Infinity, help: true, practice: true, desc: t('mode.allenamento.desc') },
};
export const RANKED = ['classica', 'sprint', 'sopravvivenza'];

export const fmtTime = ms => `${dec(ms / 1000, 2)} s`;
export const fmtValue = (mode, v) => (v == null ? '—' : MODES[mode]?.rank === 'time' ? fmtTime(v) : `${v} ${t('res.points')}`);
export const better = (mode, a, b) => b == null || (MODES[mode].rank === 'time' ? a < b : a > b);
// il valore che conta in classifica: i punti, o il tempo dello sprint se è arrivato in fondo
export const valueOf = s => (MODES[s.mode].rank === 'time' ? (s.finished ? s.time_ms : null) : s.score);

// ---------- la sfida del giorno, calcolata qui come fa il server: così si gioca anche offline ----------
const ROTATION_START = '2026-11-11';
const ROTATION = ['gpu', 'mcu', 'singolo', 'multiciclo', 'pipeline'];
export const today = () => new Date().toLocaleDateString('sv');   // AAAA-MM-GG nell'ora locale
export function dailyFor(day = today()) {
  const h = sha256(`overclock-${day}`);
  const seed = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) & 0x3fffffff;
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${ROTATION_START}T00:00:00Z`)) / 86400000);
  const cpu = days < 0 ? 'pipeline' : ROTATION[days % ROTATION.length];
  return { code: `D-${day}`, cpu, mode: 'classica', seed, date: day };
}

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
