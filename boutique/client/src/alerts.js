// Sons d'alerte et notifications du téléphone.
import { api } from './api.js';

const SOUND_KEY = 'boutique.sound';
const PUSH_KEY = 'boutique.push';
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* navigation privée */ } },
};

// ---------- son ----------
let actx = null;
const listeners = new Set();
export const soundOn = () => ls.get(SOUND_KEY) !== 'off';
export const setSoundOn = (on) => { ls.set(SOUND_KEY, on ? 'on' : 'off'); listeners.forEach((f) => f()); };
export const onAudioChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

function ctx() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; try { actx = new C(); } catch { return null; } }
  return actx;
}
/** Le navigateur n'autorise le son qu'après un toucher : on le débloque au premier toucher. */
export function unlockAudio() {
  const c = ctx(); if (!c) return false;
  if (c.state !== 'running') c.resume().then(() => listeners.forEach((f) => f())).catch(() => {});
  return c.state === 'running';
}
export const audioReady = () => Boolean(actx && actx.state === 'running');
if (typeof window !== 'undefined') {
  const once = () => { unlockAudio(); };
  window.addEventListener('pointerdown', once, { passive: true });
  window.addEventListener('keydown', once);
}

function tone(c, t0, freq, dur, vol = 0.5, type = 'sine') {
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.05);
}
/** kind : 'new' (nouvelle commande en cuisine), 'ready' (commande prête), 'cancel'. Renvoie false si le son est coupé ou bloqué. */
export function playSound(kind) {
  if (!soundOn()) return false;
  const c = ctx(); if (!c || c.state !== 'running') return false;
  const t = c.currentTime + 0.02;
  if (kind === 'new') { tone(c, t, 880, 0.35, 0.6, 'triangle'); tone(c, t + 0.4, 660, 0.35, 0.6, 'triangle'); tone(c, t + 0.8, 880, 0.5, 0.6, 'triangle'); }
  else if (kind === 'ready') { [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.16, f, 0.28, 0.55, 'sine')); }
  else tone(c, t, 300, 0.6, 0.5, 'square');
  try { navigator.vibrate?.(kind === 'ready' ? [250, 100, 250, 100, 250] : [200, 100, 200]); } catch { /* non supporté */ }
  return true;
}

// ---------- notifications du téléphone (push) ----------
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const deviceName = () => {
  const u = navigator.userAgent;
  const os = /Android/.test(u) ? 'Android' : isIos() ? 'iPhone/iPad' : /Windows/.test(u) ? 'Windows' : /Mac/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Appareil';
  const br = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  return `${os} ${br}`.trim();
};

/** 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on' */
export async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  if (isIos() && !standalone()) return 'ios-install';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || ls.get(PUSH_KEY) !== '1') return 'off';
  try { const reg = await navigator.serviceWorker.ready; return (await reg.pushManager.getSubscription()) ? 'on' : 'off'; } catch { return 'off'; }
}

async function subscribeOnServer() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api.get('/api/push/key');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
  }
  const j = sub.toJSON();
  await api.post('/api/push/subscribe', { endpoint: j.endpoint, keys: j.keys, device: deviceName() });
  return sub;
}

/** À appeler suite à un toucher de l'utilisateur. Renvoie { ok } ou { error }. */
export async function enablePush() {
  try {
    unlockAudio();
    const st = await pushState();
    if (st === 'unsupported') return { error: 'Ce navigateur ne sait pas recevoir de notifications.' };
    if (st === 'ios-install') return { error: 'Sur iPhone/iPad : ouvrez le menu Partager de Safari, choisissez « Sur l’écran d’accueil », puis ouvrez l’application depuis cette icône.' };
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { error: 'Notifications refusées. Autorisez-les dans les réglages du navigateur pour ce site, puis recommencez.' };
    await subscribeOnServer();
    ls.set(PUSH_KEY, '1');
    return { ok: true };
  } catch (e) { return { error: e.message || 'Impossible d’activer les notifications.' }; }
}

export async function disablePush() {
  try {
    ls.set(PUSH_KEY, null);
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { try { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* serveur injoignable */ } await sub.unsubscribe(); }
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

/** Après une connexion : si cet appareil avait activé les notifications, on les rattache à la personne qui vient de se connecter. */
export async function resyncPush() {
  try { if (ls.get(PUSH_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted') await subscribeOnServer(); } catch { /* sans réseau : au prochain démarrage */ }
}
/** Avant une déconnexion : cet appareil ne doit plus recevoir les notifications de cette personne. */
export async function detachPush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
  } catch { /* tant pis */ }
}
export const testPush = () => api.post('/api/push/test');
