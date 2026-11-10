// Lingue del gioco: inglese (predefinito al primo avvio) e italiano, scelte nelle Impostazioni.
// La lingua si decide all'avvio: cambiandola la pagina si ricarica, così anche i testi fissi dei processori si aggiornano.
// I testi possono contenere {segnaposto}; quelli che dipendono da un numero sono funzioni.

const KEY = 'overclock-lang';
export const LANGS = { en: 'English', it: 'Italiano' };
function pick() {
  try { const v = localStorage.getItem(KEY); if (LANGS[v]) return v; } catch { /* niente memoria: inglese */ }
  return 'en';
}
export const lang = pick();
document.documentElement.lang = lang;
export function setLang(l) {
  if (!LANGS[l] || l === lang) return;
  try { localStorage.setItem(KEY, l); } catch { /* resta per questa volta */ }
  location.reload();
}

const plural = (n, one, many) => (n === 1 ? one : many).replace('{n}', n);

const en = {
  'back': 'Back', 'copy': 'Copy', 'copied': 'Copied!', 'loading': 'Loading…', 'login.link': 'Log in',
  'empty.board': 'Nobody yet: you can be the first.',
  'qr.aria': 'QR code for {url}',
  'guest.board': 'You are playing as a guest: this game won\'t enter the leaderboard.',
  'guest.challenge': 'You are playing as a guest: this game won\'t enter the challenge.',
  'oldServer': 'The score server doesn\'t know {proc} yet: it needs a restart. Meanwhile you can play without saving.',
  'unreachable': 'Score server not reachable',

  'home.tag': 'You are the processor\'s clock.',
  'home.offline': 'No score server: you are playing offline, and your records stay on this device.',
  'home.hello': 'Hi {name}', 'home.logout': 'log out',
  'home.guest': 'Playing as a guest', 'home.login': 'log in or sign up',
  'home.play': 'Play', 'home.daily': 'Daily challenge', 'home.friends': 'Friend challenges', 'home.boards': 'Leaderboards',
  'home.invite': 'Invite friends', 'home.howto': 'How to play', 'home.settings': 'Settings',
  'home.keys': 'Space or click: clock · P pause · M sound · F fullscreen',

  'procs.title': 'Processor',
  'rec.device': 'Record on this device: {v}', 'rec.mine': 'Your record: {v}', 'rec.rank': ' · {pos} of {total}', 'rec.none': 'Not played yet',

  'daily.title': 'Daily challenge',
  'daily.intro': 'A Classic game with the same program for everyone, each day on a different processor. Your best score of the day counts; it starts over at midnight.',
  'daily.play': 'Play the challenge', 'daily.today': 'Today: {proc}', 'daily.board': 'Today, {date}',
  'daily.empty': 'Nobody has played today yet: you can be the first.',
  'daily.mine': 'Your best today on this device: {v}',
  'daily.offline': 'Without a score server there is no leaderboard, but today\'s challenge can still be played.',

  'ch.title': 'Friend challenges',
  'ch.intro': 'Everyone plays the same program, with the same instructions and the same data: the best result wins. Create a challenge and send the code.',
  'ch.create': 'Create a challenge', 'ch.haveCode': 'Got a code?', 'ch.join': 'Join', 'ch.yours': 'Your challenges',
  'ch.none': 'No challenges yet: create one above, or join with a code.',
  'ch.players': n => (n ? plural(n, '1 player', '{n} players') : 'no players'),
  'ch.leader': 'Leading: {name} with {v}', 'ch.nobody': 'Nobody has played yet', 'ch.you': ' · you are {pos}',
  'ch.code': 'Challenge {code}', 'ch.by': ' · created by {name} on {date}',
  'ch.send': 'Send the code <b>{code}</b> or the link, or let them scan the QR code:',
  'ch.link': 'Challenge link', 'ch.board': 'Challenge leaderboard', 'ch.empty': 'Nobody has played yet: you can be the first.',
  'ch.badCode': 'The code has 5 characters, letters or digits.',
  'ch.needAccount': 'You need an account to create and play challenges.',
  'ch.oldServer': 'The server doesn\'t know this processor yet: it needs a restart.',

  'boards.title': 'Leaderboards', 'boards.today': 'Today', 'boards.all': 'All time', 'boards.week': 'Last 7 days',
  'boards.daily': 'Daily challenge, {date} · {proc}', 'boards.todayEmpty': 'Nobody has played today yet.',
  'boards.time': '{proc}: everyone\'s best time, finished sprints only.', 'boards.score': '{proc}: everyone\'s best score.',

  'prof.logout': 'Log out', 'prof.since': 'Playing since {date}',
  'prof.games': 'games', 'prof.time': 'played', 'prof.perfect': 'perfect hits', 'prof.combo': 'best combo',
  'prof.procs': n => (n === 1 ? 'processor tried' : 'processors tried'), 'prof.ok': 'correct instructions',
  'prof.records': 'Records', 'prof.noGames': 'No saved games yet.', 'prof.recent': 'Recent games', 'prof.none': 'No games.',
  'prof.unfinished': 'not finished', 'prof.daily': ' · daily', 'prof.challenge': ' · challenge {code}',
  'when.today': 'today {time}',

  'login.title': 'Log in', 'login.titleNew': 'New account', 'login.tab': 'Log in', 'login.tabNew': 'New account',
  'login.name': 'Name', 'login.nameHint': ' (3 to 12 letters, digits or hyphens)',
  'login.password': 'Password', 'login.pwHint': ' (at least {n} characters)',
  'login.invite': 'Invite code', 'login.inviteHint': ' (ask whoever runs this server)',
  'login.plain': 'This server doesn\'t use HTTPS: the password travels unencrypted over the network. Pick one you use only for Overclock.',
  'login.create': 'Create account', 'login.enter': 'Log in', 'login.missing': 'Enter name and password.',
  'login.closed': 'This server doesn\'t accept new accounts.',
  'login.saveReason': 'Log in and the game you just played will be saved.',

  'inv.title': 'Invite friends',
  'inv.lan': 'Let them scan the code with their phone camera: the game opens. It works for anyone on the same network.',
  'inv.web': 'Let them scan the code with their phone camera: the game opens.',
  'inv.link': 'Game link', 'inv.preparing': 'Preparing the code…',

  'howto.title': 'How to play',
  'howto.body': `<p><b>You are the processor's clock.</b> Every tap, click or space is a clock tick: after each tick the bits race towards the registers.</p>
      <p><b class="g">Tap when the registers are all green.</b> The latches turn green when they have received all their bits, and so does the column of the register about to be written.</p>
      <p>Watch the chip, not the numbers: the light stays on whatever is still working, every stage that finishes plays a note and the last one closes the chord.</p>
      <ul>
        <li><b class="r">Too early</b>: glitch. The wrong value really travels on through the processor and you lose a life.</li>
        <li><b class="g">Perfect</b> within 0.1 s, <b class="c">good</b> within 0.3 s: the combo grows and so does the multiplier, up to ×4.</li>
        <li><b>Slow</b>: few points and the combo resets.</li>
        <li>Every 20 on-time ticks in a row you get a life back.</li>
      </ul>
      <p>Sums with many carries and memory reads are slower. Rushing heats up the chip, and hot silicon is slower.</p>`,
  'howto.procs': 'Processors', 'howto.modes': 'Modes',
  'howto.daily': '<b>Daily challenge</b>: a new program every day, the same for everyone, on a different processor.',
  'howto.friends': '<b>Friend challenges</b>: create a challenge, send the code, and whoever does best on the same program wins.',
  'howto.keys': 'Keys', 'howto.keysText': 'Space or Enter: clock · P or Esc: pause · M: sound · F: fullscreen',

  'res.crash': 'CRASH!', 'res.brownout': 'BROWN-OUT!', 'res.done': 'FINISHED!', 'res.time': 'TIME UP',
  'res.daily': 'Daily challenge', 'res.challenge': 'Challenge {code}',
  'res.forN': 'for {n} instructions', 'res.unfinished': 'instructions: sprint not finished', 'res.points': 'points',
  'why.watchdog': 'The watchdog reset the processor: the clock came too late.',
  'why.battery': 'The battery ran out: with the voltage too low the microcontroller shut down.',
  'why.overrun': 'Too many interrupts served late: the microcontroller lost data.',
  'why.glitch': 'Too many glitches: the processor locked up.',
  'st.ok': 'correct instructions', 'st.pgs': 'perfect / good / slow', 'st.glitch': 'glitches', 'st.combo': 'best combo',
  'st.peak': 'peak', 'st.time': 'duration',
  'res.again': 'Play again', 'res.menu': 'Menu', 'res.dare': 'Challenge a friend on this game',
  'save.practice': 'Practice: this game isn\'t saved.', 'save.custom': 'Custom duration: this game isn\'t saved.',
  'save.localBest': 'New record on this device!',
  'save.offline': 'Saved on this device: you can export it from Settings and send it to a server.',
  'save.oldServer': 'The score server doesn\'t know this processor yet (it needs a restart): saved only on this device.',
  'save.guest': 'to save the game on the server and enter the leaderboard.', 'save.guestLink': 'Log in or sign up',
  'save.saving': 'Saving the game…', 'save.best': 'New personal best!', 'save.record': 'Your record: {v}.',
  'save.sprint': 'The sprint isn\'t finished: it doesn\'t enter the leaderboard.',
  'save.chDaily': 'Daily challenge: you are {pos} of {total}.', 'save.ch': 'In the challenge: you are {pos} of {total}.',
  'save.rank': 'In the {where} leaderboard: you are {pos} of {total}.', 'save.done': 'Game saved.',
  'save.error': 'Not saved on the server: {msg}. It is kept on this device.',

  'pause.title': 'Pause', 'pause.resume': 'Resume', 'pause.restart': 'Restart', 'pause.quit': 'Quit to menu',
  'pause.note': 'If you quit or restart, this game isn\'t saved.',

  'set.title': 'Settings', 'set.lang': 'Language', 'set.sound': 'Sound', 'set.on': 'On', 'set.off': 'Off',
  'set.server': 'Score server', 'set.serverThis': 'this page\'s server',
  'set.online': 'Connected to {url}', 'set.offline': 'Not reachable ({url}): you are playing offline.',
  'set.url': 'Server address', 'set.connect': 'Connect', 'set.reset': 'Use this page\'s server',
  'set.serverNote': 'Anyone can run their own server with <code>python3 server.py</code> (see the README). From the web version the server must use HTTPS; on a local network, open the game from the server\'s own address instead.',
  'set.badUrl': 'Write a full address, like https://example.org:8765/',
  'set.needHttps': 'This page uses HTTPS, so the browser blocks a server on plain HTTP. Open the game from the server\'s address instead: {url}',
  'set.cantReach': 'Can\'t reach that server.',
  'set.results': 'Your results',
  'set.count': n => (n ? plural(n, '1 game saved on this device.', '{n} games saved on this device.') : 'No games saved on this device yet.'),
  'set.export': 'Export file', 'set.send': 'Send to the server', 'set.upload': 'Upload a file to the server',
  'set.needLogin': 'Log in to a score server to send your results.',
  'set.sent': 'Sent: {imported} new, {dup} already there, {rej} rejected.',
  'set.badFile': 'This isn\'t an Overclock results file.',
  'set.exportNote': 'The file carries a checksum: a server rejects it if it was edited by hand.',
  'set.clear': 'Delete history', 'set.clearSure': 'Tap again to delete {n} games', 'set.cleared': 'History deleted.',
  'set.install': 'Install the app',
  'set.about': 'About',
  'set.aboutText': 'Overclock © 2026 Angelo Quartarone. Free for non-commercial use (PolyForm Noncommercial 1.0). <a href="https://github.com/AngeloQuartarone/overclock" target="_blank" rel="noopener">Source code</a>',

  'mode.classica': 'Classic', 'mode.classica.desc': '60 seconds and 3 lives: score as many points as you can.',
  'mode.sprint': 'Sprint 50', 'mode.sprint.desc': '{n} correct instructions as fast as you can.',
  'mode.sopravvivenza': 'Survival', 'mode.sopravvivenza.desc': 'No time limit, but the watchdog allows less and less delay: if you are too late you lose a life.',
  'mode.allenamento': 'Practice', 'mode.allenamento.desc': 'No lives and no timer, with the stage lights at the bottom. Not saved.',

  'hud.score': 'SCORE', 'hud.instr': 'INSTRUCTIONS', 'hud.time': 'TIME', 'hud.heat': 'HEAT', 'hud.battery': 'BATTERY',
  'hud.muted': 'SOUND OFF', 'hud.go': 'GO!', 'fb.perfect': 'PERFECT!', 'fb.good': 'GOOD', 'fb.slow': 'SLOW',
  'fb.life': '+1 LIFE', 'fb.waste': 'WASTED',
  'scene.aria': 'Overclock: tap or press space to send a clock tick',

  'proc.singolo': 'Single-cycle', 'proc.singolo.short': 'Single',
  'proc.singolo.tag': 'One whole instruction per tick: slow, but very easy to read.',
  'proc.singolo.desc': 'There are no registers between the stages: on every tick a single wave crosses the whole chip. Tap when it reaches the registers.',
  'proc.singolo.howto': 'a single wave per tick crosses the whole chip: tap when it reaches the register being written (or the memory, for a STORE).',
  'proc.singolo.note': 'With a fixed clock, tuned to the slowest instruction you met ({worst} s per tick), those {cycles} ticks would have taken {fixed} s: your clock took {span} s{gain}.',
  'proc.singolo.gain': ', {g}% less',
  'proc.multiciclo': 'Multi-cycle', 'proc.multiciclo.short': 'Multi',
  'proc.multiciclo.tag': 'One step per tick: every instruction has its own rhythm.',
  'proc.multiciclo.desc': 'Every instruction is split into steps, one per tick: 4 for operations, 5 for LOAD, 4 for STORE. A single ALU and a single memory, reused at every step.',
  'proc.multiciclo.howto': 'one tick for each step of the instruction (4 for operations, 5 for LOAD, 4 for STORE): the state-machine lights on the control unit tell you which steps are left.',
  'proc.multiciclo.cpi': 'ticks per instruction (CPI)',
  'proc.pipeline': 'Pipeline', 'proc.pipeline.short': 'Pipeline',
  'proc.pipeline.tag': 'Five instructions at once, one per stage.',
  'proc.pipeline.desc': 'Between one stage and the next there is a row of latches: tap when they are all green. The original processor.',
  'proc.mcu': 'Microcontroller', 'proc.mcu.short': 'MCU',
  'proc.mcu.tag': 'Sleeps until you call it: interrupts, deadlines and battery.',
  'proc.mcu.desc': 'When a pin lights up (IRQ!) clock its routine before the deadline. Then it goes back to sleep: don\'t tap, you would waste battery.',
  'proc.mcu.howto': 'it sleeps until a pin sends an interrupt: then clock the routine (the first tick fetches the vector) and finish it before the deadline. After RETI don\'t tap: while it sleeps every tick wastes battery, and with a flat battery the chip slows down until the brown-out.',
  'proc.mcu.asleep': 'ASLEEP!', 'proc.mcu.late': 'LATE IRQ',
  'proc.mcu.irqs': 'interrupts served', 'proc.mcu.overruns': 'missed deadlines (overrun)', 'proc.mcu.battery': 'battery left',
  'proc.mcu.wasted': 'wasted ticks (asleep)',
  'proc.gpu': 'GPU', 'proc.gpu.short': 'GPU',
  'proc.gpu.tag': '16 lanes running the same instruction: you wait for the slowest.',
  'proc.gpu.desc': 'Every tick sends the same instruction to 16 lanes, each on its own pixel: tap when the last one has arrived. Each row lands in the framebuffer and eight rows make a frame.',
  'proc.gpu.howto': 'the same instruction goes to 16 lanes: tap when they are all green, even the slowest. Rows of pixels build an image on the chip; a glitch leaves wrong pixels (artifacts).',
  'proc.gpu.frames': n => (n === 1 ? 'complete frame' : 'complete frames'), 'proc.gpu.artifacts': 'pixels with artifacts',
  'proc.gpu.badFrame': 'FRAME WITH ARTIFACTS', 'proc.gpu.badShort': 'ARTIFACTS!',
};

const it = {
  'back': 'Indietro', 'copy': 'Copia', 'copied': 'Copiato!', 'loading': 'Carico…', 'login.link': 'Accedi',
  'empty.board': 'Ancora nessuno: puoi essere il primo.',
  'qr.aria': 'QR code di {url}',
  'guest.board': 'Giochi come ospite: la partita non entra in classifica.',
  'guest.challenge': 'Giochi come ospite: la partita non entra nella sfida.',
  'oldServer': 'Il server dei punteggi non conosce ancora {proc}: va riavviato. Intanto si gioca senza salvare.',
  'unreachable': 'Server dei punteggi non raggiungibile',

  'home.tag': 'Sei tu il clock del processore.',
  'home.offline': 'Nessun server dei punteggi: giochi offline, e i record restano su questo dispositivo.',
  'home.hello': 'Ciao {name}', 'home.logout': 'esci',
  'home.guest': 'Giochi come ospite', 'home.login': 'accedi o crea un account',
  'home.play': 'Gioca', 'home.daily': 'Sfida del giorno', 'home.friends': 'Sfide tra amici', 'home.boards': 'Classifiche',
  'home.invite': 'Invita amici', 'home.howto': 'Come si gioca', 'home.settings': 'Impostazioni',
  'home.keys': 'Spazio o clic: colpo di clock · P pausa · M audio · F schermo intero',

  'procs.title': 'Processore',
  'rec.device': 'Record su questo dispositivo: {v}', 'rec.mine': 'Il tuo record: {v}', 'rec.rank': ' · {pos} su {total}', 'rec.none': 'Non l\'hai ancora giocata',

  'daily.title': 'Sfida del giorno',
  'daily.intro': 'Una partita Classica con lo stesso programma per tutti, ogni giorno su un processore diverso. Vale il tuo miglior punteggio di oggi; a mezzanotte si ricomincia.',
  'daily.play': 'Gioca la sfida', 'daily.today': 'Oggi: {proc}', 'daily.board': 'Oggi, {date}',
  'daily.empty': 'Nessuno ha ancora giocato oggi: puoi essere il primo.',
  'daily.mine': 'Il tuo migliore di oggi su questo dispositivo: {v}',
  'daily.offline': 'Senza server dei punteggi non c\'è la classifica, ma la sfida di oggi si gioca lo stesso.',

  'ch.title': 'Sfide tra amici',
  'ch.intro': 'Tutti giocano lo stesso programma, con le stesse istruzioni e gli stessi dati: vince chi fa meglio. Crea una sfida e manda il codice.',
  'ch.create': 'Crea una sfida', 'ch.haveCode': 'Hai un codice?', 'ch.join': 'Entra', 'ch.yours': 'Le tue sfide',
  'ch.none': 'Non hai ancora sfide: creane una qui sopra, o entra con un codice.',
  'ch.players': n => (n ? plural(n, '1 giocatore', '{n} giocatori') : 'nessun giocatore'),
  'ch.leader': 'In testa {name} con {v}', 'ch.nobody': 'Nessuno ha ancora giocato', 'ch.you': ' · tu sei {pos}',
  'ch.code': 'Sfida {code}', 'ch.by': ' · creata da {name} il {date}',
  'ch.send': 'Manda il codice <b>{code}</b> o il link, o fai inquadrare il QR:',
  'ch.link': 'Link della sfida', 'ch.board': 'Classifica della sfida', 'ch.empty': 'Nessuno ha ancora giocato: puoi essere il primo.',
  'ch.badCode': 'Il codice ha 5 caratteri, lettere o cifre.',
  'ch.needAccount': 'Per creare e giocare le sfide serve un account.',
  'ch.oldServer': 'Il server non conosce ancora questo processore: va riavviato.',

  'boards.title': 'Classifiche', 'boards.today': 'Oggi', 'boards.all': 'Sempre', 'boards.week': 'Ultimi 7 giorni',
  'boards.daily': 'Sfida del giorno, {date} · {proc}', 'boards.todayEmpty': 'Nessuno ha ancora giocato oggi.',
  'boards.time': '{proc}: il tempo migliore di ognuno, solo sprint finiti.', 'boards.score': '{proc}: il punteggio migliore di ognuno.',

  'prof.logout': 'Esci dall\'account', 'prof.since': 'Gioca dal {date}',
  'prof.games': 'partite', 'prof.time': 'di gioco', 'prof.perfect': 'colpi perfetti', 'prof.combo': 'combo massima',
  'prof.procs': n => (n === 1 ? 'processore provato' : 'processori provati'), 'prof.ok': 'istruzioni corrette',
  'prof.records': 'Record', 'prof.noGames': 'Ancora nessuna partita salvata.', 'prof.recent': 'Ultime partite', 'prof.none': 'Nessuna partita.',
  'prof.unfinished': 'non finito', 'prof.daily': ' · del giorno', 'prof.challenge': ' · sfida {code}',
  'when.today': 'oggi {time}',

  'login.title': 'Accedi', 'login.titleNew': 'Nuovo account', 'login.tab': 'Accedi', 'login.tabNew': 'Nuovo account',
  'login.name': 'Nome', 'login.nameHint': ' (da 3 a 12 tra lettere, cifre e trattino)',
  'login.password': 'Password', 'login.pwHint': ' (almeno {n} caratteri)',
  'login.invite': 'Codice d\'invito', 'login.inviteHint': ' (chiedilo a chi gestisce il server)',
  'login.plain': 'Questo server non usa HTTPS: la password viaggia in chiaro sulla rete. Scegline una che usi solo per Overclock.',
  'login.create': 'Crea account', 'login.enter': 'Entra', 'login.missing': 'Scrivi nome e password.',
  'login.closed': 'Questo server non accetta nuovi account.',
  'login.saveReason': 'Accedi e la partita appena fatta viene salvata.',

  'inv.title': 'Invita amici',
  'inv.lan': 'Fai inquadrare il codice con la fotocamera del telefono: si apre il gioco. Funziona per chi è collegato alla stessa rete.',
  'inv.web': 'Fai inquadrare il codice con la fotocamera del telefono: si apre il gioco.',
  'inv.link': 'Link del gioco', 'inv.preparing': 'Preparo il codice…',

  'howto.title': 'Come si gioca',
  'howto.body': `<p><b>Sei tu il clock del processore.</b> Ogni tocco, clic o spazio è un colpo di clock: dopo ogni colpo i bit corrono verso i registri.</p>
      <p><b class="g">Tocca quando i registri sono tutti verdi.</b> I latch diventano verdi quando hanno ricevuto tutti i bit, e così la colonna del registro che sta per essere scritto.</p>
      <p>Guarda il chip, non i numeri: la luce resta su chi lavora, ogni stadio che finisce suona una nota e l'ultimo chiude l'accordo.</p>
      <ul>
        <li><b class="r">Troppo presto</b>: glitch. Il valore sbagliato prosegue davvero nel processore e perdi una vita.</li>
        <li><b class="g">Perfetto</b> entro 0,1 s, <b class="c">buono</b> entro 0,3 s: la combo sale e con lei il moltiplicatore, fino a ×4.</li>
        <li><b>Lento</b>: pochi punti e la combo si azzera.</li>
        <li>Ogni 20 colpi in tempo di fila recuperi una vita.</li>
      </ul>
      <p>Le somme con tanti riporti e le letture dalla memoria sono più lente. Correre scalda il chip, e il silicio caldo rallenta.</p>`,
  'howto.procs': 'Processori', 'howto.modes': 'Modalità',
  'howto.daily': '<b>Sfida del giorno</b>: ogni giorno un programma nuovo, uguale per tutti, su un processore diverso.',
  'howto.friends': '<b>Sfide tra amici</b>: crei una sfida, mandi il codice e vince chi fa meglio sullo stesso programma.',
  'howto.keys': 'Tasti', 'howto.keysText': 'Spazio o invio: clock · P o Esc: pausa · M: audio · F: schermo intero',

  'res.crash': 'CRASH!', 'res.brownout': 'BROWN-OUT!', 'res.done': 'FINITO!', 'res.time': 'TEMPO SCADUTO',
  'res.daily': 'Sfida del giorno', 'res.challenge': 'Sfida {code}',
  'res.forN': 'per {n} istruzioni', 'res.unfinished': 'istruzioni: sprint non finito', 'res.points': 'punti',
  'why.watchdog': 'Il watchdog ha riavviato il processore: il clock arrivava troppo tardi.',
  'why.battery': 'La batteria si è scaricata: con la tensione troppo bassa il microcontrollore si è spento.',
  'why.overrun': 'Troppi interrupt serviti in ritardo: il microcontrollore ha perso i dati.',
  'why.glitch': 'Troppi glitch: il processore si è bloccato.',
  'st.ok': 'istruzioni corrette', 'st.pgs': 'perfetti / buoni / lenti', 'st.glitch': 'glitch', 'st.combo': 'combo massima',
  'st.peak': 'picco', 'st.time': 'durata',
  'res.again': 'Rigioca', 'res.menu': 'Menu', 'res.dare': 'Sfida un amico su questa partita',
  'save.practice': 'Allenamento: la partita non si salva.', 'save.custom': 'Durata personalizzata: la partita non si salva.',
  'save.localBest': 'Nuovo record su questo dispositivo!',
  'save.offline': 'Salvata su questo dispositivo: puoi esportarla dalle Impostazioni e mandarla a un server.',
  'save.oldServer': 'Il server dei punteggi non conosce ancora questo processore (va riavviato): salvata solo su questo dispositivo.',
  'save.guest': 'per salvare la partita sul server ed entrare in classifica.', 'save.guestLink': 'Accedi o crea un account',
  'save.saving': 'Salvo la partita…', 'save.best': 'Nuovo record personale!', 'save.record': 'Il tuo record: {v}.',
  'save.sprint': 'Lo sprint non è finito: non entra in classifica.',
  'save.chDaily': 'Sfida del giorno: sei {pos} su {total}.', 'save.ch': 'Nella sfida: sei {pos} su {total}.',
  'save.rank': 'In classifica {where}: sei {pos} su {total}.', 'save.done': 'Partita salvata.',
  'save.error': 'Non salvata sul server: {msg}. Resta su questo dispositivo.',

  'pause.title': 'Pausa', 'pause.resume': 'Riprendi', 'pause.restart': 'Ricomincia', 'pause.quit': 'Esci al menu',
  'pause.note': 'Se esci o ricominci, questa partita non viene salvata.',

  'set.title': 'Impostazioni', 'set.lang': 'Lingua', 'set.sound': 'Audio', 'set.on': 'Sì', 'set.off': 'No',
  'set.server': 'Server dei punteggi', 'set.serverThis': 'il server di questa pagina',
  'set.online': 'Collegato a {url}', 'set.offline': 'Non raggiungibile ({url}): si gioca offline.',
  'set.url': 'Indirizzo del server', 'set.connect': 'Collega', 'set.reset': 'Usa il server di questa pagina',
  'set.serverNote': 'Chiunque può avviare un suo server con <code>python3 server.py</code> (vedi il README). Dalla versione web il server deve essere in HTTPS; in rete locale apri invece il gioco dall\'indirizzo del server.',
  'set.badUrl': 'Scrivi un indirizzo completo, come https://example.org:8765/',
  'set.needHttps': 'Questa pagina è in HTTPS, quindi il browser blocca un server in HTTP semplice. Apri invece il gioco dall\'indirizzo del server: {url}',
  'set.cantReach': 'Non riesco a raggiungere quel server.',
  'set.results': 'I tuoi risultati',
  'set.count': n => (n ? plural(n, '1 partita salvata su questo dispositivo.', '{n} partite salvate su questo dispositivo.') : 'Ancora nessuna partita salvata su questo dispositivo.'),
  'set.export': 'Esporta file', 'set.send': 'Manda al server', 'set.upload': 'Carica un file sul server',
  'set.needLogin': 'Accedi a un server dei punteggi per mandare i risultati.',
  'set.sent': 'Inviati: {imported} nuovi, {dup} già presenti, {rej} scartati.',
  'set.badFile': 'Questo non è un file di risultati di Overclock.',
  'set.exportNote': 'Il file ha un codice di controllo: un server lo rifiuta se è stato modificato a mano.',
  'set.clear': 'Cancella lo storico', 'set.clearSure': 'Tocca di nuovo per cancellare {n} partite', 'set.cleared': 'Storico cancellato.',
  'set.install': 'Installa l\'app',
  'set.about': 'Informazioni',
  'set.aboutText': 'Overclock © 2026 Angelo Quartarone. Libero per uso non commerciale (PolyForm Noncommercial 1.0). <a href="https://github.com/AngeloQuartarone/overclock" target="_blank" rel="noopener">Codice sorgente</a>',

  'mode.classica': 'Classica', 'mode.classica.desc': '60 secondi e 3 vite: fai più punti che puoi.',
  'mode.sprint': 'Sprint 50', 'mode.sprint.desc': '{n} istruzioni corrette nel minor tempo possibile.',
  'mode.sopravvivenza': 'Sopravvivenza', 'mode.sopravvivenza.desc': 'Niente tempo limite, ma il watchdog concede sempre meno ritardo: se tardi troppo perdi una vita.',
  'mode.allenamento': 'Allenamento', 'mode.allenamento.desc': 'Senza vite né tempo, con le spie degli stadi in basso. Non si salva.',

  'hud.score': 'PUNTI', 'hud.instr': 'ISTRUZIONI', 'hud.time': 'TEMPO', 'hud.heat': 'CALORE', 'hud.battery': 'BATTERIA',
  'hud.muted': 'AUDIO NO', 'hud.go': 'VIA!', 'fb.perfect': 'PERFETTO!', 'fb.good': 'BUONO', 'fb.slow': 'LENTO',
  'fb.life': '+1 VITA', 'fb.waste': 'A VUOTO',
  'scene.aria': 'Overclock: tocca o premi spazio per dare il colpo di clock',

  'proc.singolo': 'Ciclo singolo', 'proc.singolo.short': 'Singolo',
  'proc.singolo.tag': 'Un\'istruzione intera per colpo: lento, ma si legge benissimo.',
  'proc.singolo.desc': 'Non ci sono registri tra gli stadi: a ogni colpo un\'onda sola attraversa tutto il chip. Tocca quando arriva ai registri.',
  'proc.singolo.howto': 'un\'onda sola per colpo, che attraversa tutto il chip: tocca quando arriva al registro che viene scritto (o alla memoria, per la STORE).',
  'proc.singolo.note': 'Con un clock fisso, tarato sull\'istruzione più lenta che hai incontrato ({worst} s a colpo), quei {cycles} colpi avrebbero richiesto {fixed} s: il tuo clock ci ha messo {span} s{gain}.',
  'proc.singolo.gain': ', il {g}% in meno',
  'proc.multiciclo': 'Multi-ciclo', 'proc.multiciclo.short': 'Multi',
  'proc.multiciclo.tag': 'Un passo per colpo: ogni istruzione ha il suo ritmo.',
  'proc.multiciclo.desc': 'Ogni istruzione è divisa in passi, uno per colpo: 4 per le operazioni, 5 per la LOAD, 4 per la STORE. Una sola ALU e una sola memoria, riusate a ogni passo.',
  'proc.multiciclo.howto': 'un colpo per ogni passo dell\'istruzione (4 per le operazioni, 5 per la LOAD, 4 per la STORE): le spie della macchina a stati, sull\'unità di controllo, dicono quali passi restano.',
  'proc.multiciclo.cpi': 'colpi per istruzione (CPI)',
  'proc.pipeline': 'Pipeline', 'proc.pipeline.short': 'Pipeline',
  'proc.pipeline.tag': 'Cinque istruzioni insieme, una per stadio.',
  'proc.pipeline.desc': 'Tra uno stadio e l\'altro c\'è una fila di latch: tocca quando sono tutte verdi. Il processore originale.',
  'proc.mcu': 'Microcontrollore', 'proc.mcu.short': 'MCU',
  'proc.mcu.tag': 'Dorme finché non lo chiami: interrupt, scadenze e batteria.',
  'proc.mcu.desc': 'Quando un piedino si accende (IRQ!) dai il clock alla sua routine prima che scada il tempo. Poi torna a dormire: non toccare, sprecheresti batteria.',
  'proc.mcu.howto': 'dorme finché un piedino non manda un interrupt: allora dai il clock alla routine (la prima battuta preleva il vettore) e finiscila prima della scadenza. Dopo RETI non toccare: mentre dorme ogni colpo spreca batteria, e con la batteria scarica il chip rallenta fino al brown-out.',
  'proc.mcu.asleep': 'DORME!', 'proc.mcu.late': 'IRQ IN RITARDO',
  'proc.mcu.irqs': 'interrupt serviti', 'proc.mcu.overruns': 'scadenze mancate (overrun)', 'proc.mcu.battery': 'batteria rimasta',
  'proc.mcu.wasted': 'colpi a vuoto (dormiva)',
  'proc.gpu': 'GPU', 'proc.gpu.short': 'GPU',
  'proc.gpu.tag': '16 corsie con la stessa istruzione: si aspetta la più lenta.',
  'proc.gpu.desc': 'Ogni colpo manda la stessa istruzione a 16 corsie, ognuna sul suo pixel: tocca quando è arrivata l\'ultima. Ogni riga finisce nel framebuffer e otto righe fanno un frame.',
  'proc.gpu.howto': 'la stessa istruzione va a 16 corsie: tocca quando sono verdi tutte, anche la più lenta. Le righe di pixel compongono un\'immagine sul chip; un glitch lascia pixel sbagliati (artefatti).',
  'proc.gpu.frames': n => (n === 1 ? 'frame completo' : 'frame completi'), 'proc.gpu.artifacts': 'pixel con artefatti',
  'proc.gpu.badFrame': 'FRAME CON ARTEFATTI', 'proc.gpu.badShort': 'ARTEFATTI!',
};

const DICT = { en, it };

// t('chiave', { segnaposto }) — se manca nella lingua scelta si usa l'inglese, se manca anche lì la chiave stessa
export function t(key, vars = {}) {
  const s = DICT[lang][key] ?? en[key];
  if (s === undefined) return key;
  if (typeof s === 'function') return s(vars.n ?? 0, vars);
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// numeri, posizioni e date nella forma della lingua
export const dec = (v, d = 1) => (lang === 'it' ? v.toFixed(d).replace('.', ',') : v.toFixed(d));
export function ord(n) {
  if (lang === 'it') return `${n}°`;
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${s}`;
}
const LOCALE = { en: 'en-GB', it: 'it-IT' };
const asDate = iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const fmtDay = iso => asDate(iso).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtShortDay = iso => asDate(iso).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short' });
