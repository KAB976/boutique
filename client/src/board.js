// Suivi en direct des commandes de la cuisine : tourne dans toute l'application, donc la caisse sonne aussi.
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { playSound, soundOn, audioReady, onAudioChange } from './alerts.js';

const state = { data: null, error: '', offline: false, loading: false };
const subs = new Set();
const emit = () => subs.forEach((f) => f({ ...state }));
let timer = null; let ringTimer = null; let me = null; let seen = null; let lastRing = { new: 0, ready: 0 };

export const boardState = () => ({ ...state });
export function useBoard() {
  const [s, setS] = useState(boardState());
  useEffect(() => { subs.add(setS); setS(boardState()); return () => subs.delete(setS); }, []);
  return s;
}
export function useAudioReady() {
  const [v, setV] = useState(audioReady());
  useEffect(() => { const off = onAudioChange(() => setV(audioReady())); const t = setInterval(() => setV(audioReady()), 1500); return () => { off(); clearInterval(t); }; }, []);
  return v;
}

const can = (perm) => Boolean(me?.permissions?.includes(perm));
/** Ce qui doit faire du bruit maintenant. */
export function pendingAlerts(data = state.data) {
  const act = data?.active ?? [];
  return {
    newOrders: can('orders.kitchen') ? act.filter((o) => o.status === 'sent' && o.has_kitchen) : [],
    ready: can('orders.serve') ? act.filter((o) => o.status === 'ready') : [],
    mineReady: can('orders.serve') ? act.filter((o) => o.status === 'ready' && o.user_id === me?.id) : [],
  };
}

function diff(prev, next) {
  const was = new Map((prev?.active ?? []).map((o) => [o.id, o.status]));
  const fresh = []; const becameReady = []; const cancelled = [];
  for (const o of next.active) {
    const w = was.get(o.id);
    if (w === undefined && o.status === 'sent') fresh.push(o);
    if (o.status === 'ready' && w !== 'ready') becameReady.push(o);
  }
  const still = new Set(next.active.map((o) => o.id));
  for (const [id, st] of was) if (!still.has(id) && st !== 'ready') cancelled.push(id);
  return { fresh, becameReady, cancelled };
}

async function poll() {
  if (!me || state.loading) return;
  state.loading = true;
  try {
    const data = await api.get('/api/orders/board');
    const first = seen === null;
    const d = first ? { fresh: [], becameReady: [], cancelled: [] } : diff(state.data, data);
    state.data = data; state.error = ''; state.offline = false; seen = true;
    if (d.fresh.some((o) => o.has_kitchen) && can('orders.kitchen')) { playSound('new'); lastRing.new = Date.now(); }
    const mine = d.becameReady.filter((o) => can('orders.serve'));
    if (mine.length) { playSound('ready'); lastRing.ready = Date.now(); }
  } catch (e) {
    if (e.code === 'network') state.offline = true; else state.error = e.message;
  } finally { state.loading = false; updateBadge(); emit(); }
}

function updateBadge() {
  const a = pendingAlerts(); const n = a.newOrders.length + a.ready.length;
  try {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = n > 0 ? `(${n}) ${base}` : base;
    if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.();
  } catch { /* non supporté */ }
}

/** Sonnerie qui se répète tant qu'une commande attend (cuisine : nouvelle commande ; salle : commande prête qu'on a prise). */
function ring() {
  if (!soundOn() || !audioReady() || document.visibilityState === 'hidden') return;
  const a = pendingAlerts(); const now = Date.now();
  if (a.newOrders.length && now - lastRing.new > 8000) { playSound('new'); lastRing.new = now; }
  else if (a.mineReady.length && now - lastRing.ready > 20000) { playSound('ready'); lastRing.ready = now; }
}

const onMsg = (e) => { if (e.data?.type === 'push') poll(); if (e.data?.type === 'open') window.dispatchEvent(new CustomEvent('boutique:open', { detail: e.data.url })); };
const onVis = () => { if (document.visibilityState === 'visible') poll(); };

export function startBoard(user) {
  stopBoard(); me = user; seen = null; state.data = null; state.error = ''; state.offline = false;
  if (!can('orders.view')) return;
  poll();
  timer = setInterval(poll, 4000);
  ringTimer = setInterval(ring, 2000);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', poll);
  navigator.serviceWorker?.addEventListener('message', onMsg);
}
export function stopBoard() {
  clearInterval(timer); clearInterval(ringTimer); timer = ringTimer = null; me = null;
  document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', poll);
  navigator.serviceWorker?.removeEventListener('message', onMsg);
  state.data = null; try { navigator.clearAppBadge?.(); } catch { /* ok */ }
}
export const refreshBoard = () => poll();
