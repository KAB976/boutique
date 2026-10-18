import { tx } from './db.js';
import { bad, notFound } from './errors.js';
import { writeAudit } from './audit.js';
import { cents, text, number, dateStr } from './common.js';

const TYPES = { bogo: 'X achetés, Y offerts', bundle: 'Lot à prix fixe', percent: 'Pourcentage de remise', amount: 'Remise en euros par article' };
export { TYPES };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function cleanPromo(db, b, existing) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const get = (k, d = null) => (has(k) ? b[k] : existing?.[k] ?? d);
  const type = get('type');
  if (!TYPES[type]) throw bad('Choisissez le type de promotion.');
  const scope = get('scope');
  if (!['product', 'category', 'all'].includes(scope)) throw bad('Choisissez ce à quoi la promotion s’applique.');
  const o = {
    name: text(get('name'), 'Nom', { max: 60, min: 1 }), type, scope, product_id: null, category: '',
    buy_qty: null, free_qty: null, bundle_qty: null, bundle_price_cents: null, percent: null, amount_cents: null,
    starts_on: dateStr(get('starts_on'), 'Date de début', { nullable: true }), ends_on: dateStr(get('ends_on'), 'Date de fin', { nullable: true }),
    weekdays: '', time_from: null, time_to: null,
  };
  if (o.starts_on && o.ends_on && o.ends_on < o.starts_on) throw bad('La date de fin est avant la date de début.');
  if (scope === 'product') {
    const pid = get('product_id');
    if (!Number.isInteger(pid) || !db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid)) throw bad('Choisissez l’article concerné.');
    o.product_id = pid;
  } else if (scope === 'category') o.category = text(get('category', ''), 'Catégorie', { max: 40, min: 1 });
  if (type === 'bogo') {
    o.buy_qty = number(get('buy_qty'), 'Nombre achetés', { min: 1, max: 50, int: true });
    o.free_qty = number(get('free_qty'), 'Nombre offerts', { min: 1, max: 50, int: true });
  } else if (type === 'bundle') {
    o.bundle_qty = number(get('bundle_qty'), 'Nombre d’articles du lot', { min: 2, max: 100, int: true });
    o.bundle_price_cents = cents(get('bundle_price_cents'), 'Prix du lot', { min: 1 });
  } else if (type === 'percent') {
    o.percent = number(get('percent'), 'Pourcentage', { min: 0, max: 100, exclusiveMin: true });
  } else o.amount_cents = cents(get('amount_cents'), 'Remise par article', { min: 1 });
  const wd = get('weekdays', '');
  if (wd !== '' && wd !== null) {
    const list = String(wd).split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.every((x) => /^[0-6]$/.test(x))) throw bad('Jours de la semaine invalides.');
    o.weekdays = [...new Set(list)].sort().join(',');
  }
  const tf = get('time_from'), tt = get('time_to');
  if ((tf && !tt) || (!tf && tt)) throw bad('Indiquez l’heure de début ET l’heure de fin.');
  if (tf) {
    if (!TIME_RE.test(tf) || !TIME_RE.test(tt)) throw bad('Heures invalides (format HH:MM).');
    if (tf === tt) throw bad('L’heure de début et de fin sont identiques.');
    o.time_from = tf; o.time_to = tt;
  }
  return o;
}

const COLS = ['name', 'type', 'scope', 'product_id', 'category', 'buy_qty', 'free_qty', 'bundle_qty', 'bundle_price_cents', 'percent', 'amount_cents', 'starts_on', 'ends_on', 'weekdays', 'time_from', 'time_to'];

export function createPromo(db, ts, actor, body) {
  return tx(db, () => {
    const o = cleanPromo(db, body || {}, null);
    const r = db.prepare(`INSERT INTO promotions (${COLS.join(',')}, active, created_at, updated_at) VALUES (${COLS.map(() => '?').join(',')},1,?,?)`).run(...COLS.map((k) => o[k]), ts, ts);
    const id = Number(r.lastInsertRowid);
    writeAudit(db, ts, actor, 'promotion.create', { entity: 'promotion', entityId: id, detail: { name: o.name, type: o.type } });
    return id;
  });
}

export function updatePromo(db, ts, actor, id, body) {
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
    if (!cur) throw notFound('Promotion introuvable.');
    const b = body || {};
    const o = cleanPromo(db, b, cur);
    const active = Object.prototype.hasOwnProperty.call(b, 'active') ? (b.active ? 1 : 0) : cur.active;
    db.prepare(`UPDATE promotions SET ${COLS.map((k) => `${k}=?`).join(',')}, active=?, updated_at=? WHERE id=?`).run(...COLS.map((k) => o[k]), active, ts, id);
    const changes = {};
    for (const k of COLS) if (cur[k] !== o[k]) changes[k] = { from: cur[k], to: o[k] };
    if (cur.active !== active) changes.active = { from: cur.active, to: active };
    if (Object.keys(changes).length) writeAudit(db, ts, actor, 'promotion.update', { entity: 'promotion', entityId: id, detail: changes });
    return changes;
  });
}

export function setLoyalty(db, ts, actor, body) {
  const b = body || {};
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM loyalty_program WHERE id = 1').get();
    const o = {
      enabled: Object.prototype.hasOwnProperty.call(b, 'enabled') ? (b.enabled ? 1 : 0) : cur.enabled,
      spend_cents_per_stamp: Object.prototype.hasOwnProperty.call(b, 'spend_cents_per_stamp') ? cents(b.spend_cents_per_stamp, 'Dépense par tampon', { min: 1 }) : cur.spend_cents_per_stamp,
      stamps_needed: Object.prototype.hasOwnProperty.call(b, 'stamps_needed') ? number(b.stamps_needed, 'Tampons nécessaires', { min: 1, max: 1000, int: true }) : cur.stamps_needed,
      reward_cents: Object.prototype.hasOwnProperty.call(b, 'reward_cents') ? cents(b.reward_cents, 'Valeur de la récompense', { min: 1 }) : cur.reward_cents,
    };
    db.prepare('UPDATE loyalty_program SET enabled=?, spend_cents_per_stamp=?, stamps_needed=?, reward_cents=?, updated_at=? WHERE id=1').run(o.enabled, o.spend_cents_per_stamp, o.stamps_needed, o.reward_cents, ts);
    const changes = {};
    for (const k of Object.keys(o)) if (cur[k] !== o[k]) changes[k] = { from: cur[k], to: o[k] };
    if (Object.keys(changes).length) writeAudit(db, ts, actor, 'loyalty.update', { entity: 'loyalty', detail: changes });
    return changes;
  });
}
