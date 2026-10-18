// File d'attente des ventes faites sans réseau. Stockée dans le navigateur de la caisse, envoyée dès que le réseau revient.
// Chaque vente a un identifiant unique : l'envoyer deux fois ne la crée jamais deux fois.
import { api } from './api.js';

const K = { queue: 'boutique.queue', failed: 'boutique.failed', catalog: 'boutique.catalog', seq: 'boutique.seq', dev: 'boutique.dev', ticket: 'boutique.ticketinfo', me: 'boutique.me', pub: 'boutique.pub' };
const mem = {};
function read(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return k in mem ? mem[k] : d; } }
function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { mem[k] = v; } }

export const cache = {
  get: (name, d = null) => read(K[name], d),
  set: (name, v) => write(K[name], v),
  del: (name) => { try { localStorage.removeItem(K[name]); } catch { delete mem[K[name]]; } },
};

export const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 8)}`);
export function deviceCode() {
  let d = read(K.dev, null);
  if (!d) { d = Math.random().toString(36).slice(2, 5).toUpperCase(); write(K.dev, d); }
  return d;
}
export function nextProvisional() {
  const n = (read(K.seq, 0) || 0) + 1; write(K.seq, n);
  return `H${deviceCode()}-${String(n).padStart(3, '0')}`;
}

const listeners = new Set();
export const onQueueChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => f());

export const queue = () => read(K.queue, []);
export const failed = () => read(K.failed, []);
export function enqueue(sale) { write(K.queue, [...queue(), sale]); emit(); }
export function dismissFailed(uuid) { write(K.failed, failed().filter((s) => s.client_uuid !== uuid)); emit(); }

let syncing = false;
/** Envoie tout ce qui attend. Retourne { sent, failed, left } ou null si déjà en cours / rien à faire. */
export async function syncNow() {
  if (syncing) return null;
  const q = queue();
  if (!q.length) return null;
  syncing = true;
  try {
    let res;
    try { res = await api.post('/api/sales/sync', { sales: q }); } catch (e) { return { sent: 0, failed: 0, left: q.length, error: e.message, network: e.code === 'network', auth: e.status === 401 }; }
    const byId = new Map(res.results.map((r) => [r.client_uuid, r]));
    const keep = [], bad = [];
    for (const s of q) {
      const r = byId.get(s.client_uuid);
      if (r?.ok) continue;
      if (r) bad.push({ ...s, error: r.error, code: r.code, failed_at: new Date().toISOString() });
      else keep.push(s);
    }
    write(K.queue, keep);
    if (bad.length) write(K.failed, [...failed(), ...bad]);
    emit();
    return { sent: q.length - keep.length - bad.length, failed: bad.length, left: keep.length };
  } finally { syncing = false; }
}
