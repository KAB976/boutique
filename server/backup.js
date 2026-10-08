import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_VERSION } from './db.js';
import { bad, notFound } from './errors.js';

const NAME_RE = /^(auto|manuelle|avant-restauration|import)-(\d{8})-(\d{6})(?:-(\d+))?\.db$/;
export const KINDS = ['auto', 'manuelle', 'avant-restauration', 'import'];
export const KIND_LABELS = { auto: 'Automatique', manuelle: 'Manuelle', 'avant-restauration': 'Avant restauration', import: 'Importée' };

const pad = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function parseName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, kind, ymd, hms] = m;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}Z`;
  return { kind, createdAt: iso };
}

/** Garde-fou contre les chemins piégés : seul un nom exact du format ci-dessus est accepté. */
export function safeName(name) {
  if (typeof name !== 'string' || !parseName(name)) throw bad('Nom de sauvegarde invalide.');
  return name;
}

export const dayIn = (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export function listBackups(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir)
    .map((name) => {
      const p = parseName(name);
      if (!p) return null;
      return { name, kind: p.kind, createdAt: p.createdAt, size: fs.statSync(path.join(dir, name)).size };
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.name < b.name ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
}

/** Copie cohérente de la base pendant son utilisation (VACUUM INTO), puis contrôle de la copie. */
export function reserveName(dir, kind, now = new Date()) {
  if (!KINDS.includes(kind)) throw new Error(`Type de sauvegarde inconnu : ${kind}`);
  fs.mkdirSync(dir, { recursive: true });
  let name, n = 0;
  do {
    name = `${kind}-${stamp(now)}${n ? `-${n}` : ''}.db`;
    n++;
  } while (fs.existsSync(path.join(dir, name)));
  return name;
}

export function createBackup(db, dir, kind, now = new Date()) {
  const name = reserveName(dir, kind, now);
  const target = path.join(dir, name);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const check = verifyBackupFile(target);
  if (!check.ok) {
    fs.rmSync(target, { force: true });
    throw new Error(`La sauvegarde créée est illisible : ${check.reason}`);
  }
  return { name, kind, createdAt: parseName(name).createdAt, size: fs.statSync(target).size };
}

/** Ouvre le fichier en lecture seule et vérifie qu'il s'agit bien d'une base de cette application. */
export function verifyBackupFile(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const ic = db.prepare('PRAGMA integrity_check').all();
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') return { ok: false, reason: 'Le fichier est abîmé (contrôle d\'intégrité échoué).' };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of ['schema_version', 'users', 'audit', 'settings']) {
      if (!tables.has(t)) return { ok: false, reason: `Ce fichier n'est pas une sauvegarde de cette application (table « ${t} » absente).` };
    }
    const v = db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_version').get().v;
    if (v > LATEST_VERSION) return { ok: false, reason: `Sauvegarde faite par une version plus récente du programme (${v} > ${LATEST_VERSION}).` };
    const users = db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 1').get().c;
    return { ok: true, version: v, activeUsers: users };
  } catch (e) {
    return { ok: false, reason: `Fichier illisible : ${e.message}` };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function backupPath(dir, name) {
  safeName(name);
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) throw notFound('Sauvegarde introuvable.');
  return p;
}

/** Supprime les plus anciennes sauvegardes d'un type au-delà de la limite. Les manuelles ne sont jamais supprimées. */
export function prune(dir, limits) {
  const removed = [];
  for (const [kind, keep] of Object.entries(limits)) {
    const mine = listBackups(dir).filter((b) => b.kind === kind);
    for (const b of mine.slice(keep)) {
      fs.rmSync(path.join(dir, b.name), { force: true });
      removed.push(b.name);
    }
  }
  return removed;
}
