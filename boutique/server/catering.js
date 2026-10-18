import { tx } from './db.js';
import { assertDrawer } from './shifts.js';
import { bad, notFound, conflict } from './errors.js';
import { writeAudit } from './audit.js';
import { fmtBase, round6 } from '../shared/units.js';
import { cents, text, number, dateStr, nextNumber } from './common.js';
import { loadIngredient, shoppingCalc } from './stock.js';
import { loadVersion, costLines, getRecipe } from './recipes.js';
import { unitCost } from './products.js';

export const STATUS = { quote: 'Devis', confirmed: 'Confirmée', prepared: 'Préparée', delivered: 'Livrée', cancelled: 'Annulée' };
const NEXT = { quote: ['confirmed'], confirmed: ['prepared'], prepared: ['delivered'] };

export const paidOf = (db, id) => db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM catering_payments WHERE order_id = ?').get(id).s;

function cleanLines(db, lines) {
  if (!Array.isArray(lines)) throw bad('Lignes invalides.');
  if (lines.length > 80) throw bad('80 lignes au maximum.');
  return lines.map((l, i) => {
    const at = `ligne ${i + 1}`;
    const qty = number(l?.qty, `Quantité (${at})`, { min: 0, max: 100000, exclusiveMin: true });
    if (l.kind === 'recipe') {
      const rec = Number.isInteger(l.recipe_id) ? db.prepare('SELECT id, name FROM recipes WHERE id = ?').get(l.recipe_id) : null;
      if (!rec) throw bad(`Recette introuvable (${at}).`);
      const v = loadVersion(db, rec.id, null);
      const c = costLines(db, v.lines);
      return { kind: 'recipe', recipe_id: rec.id, product_id: null, label: rec.name, qty, price: cents(l.unit_price_cents, `Prix (${at})`), est_cost: (c.total / v.servings) * qty };
    }
    if (l.kind === 'product') {
      const p = Number.isInteger(l.product_id) ? db.prepare('SELECT * FROM products WHERE id = ?').get(l.product_id) : null;
      if (!p) throw bad(`Article introuvable (${at}).`);
      return { kind: 'product', recipe_id: null, product_id: p.id, label: p.name, qty, price: cents(l.unit_price_cents ?? p.price_cents, `Prix (${at})`), est_cost: (unitCost(db, p).cost ?? 0) * qty };
    }
    if (l.kind === 'free') return { kind: 'free', recipe_id: null, product_id: null, label: text(l.label, `Libellé (${at})`, { max: 80, min: 1 }), qty, price: cents(l.unit_price_cents, `Prix (${at})`), est_cost: 0 };
    throw bad(`Type de ligne inconnu (${at}).`);
  });
}

function head(db, b, cur) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const g = (k, d) => (has(k) ? b[k] : cur?.[k] ?? d);
  const cid = g('customer_id', null);
  if (cid != null && !(Number.isInteger(cid) && db.prepare('SELECT 1 FROM customers WHERE id = ?').get(cid))) throw bad('Client introuvable.');
  const time = g('event_time', '');
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Heure invalide (HH:MM).');
  const guests = g('guests', null);
  return {
    customer_id: cid ?? null, contact_name: text(g('contact_name'), 'Nom du contact', { max: 80, min: 1 }), contact_phone: text(g('contact_phone', ''), 'Téléphone', { max: 30 }),
    event_date: dateStr(g('event_date'), 'Date de l’événement'), event_time: time || '', place: text(g('place', ''), 'Lieu', { max: 150 }),
    guests: guests == null || guests === '' ? null : number(guests, 'Nombre d’invités', { min: 1, max: 100000, int: true }),
    note: text(g('note', ''), 'Note', { max: 500 }), discount_cents: cents(g('discount_cents', 0), 'Remise', { min: 0 }),
  };
}

function writeLines(db, id, lines) {
  db.prepare('DELETE FROM catering_lines WHERE order_id = ?').run(id);
  let total = 0, est = 0;
  lines.forEach((l, i) => {
    const t = Math.round(l.qty * l.price);
    total += t; est += l.est_cost;
    db.prepare('INSERT INTO catering_lines (order_id, pos, kind, recipe_id, product_id, label, qty, unit_price_cents, total_cents, est_cost) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, i, l.kind, l.recipe_id, l.product_id, l.label, l.qty, l.price, t, l.est_cost);
  });
  return { total, est };
}

export function createOrder(db, ts, actor, b) {
  return tx(db, () => {
    const h = head(db, b || {}, null);
    const lines = cleanLines(db, b?.lines ?? []);
    const number_ = nextNumber(db, 'catering', 'T', { pad: 4 });
    const r = db.prepare(`INSERT INTO catering_orders (number, status, customer_id, contact_name, contact_phone, event_date, event_time, place, guests, note, discount_cents, total_cents, est_cost, created_at, updated_at, user_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`).run(number_, 'quote', h.customer_id, h.contact_name, h.contact_phone, h.event_date, h.event_time, h.place, h.guests, h.note, 0, ts, ts, actor?.name ?? null);
    const id = Number(r.lastInsertRowid);
    const { total, est } = writeLines(db, id, lines);
    if (h.discount_cents > total) throw bad('La remise dépasse le total.');
    db.prepare('UPDATE catering_orders SET discount_cents=?, total_cents=?, est_cost=? WHERE id=?').run(h.discount_cents, total - h.discount_cents, est, id);
    writeAudit(db, ts, actor, 'catering.create', { entity: 'catering', entityId: id, detail: { number: number_, contact: h.contact_name, event_date: h.event_date } });
    return id;
  });
}

export function updateOrder(db, ts, actor, id, b) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM catering_orders WHERE id = ?').get(id);
    if (!o) throw notFound('Commande introuvable.');
    if (!['quote', 'confirmed'].includes(o.status)) throw conflict(`Une commande « ${STATUS[o.status]} » ne se modifie plus.`, 'locked');
    const h = head(db, b || {}, o);
    let total = o.total_cents + o.discount_cents, est = o.est_cost;
    if (Array.isArray(b?.lines)) ({ total, est } = writeLines(db, id, cleanLines(db, b.lines)));
    if (h.discount_cents > total) throw bad('La remise dépasse le total.');
    const newTotal = total - h.discount_cents;
    db.prepare(`UPDATE catering_orders SET customer_id=?, contact_name=?, contact_phone=?, event_date=?, event_time=?, place=?, guests=?, note=?, discount_cents=?, total_cents=?, est_cost=?, updated_at=? WHERE id=?`)
      .run(h.customer_id, h.contact_name, h.contact_phone, h.event_date, h.event_time, h.place, h.guests, h.note, h.discount_cents, newTotal, est, ts, id);
    writeAudit(db, ts, actor, 'catering.update', { entity: 'catering', entityId: id, detail: { number: o.number, total_before: o.total_cents, total_after: newTotal } });
  });
}

export function setStatus(db, ts, actor, id, status, reason) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM catering_orders WHERE id = ?').get(id);
    if (!o) throw notFound('Commande introuvable.');
    if (status === 'cancelled') {
      if (['delivered', 'cancelled'].includes(o.status)) throw conflict(`Une commande « ${STATUS[o.status]} » ne peut plus être annulée.`, 'bad_status');
      const why = text(reason, 'Motif', { max: 200, min: 1 });
      const paid = paidOf(db, id);
      if (paid > 0) throw conflict(`Remboursez d'abord ${(paid / 100).toFixed(2).replace('.', ',')} € déjà encaissés (acompte), puis annulez.`, 'refund_first');
      db.prepare('UPDATE catering_orders SET status=?, cancelled_reason=?, updated_at=? WHERE id=?').run('cancelled', why, ts, id);
      writeAudit(db, ts, actor, 'catering.cancel', { entity: 'catering', entityId: id, detail: { number: o.number, reason: why } });
      return;
    }
    if (!(NEXT[o.status] || []).includes(status)) throw conflict(`Une commande « ${STATUS[o.status]} » ne peut pas passer à « ${STATUS[status] ?? status} ».`, 'bad_status');
    if (status === 'confirmed' && !db.prepare('SELECT 1 FROM catering_lines WHERE order_id = ?').get(id)) throw bad('Ajoutez au moins une ligne avant de confirmer.');
    db.prepare('UPDATE catering_orders SET status=?, updated_at=? WHERE id=?').run(status, ts, id);
    writeAudit(db, ts, actor, `catering.${status}`, { entity: 'catering', entityId: id, detail: { number: o.number } });
  });
}

export function addPayment(db, ts, day, actor, id, b) {
  const kind = b?.kind;
  if (!['deposit', 'balance', 'refund'].includes(kind)) throw bad('Type de paiement invalide.');
  const method = b?.method;
  if (!['cash', 'card', 'voucher', 'transfer', 'other'].includes(method)) throw bad('Choisissez le moyen de paiement.');
  const amount = cents(b?.amount_cents, 'Montant', { min: 1 });
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM catering_orders WHERE id = ?').get(id);
    if (!o) throw notFound('Commande introuvable.');
    const paid = paidOf(db, id);
    if (kind === 'refund') {
      if (amount > paid) throw conflict('Vous ne pouvez pas rembourser plus que ce qui a été encaissé.', 'too_much');
    } else {
      if (o.status === 'cancelled') throw conflict('Cette commande est annulée.', 'bad_status');
      if (o.status === 'quote') throw conflict('Confirmez la commande avant d’encaisser un acompte.', 'bad_status');
      if (paid + amount > o.total_cents) throw conflict(`Il ne reste que ${((o.total_cents - paid) / 100).toFixed(2).replace('.', ',')} € à payer.`, 'too_much');
    }
    const signed = kind === 'refund' ? -amount : amount;
    const r = db.prepare('INSERT INTO catering_payments (order_id, ts, day, kind, method, amount_cents, user_name, note) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, ts, day, kind, method, signed, actor?.name ?? null, text(b.note ?? '', 'Note', { max: 200 }));
    if (method === 'cash') {
      assertDrawer(db, actor);
      db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?)')
        .run(ts, day, signed, `Traiteur ${o.number} — ${kind === 'deposit' ? 'acompte' : kind === 'balance' ? 'solde' : 'remboursement'}`, `catering:${Number(r.lastInsertRowid)}`, actor?.id ?? null, actor?.name ?? null);
    }
    writeAudit(db, ts, actor, 'catering.payment', { entity: 'catering', entityId: id, detail: { number: o.number, kind, method, amount_cents: signed } });
    return { id: Number(r.lastInsertRowid), paid: paid + signed, balance: o.total_cents - (paid + signed) };
  });
}

export function orderView(db, id) {
  const o = db.prepare('SELECT * FROM catering_orders WHERE id = ?').get(id);
  if (!o) return null;
  const paid = paidOf(db, id);
  return {
    ...o, status_label: STATUS[o.status], lines: db.prepare('SELECT * FROM catering_lines WHERE order_id = ? ORDER BY pos').all(id),
    payments: db.prepare('SELECT * FROM catering_payments WHERE order_id = ? ORDER BY id').all(id), paid_cents: paid, balance_cents: o.total_cents - paid,
    customer: o.customer_id ? db.prepare('SELECT id, name FROM customers WHERE id = ?').get(o.customer_id) : null,
    productions: db.prepare('SELECT id, number, ts, servings, qty_obtained, voided_at FROM productions WHERE order_id = ? ORDER BY id').all(id),
  };
}

/** Liste de courses pour les commandes confirmées d'une période : besoins totaux, stock, manque, emballages à acheter. */
export function shoppingList(db, { from, to }) {
  const orders = db.prepare("SELECT * FROM catering_orders WHERE status IN ('confirmed','prepared') AND event_date BETWEEN ? AND ? ORDER BY event_date, event_time").all(from, to);
  const need = new Map();
  const free = [];
  const add = (iid, q) => need.set(iid, round6((need.get(iid) ?? 0) + q));
  for (const o of orders) {
    for (const l of db.prepare('SELECT * FROM catering_lines WHERE order_id = ?').all(o.id)) {
      let recipeId = null, servings = 0;
      if (l.kind === 'recipe') { recipeId = l.recipe_id; servings = l.qty; }
      else if (l.kind === 'product') {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(l.product_id);
        if (p.kind === 'resale') { add(p.ingredient_id, p.ingredient_qty * l.qty); continue; }
        if (p.kind === 'made') { recipeId = p.recipe_id; servings = l.qty / (p.portions ?? 1); }
        if (p.kind === 'direct') { recipeId = p.recipe_id; servings = l.qty * (p.portions ?? 1); }
      }
      if (!recipeId) continue;
      const v = loadVersion(db, recipeId, null);
      const f = servings / v.servings;
      for (const rl of v.lines) {
        if (rl.ingredient_id == null) { free.push({ order: o.number, label: rl.label, text: `${round6(rl.qty * f)} ${rl.unit}`.trim() }); continue; }
        const ing = loadIngredient(db, rl.ingredient_id);
        add(rl.ingredient_id, (rl.base * f) / (ing.yieldPct / 100));
      }
    }
  }
  const items = [...need].map(([iid, q]) => {
    const ing = loadIngredient(db, iid);
    const s = shoppingCalc(db, ing, q);
    return {
      ingredient_id: iid, name: ing.name, family: ing.family, needText: fmtBase(q, ing.family), stockText: fmtBase(s.inStock, ing.family), missing: s.missing, missingText: fmtBase(s.missing, ing.family),
      toBuyText: s.missing > 0 ? fmtBase(s.toBuyBase, ing.family) : null, packs: s.packs, packLabel: s.packLabel ?? null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return { orders: orders.map((o) => ({ id: o.id, number: o.number, event_date: o.event_date, contact_name: o.contact_name })), items, free, toBuy: items.filter((i) => i.missing > 1e-9).length };
}
