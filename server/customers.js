import { tx } from './db.js';
import { bad, notFound, conflict } from './errors.js';
import { writeAudit } from './audit.js';
import { cents, text } from './common.js';

export const balanceOf = (db, id) => db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM customer_ledger WHERE customer_id = ?').get(id).s; // > 0 : le client doit de l'argent
export const stampsOf = (db, id) => db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM loyalty_moves WHERE customer_id = ?').get(id).s;

export function cleanCustomer(b, existing) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  return {
    name: text(has('name') ? b.name : existing?.name, 'Nom', { max: 80, min: 1 }),
    phone: text(has('phone') ? b.phone : existing?.phone ?? '', 'Téléphone', { max: 30 }),
    notes: text(has('notes') ? b.notes : existing?.notes ?? '', 'Notes', { max: 500 }),
  };
}

export function createCustomer(db, ts, actor, body) {
  const o = cleanCustomer(body || {}, null);
  return tx(db, () => {
    const r = db.prepare('INSERT INTO customers (name, phone, notes, active, created_at, updated_at) VALUES (?,?,?,1,?,?)').run(o.name, o.phone, o.notes, ts, ts);
    const id = Number(r.lastInsertRowid);
    writeAudit(db, ts, actor, 'customer.create', { entity: 'customer', entityId: id, detail: { name: o.name } });
    return id;
  });
}

export function updateCustomer(db, ts, actor, id, body, { canCredit }) {
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!cur) throw notFound('Client introuvable.');
    const b = body || {};
    const o = cleanCustomer(b, cur);
    let limit = cur.credit_limit_cents;
    if (Object.prototype.hasOwnProperty.call(b, 'credit_limit_cents')) {
      if (!canCredit) throw bad('Seul le gérant fixe la limite d’ardoise.', 'forbidden');
      limit = cents(b.credit_limit_cents, 'Limite d’ardoise', { nullable: true });
    }
    const active = Object.prototype.hasOwnProperty.call(b, 'active') ? (b.active ? 1 : 0) : cur.active;
    if (!active && balanceOf(db, id) !== 0) throw conflict('Ce client a encore une ardoise non soldée : soldez-la avant de le désactiver.', 'has_balance');
    db.prepare('UPDATE customers SET name=?, phone=?, notes=?, credit_limit_cents=?, active=?, updated_at=? WHERE id=?').run(o.name, o.phone, o.notes, limit, active, ts, id);
    const changes = {};
    for (const k of ['name', 'phone', 'notes']) if (cur[k] !== o[k]) changes[k] = { from: cur[k], to: o[k] };
    if (cur.credit_limit_cents !== limit) changes.credit_limit_cents = { from: cur.credit_limit_cents, to: limit };
    if (cur.active !== active) changes.active = { from: cur.active, to: active };
    if (Object.keys(changes).length) writeAudit(db, ts, actor, 'customer.update', { entity: 'customer', entityId: id, detail: changes });
    return changes;
  });
}

export function receivePayment(db, ts, day, actor, id, body) {
  const amount = cents(body?.amount_cents, 'Montant', { min: 1 });
  const method = body?.method;
  if (!['cash', 'card', 'transfer', 'other'].includes(method)) throw bad('Choisissez le moyen de paiement.');
  const note = text(body?.note ?? '', 'Note', { max: 200 });
  return tx(db, () => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw notFound('Client introuvable.');
    const bal = balanceOf(db, id);
    if (bal <= 0) throw conflict('Ce client ne doit rien.', 'no_balance');
    if (amount > bal) throw conflict(`L'ardoise de ce client est de ${(bal / 100).toFixed(2).replace('.', ',')} € : le règlement ne peut pas être plus grand.`, 'too_much');
    const r = db.prepare('INSERT INTO customer_ledger (customer_id, ts, type, amount_cents, method, note, user_id, user_name) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, ts, 'payment', -amount, method, note || null, actor?.id ?? null, actor?.name ?? null);
    const lid = Number(r.lastInsertRowid);
    if (method === 'cash') {
      db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?)')
        .run(ts, day, amount, `Règlement d'ardoise — ${c.name}`, `ledger:${lid}`, actor?.id ?? null, actor?.name ?? null);
    }
    writeAudit(db, ts, actor, 'customer.payment', { entity: 'customer', entityId: id, detail: { name: c.name, amount_cents: amount, method } });
    return { id: lid, balance: bal - amount };
  });
}

export function adjustLedger(db, ts, actor, id, body) {
  const amount = cents(body?.amount_cents, 'Montant', { min: -100_000_000 });
  if (amount === 0) throw bad('Le montant ne peut pas être zéro.');
  const note = text(body?.note, 'Raison', { max: 200, min: 1 });
  return tx(db, () => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw notFound('Client introuvable.');
    if (balanceOf(db, id) + amount < 0) throw conflict('La correction rendrait l’ardoise négative.', 'negative');
    db.prepare('INSERT INTO customer_ledger (customer_id, ts, type, amount_cents, note, user_id, user_name) VALUES (?,?,?,?,?,?,?)').run(id, ts, 'adjust', amount, note, actor?.id ?? null, actor?.name ?? null);
    writeAudit(db, ts, actor, 'customer.adjust', { entity: 'customer', entityId: id, detail: { name: c.name, amount_cents: amount, note } });
    return { balance: balanceOf(db, id) };
  });
}

/** Ajustement manuel de tampons (geste commercial, correction). */
export function adjustStamps(db, ts, actor, id, body) {
  const delta = Number(body?.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) throw bad('Nombre de tampons invalide.');
  const note = text(body?.note, 'Raison', { max: 200, min: 1 });
  return tx(db, () => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw notFound('Client introuvable.');
    if (stampsOf(db, id) + delta < 0) throw conflict('Le client n’a pas assez de tampons.', 'negative');
    db.prepare('INSERT INTO loyalty_moves (customer_id, ts, delta, reason, user_name) VALUES (?,?,?,?,?)').run(id, ts, delta, note, actor?.name ?? null);
    writeAudit(db, ts, actor, 'customer.stamps', { entity: 'customer', entityId: id, detail: { name: c.name, delta, note } });
    return { stamps: stampsOf(db, id) };
  });
}
