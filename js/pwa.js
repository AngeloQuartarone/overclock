// L'app installabile: il service worker tiene i file del gioco, così si gioca anche offline.
// Funziona solo nelle pagine sicure (HTTPS o localhost): in http sulla rete locale il gioco va lo stesso, senza.
let prompt = null;
const listeners = new Set();

if ('serviceWorker' in navigator && isSecureContext) {
  addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* si gioca online */ }); });
}
// il browser propone l'installazione: la teniamo per il pulsante nelle Impostazioni
addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; listeners.forEach(f => f()); });
addEventListener('appinstalled', () => { prompt = null; listeners.forEach(f => f()); });

export const canInstall = () => !!prompt;
export const onInstallChange = f => listeners.add(f);
export async function install() {
  if (!prompt) return false;
  const p = prompt;
  prompt = null;
  await p.prompt();
  const r = await p.userChoice.catch(() => null);
  listeners.forEach(f => f());
  return r?.outcome === 'accepted';
}
