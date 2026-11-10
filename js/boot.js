// Se il gioco non parte (browser vecchio, file non scaricati…) lo si dice, invece di lasciare lo schermo vuoto.
// Script classico, caricato subito dopo il modulo del gioco: non usa import e funziona anche sui browser vecchi.
(function () {
  var it = false;
  try { it = localStorage.getItem('overclock-lang') === 'it'; } catch (e) { /* inglese */ }
  document.documentElement.lang = it ? 'it' : 'en';
  var T = it ? {
    title: 'Il gioco non è partito su questo dispositivo.',
    note: 'Riprova. Se succede ancora, aggiorna il browser o provane un altro.',
    retry: 'Riprova', checking: 'controllo…', ok: 'ok', err: 'errore ', down: 'non raggiungibile',
    files: 'File del gioco', lib: 'Motore 3D (Three.js)',
    old: 'Questo browser è troppo vecchio per il gioco: aggiornalo o prova con un altro.',
    error: 'Errore: ', slow: 'Il gioco non è partito entro 20 secondi.', missing: 'Non sono riuscito a scaricare tutti i file del gioco.'
  } : {
    title: 'The game didn\'t start on this device.',
    note: 'Try again. If it keeps happening, update your browser or try another one.',
    retry: 'Try again', checking: 'checking…', ok: 'ok', err: 'error ', down: 'not reachable',
    files: 'Game files', lib: '3D engine (Three.js)',
    old: 'This browser is too old for the game: update it or try another one.',
    error: 'Error: ', slow: 'The game didn\'t start within 20 seconds.', missing: 'Couldn\'t download all the game files.'
  };
  var veil = document.getElementById('veil'), box = document.getElementById('oops'), done = false;
  document.getElementById('oops-title').textContent = T.title;
  document.getElementById('oops-note').textContent = T.note;
  var retry = document.getElementById('oops-retry');
  retry.textContent = T.retry;
  retry.addEventListener('click', function () { location.reload(); });

  function started() { return veil.classList.contains('gone'); }
  function check(label, url) {
    var li = document.createElement('li'), span = document.createElement('span');
    li.textContent = label + ': ';
    span.textContent = T.checking;
    li.appendChild(span);
    document.getElementById('oops-checks').appendChild(li);
    fetch(url, { cache: 'no-store' }).then(function (r) {
      span.className = r.ok ? 'ok' : 'ko';
      span.textContent = r.ok ? T.ok : T.err + r.status;
    }, function (e) {
      span.className = 'ko';
      span.textContent = T.down + ' (' + ((e && e.message) || e) + ')';
    });
  }
  function fail(why) {
    if (done || started()) return;
    done = true;
    document.getElementById('oops-why').textContent = why;
    box.hidden = false;
    check(T.files, 'js/main.js');
    check(T.lib, 'vendor/three/build/three.module.js');
  }
  new MutationObserver(function () { if (started()) box.hidden = true; }).observe(veil, { attributes: true });   // partito in ritardo
  if (window.HTMLScriptElement && HTMLScriptElement.supports && !HTMLScriptElement.supports('importmap')) fail(T.old);
  var main = document.getElementById('main-js');
  if (main) main.addEventListener('error', function () { fail(T.missing); });
  window.addEventListener('error', function (e) { if (e.message) fail(T.error + e.message); });
  setTimeout(function () { fail(T.slow); }, 20000);
})();
