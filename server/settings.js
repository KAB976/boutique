import { bad } from './errors.js';
import { tx } from './db.js';
import { writeAudit } from './audit.js';
import { can } from './permissions.js';

const LOGO_MAX_BYTES = 300_000;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

const str = (label, max, { min = 0 } = {}) => (v) => {
  if (typeof v !== 'string') throw bad(`« ${label} » doit être un texte.`);
  const t = v.trim();
  if (t.length < min) throw bad(`« ${label} » est obligatoire.`);
  if (t.length > max) throw bad(`« ${label} » est trop long (${max} caractères au maximum).`);
  return t;
};
const num = (label, lo, hi, { int = false } = {}) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`« ${label} » doit être un nombre.`);
  if (int && !Number.isInteger(n)) throw bad(`« ${label} » doit être un nombre entier.`);
  if (n < lo || n > hi) throw bad(`« ${label} » doit être compris entre ${lo} et ${hi}.`);
  return n;
};

/** read : qui peut lire (all | manage | owner). Écriture : propriétaire seulement. */
export const SETTINGS = {
  shop_name:     { label: 'Nom du commerce', def: 'Mon snack', read: 'all', check: str('Nom du commerce', 60, { min: 1 }) },
  address:       { label: 'Adresse', def: '', read: 'all', check: str('Adresse', 200) },
  phone:         { label: 'Téléphone', def: '', read: 'all', check: str('Téléphone', 30) },
  ticket_footer: { label: 'Message en bas du ticket', def: 'Merci de votre visite', read: 'all', check: str('Message du ticket', 200) },
  currency:      { label: 'Symbole de la monnaie', def: '€', read: 'all', check: str('Monnaie', 4, { min: 1 }) },
  timezone: {
    label: 'Fuseau horaire', def: 'Indian/Mayotte', read: 'all',
    check: (v) => {
      const t = str('Fuseau horaire', 64, { min: 1 })(v);
      try { new Intl.DateTimeFormat('fr-FR', { timeZone: t }); } catch { throw bad(`Fuseau horaire inconnu : « ${t} ».`); }
      return t;
    },
  },
  logo: {
    label: 'Logo du ticket', def: '', read: 'all',
    check: (v) => {
      if (v === '' || v === null) return '';
      const m = typeof v === 'string' && LOGO_RE.exec(v);
      if (!m) throw bad('Le logo doit être une image PNG, JPEG ou WebP.');
      const bytes = Math.floor((m[2].length * 3) / 4);
      if (bytes > LOGO_MAX_BYTES) throw bad(`Le logo est trop lourd (${Math.round(bytes / 1000)} ko, maximum ${LOGO_MAX_BYTES / 1000} ko).`);
      return v;
    },
  },
  vat_default:   { label: 'TVA par défaut (%)', def: 0, read: 'manage', check: num('TVA par défaut', 0, 100) },
  target_margin: { label: 'Marge cible par défaut (%)', def: 50, read: 'manage', check: num('Marge cible', 0, 95) },
  price_alert_pct: { label: 'Alerte de hausse de prix (%)', def: 10, read: 'manage', check: num('Alerte de hausse', 1, 500) },
  expiry_alert_days: { label: 'Alerte de péremption (jours avant)', def: 3, read: 'all', check: num('Alerte de péremption', 0, 60, { int: true }) },
  session_hours: { label: "Déconnexion après inactivité (heures)", def: 12, read: 'owner', check: num('Durée de session', 1, 72, { int: true }) },
  backup_keep:   { label: 'Sauvegardes automatiques conservées', def: 30, read: 'owner', check: num('Sauvegardes conservées', 7, 365, { int: true }) },
};

const readPerm = { all: 'settings.read.all', manage: 'settings.read.manage', owner: 'settings.read.owner' };

function allValues(db) {
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS)) out[k] = s.def;
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in SETTINGS) out[r.key] = JSON.parse(r.value);
  }
  return out;
}

/** Valeur interne (serveur), sans filtre de rôle. */
export const getSetting = (db, key) => allValues(db)[key];
export const getAllSettings = (db) => allValues(db);

/** Réglages visibles pour un rôle donné. */
export function settingsFor(db, role) {
  const all = allValues(db);
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS)) {
    if (can(role, readPerm[s.read])) out[k] = all[k];
  }
  return out;
}

export function settingsMeta(role) {
  return Object.fromEntries(Object.entries(SETTINGS)
    .filter(([, s]) => can(role, readPerm[s.read]))
    .map(([k, s]) => [k, { label: s.label, read: s.read }]));
}

/** Valide puis enregistre. Tout ou rien. Retourne la liste des changements. */
export function updateSettings(db, ts, actor, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Réglages invalides.');
  const entries = Object.entries(patch);
  if (!entries.length) throw bad('Aucun réglage à enregistrer.');
  const clean = {};
  for (const [k, v] of entries) {
    if (!(k in SETTINGS)) throw bad(`Réglage inconnu : « ${k} ».`);
    clean[k] = SETTINGS[k].check(v);
  }
  return tx(db, () => {
    const before = allValues(db);
    const changes = {};
    for (const [k, v] of Object.entries(clean)) {
      if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(k, JSON.stringify(v), ts);
      changes[k] = k === 'logo'
        ? { from: before[k] ? 'logo présent' : 'aucun', to: v ? 'logo présent' : 'aucun' }
        : { from: before[k], to: v };
    }
    if (Object.keys(changes).length) {
      writeAudit(db, ts, actor, 'settings.update', { entity: 'settings', detail: changes });
    }
    return changes;
  });
}
