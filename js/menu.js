// Le schermate fuori dalla partita: benvenuto, processori, modalità, classifiche, sfide, profilo, accesso, risultati e pausa.
// Sono HTML sopra la scena 3D, che intanto continua a girare da sola. I titoli usano lo stesso font a pixel dell'HUD.
import * as api from './api.js';
import { MODES, RANKED, SPRINT, fmtTime, valueOf, localBests, saveLocalBest } from './modes.js';
import { PROCS, ORDER, procName, lastProc } from './procs.js';
import { drawText, measure } from './font.js';

const C = { text: '#e8ebff', dim: '#7f89c6', gold: '#ffd23a', orange: '#ff8a2a', green: '#7dff6a', cyan: '#3fd6ff', red: '#ff3348' };
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const short = (mode, v) => (v == null ? '—' : MODES[mode].rank === 'time' ? fmtTime(v) : String(v));
const num1 = v => v.toFixed(1).replace('.', ',');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const day = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
function when(iso) {
  const today = new Date().toLocaleDateString('sv');                // AAAA-MM-GG nell'ora locale
  return iso.startsWith(today) ? `oggi ${iso.slice(11, 16)}` : day(iso).slice(0, 5);
}
function hours(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const stat = (v, label) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`;
const isDaily = code => String(code).startsWith('D-');
const fine = matchMedia('(pointer: fine)').matches;                  // sul telefono non apriamo la tastiera da soli
const shortName = id => PROCS[id]?.meta.short ?? id;
const freq = (id, v) => { const f = PROCS[id]?.meta.freq; return f ? `${num1(v)} ${f.unit.replace('HZ', 'Hz')}` : num1(v); };
const where = (cpu, mode) => `${procName(cpu)} · ${MODES[mode]?.name ?? mode}`;

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
  const flash = msg => { const el = $('#msg'); if (el) el.textContent = msg; };

  function show(name, a = null, { push = true } = {}) {
    if (push && screen && !TRANSIENT.has(screen) && (screen !== name || arg !== a)) stack.push([screen, arg]);
    screen = name; arg = a;
    render();
  }
  // va a una schermata togliendo dalla pila un doppione (succede tornando dall'accesso)
  function go(name, a = null) {
    const t = stack[stack.length - 1];
    if (t && t[0] === name && t[1] === a) stack.pop();
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

  const BACK = '<button class="btn ghost" data-act="back">Indietro</button>';
  const table = (mode, rows, empty = 'Ancora nessuno: puoi essere il primo.') => (!rows?.length ? `<p class="note">${empty}</p>` :
    `<table class="board"><tbody>${rows.map((r, i) => `<tr${r.name === account.user?.name ? ' class="me"' : ''}>
      <td class="pos">${i + 1}</td>
      <td><button class="link" data-go="profile" data-arg="${esc(r.name)}">${esc(r.name)}</button></td>
      <td class="val">${short(mode, r.best)}</td></tr>`).join('')}</tbody></table>`);
  // QR code (l'SVG lo fa il server: contiene solo numeri) con sotto il link da copiare
  const share = (d, label, cls = '') => `${d.svg ? `<div class="qr${cls}" role="img" aria-label="QR code di ${esc(d.url)}">${d.svg}</div>` : ''}
    <div class="row"><input readonly value="${esc(d.url)}" aria-label="${label}"><button class="btn sm" data-act="copy">Copia</button></div>`;
  const guestNote = what => (account.user ? '' :
    `<p class="note">Giochi come ospite: la partita non entra ${what}. <button class="link" data-act="loginBack">Accedi</button></p>`);
  const oldServer = cpu => (account.online && !api.supports(cpu)
    ? `<p class="note">Il server dei punteggi non conosce ancora ${esc(procName(cpu))}: va riavviato. Intanto si gioca senza salvare.</p>` : '');
  // una fila di linguette per scegliere il processore
  const cpuTabs = (sel, act) => `<div class="tabs" role="tablist">${ORDER.map(id =>
    `<button class="tab" role="tab" aria-selected="${id === sel}" data-act="${act}" data-cpu="${id}">${esc(shortName(id))}</button>`).join('')}</div>`;

  // ---------- schermate ----------
  const SCREENS = {
    home() {
      const u = account.user, on = account.online, off = on ? '' : ' disabled';
      const who = !on ? '<p class="note center">Server dei punteggi non raggiungibile: si gioca come ospite, senza classifiche né sfide.</p>'
        : u ? `<p class="who">Ciao <button class="link" data-go="profile" data-arg="${esc(u.name)}">${esc(u.name)}</button> · <button class="link" data-act="logout">esci</button></p>`
          : '<p class="who">Giochi come ospite · <button class="link" data-go="login">accedi o crea un account</button></p>';
      return `${head('OVERCLOCK', C.orange, 6)}
        <p class="tag">Sei tu il clock del processore.</p>${who}
        <button class="btn primary" data-go="procs" data-focus>Gioca</button>
        <button class="btn" data-go="daily"${off}>Sfida del giorno</button>
        <button class="btn" data-act="friends"${off}>Sfide tra amici</button>
        <button class="btn" data-go="boards"${off}>Classifiche</button>
        <button class="btn" data-go="invite"${off}>Invita amici</button>
        <button class="btn" data-go="howto">Come si gioca</button>
        <p class="foot">Spazio o clic: colpo di clock · P pausa · M audio · F schermo intero</p>`;
    },

    // il chip dietro al menu cambia mentre si passano i processori
    procs() {
      const cur = lastProc();
      return head('PROCESSORE', C.text, 4) + ORDER.map(id => {
        const m = PROCS[id].meta;
        return `<button class="btn card proc" data-act="pickProc" data-cpu="${id}"${id === cur ? ' data-focus' : ''}>
          <span class="title">${esc(m.name)}</span><small>${esc(m.tag)}</small></button>`;
      }).join('') + BACK;
    },

    modes(cpu) {
      const lb = localBests(cpu), m = PROCS[cpu].meta;
      return `${head(m.name.toUpperCase(), C.cyan, 4)}<p class="note center">${esc(m.desc)}</p>` + [...RANKED, 'allenamento'].map(id => {
        const md = MODES[id], b = lb[id];
        return `<button class="btn card" data-act="play" data-mode="${id}"${id === 'classica' ? ' data-focus' : ''}>
          <span class="title">${md.name}</span><small>${md.desc}</small>
          <small class="rec" data-rec="${id}">${!md.practice && b != null ? `Record su questo browser: ${short(id, b)}` : ''}</small></button>`;
      }).join('') + oldServer(cpu) + BACK;
    },

    daily: () => `${head('SFIDA DEL GIORNO', C.gold, 3)}
      <p>Una partita Classica con lo stesso programma per tutti, ogni giorno su un processore diverso. Vale il tuo miglior punteggio di oggi; a mezzanotte si ricomincia.</p>
      <div id="slot"><p class="note">Carico la classifica…</p></div>
      <button class="btn primary" data-act="playDaily" data-focus disabled>Gioca la sfida</button>
      ${guestNote('in classifica')}${BACK}`,

    challenges: () => `${head('SFIDE TRA AMICI', C.gold, 3)}
      <p>Tutti giocano lo stesso programma, con le stesse istruzioni e gli stessi dati: vince chi fa meglio. Crea una sfida e manda il codice.</p>
      <h3>Crea una sfida</h3>
      ${cpuTabs(makeCpu, 'makeCpu')}
      <div class="grid">${RANKED.map(m => `<button class="btn sm" data-act="create" data-mode="${m}">${MODES[m].name}</button>`).join('')}</div>
      ${oldServer(makeCpu)}
      <form data-form="join" novalidate>
        <h3><label for="code">Hai un codice?</label></h3>
        <div class="row"><input id="code" name="code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE">
        <button class="btn sm">Entra</button></div>
      </form>
      <p class="err" id="msg" role="alert"></p>
      <h3>Le tue sfide</h3><div id="slot"><p class="note">Carico…</p></div>${BACK}`,

    challenge: code => `${head(isDaily(code) ? 'SFIDA DEL GIORNO' : `SFIDA ${code}`, C.gold, 3)}
      <div id="slot"><p class="note">Carico…</p></div>
      <button class="btn primary" data-act="playChallenge" data-focus disabled>Gioca la sfida</button>
      <p class="err" id="msg" role="alert"></p>
      ${guestNote('nella sfida')}${BACK}`,

    boards() {
      const tabs = [...RANKED, 'oggi'].map(m => `<button class="tab" role="tab" aria-selected="${m === boardMode}" data-act="boardTab" data-mode="${m}">${m === 'oggi' ? 'Oggi' : MODES[m].name}</button>`).join('');
      const per = boardMode === 'oggi' ? '' : `<div class="tabs small">${[['all', 'Sempre'], ['week', 'Ultimi 7 giorni']].map(([p, l]) =>
        `<button class="tab" aria-selected="${p === boardPeriod}" data-act="boardPeriod" data-period="${p}">${l}</button>`).join('')}</div>`;
      return `${head('CLASSIFICHE')}${boardMode === 'oggi' ? '' : cpuTabs(boardCpu, 'boardCpu')}<div class="tabs" role="tablist">${tabs}</div>${per}<div id="slot"><p class="note">Carico…</p></div>${BACK}`;
    },

    profile: name => `${head(String(name), C.cyan, 3)}<div id="slot"><p class="note">Carico…</p></div>
      ${account.user?.name === name ? '<button class="btn" data-act="logout">Esci dall\'account</button>' : ''}${BACK}`,

    login(a) {
      const reg = loginTab === 'register';
      return `${head(reg ? 'NUOVO ACCOUNT' : 'ACCEDI', C.text, 3)}
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" aria-selected="${!reg}" data-act="loginTab" data-tab="login">Accedi</button>
          <button class="tab" role="tab" aria-selected="${reg}" data-act="loginTab" data-tab="register">Nuovo account</button>
        </div>
        ${a?.reason ? `<p class="note">${esc(a.reason)}</p>` : ''}
        <form data-form="auth" novalidate>
          <label class="field"><span>Nome${reg ? ' (da 3 a 12 tra lettere, cifre e trattino)' : ''}</span>
            <input name="name" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="12" data-focus></label>
          <label class="field"><span>Password${reg ? ' (almeno 4 caratteri)' : ''}</span>
            <input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" maxlength="64"></label>
          ${reg ? '<p class="note">La password viaggia in chiaro sulla rete locale: scegline una che usi solo per Overclock.</p>' : ''}
          <p class="err" id="msg" role="alert"></p>
          <button class="btn primary">${reg ? 'Crea account' : 'Entra'}</button>
        </form>${BACK}`;
    },

    invite: () => `${head('INVITA AMICI', C.cyan, 3)}
      <p>Fai inquadrare il codice con la fotocamera del telefono: si apre il gioco. Funziona per chi è collegato alla stessa rete.</p>
      <div id="slot"><p class="note">Preparo il codice…</p></div>${BACK}`,

    howto: () => `${head('COME SI GIOCA')}<div class="prose">
      <p><b>Sei tu il clock del processore.</b> Ogni tocco, clic o spazio è un colpo di clock: dopo ogni colpo i bit corrono verso i registri.</p>
      <p><b class="g">Tocca quando i registri sono tutti verdi.</b> I latch diventano verdi quando hanno ricevuto tutti i bit, e così la colonna del registro che sta per essere scritto.</p>
      <p>Guarda il chip, non i numeri: la luce resta su chi lavora, ogni stadio che finisce suona una nota e l'ultimo chiude l'accordo.</p>
      <ul>
        <li><b class="r">Troppo presto</b>: glitch. Il valore sbagliato prosegue davvero nel processore e perdi una vita.</li>
        <li><b class="g">Perfetto</b> entro 0,1 s, <b class="c">buono</b> entro 0,3 s: la combo sale e con lei il moltiplicatore, fino a ×4.</li>
        <li><b>Lento</b>: pochi punti e la combo si azzera.</li>
        <li>Ogni 20 colpi in tempo di fila recuperi una vita.</li>
      </ul>
      <p>Le somme con tanti riporti e le letture dalla memoria sono più lente. Correre scalda il chip, e il silicio caldo rallenta.</p>
      <h3>Processori</h3>
      <ul>${ORDER.map(id => `<li><b>${esc(PROCS[id].meta.name)}</b>: ${esc(PROCS[id].meta.howto || PROCS[id].meta.desc)}</li>`).join('')}</ul>
      <h3>Modalità</h3>
      <ul>${[...RANKED, 'allenamento'].map(id => `<li><b>${MODES[id].name}</b>: ${MODES[id].desc}</li>`).join('')}
        <li><b>Sfida del giorno</b>: ogni giorno un programma nuovo, uguale per tutti, su un processore diverso.</li>
        <li><b>Sfide tra amici</b>: crei una sfida, mandi il codice e vince chi fa meglio sullo stesso programma.</li></ul>
      <h3>Tasti</h3><p>Spazio o invio: clock · P o Esc: pausa · M: audio · F: schermo intero</p>
      </div>${BACK}`,

    results() {
      const s = last.s, m = MODES[s.mode];
      const [title, color] = s.end === 'crash' ? [s.why === 'battery' ? 'BROWN-OUT!' : 'CRASH!', C.red] : s.end === 'done' ? ['FINITO!', C.green] : ['TEMPO SCADUTO', C.orange];
      const place = s.challenge ? `${isDaily(s.challenge) ? 'Sfida del giorno' : `Sfida ${s.challenge}`} · ${procName(s.cpu)}` : where(s.cpu, s.mode);
      const timed = m.rank === 'time';
      const big = timed ? (s.finished ? fmtTime(s.time_ms) : `${s.ok}/${SPRINT}`) : String(s.score);
      const unit = timed ? (s.finished ? `per ${SPRINT} istruzioni` : 'istruzioni: sprint non finito') : 'punti';
      const why = { watchdog: 'Il watchdog ha riavviato il processore: il clock arrivava troppo tardi.', battery: 'La batteria si è scaricata: con la tensione troppo bassa il microcontrollore si è spento.', overrun: 'Troppi interrupt serviti in ritardo: il microcontrollore ha perso i dati.' };
      return `${head(title, color, 4)}<p class="center sub">${esc(place)}</p>
        <div class="big">${big}<small>${unit}</small></div>
        ${s.end === 'crash' ? `<p class="note center">${why[s.why] || 'Troppi glitch: il processore si è bloccato.'}</p>` : ''}
        <div class="stats">${stat(s.ok, 'istruzioni corrette')}${stat(`${s.perfect} / ${s.good} / ${s.slow}`, 'perfetti / buoni / lenti')}
          ${stat(s.glitches, 'glitch')}${stat(s.combo, 'combo massima')}${stat(freq(s.cpu, s.peak), 'picco')}${stat(`${num1(s.time_ms / 1000)} s`, 'durata')}
          ${(s.more || []).map(([v, l]) => stat(esc(v), esc(l))).join('')}</div>
        ${(s.notes || []).map(t => `<p class="note center">${esc(t)}</p>`).join('')}
        <p id="save" class="save" aria-live="polite">${last.status}</p>
        <div class="row"><button class="btn primary" data-act="again" data-focus disabled>Rigioca</button><button class="btn" data-act="home" disabled>Menu</button></div>
        <button class="btn" data-act="dare"${last.saved && !s.challenge ? '' : ' hidden'}>Sfida un amico su questa partita</button>`;
    },

    pause: () => `${head('PAUSA')}
      <button class="btn primary" data-act="resume" data-focus>Riprendi</button>
      <button class="btn" data-act="restart">Ricomincia</button>
      <button class="btn" data-act="quit">Esci al menu</button>
      <p class="note center">Se esci o ricominci, questa partita non viene salvata.</p>`,
  };

  // ---------- dati dal server ----------
  const LOAD = {
    async modes(cpu, id) {
      onPreview(cpu);
      if (!account.user || !api.supports(cpu)) return;
      const p = await api.player(account.user.name);
      if (!alive(id)) return;
      const modes = p.cpus ? p.cpus[cpu]?.modes : cpu === 'pipeline' ? p.modes : null;
      for (const m of RANKED) {
        const el = $(`[data-rec="${m}"]`), v = modes?.[m];
        if (el) el.textContent = v?.best != null ? `Il tuo record: ${short(m, v.best)}${v.rank ? ` · ${v.rank}° su ${v.total}` : ''}` : 'Non l\'hai ancora giocata';
      }
    },
    async daily(_, id) {
      const d = await api.daily();
      if (!alive(id)) return;
      daily = { ...d, cpu: PROCS[d.cpu] ? d.cpu : 'pipeline' };
      onPreview(daily.cpu);
      fill('#slot', `<p class="center"><b>Oggi: ${esc(procName(daily.cpu))}</b></p><p class="note center">${esc(PROCS[daily.cpu].meta.desc)}</p>
        <h3>Oggi, ${day(d.date)}</h3>${table(d.mode, d.standings, 'Nessuno ha ancora giocato oggi: puoi essere il primo.')}`);
      const b = $('[data-act="playDaily"]');
      b.disabled = false;
      b.focus({ preventScroll: true });
    },
    async challenges(_, id) {
      const d = await api.myChallenges();
      if (!alive(id)) return;
      fill('#slot', !d.challenges.length ? '<p class="note">Non hai ancora sfide: creane una qui sopra, o entra con un codice.</p>'
        : `<ul class="list">${d.challenges.map(c => `<li><button class="item" data-go="challenge" data-arg="${esc(c.code)}">
          <b>${esc(c.code)}</b> <span>${esc(where(c.cpu || 'pipeline', c.mode))} · ${!c.players ? 'nessun giocatore' : c.players === 1 ? '1 giocatore' : `${c.players} giocatori`}</span>
          <small>${c.leader ? `In testa ${esc(c.leader.name)} con ${short(c.mode, c.leader.best)}` : 'Nessuno ha ancora giocato'}${c.rank ? ` · tu sei ${c.rank}°` : ''}</small>
          </button></li>`).join('')}</ul>`);
    },
    async invite(_, id) {
      const d = await api.invite();
      if (alive(id)) fill('#slot', `<div class="share">${share(d, 'Link del gioco')}</div>`);
    },
    async challenge(code, id) {
      const d = await api.challenge(code);
      const inv = d.daily ? null                                      // senza QR (server vecchio) resta il link
        : await api.invite(d.code).catch(() => ({ url: `${location.origin}${location.pathname}?sfida=${d.code}`, svg: '' }));
      if (!alive(id)) return;
      current = { ...d, cpu: PROCS[d.cpu] ? d.cpu : 'pipeline' };
      onPreview(current.cpu);
      fill('#slot', `<p>${esc(where(current.cpu, d.mode))}${d.creator ? ` · creata da ${esc(d.creator)} il ${day(d.created)}` : ''}</p>
        <p class="note">${MODES[d.mode].desc}</p>
        ${d.daily ? '' : `<div class="share"><span>Manda il codice <b>${esc(d.code)}</b> o il link, o fai inquadrare il QR:</span>
          ${share(inv, 'Link della sfida', ' sm')}</div>`}
        <h3>Classifica della sfida</h3>${table(d.mode, d.standings, 'Nessuno ha ancora giocato: puoi essere il primo.')}`);
      const b = $('[data-act="playChallenge"]');
      b.disabled = false;
      b.focus({ preventScroll: true });
    },
    async boards(_, id) {
      if (boardMode === 'oggi') {
        const d = await api.daily();
        if (alive(id)) fill('#slot', `<p class="note">Sfida del giorno, ${day(d.date)} · ${esc(procName(PROCS[d.cpu] ? d.cpu : 'pipeline'))}</p>${table(d.mode, d.standings, 'Nessuno ha ancora giocato oggi.')}`);
        return;
      }
      if (!api.supports(boardCpu)) { fill('#slot', oldServer(boardCpu)); return; }
      const d = await api.leaderboard(boardCpu, boardMode, boardPeriod);
      if (!alive(id)) return;
      const what = MODES[boardMode].rank === 'time' ? 'Il tempo migliore di ognuno, solo sprint finiti.' : 'Il punteggio migliore di ognuno.';
      fill('#slot', `<p class="note">${esc(procName(boardCpu))}: ${what}</p>${table(boardMode, d.rows)}`);
    },
    async profile(name, id) {
      const p = await api.player(name);
      if (!alive(id)) return;
      const t = p.totals;
      const cpus = p.cpus || { pipeline: { games: t.games, peak: t.peak, modes: p.modes } };   // server di prima dei processori
      const value = g => (g.mode === 'sprint' ? (g.finished ? fmtTime(g.time_ms) : 'non finito') : String(g.score));
      const tag = g => (!g.challenge ? '' : isDaily(g.challenge) ? ' · del giorno' : ` · sfida ${esc(g.challenge)}`);
      const played = ORDER.filter(c => cpus[c]?.games);
      const recordCell = (c, m) => { const v = cpus[c].modes[m]; return `<td class="val">${short(m, v.best)}${v.rank ? `<small>${v.rank}°/${v.total}</small>` : ''}</td>`; };
      fill('#slot', `<p class="note center">Gioca dal ${day(p.since)}</p>
        <div class="stats">${stat(t.games, 'partite')}${stat(hours(t.time_ms), 'di gioco')}
          ${stat(pct(t.perfect, t.perfect + t.good + t.slow), 'colpi perfetti')}${stat(t.combo, 'combo massima')}
          ${stat(played.length, played.length === 1 ? 'processore provato' : 'processori provati')}${stat(t.ok, 'istruzioni corrette')}</div>
        <h3>Record</h3>${!played.length ? '<p class="note">Ancora nessuna partita salvata.</p>'
          : `<table class="board records"><thead><tr><th></th>${RANKED.map(m => `<th>${MODES[m].name.replace(' 50', '')}</th>`).join('')}</tr></thead>
          <tbody>${played.map(c => `<tr><td>${esc(shortName(c))}<small>${freq(c, cpus[c].peak)}</small></td>${RANKED.map(m => recordCell(c, m)).join('')}</tr>`).join('')}</tbody></table>`}
        <h3>Ultime partite</h3>${!p.recent.length ? '<p class="note">Nessuna partita.</p>'
          : `<table class="board"><tbody>${p.recent.map(g => `<tr><td>${esc(shortName(g.cpu || 'pipeline'))} · ${MODES[g.mode]?.name ?? esc(g.mode)}${tag(g)}</td>
            <td class="val">${value(g)}</td><td class="val dim">${when(g.created)}</td></tr>`).join('')}</tbody></table>`}`);
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
    last.state = 'done';
    if (m.practice) return status('Allenamento: la partita non si salva.');
    if (s.custom) return status('Durata personalizzata: la partita non si salva.');
    const local = saveLocalBest(s.cpu, s.mode, valueOf(s)) ? '<b class="ok">Nuovo record su questo browser!</b> ' : '';
    if (!account.online) return status(`${local}Server dei punteggi non raggiungibile: la partita non è salvata.`);
    if (!api.supports(s.cpu)) return status(`${local}Il server dei punteggi non conosce ancora questo processore (va riavviato): la partita non è salvata.`);
    if (!account.user) {
      last.state = 'guest';
      return status(`${local}<button class="link" data-act="loginSave">Accedi o crea un account</button> per salvare la partita ed entrare in classifica.`);
    }
    status('Salvo la partita…');
    try {
      const { end, why, custom, more, notes, ...game } = s;
      const r = await api.saveGame(game);
      last.saved = r;
      const parts = [];
      if (r.best) parts.push('<b class="ok">Nuovo record personale!</b>');
      else if (r.record != null) parts.push(`Il tuo record: ${short(s.mode, r.record)}.`);
      if (m.rank === 'time' && r.value == null) parts.push('Lo sprint non è finito: non entra in classifica.');
      if (r.challenge?.rank) parts.push(`${r.challenge.daily ? 'Sfida del giorno' : 'Nella sfida'}: sei ${r.challenge.rank}° su ${r.challenge.total}.`);
      else if (!r.challenge && r.rank) parts.push(`In classifica ${esc(where(s.cpu, s.mode))}: sei ${r.rank}° su ${r.total}.`);
      status(parts.join(' ') || 'Partita salvata.');
      if (alive(id) && !s.challenge) $('[data-act="dare"]')?.removeAttribute('hidden');
    } catch (e) {
      last.state = 'error';
      status(`Partita non salvata: ${esc(e.message)}`, 'err');
    }
  }

  async function auth(form) {
    const name = form.elements.namedItem('name').value.trim(), password = form.elements.namedItem('password').value;
    const btn = form.querySelector('button');
    flash('');
    if (!name || !password) return flash('Scrivi nome e password.');
    btn.disabled = true;
    try {
      await (loginTab === 'register' ? api.register(name, password) : api.login(name, password));
      const next = arg?.next;
      if (next === 'save' && last) { last.state = 'idle'; go('results'); }
      else if (Array.isArray(next)) go(next[0], next[1]);
      else go('home');
    } catch (e) {
      btn.disabled = false;
      flash(e.message);
    }
  }

  // ---------- azioni ----------
  const ACT = {
    back,
    home: () => onHome(),
    pickProc: el => show('modes', el.dataset.cpu),
    play: el => onPlay({ cpu: arg, mode: el.dataset.mode }),
    playDaily: () => daily && onPlay({ cpu: daily.cpu, mode: daily.mode, seed: daily.seed, challenge: daily.code }),
    playChallenge: () => current && onPlay({ cpu: current.cpu, mode: current.mode, seed: current.seed, challenge: current.code }),
    friends: () => (account.user ? show('challenges') : show('login', { next: ['challenges', null], reason: 'Per creare e giocare le sfide serve un account.' })),
    loginBack: () => show('login', { next: [screen, arg] }),
    loginSave: () => show('login', { next: 'save', reason: 'Accedi e la partita appena fatta viene salvata.' }),
    loginTab: el => { loginTab = el.dataset.tab; render(); },
    boardTab: el => { boardMode = el.dataset.mode; render(); },
    boardPeriod: el => { boardPeriod = el.dataset.period; render(); },
    boardCpu: el => { boardCpu = el.dataset.cpu; onPreview(boardCpu); render(); },
    makeCpu: el => { makeCpu = el.dataset.cpu; onPreview(makeCpu); render(); },
    async logout() { await api.logout(); stack = []; show('home', null, { push: false }); },
    async create(el) {
      if (!api.supports(makeCpu)) return flash('Il server non conosce ancora questo processore: va riavviato.');
      el.disabled = true;
      try { const r = await api.createChallenge({ cpu: makeCpu, mode: el.dataset.mode }); show('challenge', r.code); }
      catch (e) { el.disabled = false; flash(e.message); }
    },
    join(form) {
      const code = form.elements.namedItem('code').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) return flash('Il codice ha 5 caratteri, lettere o cifre.');
      show('challenge', code);
    },
    copy(el) {
      const input = el.parentElement.querySelector('input');
      const done = () => { el.textContent = 'Copiato!'; setTimeout(() => { el.textContent = 'Copia'; }, 1500); };
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
        show('challenge', r.code);
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
  // passando sui processori il chip dietro al menu cambia
  const preview = e => { const el = e.target.closest?.('.proc[data-cpu]'); if (el) onPreview(el.dataset.cpu); };
  root.addEventListener('focusin', preview);
  root.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') preview(e); });
  addEventListener('resize', () => { if (!root.hidden) paint(); });

  return {
    show,
    hide,
    home() { stack = []; show('home', null, { push: false }); },
    results(s) { last = { s, state: 'idle', status: '', saved: null, armed: false }; stack = []; show('results', null, { push: false }); },
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
