import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { stateOf } from '../server/stock.js';

export const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} attendu ${b}, reçu ${a}`);
let uid = 0;
export const uuid = () => `t-${Date.now().toString(36)}-${(uid++).toString(36)}-xxxxxxxx`;

/** Boutique d'essai : farine (0,0018 €/g), œufs (0,30 €/pièce), eau (0,50 €/bouteille) ; recette Crêpes pour 4 = 1,332 €. */
export async function shop(opts) {
  const t = await boot(opts);
  const owner = await t.setup();
  const manager = await t.staff(owner, 'Mina', 'manager');
  const cook = await t.staff(owner, 'Yann', 'cook');
  const cashier = await t.staff(owner, 'Awa', 'cashier');
  const cashier2 = await t.staff(owner, 'Bao', 'cashier');
  const O = { token: owner }, M = { token: manager.token }, K = { token: cook.token }, C = { token: cashier.token }, C2 = { token: cashier2.token };
  if (!opts?.shifts) { const r = await t.api.put('/api/settings', { require_shift: 0 }, { token: owner }); assert.equal(r.status, 200, JSON.stringify(r.data)); } // les tests de la caisse n'ouvrent pas de quart ; test/shifts.test.js couvre le quart
  const ok = async (p, status = 200) => { const r = await p; assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
  const mk = (body) => ok(t.api.post('/api/ingredients', body, O), 201);
  const receive = (body) => ok(t.api.post('/api/stock/receipts', body, O), 201);
  const farine = await mk({ name: 'Farine', family: 'mass', equivalences: [{ unit: 'tasse', base_qty: 120 }] });
  const oeuf = await mk({ name: 'Oeuf', family: 'count' });
  const eau = await mk({ name: 'Eau 50cl', family: 'count' });
  await receive({ ingredient_id: farine.id, qty: 25, unit: 'kg', total_price: 45 });
  await receive({ ingredient_id: oeuf.id, qty: 30, unit: 'piece', total_price: 9 });
  await receive({ ingredient_id: eau.id, qty: 24, unit: 'piece', total_price: 12 });
  const recipe = await ok(t.api.post('/api/recipes', {
    name: 'Crêpes', category: 'Desserts', servings: 4, prep_min: 10, cook_min: 20, steps: 'Mélanger.',
    lines: [{ ingredient_id: farine.id, qty: 2, unit: 'tasse' }, { ingredient_id: oeuf.id, qty: 3, unit: 'piece' }],
  }, O), 201);
  const product = (b) => ok(t.api.post('/api/products', b, O), 201);
  const crepe = await product({ name: 'Crêpe', category: 'Desserts', kind: 'made', recipe_id: recipe.id, portions: 2, price_cents: 150, vat_pct: 10 });
  const minute = await product({ name: 'Crêpe minute', category: 'Desserts', kind: 'direct', recipe_id: recipe.id, portions: 1, price_cents: 400, vat_pct: 10 });
  const bouteille = await product({ name: 'Eau', category: 'Boissons', kind: 'resale', ingredient_id: eau.id, ingredient_qty: 1, price_cents: 200, vat_pct: 20 });
  const cafe = await product({ name: 'Café', category: 'Boissons', kind: 'free', price_cents: 100, vat_pct: 0 });
  const stock = (id) => stateOf(t.ctx.db, id).stock;
  const avg = (id) => stateOf(t.ctx.db, id).avg;
  const sell = (who, lines, payments, extra = {}) => t.api.post('/api/sales', { client_uuid: uuid(), lines, payments, ...extra }, who);
  const sellOk = async (who, lines, payments, extra) => { const r = await sell(who, lines, payments, extra); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.sale; };
  return { t, O, M, K, C, C2, owner, manager, cook, cashier, ok, mk, receive, farine, oeuf, eau, recipe, crepe, minute, bouteille, cafe, stock, avg, sell, sellOk, product };
}
