import { linkOrdersToSale } from './orders.js';
import { assertSeller, assertDrawer, shiftRequired, currentShift, confirmPin, shiftView, CASH_OUT_REASONS, CASH_IN_REASONS, refCategory, DEPOSIT, depositsOf } from './shifts.js';
import { tx } from './db.js';
import { bad, notFound, conflict, forbidden } from './errors.js';
import { writeAudit } from './audit.js';
import { can } from './permissions.js';
import { round6 } from '../shared/units.js';
import { applyPromos, atOf } from '../shared/promo.js';
import { cents, text, number, nextNumber, allocate, vatOf } from './common.js';
import { loadIngredient, stateOf, postMove } from './stock.js';
import { loadVersion } from './recipes.js';
import { unitCost, batchBalance } from './products.js';
import { balanceOf, stampsOf } from './customers.js';
import { dayIn } from './backup.js';

const METHODS = ['cash', 'card', 'voucher', 'credit', 'other'];
export const METHOD_LABELS = { cash: 'Espèces', card: 'Carte', voucher: 'Bon / ticket', credit: 'Ardoise', other: 'Autre' };
const MAX_LINES = 60;

// ---------- consommation du stock ----------

/** Sort du stock ce que consomme la vente de `qty` articles. Retourne le coût et les alertes. */
export function consume(db, ts, actor, p, qty, ref) {
  const flags = new Set();
  let cost = 0;
  if (p.kind === 'free') return { cost, flags };
  if (p.kind === 'made') {
    const uc = unitCost(db, p);
    if (uc.cost == null) flags.add('cost_unknown');
    const c = uc.cost ?? 0;
    if (batchBalance(db, p.id) < qty) flags.add('stock_negative');
    db.prepare('INSERT INTO batch_moves (ts, product_id, type, qty, unit_cost, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?,?)')
      .run(ts, p.id, 'sale', -qty, c, ref, actor?.id ?? null, actor?.name ?? null);
    return { cost: c * qty, flags };
  }
  const needs = new Map(); // ingredient -> quantité de base à sortir
  if (p.kind === 'resale') needs.set(p.ingredient_id, p.ingredient_qty * qty);
  else {
    const v = loadVersion(db, p.recipe_id, null);
    const factor = (qty * (p.portions ?? 1)) / v.servings;
    for (const l of v.lines) {
      if (l.ingredient_id == null) { flags.add('recipe_incomplete'); continue; }
      const ing = loadIngredient(db, l.ingredient_id);
      needs.set(l.ingredient_id, (needs.get(l.ingredient_id) ?? 0) + (l.base * factor) / (ing.yieldPct / 100));
    }
  }
  for (const [iid, q] of needs) {
    const ing = loadIngredient(db, iid);
    const m = postMove(db, { ts, ing, type: 'sale', qty: -round6(q), ref, user: actor });
    cost += -m.value;
    if (m.stock < -1e-9) flags.add('stock_negative');
    if (!(m.prevAvg > 0)) flags.add('cost_unknown');
  }
  return { cost, flags };
}

// ---------- lecture ----------

export function lastClosure(db) { return db.prepare('SELECT * FROM closures ORDER BY id DESC LIMIT 1').get() ?? null; }
const closedUpTo = (db) => lastClosure(db)?.to_sale_id ?? 0;

export function saleView(db, id) {
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!s) return null;
  const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY pos').all(id);
  const payments = db.prepare('SELECT method, amount_cents, ref FROM payments WHERE sale_id = ? ORDER BY id').all(id);
  const customer = s.customer_id ? db.prepare('SELECT id, name FROM customers WHERE id = ?').get(s.customer_id) : null;
  const refund = s.kind === 'sale' ? db.prepare('SELECT id, number, ts, void_reason FROM sales WHERE refund_of = ?').get(id) ?? null : null;
  const original = s.refund_of ? db.prepare('SELECT id, number FROM sales WHERE id = ?').get(s.refund_of) : null;
  return {
    ...s, flags: JSON.parse(s.flags), lines, payments, customer, refunded_by: refund, refund_of_sale: original,
    closed: s.id <= closedUpTo(db),
  };
}

// ---------- création d'une vente ----------

const UUID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function whenOf(ctx, body, flags) {
  const now = ctx.now();
  if (!body.offline || body.ts == null) return now;
  const t = typeof body.ts === 'string' ? Date.parse(body.ts) : NaN;
  if (!Number.isFinite(t)) return now;
  if (t > now.getTime() + 5 * 60_000) { flags.add('ts_future'); return now; }
  if (t < now.getTime() - 14 * 86_400_000) flags.add('ts_old');
  return new Date(t);
}

/** Qui autorise la remise libre : le gérant/propriétaire lui-même, ou quelqu'un d'autre qui tape SON code sur cet appareil. */
export function resolveApprover(ctx, approval) {
  if (!approval) throw forbidden('Seul le gérant peut accorder une remise libre : il doit l’autoriser en tapant son code.');
  const id = approval?.user_id;  const u = Number.isInteger(id) ? ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id) : null;
  if (!u) throw bad('Choisissez qui autorise la remise.', 'approver_required');
  if (!can(u.role, 'promotions.manage')) throw forbidden(`${u.name} n’a pas le droit d’accorder une remise.`);
  confirmPin(ctx, u, approval?.pin); // mêmes blocages qu'à la connexion (5 erreurs = 60 s)
  return { id: u.id, name: u.name, role: u.role };
}

export function createSale(ctx, actor, body) {
  const db = ctx.db;
  const b = body || {};
  // la remise libre est décidée AVANT la vente (une erreur de code ne doit pas être annulée avec elle)
  let approver = null;
  if (b.discount_cents !== undefined && b.discount_cents !== null && b.discount_cents !== 0) {
    if (can(actor?.role, 'promotions.manage')) approver = { id: actor.id, name: actor.name };
    else if (b.offline) throw forbidden('Une remise libre exige l’accord du gérant, qui doit taper son code : impossible sans réseau.');
    else approver = resolveApprover(ctx, b.discount_approval);
  }
  if (typeof b.client_uuid !== 'string' || !UUID_RE.test(b.client_uuid)) throw bad('Identifiant de vente manquant (rechargez la page).');
  const dup = db.prepare('SELECT id FROM sales WHERE client_uuid = ?').get(b.client_uuid);
  if (dup) return { duplicate: true, sale: saleView(db, dup.id) };
  const offline = Boolean(b.offline);
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Le panier est vide.');
  if (b.lines.length > MAX_LINES) throw bad(`${MAX_LINES} lignes au maximum par vente.`);
  const tz = ctx.tz();

  return tx(db, () => {
    const flags = new Set();
    if (offline) flags.add('offline');
    if (!offline) assertSeller(ctx, actor); // quart de caisse ouvert par cette personne
    else if (shiftRequired(db) && currentShift(db)?.user_id !== actor?.id) flags.add('no_shift'); // déjà encaissé physiquement : on enregistre, on signale
    const when = whenOf(ctx, b, flags);
    const ts = when.toISOString();
    const day = dayIn(when, tz);
    const at = atOf(when, tz);

    // lignes et prix (le serveur fait foi ; hors-ligne, le prix affiché au client est honoré)
    const priced = b.lines.map((l, i) => {
      const p = Number.isInteger(l?.product_id) ? db.prepare('SELECT * FROM products WHERE id = ?').get(l.product_id) : null;
      if (!p) throw bad(`Article inconnu (ligne ${i + 1}).`);
      const qty = number(l.qty, `Quantité de ${p.name}`, { min: 1, max: 999, int: true });
      if (!p.active) { if (!offline) throw bad(`« ${p.name} » n'est plus en vente.`); flags.add('product_inactive'); }
      let price = p.price_cents;
      if (l.unit_price_cents !== undefined && l.unit_price_cents !== null && l.unit_price_cents !== p.price_cents) {
        const quoted = cents(l.unit_price_cents, `Prix de ${p.name}`);
        if (!offline) throw conflict('Des prix ont changé depuis l’ouverture de la caisse : actualisez l’écran puis recommencez.', 'price_changed');
        price = quoted; flags.add('price_differs');
      }
      return { key: String(i), p, qty, price };
    });

    const promos = db.prepare('SELECT * FROM promotions WHERE active = 1').all();
    const promo = applyPromos(priced.map((x) => ({ key: x.key, product_id: x.p.id, category: x.p.category, qty: x.qty, price_cents: x.price })), promos, at);
    const gross = priced.map((x) => x.qty * x.price);
    const afterPromo = priced.map((x, i) => gross[i] - promo.discounts[x.key]);
    let subtotalAfter = afterPromo.reduce((a, c) => a + c, 0);

    // client et fidélité
    let customer = null;
    if (b.customer_id != null) {
      customer = Number.isInteger(b.customer_id) ? db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customer_id) : null;
      if (!customer || !customer.active) throw bad('Client introuvable.');
    }
    const prog = db.prepare('SELECT * FROM loyalty_program WHERE id = 1').get();
    let rewardCents = 0;
    if (b.redeem_loyalty) {
      if (!customer) throw bad('Choisissez le client pour utiliser ses tampons.');
      if (!prog.enabled) throw bad('Le programme de fidélité n’est pas activé.');
      if (stampsOf(db, customer.id) < prog.stamps_needed) throw bad(`Il faut ${prog.stamps_needed} tampons (le client en a ${stampsOf(db, customer.id)}).`);
      rewardCents = Math.min(prog.reward_cents, subtotalAfter);
    }
    let manual = 0;
    if (b.discount_cents !== undefined && b.discount_cents !== null && b.discount_cents !== 0) {
      manual = cents(b.discount_cents, 'Remise', { min: 0 });
      if (!text(b.discount_reason ?? '', 'Motif de la remise', { max: 200 })) throw bad('Indiquez le motif de la remise.');
      if (manual > subtotalAfter - rewardCents) throw bad('La remise dépasse le total.');
    }
    // hors-ligne : le client a payé le total affiché sur la caisse. Si les promotions ont changé entre-temps, c'est le commerce qui absorbe l'écart.
    let gap = 0;
    if (offline && Number.isInteger(b.expected_total_cents) && b.expected_total_cents >= 0) {
      const computed = subtotalAfter - rewardCents - manual;
      if (computed !== b.expected_total_cents) flags.add('offline_gap');
      if (computed > b.expected_total_cents) gap = computed - b.expected_total_cents;
    }
    const extra = rewardCents + manual + gap;
    const extraParts = allocate(extra, afterPromo);
    const lineTotals = afterPromo.map((v, i) => v - extraParts[i]);
    const total = lineTotals.reduce((a, c) => a + c, 0);
    const subtotal = gross.reduce((a, c) => a + c, 0);

    // paiements
    if (!Array.isArray(b.payments)) throw bad('Paiement manquant.');
    const pay = b.payments.map((x) => {
      if (!METHODS.includes(x?.method)) throw bad('Moyen de paiement inconnu.');
      return { method: x.method, amount: cents(x.amount_cents, 'Montant payé', { min: 1 }) };
    });
    const sum = (m) => pay.filter((x) => (m === 'noncash' ? x.method !== 'cash' : x.method === m)).reduce((a, c) => a + c.amount, 0);
    const nonCash = sum('noncash'), tendered = sum('cash'), credit = sum('credit');
    if (nonCash > total) throw bad('Les paiements (hors espèces) dépassent le total.');
    const remaining = total - nonCash;
    if (tendered < remaining) throw bad(`Paiement incomplet : il manque ${((remaining - tendered) / 100).toFixed(2).replace('.', ',')} €.`, 'underpaid');
    const cashApplied = remaining, change = tendered - remaining;
    if (credit > 0) {
      if (!customer) throw bad('Choisissez le client pour mettre sur l’ardoise.');
      const bal = balanceOf(db, customer.id);
      if (customer.credit_limit_cents == null) {
        if (!offline) throw bad(`« ${customer.name} » n'a pas d'ardoise autorisée. Le gérant doit fixer sa limite.`, 'no_credit');
        flags.add('over_limit');
      } else if (bal + credit > customer.credit_limit_cents) {
        if (!offline) throw conflict(`Limite d'ardoise dépassée : ${(bal / 100).toFixed(2).replace('.', ',')} € déjà dus, limite ${(customer.credit_limit_cents / 100).toFixed(2).replace('.', ',')} €.`, 'over_limit');
        flags.add('over_limit');
      }
    }

    // stock et coût
    const number_ = nextNumber(db, `sale:${day}`, 'V', { datePart: day });
    let costTotal = 0;
    const lineCosts = priced.map((x) => {
      const c = consume(db, ts, actor, x.p, x.qty, number_);
      for (const f of c.flags) flags.add(f);
      costTotal += c.cost;
      return c.cost;
    });

    const vatTotal = lineTotals.reduce((a, v, i) => a + vatOf(v, priced[i].p.vat_pct), 0);
    const note = text(b.note ?? '', 'Note', { max: 200 });
    const r = db.prepare(`INSERT INTO sales (number, kind, client_uuid, provisional, ts, day, received_at, offline, user_id, user_name, customer_id, refund_of,
      void_reason, subtotal_cents, discount_cents, total_cents, vat_cents, cost, change_cents, note, flags, discount_reason, discount_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?)`).run(
      number_, 'sale', b.client_uuid, typeof b.provisional === 'string' ? b.provisional.slice(0, 40) : null, ts, day, ctx.now().toISOString(), offline ? 1 : 0,
      actor?.id ?? null, actor?.name ?? null, customer?.id ?? null, subtotal, subtotal - total, total, vatTotal, costTotal, change, note, JSON.stringify([...flags]), manual > 0 ? text(b.discount_reason, 'Motif', { max: 200 }) : '', manual > 0 ? approver.name : '');
    const sid = Number(r.lastInsertRowid);
    const insL = db.prepare(`INSERT INTO sale_lines (sale_id, pos, product_id, name, qty, unit_price_cents, gross_cents, discount_cents, total_cents, vat_pct, cost, promo_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    priced.forEach((x, i) => {
      const labels = [...promo.labels[x.key], ...(rewardCents ? ['Fidélité'] : []), ...(manual ? ['Remise'] : []), ...(gap ? ['Écart hors-ligne'] : [])];
      insL.run(sid, i, x.p.id, x.p.name, x.qty, x.price, gross[i], gross[i] - lineTotals[i], lineTotals[i], x.p.vat_pct, lineCosts[i], extraParts[i] || promo.discounts[x.key] ? labels.join(', ') : '');
    });
    const insP = db.prepare('INSERT INTO payments (sale_id, method, amount_cents) VALUES (?,?,?)');
    for (const x of pay) if (x.method !== 'cash') insP.run(sid, x.method, x.amount);
    if (cashApplied > 0) insP.run(sid, 'cash', cashApplied);
    if (credit > 0) {
      db.prepare('INSERT INTO customer_ledger (customer_id, ts, type, amount_cents, sale_id, user_id, user_name) VALUES (?,?,?,?,?,?,?)')
        .run(customer.id, ts, 'sale', credit, sid, actor?.id ?? null, actor?.name ?? null);
    }
    if (customer && prog.enabled) {
      if (rewardCents > 0) db.prepare('INSERT INTO loyalty_moves (customer_id, ts, delta, sale_id, reason, user_name) VALUES (?,?,?,?,?,?)').run(customer.id, ts, -prog.stamps_needed, sid, 'Récompense utilisée', actor?.name ?? null);
      const earned = Math.floor(total / prog.spend_cents_per_stamp);
      if (earned > 0) db.prepare('INSERT INTO loyalty_moves (customer_id, ts, delta, sale_id, reason, user_name) VALUES (?,?,?,?,?,?)').run(customer.id, ts, earned, sid, 'Achat', actor?.name ?? null);
    }
    linkOrdersToSale(db, sid, b.order_ids);
    if (manual > 0) writeAudit(db, ts, actor, 'sale.discount', { entity: 'sale', entityId: sid, detail: { number: number_, discount_cents: manual, reason: text(b.discount_reason, 'Motif', { max: 200 }), authorized_by: approver.name, requested_by: actor?.name } });
    return { duplicate: false, sale: saleView(db, sid) };
  });
}

/** Synchronisation de ventes faites hors-ligne : chacune est traitée seule, sans bloquer les autres. */
export function syncSales(ctx, actor, list) {
  if (!Array.isArray(list) || !list.length) throw bad('Rien à envoyer.');
  if (list.length > 200) throw bad('200 ventes au maximum par envoi.');
  return list.map((s) => {
    const uuid = s?.client_uuid;
    try {
      const r = createSale(ctx, actor, { ...s, offline: true });
      return { client_uuid: uuid, ok: true, duplicate: r.duplicate, number: r.sale.number, id: r.sale.id, flags: r.sale.flags };
    } catch (e) {
      if (e.status && e.status < 500) return { client_uuid: uuid, ok: false, code: e.code, error: e.message };
      throw e;
    }
  });
}

// ---------- annulation (avoir) ----------

export function refundSale(ctx, actor, saleId, body) {
  const db = ctx.db;
  const reason = text(body?.reason, 'Motif', { max: 200, min: 1 });
  const restock = body?.restock !== false;
  return tx(db, () => {
    assertDrawer(db, actor);
    const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!s) throw notFound('Vente introuvable.');
    if (s.kind !== 'sale') throw bad('Cette pièce est déjà une annulation.');
    const existing = db.prepare('SELECT number FROM sales WHERE refund_of = ?').get(saleId);
    if (existing) throw conflict(`Cette vente est déjà annulée (${existing.number}).`, 'already_refunded');
    const closed = s.id <= closedUpTo(db);
    const today = dayIn(ctx.now(), ctx.tz());
    if (!can(actor?.role, 'sales.void_any')) {
      if (!can(actor?.role, 'sales.void_own') || s.user_id !== actor?.id) throw forbidden('Vous ne pouvez annuler que vos propres ventes.');
      if (s.day !== today || closed) throw forbidden('Vous ne pouvez annuler une vente que le jour même, avant la clôture. Demandez au gérant.');
    }
    const ts = ctx.now().toISOString();
    const flags = new Set(['refund']);
    if (closed) flags.add('after_closure');
    if (!restock) flags.add('no_restock');
    const number_ = nextNumber(db, `refund:${today}`, 'A', { datePart: today });
    const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY pos').all(saleId);
    const pays = db.prepare('SELECT * FROM payments WHERE sale_id = ? ORDER BY id').all(saleId);

    if (restock) {
      for (const m of db.prepare("SELECT * FROM stock_moves WHERE ref = ? AND type = 'sale' ORDER BY id").all(s.number)) {
        postMove(db, { ts, ing: loadIngredient(db, m.ingredient_id), type: 'void', qty: -m.qty, unitCost: m.unit_cost, ref: number_, note: `Annulation de ${s.number}`, user: actor });
      }
      for (const m of db.prepare("SELECT * FROM batch_moves WHERE ref = ? AND type = 'sale' ORDER BY id").all(s.number)) {
        db.prepare('INSERT INTO batch_moves (ts, product_id, type, qty, unit_cost, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(ts, m.product_id, 'void', -m.qty, m.unit_cost, `Annulation de ${s.number}`, number_, actor?.id ?? null, actor?.name ?? null);
      }
    }
    const r = db.prepare(`INSERT INTO sales (number, kind, client_uuid, provisional, ts, day, received_at, offline, user_id, user_name, customer_id, refund_of,
      void_reason, subtotal_cents, discount_cents, total_cents, vat_cents, cost, change_cents, note, flags)
      VALUES (?,?,NULL,NULL,?,?,?,0,?,?,?,?,?,?,?,?,?,?,0,'',?)`).run(
      number_, 'refund', ts, today, ts, actor?.id ?? null, actor?.name ?? null, s.customer_id, saleId, reason,
      -s.subtotal_cents, -s.discount_cents, -s.total_cents, -s.vat_cents, restock ? -s.cost : 0, JSON.stringify([...flags]));
    const rid = Number(r.lastInsertRowid);
    const insL = db.prepare(`INSERT INTO sale_lines (sale_id, pos, product_id, name, qty, unit_price_cents, gross_cents, discount_cents, total_cents, vat_pct, cost, promo_label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) insL.run(rid, l.pos, l.product_id, l.name, -l.qty, l.unit_price_cents, -l.gross_cents, -l.discount_cents, -l.total_cents, l.vat_pct, restock ? -l.cost : 0, l.promo_label);
    for (const p of pays) {
      db.prepare('INSERT INTO payments (sale_id, method, amount_cents, ref) VALUES (?,?,?,?)').run(rid, p.method, -p.amount_cents, p.ref);
      if (p.method === 'credit') {
        db.prepare('INSERT INTO customer_ledger (customer_id, ts, type, amount_cents, sale_id, note, user_id, user_name) VALUES (?,?,?,?,?,?,?,?)')
          .run(s.customer_id, ts, 'refund', -p.amount_cents, rid, `Annulation de ${s.number}`, actor?.id ?? null, actor?.name ?? null);
      }
    }
    // les tampons gagnés ou dépensés sur cette vente reviennent à leur état d'avant
    for (const m of db.prepare('SELECT * FROM loyalty_moves WHERE sale_id = ?').all(saleId)) {
      db.prepare('INSERT INTO loyalty_moves (customer_id, ts, delta, sale_id, reason, user_name) VALUES (?,?,?,?,?,?)').run(m.customer_id, ts, -m.delta, rid, `Annulation de ${s.number}`, actor?.name ?? null);
    }
    writeAudit(db, ts, actor, 'sale.refund', { entity: 'sale', entityId: saleId, detail: { sale: s.number, refund: number_, total_cents: s.total_cents, reason, restock } });
    return saleView(db, rid);
  });
}

// ---------- caisse : mouvements manuels et clôture ----------

export function cashMove(ctx, actor, body) {
  const amount = cents(body?.amount_cents, 'Montant', { min: -100_000_000 });
  if (amount === 0) throw bad('Le montant ne peut pas être zéro.');
  const category = text(body?.category ?? '', 'Motif', { max: 60 });
  if (!(amount < 0 ? CASH_OUT_REASONS : CASH_IN_REASONS).includes(category)) throw bad(`Choisissez le motif ${amount < 0 ? 'de la sortie' : 'de l’entrée'} dans la liste.`, 'category_required');
  const note = text(body?.reason ?? '', 'Note', { max: 200 });
  if (note.length < 3) throw bad('La note est obligatoire : expliquez à quoi sert cet argent (3 lettres au moins).', 'note_required');
  const ts = ctx.now().toISOString();
  return tx(ctx.db, () => {
    const shift = assertDrawer(ctx.db, actor);
    const r = ctx.db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, category, user_id, user_name) VALUES (?,?,?,?,?,?,?)').run(ts, dayIn(ctx.now(), ctx.tz()), amount, note, category, actor?.id ?? null, actor?.name ?? null);
    writeAudit(ctx.db, ts, actor, 'cash.move', { entity: 'cash', entityId: Number(r.lastInsertRowid), detail: { amount_cents: amount, category, note, shift: shift?.number } });
    return { id: Number(r.lastInsertRowid) };
  });
}

export function closurePreview(db, tz) {
  const last = lastClosure(db);
  const shift = currentShift(db);
  const fromSale = last?.to_sale_id ?? 0, fromMove = last?.to_cash_move_id ?? 0;
  const sales = db.prepare('SELECT * FROM sales WHERE id > ? ORDER BY id').all(fromSale);
  const moves = db.prepare('SELECT * FROM cash_moves WHERE id > ? ORDER BY id').all(fromMove);
  const byMethod = {};
  for (const r of db.prepare('SELECT p.method, SUM(p.amount_cents) AS s FROM payments p JOIN sales x ON x.id = p.sale_id WHERE x.id > ? GROUP BY p.method').all(fromSale)) byMethod[r.method] = r.s;
  const sold = sales.filter((x) => x.kind === 'sale'), refunds = sales.filter((x) => x.kind === 'refund');
  const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);
  const floatIn = shift ? shift.opening_counted_cents : (last?.float_out_cents ?? 0);
  // ventes faites sans réseau AVANT l'ouverture du quart et arrivées après : leur argent était dans le tiroir du quart précédent
  const lateCash = shift ? db.prepare(`SELECT COALESCE(SUM(p.amount_cents), 0) AS s FROM payments p JOIN sales x ON x.id = p.sale_id WHERE x.id > ? AND x.offline = 1 AND x.ts < ? AND p.method = 'cash'`).get(fromSale, shift.opened_at).s : 0;
  const cashNet = byMethod.cash ?? 0;
  const movesSum = sum(moves, 'amount_cents');
  const byProduct = db.prepare(`SELECT l.name, SUM(l.qty) AS qty, SUM(l.total_cents) AS cents FROM sale_lines l JOIN sales x ON x.id = l.sale_id WHERE x.id > ? GROUP BY l.product_id, l.name ORDER BY cents DESC`).all(fromSale);
  return {
    last: last ? { number: last.number, ts: last.ts } : null,
    shift: shift ? shiftView(db, shift.id) : null,
    to_sale_id: sales.length ? sales[sales.length - 1].id : fromSale,
    to_cash_move_id: moves.length ? moves[moves.length - 1].id : fromMove,
    sales_count: sold.length, refunds_count: refunds.length,
    sales_cents: sum(sold, 'total_cents'), refunds_cents: -sum(refunds, 'total_cents'),
    discount_cents: sum(sold, 'discount_cents') + sum(refunds, 'discount_cents'), vat_cents: sum(sales, 'vat_cents'),
    offline_count: sold.filter((x) => x.offline).length,
    by_method: byMethod, float_in_cents: floatIn, late_cash_cents: lateCash,
    cash_moves: moves.map((m) => ({ ts: m.ts, amount_cents: m.amount_cents, reason: m.reason, category: refCategory(m), user_name: m.user_name })),
    deposits: depositsOf(db, shift), deposits_cents: shift ? depositsOf(db, shift).reduce((t, d) => t + d.amount_cents, 0) : 0,
    cash_moves_cents: movesSum, cash_expected_cents: floatIn + cashNet - lateCash + movesSum, by_product: byProduct,
    empty: !shift && !sales.length && !moves.length,
  };
}

/** Ce que voit un caissier : rien sur les ventes, les encaissements ni le montant attendu. */
export function blindPreview(pv) {
  const manual = new Set([...CASH_OUT_REASONS, ...CASH_IN_REASONS]);
  return {
    blind: true, last: pv.last, shift: pv.shift, empty: pv.empty,
    deposits: pv.deposits,
    cash_moves: pv.cash_moves.filter((m) => manual.has(m.category)),
  };
}

export function closeCash(ctx, actor, body, user = null) {
  const db = ctx.db;
  const counted = cents(body?.counted_cents, 'Espèces comptées', { min: 0 });
  const floatOut = cents(body?.float_out_cents ?? 0, 'Fond de caisse laissé', { min: 0 });
  const note = text(body?.note ?? '', 'Note', { max: 300 });
  if (floatOut > counted) throw bad('Le fond de caisse laissé ne peut pas dépasser les espèces comptées.');
  const shiftOpen = currentShift(db);
  if (shiftOpen) {
    if (!user) throw bad('Code PIN manquant.', 'pin_required');
    confirmPin(ctx, user, body?.pin); // la personne qui ferme confirme avec SON code
  } else if (shiftRequired(db)) throw conflict('Aucun quart de caisse n’est ouvert : il n’y a rien à fermer.', 'no_shift');
  return tx(db, () => {
    const shift = currentShift(db);
    let forced = false;
    if (shift && shift.user_id !== actor?.id) {
      if (!can(actor?.role, 'shift.force_close')) throw forbidden(`Seul ${shift.user_name} (ou le gérant) peut fermer ce quart.`);
      if (note.length < 3) throw bad(`Vous fermez le quart de ${shift.user_name} à sa place : indiquez pourquoi dans la note.`, 'force_note');
      forced = true;
    }
    const pv = closurePreview(db);
    if (pv.empty) throw conflict('Rien à clôturer : aucune vente ni mouvement depuis la dernière clôture.', 'nothing');
    const variance = counted - pv.cash_expected_cents;
    // le caissier ne voit pas l'écart (il ne connaît pas le montant attendu) : c'est l'administrateur qui le vérifie ensuite
    const sees = can(actor?.role, 'cash.review');
    if (variance !== 0 && !note && sees) throw bad('Il y a un écart de caisse : expliquez-le dans la note avant de clôturer.', 'variance_note');
    const ts = ctx.now().toISOString();
    const day = dayIn(ctx.now(), ctx.tz());
    const number_ = nextNumber(db, 'closure', 'Z', { pad: 4 });
    let toMove = pv.to_cash_move_id;
    const deposit = counted - floatOut;
    if (deposit > 0) {
      const r = db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, category, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?,?)')
        .run(ts, day, -deposit, `Dépôt à la clôture ${number_}`, 'Dépôt à la clôture', number_, actor?.id ?? null, actor?.name ?? null);
      toMove = Number(r.lastInsertRowid);
    }
    const r = db.prepare(`INSERT INTO closures (number, ts, day, user_id, user_name, to_sale_id, to_cash_move_id, sales_count, refunds_count, sales_cents, refunds_cents, by_method,
      float_in_cents, cash_expected_cents, cash_counted_cents, variance_cents, float_out_cents, note, shift_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      number_, ts, day, actor?.id ?? null, actor?.name ?? null, pv.to_sale_id, toMove, pv.sales_count, pv.refunds_count, pv.sales_cents, pv.refunds_cents, JSON.stringify(pv.by_method),
      pv.float_in_cents, pv.cash_expected_cents, counted, variance, floatOut, note, shift?.id ?? null);
    const cid = Number(r.lastInsertRowid);
    if (shift) db.prepare('UPDATE shifts SET closure_id = ?, closed_at = ?, closed_by_id = ?, closed_by_name = ?, forced = ? WHERE id = ?').run(cid, ts, actor?.id ?? null, actor?.name ?? null, forced ? 1 : 0, shift.id);
    writeAudit(db, ts, actor, 'cash.closure', { entity: 'closure', entityId: cid, detail: { number: number_, shift: shift?.number, expected: pv.cash_expected_cents, counted, variance, deposit, float_left: floatOut, forced: forced || undefined, note: note || undefined } });
    const full = { ...pv, ...closureView(db, cid), deposit_cents: Math.max(0, deposit) };
    if (sees) return full;
    return { blind: true, number: number_, shift: full.shift && { number: full.shift.number, user_name: full.shift.user_name }, deposit_cents: full.deposit_cents, float_out_cents: floatOut, cash_counted_cents: counted, ts };
  });
}

export const closureView = (db, id) => {
  const c = db.prepare('SELECT * FROM closures WHERE id = ?').get(id);
  if (!c) return null;
  const sh = c.shift_id ? shiftView(db, c.shift_id) : null;
  return { ...c, by_method: JSON.parse(c.by_method), shift: sh ? { number: sh.number, user_name: sh.user_name, opened_at: sh.opened_at, opening_counted_cents: sh.opening_counted_cents, opening_expected_cents: sh.opening_expected_cents, opening_variance_cents: sh.opening_variance_cents, opening_note: sh.opening_note, closed_by_name: sh.closed_by_name, forced: sh.forced } : null };
};
