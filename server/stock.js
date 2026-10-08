import { toBase, baseOfPack, breakdown, round6, packsProblem, unitOptions, fmtBase, FAMILIES, BASE, METRIC } from '../shared/units.js';
import { tx } from './db.js';
import { bad, conflict, notFound, forbidden } from './errors.js';
import { writeAudit } from './audit.js';

const EPS = 1e-9;
export const LOSS_REASONS = {
  perime: 'Périmé', casse: 'Cassé ou renversé', jete: 'Jeté', donne: 'Donné', personnel: 'Repas du personnel', autre: 'Autre',
};
const MAX_QTY = 1e9;

// ---------- chargement ----------

export function loadMeasures(db, { all = false } = {}) {
  const rows = db.prepare(`SELECT id, code, label, ml, builtin, active FROM measures ${all ? '' : 'WHERE active = 1'} ORDER BY builtin DESC, id`).all();
  return new Map(rows.map((r) => [r.code, { id: r.id, label: r.label, ml: r.ml, builtin: Boolean(r.builtin), active: Boolean(r.active) }]));
}

export function loadIngredient(db, id) {
  const r = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  if (!r) return null;
  return hydrate(db, r);
}

function hydrate(db, r) {
  const packs = db.prepare('SELECT label, contains FROM pack_levels WHERE ingredient_id = ? ORDER BY depth').all(r.id);
  const equivs = new Map(db.prepare('SELECT unit, base_qty FROM ingredient_equivs WHERE ingredient_id = ?').all(r.id).map((e) => [e.unit, e.base_qty]));
  return {
    id: r.id, name: r.name, category: r.category, family: r.family, yieldPct: r.yield_pct, density: r.density, pieceG: r.piece_g,
    threshold: r.threshold, purchaseDepth: r.purchase_depth, storage: r.storage, notes: r.notes, active: Boolean(r.active),
    packs, equivs,
  };
}

export const stateOf = (db, ingredientId) => {
  const m = db.prepare('SELECT stock_after, avg_after FROM stock_moves WHERE ingredient_id = ? ORDER BY id DESC LIMIT 1').get(ingredientId);
  return m ? { stock: m.stock_after, avg: m.avg_after, hasMoves: true } : { stock: 0, avg: 0, hasMoves: false };
};

export function unitLabel(ing, measures, unit) {
  if (unit.startsWith('pack:')) return ing.packs[Number(unit.slice(5))]?.label ?? unit;
  if (METRIC[unit]) return METRIC[unit].label;
  return measures.get(unit)?.label ?? unit;
}

const nf = (x) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 }).format(x);

/** Convertit ou refuse (400) avec l'explication. */
export function convertOrThrow(db, ing, qty, unit, { allowZero = false } = {}) {
  if (typeof unit !== 'string' || !unit) throw bad('Choisissez une unité.');
  const measures = loadMeasures(db, { all: true });
  const c = toBase(ing, measures, qty, unit);
  if (!c.ok) throw bad(c.reason, 'conversion');
  if (c.base > MAX_QTY) throw bad('Quantité trop grande.');
  if (!allowZero && !(c.base > 0)) throw bad('La quantité doit être supérieure à zéro.');
  return { base: c.base, entered: `${nf(qty)} ${unitLabel(ing, measures, unit)}` };
}

// ---------- calcul d'un mouvement (utilisé à l'écriture ET à la vérification) ----------

/** Nouveau stock et nouveau coût moyen pondéré après un mouvement. `unitCost` n'importe que pour une entrée. */
export function nextState(prev, type, qty, unitCost) {
  const stock = round6(prev.stock + qty);
  if ((type === 'receipt' || type === 'void') && qty > 0 && unitCost != null) {
    const avg = prev.stock > EPS ? (prev.stock * prev.avg + qty * unitCost) / (prev.stock + qty) : unitCost;
    return { stock, avg };
  }
  return { stock, avg: prev.avg };
}

function insertMove(db, row) {
  const r = db.prepare(`INSERT INTO stock_moves
    (ts, ingredient_id, type, qty, unit_cost, value, stock_after, avg_after, expiry, price_pending, fixes_move_id, inventory_id,
     reason, ref, note, entered, user_id, user_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.ts, row.ingredient_id, row.type, row.qty, row.unit_cost, row.value, row.stock_after, row.avg_after, row.expiry ?? null,
    row.price_pending ? 1 : 0, row.fixes_move_id ?? null, row.inventory_id ?? null, row.reason ?? null, row.ref ?? null,
    row.note ?? null, row.entered ?? null, row.user_id ?? null, row.user_name ?? null);
  return Number(r.lastInsertRowid);
}

/** Écrit un mouvement de quantité. Doit être appelé dans une transaction. */
export function postMove(db, { ts, ing, type, qty, unitCost = null, expiry = null, pricePending = false, reason = null, ref = null, note = null, entered = null, user = null, inventoryId = null }) {
  const prev = stateOf(db, ing.id);
  const isIn = qty > 0 && (type === 'receipt' || type === 'void');
  const uc = isIn && unitCost != null ? unitCost : prev.avg;
  const next = nextState(prev, type, qty, isIn ? uc : null);
  const id = insertMove(db, {
    ts, ingredient_id: ing.id, type, qty, unit_cost: uc, value: qty * uc, stock_after: next.stock, avg_after: next.avg, expiry,
    price_pending: pricePending, reason, ref, note, entered, user_id: user?.id, user_name: user?.name, inventory_id: inventoryId,
  });
  return { id, stock: next.stock, avg: next.avg, unitCost: uc, value: qty * uc, prevStock: prev.stock, prevAvg: prev.avg };
}

// ---------- lots présents (dérivés du journal : on suppose que le plus ancien part en premier) ----------

export function lotsOnHand(db, ingredientId) {
  let left = Math.max(0, stateOf(db, ingredientId).stock);
  const lots = [];
  const rows = db.prepare('SELECT id, ts, qty, expiry, type FROM stock_moves WHERE ingredient_id = ? AND qty > 0 ORDER BY id DESC').all(ingredientId);
  for (const r of rows) {
    if (left <= EPS) break;
    const rem = Math.min(left, r.qty);
    lots.push({ moveId: r.id, ts: r.ts, type: r.type, qty: r.qty, remaining: round6(rem), expiry: r.expiry });
    left = round6(left - rem);
  }
  return lots;
}

// ---------- réception, perte, inventaire, correction de prix ----------

export function cleanExpiry(expiry, today) {
  if (expiry == null || expiry === '') return null;
  if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))
    || new Date(`${expiry}T00:00:00Z`).toISOString().slice(0, 10) !== expiry) throw bad('Date de péremption invalide (format AAAA-MM-JJ).');
  if (expiry < today) throw bad('Cette date de péremption est déjà dépassée.');
  return expiry;
}

function cleanMoney(v, label) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9) throw bad(`${label} invalide.`);
  return n;
}
const cleanQty = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad('La quantité doit être un nombre.');
  return n;
};
const cleanText = (v, max, label) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > max) throw bad(`${label} trop long (${max} caractères au maximum).`);
  return v.trim();
};

/** lines : [{ ingredient_id, qty, unit, total_price|null, expiry, note }]. Tout ou rien. */
export function receive(db, ts, actor, lines, { canPrice, today, ref = null }) {
  if (!Array.isArray(lines) || !lines.length) throw bad('Aucune ligne à enregistrer.');
  if (lines.length > 100) throw bad('Cent lignes au maximum par réception.');
  return tx(db, () => {
    const out = [];
    for (const [i, l] of lines.entries()) {
      const at = lines.length > 1 ? ` (ligne ${i + 1})` : '';
      const ing = loadIngredient(db, Number(l?.ingredient_id));
      if (!ing || !ing.active) throw notFound(`Ingrédient introuvable${at}.`);
      const hasPrice = l.total_price !== undefined && l.total_price !== null && l.total_price !== '';
      if (hasPrice && !canPrice) throw forbidden('Seuls le gérant et le propriétaire saisissent les prix : enregistrez la réception sans prix.');
      const total = hasPrice ? cleanMoney(l.total_price, 'Prix') : null;
      const { base, entered } = convertOrThrow(db, ing, cleanQty(l.qty), l.unit);
      const expiry = cleanExpiry(l.expiry, today);
      const prevPrice = lastPrices(db, ing.id, 1)[0]?.unit_cost ?? null;
      const m = postMove(db, {
        ts, ing, type: 'receipt', qty: base, unitCost: total == null ? null : total / base, expiry, pricePending: total == null,
        ref, note: cleanText(l.note, 200, 'Note'), entered, user: actor,
      });
      out.push({ moveId: m.id, ingredient: ing, base, entered, total, unitCost: total == null ? null : total / base, prevPrice, prevAvg: m.prevAvg, newAvg: m.avg, stock: m.stock });
    }
    writeAudit(db, ts, actor, 'stock.receipt', { entity: 'stock', detail: { lines: out.map((o) => ({ ingredient: o.ingredient.name, entered: o.entered, base: o.base, priced: o.total != null })) } });
    return out;
  });
}

export function lose(db, ts, actor, { ingredient_id, qty, unit, reason, note }) {
  if (!LOSS_REASONS[reason]) throw bad('Choisissez le motif de la perte.');
  const n = cleanText(note, 200, 'Note');
  if (reason === 'autre' && !n) throw bad('Précisez la raison dans la note.');
  return tx(db, () => {
    const ing = loadIngredient(db, Number(ingredient_id));
    if (!ing || !ing.active) throw notFound('Ingrédient introuvable.');
    const { base, entered } = convertOrThrow(db, ing, cleanQty(qty), unit);
    const st = stateOf(db, ing.id);
    if (base > st.stock + EPS) {
      throw conflict(`Stock insuffisant pour « ${ing.name} » : il reste ${fmtBase(Math.max(0, st.stock), ing.family)}, vous voulez retirer ${fmtBase(base, ing.family)}.`, 'insufficient');
    }
    const m = postMove(db, { ts, ing, type: 'loss', qty: -base, reason, note: n, entered, user: actor });
    writeAudit(db, ts, actor, 'stock.loss', { entity: 'ingredient', entityId: ing.id, detail: { ingredient: ing.name, entered, reason: LOSS_REASONS[reason] } });
    return { moveId: m.id, ingredient: ing, base, value: -m.value, stock: m.stock };
  });
}

/** counts : [{ ingredient_id, parts: [{qty, unit}] }]. Retourne le calcul ; l'écrit seulement si commit=true. */
export function inventory(db, ts, actor, counts, { commit, note }) {
  if (!Array.isArray(counts) || !counts.length) throw bad('Aucun comptage saisi.');
  if (counts.length > 500) throw bad('Cinq cents lignes au maximum par inventaire.');
  const run = () => {
    const seen = new Set();
    const lines = [];
    for (const c of counts) {
      const ing = loadIngredient(db, Number(c?.ingredient_id));
      if (!ing || !ing.active) throw notFound('Ingrédient introuvable dans le comptage.');
      if (seen.has(ing.id)) throw bad(`« ${ing.name} » est compté deux fois.`);
      seen.add(ing.id);
      if (!Array.isArray(c.parts) || !c.parts.length) throw bad(`Aucune quantité pour « ${ing.name} ».`);
      let counted = 0;
      const entered = [];
      for (const p of c.parts) {
        const r = convertOrThrow(db, ing, cleanQty(p.qty), p.unit, { allowZero: true });
        counted = round6(counted + r.base);
        entered.push(r.entered);
      }
      const st = stateOf(db, ing.id);
      const delta = round6(counted - st.stock);
      lines.push({ ing, counted, theoretical: st.stock, delta: Math.abs(delta) < EPS ? 0 : delta, avg: st.avg, entered: entered.join(' + ') });
    }
    let invId = null;
    const variance = lines.reduce((s, l) => s + l.delta * l.avg, 0);
    if (commit) {
      const r = db.prepare('INSERT INTO inventories (ts, user_id, user_name, note, lines, variance_value) VALUES (?,?,?,?,?,?)')
        .run(ts, actor.id, actor.name, cleanText(note, 200, 'Note'), lines.length, variance);
      invId = Number(r.lastInsertRowid);
      for (const l of lines) {
        if (l.delta !== 0) postMove(db, { ts, ing: l.ing, type: 'inventory', qty: l.delta, note: null, entered: l.entered, user: actor, inventoryId: invId });
      }
      writeAudit(db, ts, actor, 'stock.inventory', {
        entity: 'inventory', entityId: invId,
        detail: { lines: lines.length, withGap: lines.filter((l) => l.delta !== 0).length, gaps: lines.filter((l) => l.delta !== 0).map((l) => ({ ingredient: l.ing.name, delta: l.delta })) },
      });
    }
    return { inventoryId: invId, variance, lines };
  };
  return commit ? tx(db, run) : run();
}

/** Complète le prix d'une réception faite sans prix. Réévalue le stock restant de ce lot. */
export function fixPrice(db, ts, actor, { move_id, total_price }) {
  const total = cleanMoney(total_price, 'Prix');
  return tx(db, () => {
    const mv = db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(Number(move_id));
    if (!mv || mv.type !== 'receipt' || !mv.price_pending) throw notFound('Cette réception n\'attend pas de prix.');
    if (db.prepare('SELECT 1 FROM stock_moves WHERE fixes_move_id = ?').get(mv.id)) throw conflict('Le prix de cette réception est déjà saisi.');
    const ing = loadIngredient(db, mv.ingredient_id);
    const lot = lotsOnHand(db, ing.id).find((l) => l.moveId === mv.id);
    const share = lot ? lot.remaining / mv.qty : 0;
    const delta = total - mv.value;
    const applied = delta * share;
    const prev = stateOf(db, ing.id);
    const avg = prev.stock > EPS ? Math.max(0, (prev.stock * prev.avg + applied) / prev.stock) : prev.avg;
    const id = insertMove(db, {
      ts, ingredient_id: ing.id, type: 'price_fix', qty: 0, unit_cost: total / mv.qty, value: applied, stock_after: prev.stock, avg_after: avg,
      fixes_move_id: mv.id, note: `Prix de la réception du ${mv.ts.slice(0, 10)} : ${total.toFixed(2)}`, user_id: actor.id, user_name: actor.name,
    });
    writeAudit(db, ts, actor, 'stock.price_fix', { entity: 'ingredient', entityId: ing.id, detail: { ingredient: ing.name, total, appliedToStock: applied } });
    return { moveId: id, ingredient: ing, avg, prevAvg: prev.avg, applied };
  });
}

// ---------- vérification du journal ----------

const close = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));

/** Rejoue tout le journal : stock = somme des lignes, coût moyen recalculé. Retourne la liste des écarts. */
export function verifyJournal(db) {
  const problems = [];
  const state = new Map();
  let count = 0;
  for (const m of db.prepare('SELECT * FROM stock_moves ORDER BY id').iterate()) {
    count++;
    const prev = state.get(m.ingredient_id) || { stock: 0, avg: 0 };
    let exp;
    if (m.type === 'price_fix') {
      exp = { stock: prev.stock, avg: prev.stock > EPS ? Math.max(0, (prev.stock * prev.avg + m.value) / prev.stock) : prev.avg };
      if (m.qty !== 0) problems.push({ moveId: m.id, problem: 'Une correction de prix ne doit pas changer la quantité.' });
    } else {
      exp = nextState(prev, m.type, m.qty, (m.type === 'receipt' || m.type === 'void') && m.qty > 0 ? m.unit_cost : null);
      if (!close(m.value, m.qty * m.unit_cost)) problems.push({ moveId: m.id, problem: 'Valeur incohérente avec quantité × coût.' });
      if (!((m.type === 'receipt' || m.type === 'void') && m.qty > 0) && !close(m.unit_cost, prev.avg)) {
        problems.push({ moveId: m.id, problem: 'Une sortie doit être valorisée au coût moyen du moment.' });
      }
    }
    if (!close(m.stock_after, exp.stock)) problems.push({ moveId: m.id, problem: `Stock après = ${m.stock_after}, recalculé = ${exp.stock}.` });
    if (!close(m.avg_after, exp.avg)) problems.push({ moveId: m.id, problem: `Coût moyen après = ${m.avg_after}, recalculé = ${exp.avg}.` });
    state.set(m.ingredient_id, { stock: m.stock_after, avg: m.avg_after });
  }
  // chaque ingrédient : stock courant = somme des quantités
  for (const r of db.prepare('SELECT ingredient_id, ROUND(SUM(qty), 6) AS s FROM stock_moves GROUP BY ingredient_id').all()) {
    const st = state.get(r.ingredient_id);
    if (!close(st.stock, r.s)) problems.push({ ingredientId: r.ingredient_id, problem: `Stock ${st.stock} différent de la somme des lignes ${r.s}.` });
  }
  return { ok: problems.length === 0, moves: count, problems };
}

// ---------- alertes ----------

export const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** Prix d'achat connus (saisis, ou complétés après coup), du plus récent au plus ancien. */
export function lastPrices(db, ingredientId, limit = 2) {
  return db.prepare(`SELECT m.id, m.ts, m.qty, COALESCE(f.unit_cost, m.unit_cost) AS unit_cost FROM stock_moves m
    LEFT JOIN stock_moves f ON f.fixes_move_id = m.id
    WHERE m.ingredient_id = ? AND m.type = 'receipt' AND (m.price_pending = 0 OR f.id IS NOT NULL) ORDER BY m.id DESC LIMIT ?`).all(ingredientId, limit);
}
export const priceHistory = (db, ingredientId, limit = 12) => lastPrices(db, ingredientId, limit).reverse();

export function alerts(db, { today, expiryDays, pricePct, windowDays = 30 }) {
  const low = [], expiring = [], priceRises = [];
  let pending = 0;
  for (const r of db.prepare('SELECT * FROM ingredients WHERE active = 1 ORDER BY lower(name)').all()) {
    const ing = hydrate(db, r);
    const st = stateOf(db, ing.id);
    if (ing.threshold != null && st.stock <= ing.threshold + EPS) {
      low.push({ id: ing.id, name: ing.name, family: ing.family, stock: st.stock, threshold: ing.threshold, empty: st.stock <= EPS });
    }
    for (const lot of lotsOnHand(db, ing.id)) {
      if (!lot.expiry) continue;
      const left = dayDiff(lot.expiry, today);
      if (left <= expiryDays) expiring.push({ id: ing.id, name: ing.name, family: ing.family, remaining: lot.remaining, expiry: lot.expiry, daysLeft: left });
    }
    const [last, prev] = lastPrices(db, ing.id);
    if (last && prev && prev.unit_cost > 0 && dayDiff(today, last.ts.slice(0, 10)) <= windowDays) {
      const pct = ((last.unit_cost - prev.unit_cost) / prev.unit_cost) * 100;
      if (pct >= pricePct) priceRises.push({ id: ing.id, name: ing.name, family: ing.family, from: prev.unit_cost, to: last.unit_cost, pct, date: last.ts.slice(0, 10) });
    }
    pending += db.prepare(`SELECT COUNT(*) AS c FROM stock_moves m WHERE m.ingredient_id = ? AND m.type = 'receipt' AND m.price_pending = 1
      AND NOT EXISTS (SELECT 1 FROM stock_moves f WHERE f.fixes_move_id = m.id)`).get(ing.id).c;
  }
  expiring.sort((a, b) => a.daysLeft - b.daysLeft);
  return { low, expiring, priceRises, pricePending: pending };
}

export function pendingPrices(db) {
  return db.prepare(`SELECT m.id, m.ts, m.qty, m.entered, i.id AS ingredient_id, i.name, i.family, m.user_name FROM stock_moves m
    JOIN ingredients i ON i.id = m.ingredient_id
    WHERE m.type = 'receipt' AND m.price_pending = 1 AND NOT EXISTS (SELECT 1 FROM stock_moves f WHERE f.fixes_move_id = m.id)
    ORDER BY m.id DESC`).all();
}

// ---------- liste de courses en vrais emballages ----------

/** Combien acheter pour couvrir un besoin, en emballages entiers du niveau d'achat de l'ingrédient. */
export function shoppingCalc(db, ing, needBase) {
  const st = stateOf(db, ing.id);
  const inStock = Math.max(0, st.stock);
  const missing = Math.max(0, round6(needBase - inStock));
  if (!ing.packs.length) return { needBase, inStock, missing, toBuyBase: missing, packs: null, leftover: 0 };
  const depth = Math.min(ing.purchaseDepth, ing.packs.length - 1);
  const per = baseOfPack(ing.packs, depth);
  const n = missing <= EPS ? 0 : Math.ceil(missing / per - 1e-9);
  const bought = n * per;
  return {
    needBase, inStock, missing, toBuyBase: round6(bought), packs: n, packLabel: ing.packs[depth].label, packBase: per,
    leftover: round6(inStock + bought - needBase), detail: breakdown(missing, ing.packs),
  };
}

// ---------- ingrédients : validation et écriture ----------

function cleanNumber(v, label, { min = 0, max, nullable = true, exclusiveMin = false }) {
  if (v === null || v === undefined || v === '') {
    if (nullable) return null;
    throw bad(`« ${label} » est obligatoire.`);
  }
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`« ${label} » doit être un nombre.`);
  if (exclusiveMin ? n <= min : n < min) throw bad(`« ${label} » doit être ${exclusiveMin ? 'supérieur' : 'supérieur ou égal'} à ${min}.`);
  if (n > max) throw bad(`« ${label} » est trop grand (maximum ${max}).`);
  return n;
}

function cleanIngredientInput(db, body, existing) {
  const b = body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  const name = has('name') ? b.name : existing?.name;
  if (typeof name !== 'string' || !name.trim()) throw bad('Le nom est obligatoire.');
  if (name.trim().length > 60) throw bad('Le nom est trop long (60 caractères au maximum).');
  out.name = name.trim().replace(/\s+/g, ' ');
  out.family = has('family') ? b.family : existing?.family;
  if (!FAMILIES.includes(out.family)) throw bad('Choisissez comment cet ingrédient se compte : poids, volume ou pièces.');
  out.category = has('category') ? (cleanText(b.category, 40, 'Catégorie') ?? '') : existing?.category ?? '';
  out.storage = has('storage') ? (cleanText(b.storage, 40, 'Lieu de stockage') ?? '') : existing?.storage ?? '';
  out.notes = has('notes') ? (cleanText(b.notes, 500, 'Notes') ?? '') : existing?.notes ?? '';
  out.yieldPct = has('yield_pct') ? cleanNumber(b.yield_pct, 'Rendement', { min: 0, max: 100, nullable: false, exclusiveMin: true }) : existing?.yieldPct ?? 100;
  out.density = has('density') ? cleanNumber(b.density, 'Densité', { min: 0, max: 20, exclusiveMin: true }) : existing?.density ?? null;
  out.pieceG = has('piece_g') ? cleanNumber(b.piece_g, 'Poids d\'une pièce', { min: 0, max: 100000, exclusiveMin: true }) : existing?.pieceG ?? null;
  if (out.family === 'mass' || out.family === 'volume') {
    // le poids d'une pièce n'a de sens que si on compte à la pièce ou si on veut passer du poids aux pièces : on le garde
  }
  const packsIn = has('packs') ? b.packs : existing?.packs ?? [];
  if (!Array.isArray(packsIn)) throw bad('Conditionnements invalides.');
  out.packs = packsIn.map((p) => ({ label: typeof p?.label === 'string' ? p.label.trim() : '', contains: typeof p?.contains === 'string' ? Number(p.contains.replace(',', '.')) : p?.contains }));
  const pp = packsProblem(out.packs);
  if (pp) throw bad(pp);
  const depth = has('purchase_depth') ? b.purchase_depth : existing?.purchaseDepth ?? 0;
  if (!Number.isInteger(depth) || depth < 0 || (out.packs.length ? depth >= out.packs.length : depth !== 0)) throw bad('Niveau d\'achat invalide.');
  out.purchaseDepth = depth;

  const measures = loadMeasures(db, { all: true });
  const eqIn = has('equivalences') ? b.equivalences : existing ? [...existing.equivs].map(([unit, base_qty]) => ({ unit, base_qty })) : [];
  if (!Array.isArray(eqIn)) throw bad('Équivalences invalides.');
  out.equivs = new Map();
  for (const e of eqIn) {
    if (!measures.has(e?.unit)) throw bad(`Mesure inconnue dans les équivalences : « ${e?.unit} ».`);
    if (out.equivs.has(e.unit)) throw bad(`La mesure « ${measures.get(e.unit).label} » est indiquée deux fois.`);
    out.equivs.set(e.unit, cleanNumber(e.base_qty, `Équivalence de ${measures.get(e.unit).label}`, { min: 0, max: 1e7, nullable: false, exclusiveMin: true }));
  }

  // seuil d'alerte : { qty, unit } converti dans l'unité de base
  if (has('threshold')) {
    const t = b.threshold;
    if (t === null || t === '' || t === undefined) out.threshold = null;
    else {
      const probe = { ...out, equivs: out.equivs };
      const r = toBase(probe, measures, cleanNumber(t.qty, 'Seuil d\'alerte', { min: 0, max: MAX_QTY, nullable: false }), t.unit || BASE[out.family].code);
      if (!r.ok) throw bad(r.reason, 'conversion');
      out.threshold = r.base;
    }
  } else out.threshold = existing?.threshold ?? null;
  return out;
}

const describe = (ing) => ({
  nom: ing.name, famille: ing.family, catégorie: ing.category, rendement: ing.yieldPct, densité: ing.density, poids_pièce: ing.pieceG,
  seuil: ing.threshold, achat_niveau: ing.purchaseDepth, stockage: ing.storage,
  conditionnement: ing.packs.map((p) => `${p.label}×${p.contains}`).join(' > '),
  équivalences: [...ing.equivs].map(([u, q]) => `${u}=${q}`).join(', '),
});

function writeIngredientParts(db, id, v) {
  db.prepare('DELETE FROM pack_levels WHERE ingredient_id = ?').run(id);
  v.packs.forEach((p, i) => db.prepare('INSERT INTO pack_levels (ingredient_id, depth, label, contains) VALUES (?,?,?,?)').run(id, i, p.label, p.contains));
  db.prepare('DELETE FROM ingredient_equivs WHERE ingredient_id = ?').run(id);
  for (const [unit, q] of v.equivs) db.prepare('INSERT INTO ingredient_equivs (ingredient_id, unit, base_qty) VALUES (?,?,?)').run(id, unit, q);
}

export function createIngredient(db, ts, actor, body) {
  return tx(db, () => {
    const v = cleanIngredientInput(db, body, null);
    if (db.prepare('SELECT 1 FROM ingredients WHERE active = 1 AND lower(name) = lower(?)').get(v.name)) throw conflict('Un ingrédient actif porte déjà ce nom.', 'name_taken');
    const r = db.prepare(`INSERT INTO ingredients (name, category, family, yield_pct, density, piece_g, threshold, purchase_depth, storage, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.name, v.category, v.family, v.yieldPct, v.density, v.pieceG, v.threshold, v.purchaseDepth, v.storage, v.notes, ts, ts);
    const id = Number(r.lastInsertRowid);
    writeIngredientParts(db, id, v);
    writeAudit(db, ts, actor, 'ingredient.create', { entity: 'ingredient', entityId: id, detail: { name: v.name, family: v.family } });
    return loadIngredient(db, id);
  });
}

export function updateIngredient(db, ts, actor, id, body) {
  return tx(db, () => {
    const cur = loadIngredient(db, id);
    if (!cur) throw notFound('Ingrédient introuvable.');
    const b = body || {};
    const hasActive = Object.prototype.hasOwnProperty.call(b, 'active');
    if (hasActive && typeof b.active !== 'boolean') throw bad('Valeur « actif » invalide.');
    const v = cleanIngredientInput(db, b, cur);
    const st = stateOf(db, id);
    if (v.family !== cur.family && st.hasMoves) throw conflict('On ne change pas la façon de compter un ingrédient qui a déjà des mouvements de stock : créez-en un nouveau.', 'family_locked');
    const active = hasActive ? b.active : cur.active;
    if (cur.active && !active && Math.abs(st.stock) > EPS) {
      throw conflict(`Le stock n'est pas vide (${fmtBase(st.stock, cur.family)}) : déclarez une perte ou faites un inventaire à zéro avant d'archiver.`, 'stock_not_empty');
    }
    if (active && db.prepare('SELECT 1 FROM ingredients WHERE active = 1 AND lower(name) = lower(?) AND id <> ?').get(v.name, id)) throw conflict('Un ingrédient actif porte déjà ce nom.', 'name_taken');
    db.prepare(`UPDATE ingredients SET name=?, category=?, family=?, yield_pct=?, density=?, piece_g=?, threshold=?, purchase_depth=?, storage=?, notes=?, active=?, updated_at=? WHERE id=?`)
      .run(v.name, v.category, v.family, v.yieldPct, v.density, v.pieceG, v.threshold, v.purchaseDepth, v.storage, v.notes, active ? 1 : 0, ts, id);
    writeIngredientParts(db, id, v);
    const before = describe(cur), after = describe({ ...v, id });
    const changes = {};
    for (const k of Object.keys(after)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k], to: after[k] };
    if (cur.active !== active) changes.actif = { from: cur.active, to: active };
    if (Object.keys(changes).length) {
      writeAudit(db, ts, actor, cur.active && !active ? 'ingredient.archive' : !cur.active && active ? 'ingredient.restore' : 'ingredient.update',
        { entity: 'ingredient', entityId: id, detail: { name: cur.name, ...changes } });
    }
    return loadIngredient(db, id);
  });
}

// ---------- mesures générales ----------

const measureSlug = (db, label) => {
  const base = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'mesure';
  let code = `m-${base}`, n = 2;
  while (db.prepare('SELECT 1 FROM measures WHERE code = ?').get(code)) code = `m-${base}-${n++}`;
  return code;
};
function cleanMeasure(label, ml) {
  const l = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : '';
  if (!l) throw bad('Le nom de la mesure est obligatoire.');
  if (l.length > 30) throw bad('Le nom de la mesure est trop long (30 caractères au maximum).');
  const v = cleanNumber(ml, 'Volume (ml)', { min: 0, max: 100000, nullable: false, exclusiveMin: true });
  return { label: l, ml: v };
}
export function createMeasure(db, ts, actor, { label, ml }) {
  return tx(db, () => {
    const m = cleanMeasure(label, ml);
    if (db.prepare('SELECT 1 FROM measures WHERE active = 1 AND lower(label) = lower(?)').get(m.label)) throw conflict('Une mesure porte déjà ce nom.', 'name_taken');
    const code = measureSlug(db, m.label);
    db.prepare('INSERT INTO measures (code, label, ml, builtin, created_at, updated_at) VALUES (?,?,?,0,?,?)').run(code, m.label, m.ml, ts, ts);
    writeAudit(db, ts, actor, 'measure.create', { entity: 'measure', entityId: code, detail: { label: m.label, ml: m.ml } });
    return { code, ...m, builtin: false, active: true };
  });
}
export function updateMeasure(db, ts, actor, code, body) {
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM measures WHERE code = ?').get(code);
    if (!cur) throw notFound('Mesure introuvable.');
    const b = body || {};
    const m = cleanMeasure('label' in b ? b.label : cur.label, 'ml' in b ? b.ml : cur.ml);
    let active = cur.active;
    if ('active' in b) {
      if (typeof b.active !== 'boolean') throw bad('Valeur « actif » invalide.');
      if (!b.active && cur.builtin) throw conflict('Les mesures de base ne peuvent pas être retirées (on peut changer leur volume).', 'builtin');
      if (!b.active && db.prepare('SELECT 1 FROM ingredient_equivs WHERE unit = ? LIMIT 1').get(code)) throw conflict('Cette mesure est utilisée dans la fiche d\'un ingrédient.', 'in_use');
      active = b.active ? 1 : 0;
    }
    if (active && db.prepare('SELECT 1 FROM measures WHERE active = 1 AND lower(label) = lower(?) AND code <> ?').get(m.label, code)) throw conflict('Une mesure porte déjà ce nom.', 'name_taken');
    db.prepare('UPDATE measures SET label=?, ml=?, active=?, updated_at=? WHERE code=?').run(m.label, m.ml, active, ts, code);
    const changes = {};
    if (cur.label !== m.label) changes.label = { from: cur.label, to: m.label };
    if (cur.ml !== m.ml) changes.ml = { from: cur.ml, to: m.ml };
    if (cur.active !== active) changes.active = { from: Boolean(cur.active), to: Boolean(active) };
    if (Object.keys(changes).length) writeAudit(db, ts, actor, 'measure.update', { entity: 'measure', entityId: code, detail: changes });
    return { code, ...m, builtin: Boolean(cur.builtin), active: Boolean(active) };
  });
}

export { unitOptions };
