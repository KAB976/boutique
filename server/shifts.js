/**
 * Quart de caisse : une personne, un tiroir, un moment.
 * - On ouvre son quart avec son code PIN et on compte le fond de caisse laissé par la personne d'avant.
 * - Tant qu'un quart est ouvert, seule la personne qui l'a ouvert encaisse (le gérant peut le fermer à sa place).
 * - Fermer le quart = la clôture de caisse (comptage, écart, fond laissé, dépôt), avec le code PIN.
 * Le réglage « require_shift » (oui par défaut) rend l'ouverture obligatoire pour encaisser.
 */
import { tx } from './db.js';
import { bad, conflict, forbidden, HttpError } from './errors.js';
import { writeAudit } from './audit.js';
import { verifyPin, burnTime } from './security.js';
import { can } from './permissions.js';
import { cents, text, nextNumber } from './common.js';
import { getSetting } from './settings.js';
import { dayIn } from './backup.js';

const LOCK_AFTER = 5; const LOCK_SECONDS = 60; // comme à la connexion

export const shiftRequired = (db) => Number(getSetting(db, 'require_shift')) === 1;
export const currentShift = (db) => db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL').get() ?? null;

export const CASH_OUT_REASONS = ['Dépôt en banque', 'Achat de marchandises', 'Paiement fournisseur', 'Remboursement client', 'Retrait / avance', 'Autre'];
export const CASH_IN_REASONS = ['Ajout de fond de caisse', 'Monnaie / change', 'Autre'];
export const DEPOSIT = 'Versement';
export const refCategory = (m) => {
  if (m.category) return m.category;
  const r = m.ref || '';
  if (r.startsWith('ledger:')) return 'Règlement d’ardoise';
  if (r.startsWith('catering:')) return 'Traiteur';
  if (r.startsWith('expense')) return 'Dépense';
  if (r.startsWith('supplier:')) return 'Paiement fournisseur';
  if (r.startsWith('Z-')) return 'Dépôt à la clôture';
  return '';
};

const hhmm = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }); } catch { return ''; } };

/** Pour encaisser ou annuler une vente : le quart ouvert doit être celui de la personne. */
export function assertSeller(ctx, actor) {
  const db = ctx.db;
  if (!shiftRequired(db)) return null;
  const s = currentShift(db);
  if (!s) throw conflict('Ouvrez votre quart de caisse avant d’encaisser (onglet Caisse).', 'no_shift');
  if (s.user_id !== actor?.id) {
    throw conflict(`Le quart de ${s.user_name} est ouvert depuis ${hhmm(s.opened_at, ctx.tz?.())}. ${s.user_name} doit le fermer (ou le gérant) avant que vous encaissiez.`, 'shift_other', { shift: { number: s.number, user_name: s.user_name } });
  }
  return s;
}
/** Pour tout mouvement d'espèces du tiroir (dépense, règlement…) : il faut un quart ouvert, quel qu'en soit le titulaire. */
export function assertDrawer(db, actor) {
  if (!shiftRequired(db)) return null;
  const s = currentShift(db);
  if (!s) throw conflict('Aucun quart de caisse ouvert : ouvrez le quart avant de toucher aux espèces du tiroir.', 'no_shift');
  return s;
}

/** Vérifie le code PIN de la personne connectée (mêmes blocages qu'à la connexion). */
export function confirmPin(ctx, user, pin) {
  const db = ctx.db; const nowMs = ctx.now().getTime();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (u.locked_until && Date.parse(u.locked_until) > nowMs) {
    const wait = Math.ceil((Date.parse(u.locked_until) - nowMs) / 1000);
    throw new HttpError(429, 'locked', `Compte bloqué après trop d'erreurs. Réessayez dans ${wait} s.`, { retryAfter: wait });
  }
  if (typeof pin !== 'string' || !pin) { burnTime(pin); throw bad('Tapez votre code PIN pour confirmer.', 'pin_required'); }
  if (verifyPin(pin, u.pin_hash)) { if (u.failed_count) db.prepare('UPDATE users SET failed_count = 0 WHERE id = ?').run(u.id); return; }
  const failed = u.failed_count + 1; const t = ctx.now().toISOString();
  tx(db, () => {
    if (failed >= LOCK_AFTER) {
      db.prepare('UPDATE users SET failed_count = 0, locked_until = ? WHERE id = ?').run(new Date(nowMs + LOCK_SECONDS * 1000).toISOString(), u.id);
      writeAudit(db, t, { id: u.id, name: u.name, role: u.role }, 'auth.locked', { entity: 'user', entityId: u.id, detail: { name: u.name, seconds: LOCK_SECONDS, context: 'quart' } });
    } else db.prepare('UPDATE users SET failed_count = ? WHERE id = ?').run(failed, u.id);
  });
  if (failed >= LOCK_AFTER) throw new HttpError(429, 'locked', `Trop d'erreurs : compte bloqué ${LOCK_SECONDS} secondes.`, { retryAfter: LOCK_SECONDS });
  throw new HttpError(403, 'bad_pin', `Code PIN incorrect. Il reste ${LOCK_AFTER - failed} essai${LOCK_AFTER - failed > 1 ? 's' : ''}.`);
}

export function shiftView(db, id) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  if (!s) return null;
  const closure = s.closure_id ? db.prepare('SELECT number, variance_cents, float_out_cents, cash_expected_cents, cash_counted_cents, sales_cents, refunds_cents, sales_count FROM closures WHERE id = ?').get(s.closure_id) : null;
  return { ...s, forced: Boolean(s.forced), open: !s.closed_at, closure };
}

/** Ce que la prochaine personne doit trouver dans le tiroir. */
export function expectedFloat(db) { const l = db.prepare('SELECT float_out_cents FROM closures ORDER BY id DESC LIMIT 1').get(); return l ? l.float_out_cents : null; }

export function openShift(ctx, user, body) {
  const db = ctx.db; const actor = { id: user.id, name: user.name, role: user.role };
  if (!can(actor.role, 'shift.open')) throw forbidden('Vous n’avez pas le droit d’ouvrir un quart.');
  const counted = cents(body?.counted_cents, 'Fond de caisse compté', { min: 0 });
  const note = text(body?.note ?? '', 'Note', { max: 300 });
  confirmPin(ctx, user, body?.pin);
  return tx(db, () => {
    const open = currentShift(db);
    if (open) {
      throw conflict(open.user_id === actor.id ? `Votre quart ${open.number} est déjà ouvert.` : `Le quart de ${open.user_name} est encore ouvert : il doit être fermé avant d'en ouvrir un autre.`, 'shift_open');
    }
    const expected = expectedFloat(db);
    const variance = expected == null ? null : counted - expected;
    if (variance != null && variance !== 0 && note.length < 3) throw bad(`Le fond de caisse compté (${(counted / 100).toFixed(2).replace('.', ',')} €) n'est pas celui laissé par le quart précédent (${(expected / 100).toFixed(2).replace('.', ',')} €) : expliquez l'écart dans la note.`, 'variance_note');
    const ts = ctx.now().toISOString(); const day = dayIn(ctx.now(), ctx.tz());
    const fromSale = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sales').get().m;
    const fromMove = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM cash_moves').get().m;
    const number_ = nextNumber(db, 'shift', 'Q', { pad: 4 });
    const r = db.prepare(`INSERT INTO shifts (number, user_id, user_name, opened_at, day, from_sale_id, from_cash_move_id, opening_expected_cents, opening_counted_cents, opening_variance_cents, opening_note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(number_, actor.id, actor.name, ts, day, fromSale, fromMove, expected, counted, variance, note);
    const id = Number(r.lastInsertRowid);
    writeAudit(db, ts, actor, 'shift.open', { entity: 'shift', entityId: id, detail: { number: number_, expected, counted, variance, note: note || undefined } });
    return shiftView(db, id);
  });
}

/** État pour l'écran : quart en cours, à qui il est, ce qu'il faut trouver dans le tiroir. */
export function shiftStatus(ctx, user) {
  const db = ctx.db; const s = currentShift(db);
  return {
    required: shiftRequired(db),
    shift: s ? shiftView(db, s.id) : null,
    mine: Boolean(s && s.user_id === user.id),
    can_open: can(user.role, 'shift.open'), can_force_close: can(user.role, 'shift.force_close'),
    expected_float_cents: expectedFloat(db), tz: ctx.tz?.(),
    deposits: s && (s.user_id === user.id || can(user.role, 'cash.review')) ? depositsOf(db, s) : [],
    out_reasons: CASH_OUT_REASONS, in_reasons: CASH_IN_REASONS,
  };
}

const eurTxt = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

/** Versements du quart en cours (le caissier remet de l'argent à l'administrateur sans voir aucun total). */
export const depositsOf = (db, shift) => shift
  ? db.prepare(`SELECT id, ts, amount_cents, reason, user_name FROM cash_moves WHERE id > ? AND category = ? ORDER BY id`).all(shift.from_cash_move_id, DEPOSIT)
    .map((m, i) => ({ number: i + 1, ts: m.ts, amount_cents: -m.amount_cents, note: m.reason, user_name: m.user_name }))
  : [];

export function makeDeposit(ctx, user, body) {
  const db = ctx.db; const actor = { id: user.id, name: user.name, role: user.role };
  const amount = cents(body?.amount_cents, 'Montant du versement', { min: 1, max: 100_000_000 });
  const extra = text(body?.note ?? '', 'Note', { max: 150 });
  return tx(db, () => {
    const shift = currentShift(db);
    if (!shift) throw conflict('Aucun quart ouvert : il n’y a pas de versement à faire.', 'no_shift');
    if (shift.user_id !== actor.id && !can(actor.role, 'cash.review')) throw conflict(`Le quart ouvert est celui de ${shift.user_name}.`, 'shift_other');
    const n = depositsOf(db, shift).length + 1;
    const ts = ctx.now().toISOString();
    const reason = extra ? `Versement ${n} — ${extra}` : `Versement ${n}`;
    const r = db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, category, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?,?)')
      .run(ts, dayIn(ctx.now(), ctx.tz()), -amount, reason, DEPOSIT, `VERS-${shift.number}-${n}`, actor.id, actor.name);
    db.prepare('UPDATE shifts SET deposit_requested_at = NULL, deposit_requested_by = NULL, deposit_request_note = \'\' WHERE id = ?').run(shift.id);
    writeAudit(db, ts, actor, 'cash.deposit', { entity: 'cash', entityId: Number(r.lastInsertRowid), detail: { shift: shift.number, n, amount_cents: amount, note: extra || undefined } });
    return { number: n, amount_cents: amount, ts };
  });
}

/** L'administrateur demande au caissier de verser (trop d'espèces en caisse). */
export function requestDeposit(ctx, user, body) {
  const db = ctx.db; const actor = { id: user.id, name: user.name, role: user.role };
  if (!can(actor.role, 'cash.review')) throw forbidden();
  const note = text(body?.note ?? '', 'Message', { max: 120 });
  const out = tx(db, () => {
    const shift = currentShift(db);
    if (!shift) throw conflict('Aucun quart ouvert.', 'no_shift');
    const ts = ctx.now().toISOString();
    db.prepare('UPDATE shifts SET deposit_requested_at = ?, deposit_requested_by = ?, deposit_request_note = ? WHERE id = ?').run(ts, actor.name, note, shift.id);
    writeAudit(db, ts, actor, 'cash.deposit_request', { entity: 'shift', entityId: shift.id, detail: { shift: shift.number, cashier: shift.user_name, note: note || undefined } });
    return { shift };
  });
  ctx.push?.notify([out.shift.user_id], { title: 'Versement demandé', body: `${actor.name} vous demande de faire un versement de caisse.${note ? ` ${note}` : ''}`, tag: 'deposit', url: '/' }).catch?.(() => {});
  return { ok: true, cashier: out.shift.user_name };
}
