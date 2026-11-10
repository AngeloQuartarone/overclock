// I processori del gioco. Ognuno ha il suo file con geometria, processore simulato e tempi dei bit,
// e un `meta` con nome, descrizione, contenitore, unità della frequenza e cosa mette sotto pressione
// (il calore, o la batteria nel microcontrollore).
import * as singolo from './proc-singolo.js';
import * as multiciclo from './proc-multiciclo.js';
import * as pipeline from './proc-pipeline.js';
import * as mcu from './proc-mcu.js';
import * as gpu from './proc-gpu.js';

export const PROCS = { singolo, multiciclo, pipeline, mcu, gpu };
export const ORDER = ['singolo', 'multiciclo', 'pipeline', 'mcu', 'gpu'].filter(id => PROCS[id]);   // l'ordine nel menu
export const DEFAULT = 'pipeline';
export const procName = id => PROCS[id]?.meta.name ?? id;

// il processore scelto l'ultima volta, su questo browser
const KEY = 'overclock-cpu';
export function lastProc() {
  try { const v = localStorage.getItem(KEY); return PROCS[v] ? v : DEFAULT; } catch { return DEFAULT; }
}
export function rememberProc(id) { try { localStorage.setItem(KEY, id); } catch { /* pazienza */ } }
