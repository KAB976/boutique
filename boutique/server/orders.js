/**
 * Commandes envoyées à la cuisine (version 1.1).
 * Une commande = une « tournée » pour une étiquette (« Table 1 », « Mme Diallo »…). Plusieurs commandes peuvent avoir la même étiquette :
 * l'addition de la table = toutes ses commandes non payées. Le stock n'est touché qu'à l'encaissement (comme avant).
 * Statuts : sent (envoyée) → preparing (en préparation) → ready (prête) → served (servie) ; cancelled (annulée).
 */
import { tx } from './db.js';
import { bad, notFound, conflict, forbidden } from './errors.js';
import { writeAudit } from './audit.js';
import { nameKey } from '../shared/units.js';
import { text, number, nextNumber } from './common.js';
import { dayIn } from './backup.js';
import { can } from './permissions.js';

const UUID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const STATUS_LABELS = { sent: 'Envoyée', preparing: 'En préparation', ready: 'Prête', served: 'Servie', cancelled: 'Annulée' };
const MAX_LINES = 60;

export function orderView(db, id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return null;
  const lines = db.prepare('SELECT product_id, name, qty, unit_price_cents, kitchen, note FROM order_lines WHERE order_id = ? ORDER BY pos').all(id)
    .map((l) => ({ ...l, kitchen: Boolean(l.kitchen) }));
  return {
    id: o.id, number: o.number, label: o.label, note: o.note, status: o.status, statusLabel: STATUS_LABELS[o.status], day: o.day,
    user_id: o.user_id, user_name: o.user_name, created_at: o.created_at, preparing_at: o.preparing_at, preparing_by: o.preparing_by,
    ready_at: o.ready_at, ready_by: o.ready_by, served_at: o.served_at, served_by: o.served_by, cancelled_at: o.cancelled_at, cancel_reason: o.cancel_reason,
    paid: o.sale_id != null, sale_id: o.sale_id, lines, total_cents: lines.reduce((a, l) => a + l.qty * l.unit_price_cents, 0),
    has_kitchen: lines.some((l) => l.kitchen),
  };
}

export function createOrder(ctx, actor, body) {
  const db = ctx.db; const b = body || {};
  if (typeof b.client_uuid !== 'string' || !UUID_RE.test(b.client_uuid)) throw bad('Identifiant de commande manquant (rechargez la page).');
  const dup = db.prepare('SELECT id FROM orders WHERE client_uuid = ?').get(b.client_uuid);
  if (dup) return { duplicate: true, order: orderView(db, dup.id) };
  const label = text(b.label, 'Table ou client', { min: 1, max: 40 });
  const note = text(b.note ?? '', 'Remarque', { max: 200 });
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('La commande est vide.');
  if (b.lines.length > MAX_LINES) throw bad(`${MAX_LINES} lignes au maximum par commande.`);
  const ts = ctx.now().toISOString(); const day = dayIn(ctx.now(), ctx.tz());
  return tx(db, () => {
    const rows = b.lines.map((l, i) => {
      const p = Number.isInteger(l?.product_id) ? db.prepare('SELECT * FROM products WHERE id = ?').get(l.product_id) : null;
      if (!p) throw bad(`Article inconnu (ligne ${i + 1}).`);
      if (!p.active) throw bad(`« ${p.name} » n'est plus en vente.`);
      return { p, qty: number(l.qty, `Quantité de ${p.name}`, { min: 1, max: 99, int: true }), note: text(l.note ?? '', 'Remarque de ligne', { max: 120 }) };
    });
    const kitchen = rows.some((r) => r.p.to_kitchen);
    const number_ = nextNumber(db, `order:${day}`, 'C', { datePart: day });
    const r = db.prepare(`INSERT INTO orders (number, client_uuid, label, note, status, day, user_id, user_name, created_at, served_at, served_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(number_, b.client_uuid, label, note, kitchen ? 'sent' : 'served', day, actor?.id ?? null, actor?.name ?? null, ts, kitchen ? null : ts, kitchen ? null : '(rien à préparer)');
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO order_lines (order_id, pos, product_id, name, qty, unit_price_cents, kitchen, note) VALUES (?,?,?,?,?,?,?,?)');
    rows.forEach((x, i) => ins.run(id, i, x.p.id, x.p.name, x.qty, x.p.price_cents, x.p.to_kitchen ? 1 : 0, x.note));
    return { duplicate: false, order: orderView(db, id) };
  });
}

const FROM = { prepare: ['sent'], ready: ['sent', 'preparing'], unready: ['ready'], serve: ['ready'] };
const TO = { prepare: 'preparing', ready: 'ready', unready: 'preparing', serve: 'served' };
const PERM = { prepare: 'orders.kitchen', ready: 'orders.kitchen', unready: 'orders.kitchen', serve: 'orders.serve' };

/** Fait avancer une commande. Un double clic (déjà dans l'état demandé) ne fait rien et ne renvoie pas d'erreur. */
export function advanceOrder(ctx, actor, id, action) {
  const db = ctx.db; const ts = ctx.now().toISOString();
  if (!TO[action]) throw bad('Action inconnue.');
  if (!can(actor?.role, PERM[action])) throw forbidden('Vous n’avez pas le droit de faire cela.');
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw notFound('Commande introuvable.');
    if (o.status === TO[action]) return { changed: false, order: orderView(db, id) };
    if (!FROM[action].includes(o.status)) {
      throw conflict(o.status === 'cancelled' ? `La commande ${o.label} a été annulée.` : `La commande ${o.label} est déjà « ${STATUS_LABELS[o.status].toLowerCase()} ».`, 'bad_status');
    }
    const who = actor?.name ?? null;
    if (action === 'prepare') db.prepare('UPDATE orders SET status = ?, preparing_at = ?, preparing_by = ? WHERE id = ?').run('preparing', ts, who, id);
    else if (action === 'ready') db.prepare('UPDATE orders SET status = ?, ready_at = ?, ready_by = ?, preparing_at = COALESCE(preparing_at, ?), preparing_by = COALESCE(preparing_by, ?) WHERE id = ?').run('ready', ts, who, ts, who, id);
    else if (action === 'unready') db.prepare('UPDATE orders SET status = ?, ready_at = NULL, ready_by = NULL WHERE id = ?').run('preparing', id);
    else db.prepare('UPDATE orders SET status = ?, served_at = ?, served_by = ? WHERE id = ?').run('served', ts, who, id);
    return { changed: true, order: orderView(db, id) };
  });
}

export function cancelOrder(ctx, actor, id, reason) {
  const db = ctx.db; const ts = ctx.now().toISOString();
  const why = text(reason ?? '', 'Motif', { min: 3, max: 200 });
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw notFound('Commande introuvable.');
    if (o.status === 'cancelled') return { changed: false, order: orderView(db, id) };
    if (o.sale_id != null) throw conflict('Cette commande est déjà encaissée : faites un remboursement depuis « Ventes ».', 'paid');
    if (o.status === 'served') throw conflict('Cette commande est déjà servie.', 'bad_status');
    const mine = o.user_id != null && o.user_id === actor?.id;
    const early = ['sent'].includes(o.status);
    if (!(can(actor?.role, 'orders.cancel_any') || (mine && early && can(actor?.role, 'orders.take')))) {
      throw forbidden(mine ? 'La cuisine a déjà commencé : demandez au gérant d’annuler.' : 'Seul le gérant peut annuler la commande de quelqu’un d’autre.');
    }
    db.prepare('UPDATE orders SET status = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?').run('cancelled', ts, why, id);
    writeAudit(db, ts, actor, 'order.cancel', { entity: 'order', entityId: id, detail: { number: o.number, label: o.label, was: o.status, reason: why } });
    return { changed: true, order: orderView(db, id), was: o.status };
  });
}

/** Écran cuisine / salle : commandes en cours (envoyées, en préparation, prêtes) + dernières servies pour pouvoir corriger une erreur. */
export function board(db, tz, now) {
  const active = db.prepare("SELECT id FROM orders WHERE status IN ('sent','preparing','ready') ORDER BY created_at, id").all().map((r) => orderView(db, r.id));
  const since = new Date(now.getTime() - 3 * 3600_000).toISOString();
  const recent = db.prepare("SELECT id FROM orders WHERE status = 'served' AND served_at >= ? ORDER BY served_at DESC LIMIT 15").all(since).map((r) => orderView(db, r.id));
  return { active, recent, serverTime: now.toISOString(), tz };
}

/** Additions ouvertes : par étiquette, tout ce qui n'est pas encore encaissé ni annulé. */
export function openTabs(db) {
  const rows = db.prepare("SELECT id FROM orders WHERE sale_id IS NULL AND status <> 'cancelled' ORDER BY created_at, id").all().map((r) => orderView(db, r.id));
  const tabs = new Map();
  for (const o of rows) {
    const key = nameKey(o.label);
    if (!tabs.has(key)) tabs.set(key, { key, label: o.label, order_ids: [], lines: new Map(), total_cents: 0, first_at: o.created_at, statuses: new Set() });
    const t = tabs.get(key);
    t.order_ids.push(o.id); t.statuses.add(o.status); t.total_cents += o.total_cents;
    for (const l of o.lines) {
      const k = `${l.product_id}:${l.unit_price_cents}`;
      const cur = t.lines.get(k) ?? { product_id: l.product_id, name: l.name, unit_price_cents: l.unit_price_cents, qty: 0 };
      cur.qty += l.qty; t.lines.set(k, cur);
    }
  }
  return [...tabs.values()].map((t) => ({ ...t, lines: [...t.lines.values()], statuses: [...t.statuses] }));
}

/** Appelé par createSale, dans sa transaction : rattache les commandes à la vente. */
export function linkOrdersToSale(db, saleId, orderIds) {
  if (orderIds === undefined || orderIds === null) return [];
  if (!Array.isArray(orderIds) || orderIds.length > 100 || !orderIds.every((x) => Number.isInteger(x) && x > 0)) throw bad('Liste de commandes invalide.');
  const ids = [...new Set(orderIds)];
  for (const id of ids) {
    const o = db.prepare('SELECT id, label, status, sale_id FROM orders WHERE id = ?').get(id);
    if (!o) throw bad('Une commande de l’addition n’existe plus : rechargez les additions.');
    if (o.status === 'cancelled') throw conflict(`La commande ${o.label} a été annulée entre-temps : rechargez les additions.`, 'order_cancelled');
    if (o.sale_id != null) throw conflict(`L’addition ${o.label} vient d’être encaissée par quelqu’un d’autre.`, 'order_paid');
    db.prepare('UPDATE orders SET sale_id = ? WHERE id = ?').run(saleId, id);
  }
  return ids;
}
