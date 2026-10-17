/**
 * Vérification des caisses par l'administrateur.
 * Le caissier ferme « à l'aveugle » : il compte, verse, laisse un fond, sans connaître le montant attendu.
 * C'est ici que l'on compare ce qui devait être en caisse (ventes en espèces, sorties, versements)
 * à ce qui a été réellement versé, et que l'on valide ou non l'écart.
 */
import { tx } from './db.js';
import { bad, conflict, forbidden, notFound } from './errors.js';
import { writeAudit } from './audit.js';
import { can } from './permissions.js';
import { text } from './common.js';
import { getSetting } from './settings.js';
import { closureView, closurePreview } from './sales.js';
import { currentShift, shiftView, refCategory, DEPOSIT } from './shifts.js';

const CLOSING = 'Dépôt à la clôture';
const sum = (a) => a.reduce((t, x) => t + x, 0);

/** Tout ce qu'il faut pour vérifier une clôture, calculé depuis les écritures (jamais saisi à la main). */
export function closureDetail(db, id) {
  const c = closureView(db, id);
  if (!c) return null;
  const prev = db.prepare('SELECT to_cash_move_id FROM closures WHERE id < ? ORDER BY id DESC LIMIT 1').get(id);
  const moves = db.prepare('SELECT * FROM cash_moves WHERE id > ? AND id <= ? ORDER BY id').all(prev?.to_cash_move_id ?? 0, c.to_cash_move_id)
    .map((m) => ({ ts: m.ts, amount_cents: m.amount_cents, reason: m.reason, category: refCategory(m), user_name: m.user_name }));
  const versements = moves.filter((m) => m.category === DEPOSIT).map((m, i) => ({ number: i + 1, ts: m.ts, amount_cents: -m.amount_cents, note: m.reason }));
  const closing = moves.filter((m) => m.category === CLOSING);
  const others = moves.filter((m) => m.category !== DEPOSIT && m.category !== CLOSING);
  const cashSales = c.by_method.cash ?? 0;
  const versed = sum(versements.map((v) => v.amount_cents));
  const late = c.float_in_cents + cashSales + sum(others.map((m) => m.amount_cents)) - versed - c.cash_expected_cents;
  const closingDeposit = -sum(closing.map((m) => m.amount_cents));
  const rv = db.prepare('SELECT reviewed_at, reviewer_name, variance_cents, note FROM cash_reviews WHERE closure_id = ?').get(id) ?? null;
  return {
    ...c, moves: others, versements, versed_cents: versed, closing_deposit_cents: closingDeposit, handed_total_cents: versed + closingDeposit,
    cash_sales_cents: cashSales, late_cash_cents: late, review: rv,
  };
}

/**
 * Seuil d'espèces : au-delà de « cash_alert_eur » (hors fond de caisse du départ), le caissier doit verser ce montant.
 * Rien n'est bloqué : le rappel revient régulièrement tant que le versement n'est pas fait.
 */
export function depositDue(db) {
  const s = currentShift(db);
  const limit = Math.round(Number(getSetting(db, 'cash_alert_eur')) * 100);
  if (!s || !(limit > 0)) return { shift: s, due_cents: 0, limit };
  const pv = closurePreview(db);
  const over = pv.cash_expected_cents - s.opening_counted_cents > limit;
  return { shift: s, due_cents: over ? limit : 0, limit, expected: pv.cash_expected_cents };
}
const REMIND_EVERY_MS = 10 * 60 * 1000;
/** À appeler après chaque vente et chaque minute : prévient le caissier (écran + téléphone), puis le relance toutes les 10 minutes. */
export function cashReminderTick(ctx) {
  const d = depositDue(ctx.db);
  const memo = (ctx._cashRemind ||= new Map());
  if (!d.shift || !d.due_cents) { if (d.shift) memo.delete(d.shift.id); return false; }
  const now = ctx.now().getTime(); const last = memo.get(d.shift.id);
  if (last && now - last < REMIND_EVERY_MS) return false;
  memo.set(d.shift.id, now);
  ctx.push?.notify([d.shift.user_id], { title: '💶 Versement à faire', body: `Il y a trop d'espèces dans le tiroir : versez ${(d.due_cents / 100).toFixed(2).replace('.', ',')} € à l'administrateur.`, tag: 'deposit-due', url: '/' }).catch?.(() => {});
  return true;
}

const dayRe = /^\d{4}-\d{2}-\d{2}$/;

export function reviewOverview(ctx, q) {
  const db = ctx.db;
  const to = dayRe.test(q?.to ?? '') ? q.to : null;
  const from = dayRe.test(q?.from ?? '') ? q.from : null;
  const rows = db.prepare('SELECT id, day FROM closures WHERE (? IS NULL OR day >= ?) AND (? IS NULL OR day <= ?) ORDER BY id DESC LIMIT 200').all(from, from, to, to);
  const byDay = new Map();
  for (const r of rows) {
    const d = closureDetail(db, r.id);
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(d);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, items]) => ({
    day, items: items.reverse(),
    totals: {
      shifts: items.length,
      cash_sales_cents: sum(items.map((x) => x.cash_sales_cents)),
      card_cents: sum(items.map((x) => x.by_method.card ?? 0)),
      sales_cents: sum(items.map((x) => x.sales_cents - x.refunds_cents)),
      expected_cents: sum(items.map((x) => x.cash_expected_cents)),
      counted_cents: sum(items.map((x) => x.cash_counted_cents)),
      variance_cents: sum(items.map((x) => x.variance_cents)),
      handed_cents: sum(items.map((x) => x.handed_total_cents)),
      pending: items.filter((x) => !x.review).length,
    },
  }));
  const s = currentShift(db);
  let live = null;
  if (s) {
    const pv = closurePreview(db);
    const dd = depositDue(db); const limit = dd.limit;
    live = {
      shift: shiftView(db, s.id), expected_now_cents: pv.cash_expected_cents, cash_sales_cents: pv.by_method.cash ?? 0, card_cents: pv.by_method.card ?? 0,
      sales_cents: pv.sales_cents - pv.refunds_cents, deposits: pv.deposits, deposits_cents: pv.deposits_cents,
      alert_cents: limit, over: dd.due_cents > 0, in_drawer_cents: pv.cash_expected_cents - s.opening_counted_cents,
    };
  }
  return { days, live, pending_total: db.prepare('SELECT COUNT(*) AS c FROM closures c WHERE NOT EXISTS (SELECT 1 FROM cash_reviews r WHERE r.closure_id = c.id)').get().c };
}

export function validateClosure(ctx, user, id, body) {
  const db = ctx.db; const actor = { id: user.id, name: user.name, role: user.role };
  if (!can(actor.role, 'cash.review')) throw forbidden();
  const note = text(body?.note ?? '', 'Note', { max: 300 });
  return tx(db, () => {
    const c = db.prepare('SELECT * FROM closures WHERE id = ?').get(id);
    if (!c) throw notFound('Clôture introuvable.');
    if (db.prepare('SELECT 1 FROM cash_reviews WHERE closure_id = ?').get(id)) throw conflict('Cette caisse est déjà vérifiée.', 'already_reviewed');
    if (c.user_id === actor.id && actor.role !== 'owner') throw conflict('Vous ne pouvez pas vérifier votre propre caisse : demandez au propriétaire.', 'self_review');
    if (c.variance_cents !== 0 && note.length < 3) throw bad('Il y a un écart : écrivez votre conclusion dans la note avant de valider.', 'review_note');
    const ts = ctx.now().toISOString();
    db.prepare('INSERT INTO cash_reviews (closure_id, reviewed_at, reviewer_id, reviewer_name, variance_cents, note) VALUES (?,?,?,?,?,?)').run(id, ts, actor.id, actor.name, c.variance_cents, note);
    writeAudit(db, ts, actor, 'cash.review', { entity: 'closure', entityId: id, detail: { number: c.number, variance_cents: c.variance_cents, cashier: c.user_name, note: note || undefined } });
    return closureDetail(db, id);
  });
}
