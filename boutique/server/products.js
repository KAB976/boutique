import { tx } from './db.js';
import { bad, notFound, conflict } from './errors.js';
import { writeAudit } from './audit.js';
import { nameKey, round6 } from '../shared/units.js';
import { text, cents, number } from './common.js';
import { loadIngredient, stateOf, postMove } from './stock.js';
import { loadVersion, costLines } from './recipes.js';

const KINDS = {
  made: 'Préparé à l’avance (lots)',
  direct: 'Préparé à la commande',
  resale: 'Revendu tel quel',
  free: 'Sans stock (service, divers)',
};
export { KINDS };

export const portionsLabel = { made: 'Parts obtenues pour 1 personne de la recette', direct: 'Personnes de la recette utilisées par article' };

/** Coût d'une unité vendue. { cost, incomplete, source } — cost null si inconnu. */
export function unitCost(db, p) {
  if (p.kind === 'free') return { cost: 0, incomplete: false, source: 'aucun' };
  if (p.kind === 'resale') {
    const st = stateOf(db, p.ingredient_id);
    return st.hasMoves && st.avg > 0 ? { cost: st.avg * p.ingredient_qty, incomplete: false, source: 'stock' } : { cost: null, incomplete: true, source: 'stock' };
  }
  if (p.kind === 'made') {
    const last = db.prepare('SELECT unit_cost FROM productions WHERE product_id = ? AND voided_at IS NULL AND qty_obtained > 0 ORDER BY id DESC LIMIT 1').get(p.id);
    if (last) return { cost: last.unit_cost, incomplete: false, source: 'dernière production' };
  }
  const v = loadVersion(db, p.recipe_id, null);
  if (!v) return { cost: null, incomplete: true, source: 'recette' };
  const c = costLines(db, v.lines);
  const per = p.kind === 'direct' ? (c.total / v.servings) * (p.portions ?? 1) : c.total / (v.servings * (p.portions ?? 1));
  return { cost: per, incomplete: c.incomplete, source: 'recette' };
}

export const batchBalance = (db, productId) => round6(db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM batch_moves WHERE product_id = ?').get(productId).s);

/** Combien d'articles on peut encore servir (pour l'écran de caisse). null = illimité. */
export function available(db, p) {
  if (p.kind === 'free') return null;
  if (p.kind === 'made') return batchBalance(db, p.id);
  if (p.kind === 'resale') return Math.floor(Math.max(0, stateOf(db, p.ingredient_id).stock) / p.ingredient_qty + 1e-9);
  const v = loadVersion(db, p.recipe_id, null);
  let best = Infinity;
  for (const l of v.lines) {
    if (l.ingredient_id == null) continue;
    const ing = loadIngredient(db, l.ingredient_id);
    const per = ((l.base / v.servings) * (p.portions ?? 1)) / (ing.yieldPct / 100);
    if (per > 0) best = Math.min(best, Math.max(0, stateOf(db, l.ingredient_id).stock) / per);
  }
  return best === Infinity ? null : Math.floor(best + 1e-9);
}

export function cleanProduct(db, b, existing) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const kind = has('kind') ? b.kind : existing?.kind;
  if (!KINDS[kind]) throw bad('Choisissez le type d’article.');
  const name = text(has('name') ? b.name : existing?.name, 'Nom', { max: 60, min: 1 });
  const o = {
    kind, name,
    category: text(has('category') ? b.category : existing?.category ?? '', 'Catégorie', { max: 40 }),
    price_cents: cents(has('price_cents') ? b.price_cents : existing?.price_cents, 'Prix de vente'),
    vat_pct: number(has('vat_pct') ? b.vat_pct : existing?.vat_pct ?? 0, 'TVA', { min: 0, max: 100 }),
    sort: number(has('sort') ? b.sort : existing?.sort ?? 0, 'Ordre', { min: 0, max: 100000, int: true }),
    to_kitchen: (has('to_kitchen') ? Boolean(b.to_kitchen) : existing ? Boolean(existing.to_kitchen) : kind !== 'resale') ? 1 : 0,
    recipe_id: null, portions: null, ingredient_id: null, ingredient_qty: null,
  };
  if (kind === 'made' || kind === 'direct') {
    const rid = has('recipe_id') ? b.recipe_id : existing?.recipe_id;
    const rec = Number.isInteger(rid) ? db.prepare('SELECT id, name FROM recipes WHERE id = ?').get(rid) : null;
    if (!rec) throw bad('Choisissez la recette de cet article.');
    o.recipe_id = rec.id;
    o.portions = number(has('portions') ? b.portions : existing?.portions ?? 1, kind === 'made' ? 'Articles obtenus par personne' : 'Personnes par article', { min: 0, max: 100000, exclusiveMin: true });
  }
  if (kind === 'resale') {
    const iid = has('ingredient_id') ? b.ingredient_id : existing?.ingredient_id;
    const ing = Number.isInteger(iid) ? loadIngredient(db, iid) : null;
    if (!ing || !ing.active) throw bad('Choisissez l’ingrédient du stock vendu tel quel (ex. bouteille d’eau).');
    o.ingredient_id = ing.id;
    o.ingredient_qty = number(has('ingredient_qty') ? b.ingredient_qty : existing?.ingredient_qty ?? 1, 'Quantité du stock par article (unité de base)', { min: 0, max: 1e7, exclusiveMin: true });
  }
  const dup = db.prepare('SELECT id, name FROM products WHERE active = 1 AND id <> ?').all(existing?.id ?? 0).find((r) => nameKey(r.name) === nameKey(name));
  if (dup) throw conflict(`Un article « ${dup.name} » existe déjà.`, 'name_taken');
  return o;
}

const COLS = 'name, category, kind, price_cents, vat_pct, recipe_id, portions, ingredient_id, ingredient_qty, sort, to_kitchen';

export function createProduct(db, ts, actor, body) {
  return tx(db, () => {
    const o = cleanProduct(db, body || {}, null);
    const r = db.prepare(`INSERT INTO products (${COLS}, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
      .run(o.name, o.category, o.kind, o.price_cents, o.vat_pct, o.recipe_id, o.portions, o.ingredient_id, o.ingredient_qty, o.sort, o.to_kitchen, ts, ts);
    const id = Number(r.lastInsertRowid);
    writeAudit(db, ts, actor, 'product.create', { entity: 'product', entityId: id, detail: { name: o.name, kind: o.kind, price_cents: o.price_cents } });
    return id;
  });
}

export function updateProduct(db, ts, actor, id, body) {
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!cur) throw notFound('Article introuvable.');
    const b = body || {};
    if (b.kind && b.kind !== cur.kind) throw bad('Le type d’un article ne change pas : créez un nouvel article.');
    const o = cleanProduct(db, b, cur);
    const active = Object.prototype.hasOwnProperty.call(b, 'active') ? (b.active ? 1 : 0) : cur.active;
    if (active && !cur.active) {
      const dup = db.prepare('SELECT name FROM products WHERE active = 1 AND id <> ?').all(id).find((r) => nameKey(r.name) === nameKey(o.name));
      if (dup) throw conflict(`Un article « ${dup.name} » existe déjà.`, 'name_taken');
    }
    db.prepare(`UPDATE products SET name=?, category=?, price_cents=?, vat_pct=?, recipe_id=?, portions=?, ingredient_id=?, ingredient_qty=?, sort=?, to_kitchen=?, active=?, updated_at=? WHERE id=?`)
      .run(o.name, o.category, o.price_cents, o.vat_pct, o.recipe_id, o.portions, o.ingredient_id, o.ingredient_qty, o.sort, o.to_kitchen, active, ts, id);
    const changes = {};
    for (const k of ['name', 'category', 'price_cents', 'vat_pct', 'recipe_id', 'portions', 'ingredient_id', 'ingredient_qty', 'to_kitchen']) if (cur[k] !== o[k]) changes[k] = { from: cur[k], to: o[k] };
    if (cur.active !== active) changes.active = { from: cur.active, to: active };
    if (Object.keys(changes).length) writeAudit(db, ts, actor, 'product.update', { entity: 'product', entityId: id, detail: changes });
    return changes;
  });
}

export { postMove };
