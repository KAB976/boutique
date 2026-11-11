/**
 * Prix d'un ingrédient chez chaque fournisseur, pour acheter là où c'est le moins cher.
 * Un prix = « tant d'euros pour telle quantité » (ex. 12,50 € pour 5 kg, ou 1,20 € pour 1 brique) ; il est ramené au kg / au litre / à la pièce.
 */
import { tx } from './db.js';
import { bad, notFound } from './errors.js';
import { writeAudit } from './audit.js';
import { cents, number } from './common.js';
import { loadIngredient, convertOrThrow, lastPrices, loadMeasures, unitLabel } from './stock.js';

const SCALE = { mass: 1000, volume: 1000, count: 1 };
const PER = { mass: 'kg', volume: 'l', count: 'pièce' };

/** Prix en centimes pour une unité d'affichage (kg, l ou pièce). */
export const perDisplayCents = (row, family) => (row.price_cents / row.base) * (SCALE[family] ?? 1);

/** Prix de ce fournisseur pour une quantité donnée (en unité de base), ou null s'il n'a pas de prix enregistré. */
export function priceFor(db, supplierId, ingredientId, base) {
  const r = db.prepare('SELECT price_cents, base FROM supplier_prices WHERE supplier_id = ? AND ingredient_id = ?').get(supplierId, ingredientId);
  return r ? Math.round((r.price_cents / r.base) * base) : null;
}

function rowsOf(db, ing) {
  const rows = db.prepare(`SELECT p.*, s.name AS supplier_name, s.active AS supplier_active FROM supplier_prices p JOIN suppliers s ON s.id = p.supplier_id WHERE p.ingredient_id = ?`).all(ing.id);
  const measures = loadMeasures(db, { all: true });
  const items = rows.map((r) => ({ ...r, unit_label: unitLabel(ing, measures, r.unit), per_cents: perDisplayCents(r, ing.family) })).sort((a, b) => a.per_cents - b.per_cents || a.supplier_name.localeCompare(b.supplier_name, 'fr'));
  const best = items.find((x) => x.supplier_active)?.per_cents ?? null;
  return items.map((x) => ({
    supplier_id: x.supplier_id, supplier_name: x.supplier_name, supplier_active: Boolean(x.supplier_active),
    price_cents: x.price_cents, qty: x.qty, unit: x.unit, unit_label: x.unit_label, note: x.note, updated_at: x.updated_at, user_name: x.user_name,
    per_cents: Math.round(x.per_cents * 100) / 100, per_label: PER[ing.family],
    cheapest: best != null && x.supplier_active === 1 && Math.abs(x.per_cents - best) < 1e-9,
    over_pct: best != null && best > 0 && x.per_cents > best + 1e-9 ? Math.round(((x.per_cents - best) / best) * 1000) / 10 : 0,
  }));
}

export function pricesOf(db, ingId) {
  const ing = loadIngredient(db, ingId);
  if (!ing) throw notFound('Ingrédient introuvable.');
  return { ingredient_id: ing.id, name: ing.name, family: ing.family, per_label: PER[ing.family], items: rowsOf(db, ing) };
}

/** Remplace la liste des prix d'un ingrédient (un prix par fournisseur). */
export function setPrices(db, ts, actor, ingId, list) {
  const ing = loadIngredient(db, ingId);
  if (!ing) throw notFound('Ingrédient introuvable.');
  if (!Array.isArray(list)) throw bad('Liste de prix invalide.');
  if (list.length > 50) throw bad('50 fournisseurs au maximum par ingrédient.');
  const seen = new Set();
  const clean = list.map((l, i) => {
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(l?.supplier_id);
    if (!sup) throw bad(`Fournisseur inconnu (ligne ${i + 1}).`);
    if (seen.has(sup.id)) throw bad(`« ${sup.name} » apparaît deux fois : un seul prix par fournisseur.`);
    seen.add(sup.id);
    const qty = number(l.qty, `Quantité (${sup.name})`, { min: 0, max: 1e9, exclusiveMin: true });
    const { base } = convertOrThrow(db, ing, qty, l.unit);
    if (!(base > 0)) throw bad(`Quantité invalide (${sup.name}).`);
    return { sup, qty, unit: l.unit, base, price_cents: cents(l.price_cents, `Prix chez ${sup.name}`, { min: 0 }), note: String(l.note ?? '').slice(0, 200) };
  });
  return tx(db, () => {
    const before = new Map(db.prepare('SELECT * FROM supplier_prices WHERE ingredient_id = ?').all(ing.id).map((r) => [r.supplier_id, r]));
    const changes = [];
    for (const c of clean) {
      const o = before.get(c.sup.id);
      const same = o && o.price_cents === c.price_cents && Math.abs(o.base - c.base) < 1e-9 && o.unit === c.unit && Math.abs(o.qty - c.qty) < 1e-9 && o.note === c.note;
      if (same) continue;
      db.prepare(`INSERT INTO supplier_prices (ingredient_id, supplier_id, price_cents, qty, unit, base, note, updated_at, user_name) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(ingredient_id, supplier_id) DO UPDATE SET price_cents = excluded.price_cents, qty = excluded.qty, unit = excluded.unit, base = excluded.base, note = excluded.note, updated_at = excluded.updated_at, user_name = excluded.user_name`)
        .run(ing.id, c.sup.id, c.price_cents, c.qty, c.unit, c.base, c.note, ts, actor?.name ?? null);
      if (!o || o.price_cents !== c.price_cents || Math.abs(o.base - c.base) > 1e-9) {
        db.prepare('INSERT INTO supplier_price_log (ts, ingredient_id, supplier_id, price_cents, qty, unit, base, user_name) VALUES (?,?,?,?,?,?,?,?)').run(ts, ing.id, c.sup.id, c.price_cents, c.qty, c.unit, c.base, actor?.name ?? null);
      }
      changes.push({ fournisseur: c.sup.name, avant_cents: o?.price_cents ?? null, apres_cents: c.price_cents, quantite: `${c.qty} ${c.unit}` });
    }
    for (const [sid, o] of before) {
      if (!seen.has(sid)) {
        db.prepare('DELETE FROM supplier_prices WHERE ingredient_id = ? AND supplier_id = ?').run(ing.id, sid);
        changes.push({ fournisseur: db.prepare('SELECT name FROM suppliers WHERE id = ?').get(sid)?.name, retire: true, avant_cents: o.price_cents });
      }
    }
    if (changes.length) writeAudit(db, ts, actor, 'supplier_price.set', { entity: 'ingredient', entityId: ing.id, detail: { ingredient: ing.name, changes } });
    return pricesOf(db, ing.id);
  });
}

/** Comparaison de tous les ingrédients qui ont au moins un prix fournisseur. */
export function compareAll(db, { q = '' } = {}) {
  const ids = db.prepare('SELECT DISTINCT ingredient_id AS id FROM supplier_prices').all().map((r) => r.id);
  const out = [];
  for (const id of ids) {
    const ing = loadIngredient(db, id);
    if (!ing || !ing.active) continue;
    if (q && !ing.name.toLowerCase().includes(q.toLowerCase())) continue;
    const items = rowsOf(db, ing);
    const last = lastPrices(db, id, 1)[0];
    const best = items.find((x) => x.cheapest);
    const worst = items[items.length - 1];
    out.push({
      ingredient_id: id, name: ing.name, category: ing.category, family: ing.family, per_label: PER[ing.family], items,
      last_paid_cents: last ? Math.round(last.unit_cost * (SCALE[ing.family] ?? 1) * 100) : null,
      saving_pct: best && worst && worst.per_cents > best.per_cents ? Math.round(((worst.per_cents - best.per_cents) / worst.per_cents) * 1000) / 10 : 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export function registerSupplierPrices({ api, ctx, auth, need, iso, actorOf }) {
  api.get('/ingredients/:id/prices', auth, need('purchase_prices.view'), (req, res) => res.json(pricesOf(ctx.db, Number(req.params.id))));
  api.put('/ingredients/:id/prices', auth, need('purchasing.manage'), (req, res) => res.json(setPrices(ctx.db, iso(), actorOf(req.user), Number(req.params.id), req.body?.prices)));
  api.get('/prices/compare', auth, need('purchase_prices.view'), (req, res) => res.json({ items: compareAll(ctx.db, { q: String(req.query.q ?? '') }) }));
}
