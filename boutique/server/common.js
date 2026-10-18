import { bad } from './errors.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // Express 4 n'attrape pas les erreurs des fonctions asynchrones
export const intId = (v, label = 'Identifiant') => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw bad(`${label} invalide.`); return n; };

/** Montant en centimes : entier uniquement. */
export function cents(v, label = 'Montant', { min = 0, max = 100_000_000, nullable = false } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw bad(`${label} : montant invalide.`);
  if (n < min) throw bad(`${label} : ne peut pas être inférieur à ${min / 100}.`);
  if (n > max) throw bad(`${label} : montant trop grand.`);
  return n;
}

export function text(v, label, { max = 200, min = 0, nullable = false } = {}) {
  if ((v === null || v === undefined) && (nullable || min === 0)) return nullable ? null : '';
  if (typeof v !== 'string') throw bad(`« ${label} » doit être un texte.`);
  const t = v.trim().replace(/\s+/g, ' ');
  if (t.length < min) throw bad(`« ${label} » est obligatoire.`);
  if (t.length > max) throw bad(`« ${label} » est trop long (${max} caractères au maximum).`);
  return t;
}

export function number(v, label, { min = -Infinity, max = Infinity, int = false, exclusiveMin = false } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`« ${label} » doit être un nombre.`);
  if (int && !Number.isInteger(n)) throw bad(`« ${label} » doit être un nombre entier.`);
  if (exclusiveMin ? n <= min : n < min) throw bad(`« ${label} » doit être ${exclusiveMin ? 'supérieur' : 'supérieur ou égal'} à ${min}.`);
  if (n > max) throw bad(`« ${label} » est trop grand (maximum ${max}).`);
  return n;
}

export function dateStr(v, label = 'Date', { nullable = false } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw bad(`${label} invalide (format AAAA-MM-JJ).`);
  }
  return v;
}

/** Prochain numéro : compteur par nom (ex. V20261007 → V20261007-0001). */
export function nextNumber(db, name, prefix, { pad = 4, datePart = null } = {}) {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name);
  const n = db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
  return `${prefix}${datePart ? datePart.replaceAll('-', '') : ''}-${String(n).padStart(pad, '0')}`;
}

/** Répartit `total` (centimes, entier) au prorata de `weights`, au plus grand reste : la somme est exacte. */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

/** Part de TVA contenue dans un montant TTC (centimes). */
export const vatOf = (ttcCents, pct) => (pct > 0 ? Math.round((ttcCents * pct) / (100 + pct)) : 0);

export const round2 = (x) => Math.round(x * 100) / 100;
