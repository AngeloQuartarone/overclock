// Lo storico delle partite di questo dispositivo, da esportare in un file e mandare a un server (anche locale).
// Il file ha un codice di controllo (SHA-256): un server lo rifiuta se è stato modificato a mano.
// Non è una protezione contro chi bara sul serio, perché l'algoritmo è pubblico: il server fa anche i suoi controlli.
import { sha256hex } from './sha256.js';

const KEY = 'overclock-history';
const MAX = 2000;                                                   // come il limite di un file da importare
export const FIELDS = ['cpu', 'mode', 'seed', 'challenge', 'score', 'time_ms', 'finished', 'crashed',
  'ok', 'perfect', 'good', 'slow', 'glitches', 'combo', 'peak'];

function read() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); return true; } catch { return false; }
}

// identificativo della partita: così un server la riconosce se arriva due volte (in diretta e poi da un file)
export function newId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

// solo i campi del formato, nell'ordine giusto
export function record(s) {
  const g = { id: s.id, played: s.played };
  for (const k of FIELDS) g[k] = s[k] ?? null;
  g.challenge = s.challenge || null;
  return g;
}
export const games = () => read();
export const count = () => read().length;
export function add(s) {
  const list = read();
  if (list.some(g => g.id === s.id)) return;
  list.push(record(s));
  write(list);
}
export const clear = () => write([]);

// una riga per partita, sempre nello stesso ordine: è quella che entra nel codice di controllo
const line = g => [g.id, g.played, g.cpu, g.mode, g.seed, g.challenge || '', g.score, g.time_ms, g.finished ? 1 : 0, g.crashed ? 1 : 0,
  g.ok, g.perfect, g.good, g.slow, g.glitches, g.combo, Math.round(g.peak * 10)].join('|');
export const checksum = list => sha256hex(`overclock-results-v1\n${list.map(line).join('\n')}`);

export function exportData(list = read()) {
  return { format: 'overclock-results', version: 1, exported: new Date().toISOString(), games: list, hash: checksum(list) };
}

// un file scelto dal giocatore: va bene se ha la forma giusta (il codice di controllo lo verifica il server)
export function looksValid(d) {
  return !!d && d.format === 'overclock-results' && d.version === 1 && Array.isArray(d.games) && typeof d.hash === 'string';
}

// il file si scarica; dove il browser lo permette (telefono) si può anche condividere
export async function download() {
  const data = exportData(), name = `overclock-results-${new Date().toLocaleDateString('sv')}.json`;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  if (file && navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: 'Overclock' }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
