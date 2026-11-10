// Collegamento a un server dei punteggi (server.py). Senza server si gioca offline, come ospite.
// Il server è quello che ha servito la pagina, oppure un altro scelto nelle Impostazioni (deve essere in HTTPS
// se la pagina lo è). Ogni server ha il suo accesso: il token si tiene separato per indirizzo.
import { lang, t } from './i18n.js';

const SERVER = 'overclock-server';
const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* pazienza */ } };

let base = read(SERVER) || '';                                     // '' = il server di questa pagina
const tokenKey = () => (base ? `overclock-token@${base}` : 'overclock-token');
let token = read(tokenKey());
export const account = { online: false, user: null, cpus: null, info: null };

// l'indirizzo scritto dal giocatore, ripulito: solo http(s), sempre con la barra finale
export function normalize(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/*$/, '/')}`;
}
export const custom = () => base;
export const serverUrl = () => base || new URL('./', location.href).href;
// una pagina in HTTPS non può parlare con un server in HTTP: il browser la blocca
export const blocked = url => location.protocol === 'https:' && url.startsWith('http:');

async function call(method, path, body) {
  const headers = { 'Accept-Language': lang };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${base}api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new Error(t('unreachable'));
  }
  let data = null;
  try { data = await res.json(); } catch { /* non è JSON: probabilmente non c'è il server */ }
  if (!res.ok || !data || typeof data !== 'object') {
    if (res.status === 401 && token && path !== 'login') { token = null; write(tokenKey(), null); account.user = null; }
    const e = new Error(typeof data?.error === 'string' ? data.error : t('unreachable'));
    e.status = res.status;
    e.code = data?.code;
    throw e;
  }
  return data;
}

export async function connect() {
  // su GitHub Pages non c'è un server accanto alla pagina: inutile chiederlo
  if (!base && location.hostname.endsWith('.github.io')) { Object.assign(account, { online: false, user: null, cpus: null, info: null }); return account; }
  try {
    const d = await call('GET', 'me');
    account.online = true;
    account.user = d.user && typeof d.user.name === 'string' ? { name: d.user.name } : null;
    account.cpus = Array.isArray(d.cpus) ? d.cpus : null;              // un server di prima dei processori conosce solo la pipeline
    if (!d.user && token) { token = null; write(tokenKey(), null); }   // sessione scaduta o server nuovo
    account.info = await call('GET', 'info').catch(() => null);        // un server vecchio non ce l'ha
  } catch {
    Object.assign(account, { online: false, user: null, cpus: null, info: null });
  }
  return account;
}

// cambia server ('' = quello della pagina) e ci si collega
export function setServer(url) {
  base = url || '';
  write(SERVER, base);
  token = read(tokenKey());
  return connect();
}

async function enter(path, body) {
  const d = await call('POST', path, body);
  token = d.token; write(tokenKey(), token);
  account.user = { name: d.user.name };
  return account.user;
}
export const register = (name, password, invite) => enter('register', invite ? { name, password, invite } : { name, password });
export const login = (name, password) => enter('login', { name, password });
export async function logout() {
  try { await call('POST', 'logout'); } catch { /* il token se ne va comunque */ }
  token = null; write(tokenKey(), null);
  account.user = null;
}

// il server sa tenere le partite di questo processore? (se è ancora la versione vecchia, solo la pipeline)
export const supports = cpu => (account.cpus ? account.cpus.includes(cpu) : cpu === 'pipeline');
export const saveGame = game => call('POST', 'games', game);
export const importResults = data => call('POST', 'import', data);
export const leaderboard = (cpu, mode, period) => call('GET', `leaderboard?cpu=${encodeURIComponent(cpu)}&mode=${encodeURIComponent(mode)}&period=${period}`);
export const daily = () => call('GET', 'daily');
export const challenge = code => call('GET', `challenges/${encodeURIComponent(code)}`);
export const createChallenge = body => call('POST', 'challenges', body);
export const myChallenges = () => call('GET', 'challenges');
export const player = name => call('GET', `players/${encodeURIComponent(name)}`);
export const invite = code => call('GET', code ? `invite?sfida=${encodeURIComponent(code)}` : 'invite');
