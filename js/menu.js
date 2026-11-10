// Le schermate fuori dalla partita: benvenuto, processori, modalità, classifiche, sfide, profilo, accesso, impostazioni,
// risultati e pausa. Sono HTML sopra la scena 3D, che intanto continua a girare da sola. I titoli usano il font a pixel dell'HUD.
// Tutto quello che arriva da un server passa da esc() o num(): il server può essere uno qualsiasi, scelto dal giocatore.
import * as api from './api.js';
import * as hist from './history.js';
import { MODES, RANKED, SPRINT, fmtTime, valueOf, localBests, saveLocalBest, dailyFor } from './modes.js';
import { PROCS, ORDER, procName, lastProc } from './procs.js';
import { drawText, measure } from './font.js';
import { t, lang, LANGS, setLang, ord, fmtDay, fmtShortDay } from './i18n.js';
import { svg as qrSvg } from './qr.js';
import { canInstall, install, onInstallChange } from './pwa.js';

const C = { text: '#e8ebff', dim: '#7f89c6', gold: '#ffd23a', orange: '#ff8a2a', green: '#7dff6a', cyan: '#3fd6ff', red: '#ff3348' };
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const short = (mode, v) => (v == null ? '—' : MODES[mode]?.rank === 'time' ? fmtTime(num(v)) : String(num(v)));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const str = v => (typeof v === 'string' ? v : '');
function when(iso) {
  iso = str(iso);
  const today = new Date().toLocaleDateString('sv');                // AAAA-MM-GG nell'ora locale
  return iso.startsWith(today) ? t('when.today', { time: iso.slice(11, 16) }) : iso.length >= 10 ? fmtShortDay(iso) : '';
}
const day = iso => (str(iso).length >= 10 ? fmtDay(str(iso)) : '');
function hours(ms) {
  const m = Math.round(num(ms) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const stat = (v, label) => `<div class="stat"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
const isDaily = code => String(code).startsWith('D-');
const fine = matchMedia('(pointer: fine)').matches;                  // sul telefono non apriamo la tastiera da soli
const shortName = id => PROCS[id]?.meta.short ?? id;
const freq = (id, v) => { const f = PROCS[id]?.meta.freq; const n = num(v).toFixed(1); const x = lang === 'it' ? n.replace('.', ',') : n; return f ? `${x} ${f.unit.replace('HZ', 'Hz')}` : x; };
const where = (cpu, mode) => `${procName(cpu)} · ${MODES[mode]?.name ?? mode}`;
const cpuOf = id => (PROCS[id] ? id : 'pipeline');
const qr = url => { try { return qrSvg(url); } catch { return ''; } };   // troppo lungo per il QR: resta il link
const pageUrl = (q = '') => `${location.origin}${location.pathname}${q}`;
const local = url => /^https?:\/\/(localhost|127\.|\[::1\])/.test(url);

// titolo disegnato con il font a pixel, ingrandito a scala intera
const head = (text, color = C.text, max = 4) =>
  `<h2 class="head"><canvas data-text="${esc(text)}" data-color="${color}" data-max="${max}" aria-hidden="true"></canvas><span class="sr">${esc(text)}</span></h2>`;

export function createMenu({ sfx, onPlay, onResume, onRestart, onHome, onPreview = () => {} }) {
  const root = document.getElementById('menu');
  const account = api.account;
  const TRANSIENT = new Set(['results', 'pause', 'login']);         // non si torna indietro su queste
  let screen = null, arg = null, stack = [], seq = 0;
  let boardMode = 'classica', boardPeriod = 'all', boardCpu = lastProc(), makeCpu = lastProc(), loginTab = 'login';
  let daily = null, current = null, last = null;
  const $ = sel => root.querySelector(sel);
  const alive = id => id === seq && !root.hidden;

  function paint() {
    for (const c of root.querySelectorAll('canvas[data-text]')) {
      const text = c.dataset.text.toUpperCase(), pad = /[ÀÈÉÌÒÙ]/.test(text) ? 3 : 0;
      c.width = measure(text, 1);
      c.height = 10 + pad;
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      drawText(g, text, 0, pad, 1, c.dataset.color, '#05081a', '#05081a');
      const s = Math.max(1, Math.min(Number(c.dataset.max), Math.floor(Math.max(60, c.parentElement.clientWidth) / c.width)));
      c.style.width = `${c.width * s}px`;
      c.style.height = `${c.height * s}px`;
    }
  }
  const fill = (sel, html) => { const el = $(sel); if (el) { el.innerHTML = html; paint(); } };
  const flash = (msg, sel = '#msg', cls = 'err') => { const el = $(sel); if (el) { el.className = cls; el.textContent = msg; } };

  function show(name, a = null, { push = true } = {}) {
    if (push && screen && !TRANSIENT.has(screen) && (screen !== name || arg !== a)) stack.push([screen, arg]);
    screen = name; arg = a;
    render();
  }
  // va a una schermata togliendo dalla pila un doppione (succede tornando dall'accesso)
  function go(name, a = null) {
    const top = stack[stack.length - 1];
    if (top && top[0] === name && top[1] === a) stack.pop();
    show(name, a, { push: false });
  }
  function back() {
    const p = stack.pop();
    show(p ? p[0] : 'home', p ? p[1] : null, { push: false });
  }
  function render() {
    const id = ++seq;
    root.hidden = false;
    root.innerHTML = `<div class="panel" role="dialog" aria-modal="true">${SCREENS[screen](arg)}</div>`;
    root.scrollTop = 0;
    paint();
    const f = $('[data-focus]');
    if (f && !f.disabled && (fine || f.tagName === 'BUTTON')) f.focus({ preventScroll: true });
    LOAD[screen]?.(arg, id).catch(e => { if (alive(id)) fill('#slot', `<p class="err">${esc(e.message)}</p>`); });
  }
  function hide() {
    root.hidden = true;
    root.innerHTML = '';
    screen = null; stack = []; seq++;
    document.activeElement?.blur?.();
  }

  const BACK = `<button class="btn ghost" data-act="back">${t('back')}</button>`;
  const table = (mode, rows, empty = t('empty.board')) => (!Array.isArray(rows) || !rows.length ? `<p class="note">${esc(empty)}</p>` :
    `<table class="board"><tbody>${rows.map((r, i) => `<tr${r.name === account.user?.name ? ' class="me"' : ''}>
      <td class="pos">${i + 1}</td>
      <td><button class="link" data-go="profile" data-arg="${esc(r.name)}">${esc(r.name)}</button></td>
      <td class="val">${esc(short(mode, r.best))}</td></tr>`).join('')}</tbody></table>`);
  // QR code (disegnato qui, senza chiedere niente al server) con sotto il link da copiare
  const share = (url, label, cls = '') => {
    const code = qr(url);
    return `${code ? `<div class="qr${cls}" role="img" aria-label="${esc(t('qr.aria', { url }))}">${code}</div>` : ''}
    <div class="row"><input readonly value="${esc(url)}" aria-label="${esc(label)}"><button class="btn sm" data-act="copy">${t('copy')}</button></div>`;
  };
  const guestNote = key => (account.user || !account.online ? '' :
    `<p class="note">${esc(t(key))} <button class="link" data-act="loginBack">${t('login.link')}</button></p>`);
  const oldServer = cpu => (account.online && !api.supports(cpu) ? `<p class="note">${esc(t('oldServer', { proc: procName(cpu) }))}</p>` : '');
  // una fila di linguette per scegliere il processore
  const cpuTabs = (sel, act) => `<div class="tabs" role="tablist">${ORDER.map(id =>
    `<button class="tab" role="tab" aria-selected="${id === sel}" data-act="${act}" data-cpu="${id}">${esc(shortName(id))}</button>`).join('')}</div>`;
  const tabs = (items, sel, act, key, cls = '') => `<div class="tabs${cls}">${items.map(([v, l]) =>
    `<button class="tab" aria-selected="${v === sel}" data-act="${act}" data-${key}="${v}">${esc(l)}</button>`).join('')}</div>`;

  // ---------- schermate ----------
  const SCREENS = {
    home() {
      const u = account.user, on = account.online, off = on ? '' : ' disabled';
      const who = !on ? `<p class="note center">${t('home.offline')}</p>`
        : u ? `<p class="who">${esc(t('home.hello', { name: '' }))}<button class="link" data-go="profile" data-arg="${esc(u.name)}">${esc(u.name)}</button> · <button class="link" data-act="logout">${t('home.logout')}</button></p>`
          : `<p class="who">${t('home.guest')} · <button class="link" data-go="login">${t('home.login')}</button></p>`;
      return `${head('OVERCLOCK', C.orange, 6)}
        <p class="tag">${t('home.tag')}</p>${who}
        <button class="btn primary" data-go="procs" data-focus>${t('home.play')}</button>
        <button class="btn" data-go="daily">${t('home.daily')}</button>
        <button class="btn" data-act="friends"${off}>${t('home.friends')}</button>
        <button class="btn" data-go="boards"${off}>${t('home.boards')}</button>
        <button class="btn" data-go="invite">${t('home.invite')}</button>
        <div class="row"><button class="btn" data-go="howto">${t('home.howto')}</button><button class="btn" data-go="settings">${t('home.settings')}</button></div>
        <p class="foot">${t('home.keys')}</p>`;
    },

    // il chip dietro al menu cambia mentre si passano i processori
    procs() {
      const cur = lastProc();
      return head(t('procs.title'), C.text, 4) + ORDER.map(id => {
        const m = PROCS[id].meta;
        return `<button class="btn card proc" data-act="pickProc" data-cpu="${id}"${id === cur ? ' data-focus' : ''}>
          <span class="title">${esc(m.name)}</span><small>${esc(m.tag)}</small></button>`;
      }).join('') + BACK;
    },

    modes(cpu) {
      const lb = localBests(cpu), m = PROCS[cpu].meta;
      return `${head(m.name, C.cyan, 4)}<p class="note center">${esc(m.desc)}</p>` + [...RANKED, 'allenamento'].map(id => {
        const md = MODES[id], b = lb[id];
        return `<button class="btn card" data-act="play" data-mode="${id}"${id === 'classica' ? ' data-focus' : ''}>
          <span class="title">${esc(md.name)}</span><small>${esc(md.desc)}</small>
          <small class="rec" data-rec="${id}">${!md.practice && b != null ? esc(t('rec.device', { v: short(id, b) })) : ''}</small></button>`;
      }).join('') + oldServer(cpu) + BACK;
    },

    daily: () => `${head(t('daily.title'), C.gold, 3)}
      <p>${t('daily.intro')}</p>
      <div id="slot"><p class="note">${t('loading')}</p></div>
      <button class="btn primary" data-act="playDaily" data-focus disabled>${t('daily.play')}</button>
      ${guestNote('guest.board')}${BACK}`,

    challenges: () => `${head(t('ch.title'), C.gold, 3)}
      <p>${t('ch.intro')}</p>
      <h3>${t('ch.create')}</h3>
      ${cpuTabs(makeCpu, 'makeCpu')}
      <div class="grid">${RANKED.map(m => `<button class="btn sm" data-act="create" data-mode="${m}">${esc(MODES[m].name)}</button>`).join('')}</div>
      ${oldServer(makeCpu)}
      <form data-form="join" novalidate>
        <h3><label for="code">${t('ch.haveCode')}</label></h3>
        <div class="row"><input id="code" name="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE">
        <button class="btn sm">${t('ch.join')}</button></div>
      </form>
      <p class="err" id="msg" role="alert"></p>
      <h3>${t('ch.yours')}</h3><div id="slot"><p class="note">${t('loading')}</p></div>${BACK}`,

    challenge: code => `${head(isDaily(code) ? t('daily.title') : t('ch.code', { code }), C.gold, 3)}
      <div id="slot"><p class="note">${t('loading')}</p></div>
      <button class="btn primary" data-act="playChallenge" data-focus disabled>${t('daily.play')}</button>
      <p class="err" id="msg" role="alert"></p>
      ${guestNote('guest.challenge')}${BACK}`,

    boards() {
      const modeTabs = [...RANKED.map(m => [m, MODES[m].name]), ['oggi', t('boards.today')]];
      const per = boardMode === 'oggi' ? '' : tabs([['all', t('boards.all')], ['week', t('boards.week')]], boardPeriod, 'boardPeriod', 'period', ' small');
      return `${head(t('boards.title'))}${boardMode === 'oggi' ? '' : cpuTabs(boardCpu, 'boardCpu')}${tabs(modeTabs, boardMode, 'boardTab', 'mode')}${per}<div id="slot"><p class="note">${t('loading')}</p></div>${BACK}`;
    },

    profile: name => `${head(String(name), C.cyan, 3)}<div id="slot"><p class="note">${t('loading')}</p></div>
      ${account.user?.name === name ? `<button class="btn" data-act="logout">${t('prof.logout')}</button>` : ''}${BACK}`,

    login(a) {
      const info = account.info, mode = info?.registration ?? 'open';
      if (mode === 'closed') loginTab = 'login';
      const reg = loginTab === 'register', min = num(info?.password_min) || 4;
      const plain = api.serverUrl().startsWith('http:') && !local(api.serverUrl());
      return `${head(reg ? t('login.titleNew') : t('login.title'), C.text, 3)}
        ${mode === 'closed' ? `<p class="note">${t('login.closed')}</p>` : `<div class="tabs" role="tablist">
          <button class="tab" role="tab" aria-selected="${!reg}" data-act="loginTab" data-tab="login">${t('login.tab')}</button>
          <button class="tab" role="tab" aria-selected="${reg}" data-act="loginTab" data-tab="register">${t('login.tabNew')}</button>
        </div>`}
        ${a?.reason ? `<p class="note">${esc(a.reason)}</p>` : ''}
        <form data-form="auth" novalidate>
          <label class="field"><span>${t('login.name')}${reg ? t('login.nameHint') : ''}</span>
            <input name="name" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="12" data-focus></label>
          <label class="field"><span>${t('login.password')}${reg ? esc(t('login.pwHint', { n: min })) : ''}</span>
            <input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="128"></label>
          ${reg && mode === 'invite' ? `<label class="field"><span>${t('login.invite')}${t('login.inviteHint')}</span>
            <input name="invite" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64"></label>` : ''}
          ${reg && plain ? `<p class="note">${t('login.plain')}</p>` : ''}
          <p class="err" id="msg" role="alert"></p>
          <button class="btn primary">${reg ? t('login.create') : t('login.enter')}</button>
        </form>${BACK}`;
    },

    invite: () => `${head(t('inv.title'), C.cyan, 3)}
      <p>${account.online && !api.custom() ? t('inv.lan') : t('inv.web')}</p>
      <div id="slot"><p class="note">${t('inv.preparing')}</p></div>${BACK}`,

    howto: () => `${head(t('howto.title'))}<div class="prose">
      ${t('howto.body')}
      <h3>${t('howto.procs')}</h3>
      <ul>${ORDER.map(id => `<li><b>${esc(PROCS[id].meta.name)}</b>: ${esc(PROCS[id].meta.howto || PROCS[id].meta.desc)}</li>`).join('')}</ul>
      <h3>${t('howto.modes')}</h3>
      <ul>${[...RANKED, 'allenamento'].map(id => `<li><b>${esc(MODES[id].name)}</b>: ${esc(MODES[id].desc)}</li>`).join('')}
        <li>${t('howto.daily')}</li>
        <li>${t('howto.friends')}</li></ul>
      <h3>${t('howto.keys')}</h3><p>${t('howto.keysText')}</p>
      </div>${BACK}`,

    settings() {
      const custom = api.custom();
      return `${head(t('set.title'))}
        <h3>${t('set.lang')}</h3>${tabs(Object.entries(LANGS), lang, 'lang', 'lang')}
        <h3>${t('set.sound')}</h3>${tabs([['on', t('set.on')], ['off', t('set.off')]], sfx.muted ? 'off' : 'on', 'sound', 'v')}
        <h3>${t('set.server')}</h3>
        <p id="srv" class="note">${esc(account.online ? t('set.online', { url: api.serverUrl() }) : t('set.offline', { url: custom || t('set.serverThis') }))}</p>
        <form data-form="server" novalidate>
          <label class="field"><span>${t('set.url')}</span>
          <div class="row"><input name="url" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" placeholder="https://…" value="${esc(custom)}">
          <button class="btn sm">${t('set.connect')}</button></div></label>
        </form>
        ${custom ? `<button class="btn" data-act="serverReset">${t('set.reset')}</button>` : ''}
        <p class="err" id="msg" role="alert"></p>
        <p class="note">${t('set.serverNote')}</p>
        <h3>${t('set.results')}</h3>
        <p id="hcount">${esc(t('set.count', { n: hist.count() }))}</p>
        <div class="row"><button class="btn" data-act="export"${hist.count() ? '' : ' disabled'}>${t('set.export')}</button>
          <button class="btn" data-act="send"${hist.count() && account.user ? '' : ' disabled'}>${t('set.send')}</button></div>
        <label class="btn${account.user ? '' : ' off'}" for="upload">${t('set.upload')}</label>
        <input id="upload" type="file" accept=".json,application/json" hidden${account.user ? '' : ' disabled'}>
        ${account.user ? '' : `<p class="note">${t('set.needLogin')}</p>`}
        <p class="note">${t('set.exportNote')}</p>
        <p class="err" id="hmsg" role="status" aria-live="polite"></p>
        <button class="btn ghost" data-act="clearHistory"${hist.count() ? '' : ' disabled'}>${t('set.clear')}</button>
        <button class="btn" data-act="install"${canInstall() ? '' : ' hidden'}>${t('set.install')}</button>
        <h3>${t('set.about')}</h3><p class="note">${t('set.aboutText')}</p>
        ${BACK}`;
    },

    results() {
      const s = last.s, m = MODES[s.mode];
      const [title, color] = s.end === 'crash' ? [t(s.why === 'battery' ? 'res.brownout' : 'res.crash'), C.red] : s.end === 'done' ? [t('res.done'), C.green] : [t('res.time'), C.orange];
      const place = s.challenge ? `${isDaily(s.challenge) ? t('res.daily') : t('res.challenge', { code: s.challenge })} · ${procName(s.cpu)}` : where(s.cpu, s.mode);
      const timed = m.rank === 'time';
      const big = timed ? (s.finished ? fmtTime(s.time_ms) : `${s.ok}/${SPRINT}`) : String(s.score);
      const unit = timed ? (s.finished ? t('res.forN', { n: SPRINT }) : t('res.unfinished')) : t('res.points');
      const why = { watchdog: 'why.watchdog', battery: 'why.battery', overrun: 'why.overrun' }[s.why] || 'why.glitch';
      const secs = (s.time_ms / 1000).toFixed(1);
      return `${head(title, color, 4)}<p class="center sub">${esc(place)}</p>
        <div class="big">${esc(big)}<small>${esc(unit)}</small></div>
        ${s.end === 'crash' ? `<p class="note center">${t(why)}</p>` : ''}
        <div class="stats">${stat(s.ok, t('st.ok'))}${stat(`${s.perfect} / ${s.good} / ${s.slow}`, t('st.pgs'))}
          ${stat(s.glitches, t('st.glitch'))}${stat(s.combo, t('st.combo'))}${stat(freq(s.cpu, s.peak), t('st.peak'))}${stat(`${lang === 'it' ? secs.replace('.', ',') : secs} s`, t('st.time'))}
          ${(s.more || []).map(([v, l]) => stat(v, l)).join('')}</div>
        ${(s.notes || []).map(n => `<p class="note center">${esc(n)}</p>`).join('')}
        <p id="save" class="save" aria-live="polite">${last.status}</p>
        <div class="row"><button class="btn primary" data-act="again" data-focus disabled>${t('res.again')}</button><button class="btn" data-act="home" disabled>${t('res.menu')}</button></div>
        <button class="btn" data-act="dare"${last.saved && !s.challenge ? '' : ' hidden'}>${t('res.dare')}</button>`;
    },

    pause: () => `${head(t('pause.title'))}
      <button class="btn primary" data-act="resume" data-focus>${t('pause.resume')}</button>
      <button class="btn" data-act="restart">${t('pause.restart')}</button>
      <button class="btn" data-act="quit">${t('pause.quit')}</button>
      <p class="note center">${t('pause.note')}</p>`,
  };

  // ---------- dati dal server (o da questo dispositivo, se il server non c'è) ----------
  const LOAD = {
    async modes(cpu, id) {
      onPreview(cpu);
      if (!account.user || !api.supports(cpu)) return;
      const p = await api.player(account.user.name);
      if (!alive(id)) return;
      const modes = p.cpus ? p.cpus[cpu]?.modes : cpu === 'pipeline' ? p.modes : null;
      for (const m of RANKED) {
        const el = $(`[data-rec="${m}"]`), v = modes?.[m];
        if (el) el.textContent = v?.best != null ? t('rec.mine', { v: short(m, v.best) }) + (v.rank ? t('rec.rank', { pos: ord(num(v.rank)), total: num(v.total) }) : '') : t('rec.none');
      }
    },
    async daily(_, id) {
      let d = { ...dailyFor(), standings: null };
      if (account.online) {
        const s = await api.daily();
        d = { code: str(s.code), cpu: cpuOf(s.cpu), mode: MODES[s.mode] ? s.mode : 'classica', seed: num(s.seed) | 0, date: str(s.date), standings: s.standings };
      }
      if (!alive(id)) return;
      daily = d;
      onPreview(d.cpu);
      const mine = hist.games().filter(g => g.challenge === d.code).reduce((b, g) => Math.max(b, g.score), -1);
      fill('#slot', `<p class="center"><b>${esc(t('daily.today', { proc: procName(d.cpu) }))}</b></p><p class="note center">${esc(PROCS[d.cpu].meta.desc)}</p>
        ${mine >= 0 ? `<p class="center">${esc(t('daily.mine', { v: mine }))}</p>` : ''}
        ${d.standings ? `<h3>${esc(t('daily.board', { date: day(d.date) }))}</h3>${table(d.mode, d.standings, t('daily.empty'))}` : `<p class="note">${t('daily.offline')}</p>`}`);
      const b = $('[data-act="playDaily"]');
      b.disabled = false;
      b.focus({ preventScroll: true });
    },
    async challenges(_, id) {
      const d = await api.myChallenges();
      if (!alive(id)) return;
      const list = Array.isArray(d.challenges) ? d.challenges : [];
      fill('#slot', !list.length ? `<p class="note">${t('ch.none')}</p>`
        : `<ul class="list">${list.map(c => `<li><button class="item" data-go="challenge" data-arg="${esc(c.code)}">
          <b>${esc(c.code)}</b> <span>${esc(where(cpuOf(c.cpu), c.mode))} · ${esc(t('ch.players', { n: num(c.players) }))}</span>
          <small>${esc(c.leader ? t('ch.leader', { name: c.leader.name, v: short(c.mode, c.leader.best) }) : t('ch.nobody'))}${c.rank ? esc(t('ch.you', { pos: ord(num(c.rank)) })) : ''}</small>
          </button></li>`).join('')}</ul>`);
    },
    async invite(_, id) {
      const url = account.online ? await api.invite().then(d => str(d.url)).catch(() => '') : '';
      if (alive(id)) fill('#slot', `<div class="share">${share(/^https?:\/\//.test(url) ? url : pageUrl(), t('inv.link'))}</div>`);
    },
    async challenge(code, id) {
      const d = await api.challenge(code);
      const fallback = pageUrl(`?sfida=${encodeURIComponent(str(d.code))}`);
      const link = d.daily ? '' : await api.invite(d.code).then(r => (/^https?:\/\//.test(str(r.url)) ? r.url : fallback)).catch(() => fallback);
      if (!alive(id)) return;
      current = { code: str(d.code), cpu: cpuOf(d.cpu), mode: MODES[d.mode] ? d.mode : 'classica', seed: num(d.seed) | 0 };
      onPreview(current.cpu);
      fill('#slot', `<p>${esc(where(current.cpu, current.mode))}${d.creator ? esc(t('ch.by', { name: d.creator, date: day(d.created) })) : ''}</p>
        <p class="note">${esc(MODES[current.mode].desc)}</p>
        ${d.daily ? '' : `<div class="share"><span>${t('ch.send', { code: esc(current.code) })}</span>
          ${share(link, t('ch.link'), ' sm')}</div>`}
        <h3>${t('ch.board')}</h3>${table(current.mode, d.standings, t('ch.empty'))}`);
      const b = $('[data-act="playChallenge"]');
      b.disabled = false;
      b.focus({ preventScroll: true });
    },
    async boards(_, id) {
      if (boardMode === 'oggi') {
        const d = await api.daily();
        if (alive(id)) fill('#slot', `<p class="note">${esc(t('boards.daily', { date: day(d.date), proc: procName(cpuOf(d.cpu)) }))}</p>${table('classica', d.standings, t('boards.todayEmpty'))}`);
        return;
      }
      if (!api.supports(boardCpu)) { fill('#slot', oldServer(boardCpu)); return; }
      const d = await api.leaderboard(boardCpu, boardMode, boardPeriod);
      if (!alive(id)) return;
      const what = t(MODES[boardMode].rank === 'time' ? 'boards.time' : 'boards.score', { proc: procName(boardCpu) });
      fill('#slot', `<p class="note">${esc(what)}</p>${table(boardMode, d.rows)}`);
    },
    async profile(name, id) {
      const p = await api.player(name);
      if (!alive(id)) return;
      const tot = p.totals || {};
      const cpus = p.cpus || { pipeline: { games: tot.games, peak: tot.peak, modes: p.modes } };   // server di prima dei processori
      const value = g => (g.mode === 'sprint' ? (g.finished ? fmtTime(num(g.time_ms)) : t('prof.unfinished')) : String(num(g.score)));
      const tag = g => (!g.challenge ? '' : isDaily(g.challenge) ? t('prof.daily') : t('prof.challenge', { code: g.challenge }));
      const played = ORDER.filter(c => cpus[c]?.games);
      const recordCell = (c, m) => { const v = cpus[c].modes?.[m] || {}; return `<td class="val">${esc(short(m, v.best))}${v.rank ? `<small>${esc(ord(num(v.rank)))}/${num(v.total)}</small>` : ''}</td>`; };
      const recent = Array.isArray(p.recent) ? p.recent : [];
      fill('#slot', `<p class="note center">${esc(t('prof.since', { date: day(p.since) }))}</p>
        <div class="stats">${stat(num(tot.games), t('prof.games'))}${stat(hours(tot.time_ms), t('prof.time'))}
          ${stat(pct(num(tot.perfect), num(tot.perfect) + num(tot.good) + num(tot.slow)), t('prof.perfect'))}${stat(num(tot.combo), t('prof.combo'))}
          ${stat(played.length, t('prof.procs', { n: played.length }))}${stat(num(tot.ok), t('prof.ok'))}</div>
        <h3>${t('prof.records')}</h3>${!played.length ? `<p class="note">${t('prof.noGames')}</p>`
          : `<table class="board records"><thead><tr><th></th>${RANKED.map(m => `<th>${esc(MODES[m].name.replace(' 50', ''))}</th>`).join('')}</tr></thead>
          <tbody>${played.map(c => `<tr><td>${esc(shortName(c))}<small>${esc(freq(c, cpus[c].peak))}</small></td>${RANKED.map(m => recordCell(c, m)).join('')}</tr>`).join('')}</tbody></table>`}
        <h3>${t('prof.recent')}</h3>${!recent.length ? `<p class="note">${t('prof.none')}</p>`
          : `<table class="board"><tbody>${recent.map(g => `<tr><td>${esc(shortName(cpuOf(g.cpu)))} · ${esc(MODES[g.mode]?.name ?? g.mode)}${esc(tag(g))}</td>
            <td class="val">${esc(value(g))}</td><td class="val dim">${esc(when(g.created))}</td></tr>`).join('')}</tbody></table>`}`);
    },
    async results(_, id) {
      setTimeout(() => {                                              // un attimo di pausa: l'ultimo tocco non deve far ripartire
        if (!alive(id)) return;
        root.querySelectorAll('[data-act="again"], [data-act="home"]').forEach(b => { b.disabled = false; });
        $('[data-act="again"]')?.focus({ preventScroll: true });
      }, last.armed ? 0 : 700);
      last.armed = true;
      if (last.state === 'idle') await save(id);
    },
  };

  async function save(id) {
    const s = last.s, m = MODES[s.mode];
    const status = (html, cls = 'note') => {
      last.status = `<span class="${cls}">${html}</span>`;
      if (alive(id)) { const el = $('#save'); if (el) el.innerHTML = last.status; }
    };
    if (m.practice) { last.state = 'done'; return status(t('save.practice')); }
    if (s.custom) { last.state = 'done'; return status(t('save.custom')); }
    if (!last.kept) { hist.add(s); last.kept = true; }                // ogni partita valida resta nello storico, da esportare
    const best = last.best ??= saveLocalBest(s.cpu, s.mode, valueOf(s));
    const local = best ? `<b class="ok">${t('save.localBest')}</b> ` : '';
    last.state = 'done';
    if (!account.online) return status(`${local}${t('save.offline')}`);
    if (!api.supports(s.cpu)) return status(`${local}${t('save.oldServer')}`);
    if (!account.user) {
      last.state = 'guest';
      return status(`${local}<button class="link" data-act="loginSave">${t('save.guestLink')}</button> ${t('save.guest')}`);
    }
    status(t('save.saving'));
    try {
      const r = await api.saveGame(hist.record(s));
      last.saved = r;
      const parts = [];
      if (r.best) parts.push(`<b class="ok">${t('save.best')}</b>`);
      else if (r.record != null) parts.push(esc(t('save.record', { v: short(s.mode, r.record) })));
      if (m.rank === 'time' && r.value == null) parts.push(t('save.sprint'));
      if (r.challenge?.rank) parts.push(esc(t(r.challenge.daily ? 'save.chDaily' : 'save.ch', { pos: ord(num(r.challenge.rank)), total: num(r.challenge.total) })));
      else if (!r.challenge && r.rank) parts.push(esc(t('save.rank', { where: where(s.cpu, s.mode), pos: ord(num(r.rank)), total: num(r.total) })));
      status(parts.join(' ') || t('save.done'));
      if (alive(id) && !s.challenge) $('[data-act="dare"]')?.removeAttribute('hidden');
    } catch (e) {
      last.state = 'error';
      status(esc(t('save.error', { msg: e.message })), 'err');
    }
  }

  async function auth(form) {
    const val = n => form.elements.namedItem(n)?.value ?? '';
    const name = val('name').trim(), password = val('password'), invite = val('invite').trim();
    const btn = form.querySelector('button');
    flash('');
    if (!name || !password) return flash(t('login.missing'));
    btn.disabled = true;
    try {
      await (loginTab === 'register' ? api.register(name, password, invite) : api.login(name, password));
      const next = arg?.next;
      if (next === 'save' && last) { last.state = 'idle'; go('results'); }
      else if (Array.isArray(next)) go(next[0], next[1]);
      else go('home');
    } catch (e) {
      btn.disabled = false;
      flash(e.message);
    }
  }

  // ---------- risultati: esporta, manda al server, carica un file ----------
  const sent = r => t('set.sent', { imported: num(r.imported), dup: num(r.duplicates), rej: Array.isArray(r.rejected) ? r.rejected.length : 0 });
  async function upload(data) {
    if (!hist.looksValid(data)) return flash(t('set.badFile'), '#hmsg');
    flash(t('loading'), '#hmsg', 'note');
    try { flash(sent(await api.importResults(data)), '#hmsg', 'ok'); } catch (e) { flash(e.message, '#hmsg'); }
  }
  async function connectServer(url) {
    const prev = api.custom();
    flash(t('loading'), '#msg', 'note');
    await api.setServer(url);
    if (!account.online && url) {                                    // non risponde: si torna a quello di prima
      await api.setServer(prev);
      render();
      return flash(t('set.cantReach'));
    }
    stack = stack.filter(([s]) => s === 'home');
    render();
  }

  // ---------- azioni ----------
  const ACT = {
    back,
    home: () => onHome(),
    pickProc: el => show('modes', el.dataset.cpu),
    play: el => onPlay({ cpu: arg, mode: el.dataset.mode }),
    playDaily: () => daily && onPlay({ cpu: daily.cpu, mode: daily.mode, seed: daily.seed, challenge: daily.code }),
    playChallenge: () => current && onPlay({ cpu: current.cpu, mode: current.mode, seed: current.seed, challenge: current.code }),
    friends: () => (account.user ? show('challenges') : show('login', { next: ['challenges', null], reason: t('ch.needAccount') })),
    loginBack: () => show('login', { next: [screen, arg] }),
    loginSave: () => show('login', { next: 'save', reason: t('login.saveReason') }),
    loginTab: el => { loginTab = el.dataset.tab; render(); },
    boardTab: el => { boardMode = el.dataset.mode; render(); },
    boardPeriod: el => { boardPeriod = el.dataset.period; render(); },
    boardCpu: el => { boardCpu = el.dataset.cpu; onPreview(boardCpu); render(); },
    makeCpu: el => { makeCpu = el.dataset.cpu; onPreview(makeCpu); render(); },
    async logout() { await api.logout(); stack = []; show('home', null, { push: false }); },
    async create(el) {
      if (!api.supports(makeCpu)) return flash(t('ch.oldServer'));
      el.disabled = true;
      try { const r = await api.createChallenge({ cpu: makeCpu, mode: el.dataset.mode }); show('challenge', str(r.code)); }
      catch (e) { el.disabled = false; flash(e.message); }
    },
    join(form) {
      const code = form.elements.namedItem('code').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) return flash(t('ch.badCode'));
      show('challenge', code);
    },
    server(form) {
      const text = form.elements.namedItem('url').value.trim();
      if (!text) return connectServer('');
      const url = api.normalize(text);
      if (!url) return flash(t('set.badUrl'));
      if (api.blocked(url)) return flash(t('set.needHttps', { url }));
      return connectServer(url);
    },
    serverReset: () => connectServer(''),
    lang: el => setLang(el.dataset.lang),
    sound: el => { sfx.set(el.dataset.v === 'off'); render(); },
    export: () => hist.download().catch(e => flash(e.message, '#hmsg')),
    send: () => upload(hist.exportData()),
    clearHistory(el) {
      if (!el.dataset.sure) { el.dataset.sure = '1'; el.textContent = t('set.clearSure', { n: hist.count() }); return; }
      hist.clear();
      render();
      flash(t('set.cleared'), '#hmsg', 'ok');
    },
    async install() { await install(); if (screen === 'settings') render(); },
    copy(el) {
      const input = el.parentElement.querySelector('input');
      const done = () => { el.textContent = t('copied'); setTimeout(() => { el.textContent = t('copy'); }, 1500); };
      const legacy = () => { input.select(); try { if (document.execCommand('copy')) done(); } catch { /* resta selezionato: si copia a mano */ } };
      if (navigator.clipboard && isSecureContext) navigator.clipboard.writeText(input.value).then(done, legacy);
      else legacy();                                                  // in http sulla rete locale la clipboard moderna non c'è
    },
    again() {
      const s = last.s;
      onPlay(s.challenge ? { cpu: s.cpu, mode: s.mode, seed: s.seed, challenge: s.challenge } : { cpu: s.cpu, mode: s.mode });
    },
    async dare(el) {
      el.disabled = true;
      try {
        const r = await api.createChallenge({ cpu: last.s.cpu, mode: last.s.mode, seed: last.s.seed, game: last.saved.id });
        show('challenge', str(r.code));
      } catch (e) { el.disabled = false; flash(e.message); }
    },
    resume: () => onResume(),
    restart: () => onRestart(),
    quit: () => onHome(),
  };

  root.addEventListener('click', e => {
    const el = e.target.closest('[data-go], [data-act]');
    if (!el || el.disabled) return;
    sfx.ensure(); sfx.ui();
    if (el.dataset.go) show(el.dataset.go, el.dataset.arg ?? null);
    else ACT[el.dataset.act]?.(el);
  });
  root.addEventListener('submit', e => {
    e.preventDefault();
    sfx.ensure();
    const f = e.target;
    if (f.dataset.form === 'auth') auth(f);
    else ACT[f.dataset.form]?.(f);
  });
  // un file di risultati scelto dal giocatore va al server
  root.addEventListener('change', async e => {
    if (e.target.id !== 'upload' || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    e.target.value = '';
    if (file.size > 2 * 1024 * 1024) return flash(t('set.badFile'), '#hmsg');
    let data = null;
    try { data = JSON.parse(await file.text()); } catch { /* non è JSON */ }
    upload(data);
  });
  // passando sui processori il chip dietro al menu cambia
  const preview = e => { const el = e.target.closest?.('.proc[data-cpu]'); if (el) onPreview(el.dataset.cpu); };
  root.addEventListener('focusin', preview);
  root.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') preview(e); });
  addEventListener('resize', () => { if (!root.hidden) paint(); });
  onInstallChange(() => { if (screen === 'settings') render(); });

  return {
    show,
    hide,
    home() { stack = []; show('home', null, { push: false }); },
    results(s) { last = { s, state: 'idle', status: '', saved: null, armed: false, kept: false, best: null }; stack = []; show('results', null, { push: false }); },
    escape() {
      if (screen === 'pause') onResume();
      else if (screen === 'results') onHome();
      else if (screen && screen !== 'home') back();
    },
    refresh() { if (screen) render(); },
    get visible() { return !root.hidden; },
    get screen() { return screen; },
  };
}
