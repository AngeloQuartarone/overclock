// Collegamento al server dei punteggi (server.py). Se il server non c'è, si gioca come ospite.
const KEY = 'overclock-token';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = v => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* pazienza */ } };

let token = read();
export const account = { online: false, user: null, cpus: null };   // cpus: i processori che il server sa salvare

async function call(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`api/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    throw new Error('Server dei punteggi non raggiungibile');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non è JSON: probabilmente non c'è il server */ }
  if (!res.ok || !data) {
    if (res.status === 401 && token && path !== 'login') { token = null; write(null); account.user = null; }
    const e = new Error(data?.error || 'Server dei punteggi non raggiungibile');
    e.status = res.status;
    throw e;
  }
  return data;
}

export async function connect() {
  try {
    const d = await call('GET', 'me');
    account.online = true;
    account.user = d.user;
    account.cpus = Array.isArray(d.cpus) ? d.cpus : null;                // un server di prima dei processori conosce solo la pipeline
    if (!d.user && token) { token = null; write(null); }                // sessione scaduta o server nuovo
  } catch {
    account.online = false;
    account.user = null;
    account.cpus = null;
  }
  return account;
}

async function enter(path, name, password) {
  const d = await call('POST', path, { name, password });
  token = d.token; write(token);
  account.user = d.user;
  return d.user;
}
export const register = (name, password) => enter('register', name, password);
export const login = (name, password) => enter('login', name, password);
export async function logout() {
  try { await call('POST', 'logout'); } catch { /* il token se ne va comunque */ }
  token = null; write(null);
  account.user = null;
}

// il server sa tenere le partite di questo processore? (se è ancora la versione vecchia, solo la pipeline)
export const supports = cpu => (account.cpus ? account.cpus.includes(cpu) : cpu === 'pipeline');
export const saveGame = game => call('POST', 'games', game);
export const leaderboard = (cpu, mode, period) => call('GET', `leaderboard?cpu=${encodeURIComponent(cpu)}&mode=${encodeURIComponent(mode)}&period=${period}`);
export const daily = () => call('GET', 'daily');
export const challenge = code => call('GET', `challenges/${encodeURIComponent(code)}`);
export const createChallenge = body => call('POST', 'challenges', body);
export const myChallenges = () => call('GET', 'challenges');
export const player = name => call('GET', `players/${encodeURIComponent(name)}`);
export const invite = code => call('GET', code ? `invite?sfida=${encodeURIComponent(code)}` : 'invite');
