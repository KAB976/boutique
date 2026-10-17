import { tx } from './db.js';
import { bad, notFound, conflict } from './errors.js';
import { writeAudit } from './audit.js';
import { fmtBase, round6 } from '../shared/units.js';
import { number, text, nextNumber } from './common.js';
import { loadIngredient, stateOf, postMove, convertOrThrow, LOSS_REASONS } from './stock.js';
import { loadVersion, scaleVersion, getRecipe } from './recipes.js';
import { batchBalance, unitCost } from './products.js';

const EPS = 1e-9;
export const BATCH_LOSS_REASONS = { invendu: 'Invendu en fin de journée', ...LOSS_REASONS };

/** Besoins réels (rendement compris), regroupés par ingrédient. Rien n'est écrit. */
export function planProduction(db, recipeId, servings) {
  const rec = getRecipe(db, recipeId);
  const v = loadVersion(db, rec.id, null);
  const sc = scaleVersion(db, v, servings);
  const unlinked = v.lines.filter((l) => l.ingredient_id == null).map((l) => l.label);
  const byIng = new Map();
  for (const l of sc.lines) {
    if (l.ingredient_id == null) continue;
    const cur = byIng.get(l.ingredient_id) || { ingredient_id: l.ingredient_id, name: l.name, planned: 0 };
    cur.planned = round6(cur.planned + l.gross);
    byIng.set(l.ingredient_id, cur);
  }
  const lines = [...byIng.values()].map((x) => {
    const ing = loadIngredient(db, x.ingredient_id);
    const st = stateOf(db, ing.id);
    const stock = Math.max(0, st.stock);
    return {
      ingredient_id: ing.id, name: ing.name, family: ing.family, planned: x.planned, plannedText: fmtBase(x.planned, ing.family),
      stock, stockText: fmtBase(stock, ing.family), short: Math.max(0, round6(x.planned - stock)), shortText: fmtBase(Math.max(0, round6(x.planned - stock)), ing.family),
      enough: x.planned <= stock + EPS, avg: st.hasMoves ? st.avg : null, priced: st.hasMoves && st.avg > 0,
    };
  });
  return { recipe: { id: rec.id, name: rec.name, archived: Boolean(rec.archived), version: v.version, servings: v.servings }, servings, lines, unlinked, ready: !unlinked.length && lines.every((l) => l.enough) };
}

export function produce(db, ts, day, actor, body, { canForce = false } = {}) {
  const b = body || {};
  const recipeId = Number.isInteger(b.recipe_id) ? b.recipe_id : null;
  if (!recipeId) throw bad('Choisissez la recette.');
  const servings = number(b.servings, 'Nombre de personnes', { min: 0, max: 100000, exclusiveMin: true });
  const note = text(b.note ?? '', 'Note', { max: 300 });
  return tx(db, () => {
    const rec = getRecipe(db, recipeId);
    const v = loadVersion(db, rec.id, null);
    let product = null;
    if (b.product_id != null) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(b.product_id);
      if (!product || product.kind !== 'made' || product.recipe_id !== rec.id) throw bad('Cet article ne correspond pas à cette recette (il doit être de type « préparé à l’avance »).');
    }
    let orderId = null;
    if (b.order_id != null) {
      const o = Number.isInteger(b.order_id) ? db.prepare('SELECT id, status FROM catering_orders WHERE id = ?').get(b.order_id) : null;
      if (!o || !['confirmed', 'prepared'].includes(o.status)) throw bad('Cette commande traiteur n’existe pas ou n’est pas confirmée.');
      orderId = o.id;
    }
    const plan = planProduction(db, rec.id, servings);
    if (plan.unlinked.length) throw bad(`Cette recette contient des ingrédients qui ne sont pas dans votre liste d'ingrédients : ${plan.unlinked.join(', ')}. Reliez-les (Recettes → Modifier) avant de produire, sinon le stock serait faux.`, 'unlinked');
    const qtyDefault = round6(servings * (product?.portions ?? 1));
    const qty = b.qty_obtained === undefined || b.qty_obtained === null || b.qty_obtained === '' ? qtyDefault : number(b.qty_obtained, 'Quantité obtenue', { min: 0, max: 1e7 });
    if (product && !Number.isInteger(qty)) throw bad('La quantité obtenue d’un article se compte en nombre entier.');

    // consommation réelle : prévue, sauf indication contraire
    const actual = new Map();
    if (b.used !== undefined && b.used !== null) {
      if (!Array.isArray(b.used)) throw bad('Quantités utilisées invalides.');
      for (const u of b.used) {
        const ing = loadIngredient(db, u?.ingredient_id);
        if (!ing || !plan.lines.some((l) => l.ingredient_id === ing.id)) throw bad('Un ingrédient indiqué ne fait pas partie de cette recette.');
        if (actual.has(ing.id)) throw bad(`« ${ing.name} » est indiqué deux fois.`);
        actual.set(ing.id, convertOrThrow(db, ing, number(u.qty, `Quantité de ${ing.name}`, { min: 0, max: 1e9 }), u.unit, { allowZero: true }).base);
      }
    }
    const used = plan.lines.map((l) => ({ ...l, used: actual.has(l.ingredient_id) ? actual.get(l.ingredient_id) : l.planned }));
    const shortages = used.filter((l) => l.used > l.stock + EPS);
    if (shortages.length && !(b.force && canForce)) {
      throw conflict(`Stock insuffisant : ${shortages.map((l) => `${l.name} (il manque ${fmtBase(round6(l.used - l.stock), l.family)})`).join(', ')}.`, 'insufficient', { shortages: shortages.map((l) => ({ ingredient_id: l.ingredient_id, name: l.name, short: round6(l.used - l.stock), shortText: fmtBase(round6(l.used - l.stock), l.family) })), canForce });
    }

    const number_ = nextNumber(db, 'production', 'P', { datePart: null, pad: 5 });
    let total = 0;
    const out = [];
    for (const l of used) {
      const ing = loadIngredient(db, l.ingredient_id);
      let moveId = null, value = 0;
      if (l.used > 0) {
        const m = postMove(db, { ts, ing, type: 'production', qty: -l.used, ref: number_, note: `Production ${number_}`, entered: fmtBase(l.used, ing.family), user: actor });
        moveId = m.id; value = -m.value;
      }
      total += value;
      out.push({ ingredient_id: ing.id, name: ing.name, planned: l.planned, used: l.used, value, moveId, priced: l.priced || l.used === 0 });
    }
    const unit = qty > 0 ? total / qty : 0;
    const r = db.prepare(`INSERT INTO productions (number, ts, day, user_id, user_name, recipe_id, recipe_version, product_id, order_id, servings, qty_obtained, cost_total, unit_cost, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number_, ts, day, actor?.id ?? null, actor?.name ?? null, rec.id, v.version, product?.id ?? null, orderId, servings, qty, total, unit, note);
    const pid = Number(r.lastInsertRowid);
    out.forEach((x, i) => db.prepare('INSERT INTO production_lines (production_id, pos, ingredient_id, planned_base, used_base, value, move_id) VALUES (?,?,?,?,?,?,?)').run(pid, i, x.ingredient_id, x.planned, x.used, x.value, x.moveId));
    if (product && qty > 0) {
      db.prepare('INSERT INTO batch_moves (ts, production_id, product_id, type, qty, unit_cost, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(ts, pid, product.id, 'produce', qty, unit, number_, actor?.id ?? null, actor?.name ?? null);
    }
    const forced = shortages.length > 0;
    writeAudit(db, ts, actor, 'production.create', { entity: 'production', entityId: pid, detail: { number: number_, recipe: rec.name, servings, qty_obtained: qty, cost_total: total, forced } });
    return { id: pid, number: number_, qty_obtained: qty, cost_total: total, unit_cost: unit, incomplete: out.some((x) => !x.priced), forced, lines: out };
  });
}

export function voidProduction(db, ts, actor, id, reason) {
  const why = text(reason, 'Motif', { max: 200, min: 1 });
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
    if (!p) throw notFound('Production introuvable.');
    if (p.voided_at) throw conflict('Cette production est déjà annulée.', 'already_voided');
    if (p.product_id && p.qty_obtained > 0) {
      const bal = batchBalance(db, p.product_id);
      if (bal + EPS < p.qty_obtained) {
        throw conflict(`Impossible d'annuler : ${p.qty_obtained - Math.max(0, bal)} article(s) de ce lot sont déjà vendus ou retirés. Enregistrez plutôt une perte.`, 'already_sold');
      }
    }
    for (const l of db.prepare('SELECT * FROM production_lines WHERE production_id = ? AND move_id IS NOT NULL ORDER BY pos').all(id)) {
      const m = db.prepare('SELECT unit_cost FROM stock_moves WHERE id = ?').get(l.move_id);
      postMove(db, { ts, ing: loadIngredient(db, l.ingredient_id), type: 'void', qty: l.used_base, unitCost: m.unit_cost, ref: p.number, note: `Annulation ${p.number} : ${why}`, user: actor });
    }
    if (p.product_id && p.qty_obtained > 0) {
      db.prepare('INSERT INTO batch_moves (ts, production_id, product_id, type, qty, unit_cost, reason, ref, user_id, user_name) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(ts, id, p.product_id, 'void', -p.qty_obtained, p.unit_cost, why, p.number, actor?.id ?? null, actor?.name ?? null);
    }
    db.prepare('UPDATE productions SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(ts, actor?.name ?? null, why, id);
    writeAudit(db, ts, actor, 'production.void', { entity: 'production', entityId: id, detail: { number: p.number, reason: why } });
  });
}

/** Perte ou invendu d'un article préparé à l'avance. */
export function batchLoss(db, ts, actor, b) {
  const reason = b?.reason;
  if (!BATCH_LOSS_REASONS[reason]) throw bad('Choisissez le motif.');
  const note = text(b.note ?? '', 'Note', { max: 200 });
  if (reason === 'autre' && !note) throw bad('Précisez la raison dans la note.');
  const qty = number(b.qty, 'Quantité', { min: 0, max: 1e6, int: true, exclusiveMin: true });
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(b.product_id);
    if (!p || p.kind !== 'made') throw notFound('Article introuvable (seuls les articles préparés à l’avance ont un stock de lots).');
    const bal = batchBalance(db, p.id);
    if (qty > bal + EPS) throw conflict(`Il n'en reste que ${Math.max(0, bal)} en stock.`, 'insufficient');
    const uc = unitCost(db, p).cost ?? 0;
    const r = db.prepare('INSERT INTO batch_moves (ts, product_id, type, qty, unit_cost, reason, note, user_id, user_name) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(ts, p.id, 'loss', -qty, uc, reason, note || null, actor?.id ?? null, actor?.name ?? null);
    writeAudit(db, ts, actor, 'production.loss', { entity: 'product', entityId: p.id, detail: { product: p.name, qty, reason: BATCH_LOSS_REASONS[reason], value: qty * uc } });
    return { id: Number(r.lastInsertRowid), value: qty * uc, balance: bal - qty };
  });
}

/** Comptage des articles préparés : écrit l'écart. */
export function batchCount(db, ts, actor, b) {
  const counted = number(b?.counted, 'Quantité comptée', { min: 0, max: 1e6, int: true });
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(b.product_id);
    if (!p || p.kind !== 'made') throw notFound('Article introuvable.');
    const bal = batchBalance(db, p.id);
    const delta = counted - bal;
    if (delta === 0) return { delta: 0, balance: bal };
    const uc = unitCost(db, p).cost ?? 0;
    db.prepare('INSERT INTO batch_moves (ts, product_id, type, qty, unit_cost, reason, note, user_id, user_name) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(ts, p.id, 'adjust', delta, uc, 'comptage', text(b.note ?? '', 'Note', { max: 200 }) || null, actor?.id ?? null, actor?.name ?? null);
    writeAudit(db, ts, actor, 'production.count', { entity: 'product', entityId: p.id, detail: { product: p.name, before: bal, counted, delta } });
    return { delta, balance: counted };
  });
}
