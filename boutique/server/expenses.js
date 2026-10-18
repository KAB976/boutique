import { tx } from './db.js';
import { assertDrawer } from './shifts.js';
import { bad, notFound, conflict } from './errors.js';
import { writeAudit } from './audit.js';
import { cents, text } from './common.js';

export const EXPENSE_CATEGORIES = ['Loyer', 'Électricité / eau', 'Gaz', 'Salaires', 'Emballages', 'Entretien / réparations', 'Transport', 'Assurance / taxes', 'Publicité', 'Autre'];

export function createExpense(db, ts, day, actor, b) {
  const category = text(b?.category, 'Catégorie', { max: 40, min: 1 });
  const label = text(b?.label, 'Libellé', { max: 120, min: 1 });
  const amount = cents(b?.amount_cents, 'Montant', { min: 1 });
  return tx(db, () => {
    const r = db.prepare('INSERT INTO expenses (ts, day, category, label, amount_cents, user_name) VALUES (?,?,?,?,?,?)').run(ts, day, category, label, amount, actor?.name ?? null);
    const id = Number(r.lastInsertRowid);
    if (b.from_drawer) {
      assertDrawer(db, actor);
      db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?)').run(ts, day, -amount, `Dépense — ${label}`, `expense:${id}`, actor?.id ?? null, actor?.name ?? null);
    }
    writeAudit(db, ts, actor, 'expense.create', { entity: 'expense', entityId: id, detail: { category, label, amount_cents: amount, from_drawer: Boolean(b.from_drawer) } });
    return id;
  });
}

export function voidExpense(db, ts, day, actor, id, reason) {
  const why = text(reason, 'Motif', { max: 200, min: 1 });
  return tx(db, () => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!e) throw notFound('Dépense introuvable.');
    if (e.voided_at) throw conflict('Cette dépense est déjà annulée.', 'already_voided');
    db.prepare('UPDATE expenses SET voided_at = ?, void_reason = ? WHERE id = ?').run(ts, why, id);
    if (db.prepare('SELECT 1 FROM cash_moves WHERE ref = ?').get(`expense:${id}`)) {
      assertDrawer(db, actor);
      db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?)').run(ts, day, e.amount_cents, `Annulation de dépense — ${e.label}`, `expense-void:${id}`, actor?.id ?? null, actor?.name ?? null);
    }
    writeAudit(db, ts, actor, 'expense.void', { entity: 'expense', entityId: id, detail: { label: e.label, amount_cents: e.amount_cents, reason: why } });
  });
}
