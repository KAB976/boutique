// Quart de caisse : état partagé par la Caisse, la Clôture et l'en-tête.
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { cache } from './offline.js';

let state = null; let uid = null; const subs = new Set();
const emit = () => subs.forEach((f) => f({ s: state, uid }));
export const nav = { sub: null }; // pour ouvrir directement « Fermer mon quart » depuis la caisse

export async function loadShift(me) {
  try {
    const s = await api.get('/api/shift/current');
    state = { ...s, offline: false }; uid = me?.id ?? uid; cache.set('shift', { ...s, uid });
  } catch (e) {
    if (e.code === 'network') {
      if (!state) { const c = cache.get('shift'); if (c && c.uid === me?.id) { state = { ...c, offline: true }; uid = c.uid; } }
      else state = { ...state, offline: true };
    }
  }
  emit();
}
export function resetShift() { state = null; uid = null; cache.del('shift'); emit(); }

export function useShift(me) {
  const [v, setV] = useState({ s: state, uid });
  useEffect(() => {
    subs.add(setV);
    loadShift(me);
    const t = setInterval(() => loadShift(me), 30_000);
    return () => { subs.delete(setV); clearInterval(t); };
  }, [me?.id]); // eslint-disable-line
  return v.uid === me?.id || v.uid == null ? v.s : null;
}
