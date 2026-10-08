import { sha256 } from './security.js';
import { tx } from './db.js';

const SEP = '␟';
const GENESIS = 'GENESIS';

function digest(prev, row) {
  return sha256([prev, row.ts, row.user_id ?? '', row.user_name ?? '', row.role ?? '', row.action,
    row.entity ?? '', row.entity_id ?? '', row.detail ?? ''].join(SEP));
}

/**
 * Ajoute une ligne au journal. Chaque ligne contient l'empreinte de la précédente :
 * modifier ou retirer une ancienne ligne casse la chaîne et se voit à la vérification.
 * Ne jamais y mettre de PIN ni de secret.
 */
export function writeAudit(db, ts, actor, action, { entity = null, entityId = null, detail = null } = {}) {
  return tx(db, () => {
    const last = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
    const prev = last ? last.hash : GENESIS;
    const row = {
      ts,
      user_id: actor?.id ?? null,
      user_name: actor?.name ?? null,
      role: actor?.role ?? null,
      action,
      entity,
      entity_id: entityId == null ? null : String(entityId),
      detail: detail == null ? null : JSON.stringify(detail),
    };
    const hash = digest(prev, row);
    db.prepare(`INSERT INTO audit (ts, user_id, user_name, role, action, entity, entity_id, detail, prev_hash, hash)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.ts, row.user_id, row.user_name, row.role, row.action,
      row.entity, row.entity_id, row.detail, prev, hash);
  });
}

/** Relit toute la chaîne. Retourne { ok, count } ou { ok:false, brokenAtId, reason }. */
export function verifyAudit(db) {
  let prev = GENESIS;
  let count = 0;
  let lastId = 0;
  for (const r of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
    if (r.prev_hash !== prev) return { ok: false, count, brokenAtId: r.id, reason: 'Chaînage rompu : une ligne a été retirée ou insérée.' };
    if (digest(prev, r) !== r.hash) return { ok: false, count, brokenAtId: r.id, reason: 'Contenu modifié : l\'empreinte ne correspond plus.' };
    prev = r.hash;
    count++;
    lastId = r.id;
  }
  return { ok: true, count, lastId };
}

export function listAudit(db, { limit = 50, beforeId = null, actionPrefix = null, userId = null } = {}) {
  const where = [];
  const args = [];
  if (beforeId) { where.push('id < ?'); args.push(beforeId); }
  if (actionPrefix) { where.push("action LIKE ? ESCAPE '\\'"); args.push(actionPrefix.replace(/[\\%_]/g, '\\$&') + '%'); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  const sql = `SELECT id, ts, user_id, user_name, role, action, entity, entity_id, detail FROM audit
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit + 1);
  const hasMore = rows.length > limit;
  const out = rows.slice(0, limit).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  return { rows: out, hasMore };
}
