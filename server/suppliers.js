import { tx } from './db.js';
import { assertDrawer } from './shifts.js';
import { bad, notFound, conflict } from './errors.js';
import { writeAudit } from './audit.js';
import { cents, text, number, dateStr, nextNumber } from './common.js';
import { loadIngredient, convertOrThrow, receive } from './stock.js';

export const balanceOf = (db, id) => db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM supplier_ledger WHERE supplier_id = ?').get(id).s; // > 0 : on doit de l'argent
export const PO_STATUS = { draft: 'Brouillon', sent: 'Envoyé', partial: 'Reçu en partie', received: 'Reçu', cancelled: 'Annulé' };

export function createSupplier(db, ts, actor, b) {
  const o = { name: text(b?.name, 'Nom', { max: 80, min: 1 }), phone: text(b?.phone ?? '', 'Téléphone', { max: 30 }), email: text(b?.email ?? '', 'Email', { max: 100 }), notes: text(b?.notes ?? '', 'Notes', { max: 500 }) };
  return tx(db, () => {
    const r = db.prepare('INSERT INTO suppliers (name, phone, email, notes, active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(o.name, o.phone, o.email, o.notes, ts, ts);
    writeAudit(db, ts, actor, 'supplier.create', { entity: 'supplier', entityId: Number(r.lastInsertRowid), detail: { name: o.name } });
    return Number(r.lastInsertRowid);
  });
}

export function updateSupplier(db, ts, actor, id, b) {
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!cur) throw notFound('Fournisseur introuvable.');
    const has = (k) => Object.prototype.hasOwnProperty.call(b || {}, k);
    const o = {
      name: text(has('name') ? b.name : cur.name, 'Nom', { max: 80, min: 1 }), phone: text(has('phone') ? b.phone : cur.phone, 'Téléphone', { max: 30 }),
      email: text(has('email') ? b.email : cur.email, 'Email', { max: 100 }), notes: text(has('notes') ? b.notes : cur.notes, 'Notes', { max: 500 }),
      active: has('active') ? (b.active ? 1 : 0) : cur.active,
    };
    if (!o.active && balanceOf(db, id) !== 0) throw conflict('Vous devez encore de l’argent à ce fournisseur (ou il vous en doit) : soldez le compte avant de le désactiver.', 'has_balance');
    db.prepare('UPDATE suppliers SET name=?, phone=?, email=?, notes=?, active=?, updated_at=? WHERE id=?').run(o.name, o.phone, o.email, o.notes, o.active, ts, id);
    const changes = {};
    for (const k of Object.keys(o)) if (cur[k] !== o[k]) changes[k] = { from: cur[k], to: o[k] };
    if (Object.keys(changes).length) writeAudit(db, ts, actor, 'supplier.update', { entity: 'supplier', entityId: id, detail: changes });
    return changes;
  });
}

function cleanLines(db, lines) {
  if (!Array.isArray(lines) || !lines.length) throw bad('Ajoutez au moins un ingrédient au bon de commande.');
  if (lines.length > 100) throw bad('100 lignes au maximum.');
  const seen = new Set();
  return lines.map((l, i) => {
    const ing = loadIngredient(db, l?.ingredient_id);
    if (!ing || !ing.active) throw notFound(`Ingrédient introuvable (ligne ${i + 1}).`);
    if (seen.has(ing.id)) throw bad(`« ${ing.name} » apparaît deux fois.`);
    seen.add(ing.id);
    const q = number(l.qty, `Quantité de ${ing.name}`, { min: 0, max: 1e9, exclusiveMin: true });
    const { base } = convertOrThrow(db, ing, q, l.unit);
    return { ingredient_id: ing.id, qty: q, unit: l.unit, base, expected_total_cents: cents(l.expected_total_cents ?? null, `Prix prévu de ${ing.name}`, { nullable: true }) };
  });
}

export function createPO(db, ts, actor, b) {
  return tx(db, () => {
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(b?.supplier_id);
    if (!sup || !sup.active) throw bad('Choisissez le fournisseur.');
    const lines = cleanLines(db, b.lines);
    const num = nextNumber(db, 'po', 'BC', { pad: 4 });
    const r = db.prepare('INSERT INTO purchase_orders (number, supplier_id, status, created_at, updated_at, expected_on, note, user_name) VALUES (?,?,?,?,?,?,?,?)')
      .run(num, sup.id, 'draft', ts, ts, dateStr(b.expected_on ?? null, 'Date prévue', { nullable: true }), text(b.note ?? '', 'Note', { max: 300 }), actor?.name ?? null);
    const id = Number(r.lastInsertRowid);
    lines.forEach((l, i) => db.prepare('INSERT INTO po_lines (po_id, pos, ingredient_id, qty, unit, base, expected_total_cents) VALUES (?,?,?,?,?,?,?)').run(id, i, l.ingredient_id, l.qty, l.unit, l.base, l.expected_total_cents));
    writeAudit(db, ts, actor, 'po.create', { entity: 'po', entityId: id, detail: { number: num, supplier: sup.name, lines: lines.length } });
    return id;
  });
}

export function updatePO(db, ts, actor, id, b) {
  return tx(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!po) throw notFound('Bon de commande introuvable.');
    if (po.status !== 'draft') throw conflict('Seul un brouillon se modifie. Annulez ce bon et créez-en un autre.', 'not_draft');
    const lines = cleanLines(db, b.lines);
    db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(id);
    lines.forEach((l, i) => db.prepare('INSERT INTO po_lines (po_id, pos, ingredient_id, qty, unit, base, expected_total_cents) VALUES (?,?,?,?,?,?,?)').run(id, i, l.ingredient_id, l.qty, l.unit, l.base, l.expected_total_cents));
    db.prepare('UPDATE purchase_orders SET updated_at=?, expected_on=?, note=? WHERE id=?').run(ts, dateStr(b.expected_on ?? po.expected_on, 'Date prévue', { nullable: true }), text(b.note ?? po.note, 'Note', { max: 300 }), id);
    writeAudit(db, ts, actor, 'po.update', { entity: 'po', entityId: id, detail: { number: po.number, lines: lines.length } });
  });
}

export function setPOStatus(db, ts, actor, id, status) {
  return tx(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!po) throw notFound('Bon de commande introuvable.');
    const ok = { sent: ['draft'], cancelled: ['draft', 'sent'] }[status];
    if (!ok) throw bad('Statut invalide.');
    if (!ok.includes(po.status)) throw conflict(`Un bon « ${PO_STATUS[po.status]} » ne peut pas passer à « ${PO_STATUS[status]} ».`, 'bad_status');
    db.prepare('UPDATE purchase_orders SET status=?, updated_at=? WHERE id=?').run(status, ts, id);
    writeAudit(db, ts, actor, `po.${status}`, { entity: 'po', entityId: id, detail: { number: po.number } });
  });
}

/** Quantités déjà reçues par ligne. */
export const receivedBase = (db, lineId) => db.prepare('SELECT COALESCE(SUM(base),0) AS s FROM po_receipt_lines WHERE po_line_id = ?').get(lineId).s;

/**
 * Réception (totale ou partielle) d'un bon : entre le stock (coût moyen mis à jour), puis inscrit la facture au compte du fournisseur.
 * b.lines : [{ po_line_id, qty, unit, total_cents?, expiry? }]   b.invoice_cents : total de la facture (défaut : somme des lignes)
 */
export function receivePO(db, ts, today, actor, id, b) {
  return tx(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
    if (!po) throw notFound('Bon de commande introuvable.');
    if (!['sent', 'partial', 'draft'].includes(po.status)) throw conflict(`Ce bon est « ${PO_STATUS[po.status]} ».`, 'bad_status');
    if (!Array.isArray(b?.lines) || !b.lines.length) throw bad('Indiquez ce qui a été reçu.');
    const plines = db.prepare('SELECT * FROM po_lines WHERE po_id = ?').all(id);
    const stockLines = [], recLines = [];
    const seen = new Set();
    for (const l of b.lines) {
      const pl = plines.find((x) => x.id === l?.po_line_id);
      if (!pl) throw bad('Ligne de bon inconnue.');
      if (seen.has(pl.id)) throw bad('Une ligne est indiquée deux fois.');
      seen.add(pl.id);
      const ing = loadIngredient(db, pl.ingredient_id);
      const q = number(l.qty, `Quantité reçue de ${ing.name}`, { min: 0, max: 1e9, exclusiveMin: true });
      const { base } = convertOrThrow(db, ing, q, l.unit);
      const total = cents(l.total_cents ?? null, `Prix de ${ing.name}`, { nullable: true });
      stockLines.push({ ingredient_id: ing.id, qty: q, unit: l.unit, total_price: total == null ? undefined : total / 100, expiry: l.expiry });
      recLines.push({ pl, base, total });
    }
    const moves = receive(db, ts, actor, stockLines, { canPrice: true, today, ref: po.number });
    const known = recLines.reduce((a, x) => a + (x.total ?? 0), 0);
    const invoice = b.invoice_cents === undefined || b.invoice_cents === null || b.invoice_cents === '' ? known : cents(b.invoice_cents, 'Total de la facture', { min: 0 });
    const rr = db.prepare('INSERT INTO po_receipts (po_id, ts, user_name, invoice_ref, invoice_cents, note) VALUES (?,?,?,?,?,?)')
      .run(id, ts, actor?.name ?? null, text(b.invoice_ref ?? '', 'Numéro de facture', { max: 60 }), invoice, text(b.note ?? '', 'Note', { max: 300 }));
    const rid = Number(rr.lastInsertRowid);
    recLines.forEach((x, i) => db.prepare('INSERT INTO po_receipt_lines (receipt_id, po_line_id, base, total_cents, move_id) VALUES (?,?,?,?,?)').run(rid, x.pl.id, x.base, x.total, moves[i].moveId));
    if (invoice > 0) {
      db.prepare('INSERT INTO supplier_ledger (supplier_id, ts, type, amount_cents, receipt_id, note, user_name) VALUES (?,?,?,?,?,?,?)')
        .run(po.supplier_id, ts, 'invoice', invoice, rid, `${po.number}${b.invoice_ref ? ` — facture ${b.invoice_ref}` : ''}`, actor?.name ?? null);
    }
    const complete = plines.every((pl) => receivedBase(db, pl.id) >= pl.base - 1e-9);
    const status = complete ? 'received' : 'partial';
    db.prepare('UPDATE purchase_orders SET status=?, updated_at=? WHERE id=?').run(status, ts, id);
    writeAudit(db, ts, actor, 'po.receive', { entity: 'po', entityId: id, detail: { number: po.number, status, invoice_cents: invoice } });
    return { receipt_id: rid, status, invoice_cents: invoice };
  });
}

export function paySupplier(db, ts, day, actor, id, b, { fromCash = false } = {}) {
  const amount = cents(b?.amount_cents, 'Montant', { min: 1 });
  const method = b?.method;
  if (!['cash', 'card', 'transfer', 'other'].includes(method)) throw bad('Choisissez le moyen de paiement.');
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!s) throw notFound('Fournisseur introuvable.');
    const bal = balanceOf(db, id);
    if (bal <= 0) throw conflict('Vous ne devez rien à ce fournisseur.', 'no_balance');
    if (amount > bal) throw conflict('Le paiement dépasse ce que vous lui devez.', 'too_much');
    const r = db.prepare('INSERT INTO supplier_ledger (supplier_id, ts, type, amount_cents, method, note, user_name) VALUES (?,?,?,?,?,?,?)').run(id, ts, 'payment', -amount, method, text(b.note ?? '', 'Note', { max: 200 }) || null, actor?.name ?? null);
    if (method === 'cash' && b.from_drawer) {
      assertDrawer(db, actor);
      db.prepare('INSERT INTO cash_moves (ts, day, amount_cents, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?)').run(ts, day, -amount, `Paiement fournisseur — ${s.name}`, `supplier:${Number(r.lastInsertRowid)}`, actor?.id ?? null, actor?.name ?? null);
    }
    writeAudit(db, ts, actor, 'supplier.payment', { entity: 'supplier', entityId: id, detail: { name: s.name, amount_cents: amount, method } });
    return { balance: bal - amount };
  });
}

export function adjustSupplier(db, ts, actor, id, b) {
  const amount = cents(b?.amount_cents, 'Montant', { min: -100_000_000 });
  if (amount === 0) throw bad('Le montant ne peut pas être zéro.');
  const note = text(b?.note, 'Raison', { max: 200, min: 1 });
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    if (!s) throw notFound('Fournisseur introuvable.');
    if (balanceOf(db, id) + amount < 0) throw conflict('La correction rendrait le compte négatif.', 'negative');
    db.prepare('INSERT INTO supplier_ledger (supplier_id, ts, type, amount_cents, note, user_name) VALUES (?,?,?,?,?,?)').run(id, ts, 'adjust', amount, note, actor?.name ?? null);
    writeAudit(db, ts, actor, 'supplier.adjust', { entity: 'supplier', entityId: id, detail: { name: s.name, amount_cents: amount, note } });
    return { balance: balanceOf(db, id) };
  });
}
