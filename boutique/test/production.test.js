import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, near } from './shop-world.js';
import { verifyJournal } from '../server/stock.js';
import { verifyAudit } from '../server/audit.js';

test('migration 4 : journaux de production et de lots en lecture seule', async () => {
  const w = await shop();
  try {
    const p = await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.K), 201);
    const db = w.t.ctx.db;
    assert.throws(() => db.prepare('UPDATE batch_moves SET qty = 99').run(), /lecture seule/);
    assert.throws(() => db.prepare('DELETE FROM batch_moves').run(), /lecture seule/);
    assert.throws(() => db.prepare('UPDATE production_lines SET used_base = 1').run(), /ne se modifie pas/);
    assert.throws(() => db.prepare('DELETE FROM productions').run(), /ne se supprime pas/);
    assert.throws(() => db.prepare('UPDATE productions SET qty_obtained = 1 WHERE id = ?').run(p.id), /ne se modifie pas/);
    assert.throws(() => db.prepare('UPDATE productions SET cost_total = 0 WHERE id = ?').run(p.id), /ne se modifie pas/);
  } finally { await w.t.close(); }
});

test('plan : besoins, stock, manque ; les coûts restent cachés au cuisinier', async () => {
  const w = await shop();
  try {
    const plan = await w.ok(w.t.api.get(`/api/production/plan?recipe_id=${w.recipe.id}&servings=12`, w.K));
    const f = plan.lines.find((l) => l.name === 'Farine'), e = plan.lines.find((l) => l.name === 'Oeuf');
    near(f.planned, 720); near(e.planned, 9);
    assert.equal(plan.ready, true);
    assert.equal(plan.cost, undefined);
    assert.equal(f.avg, undefined);
    const big = await w.ok(w.t.api.get(`/api/production/plan?recipe_id=${w.recipe.id}&servings=40000`, w.M));
    assert.equal(big.ready, false);
    assert.ok(big.lines.find((l) => l.name === 'Farine').short > 0);
    near(big.cost, 40000 / 4 * 1.332, 'coût prévu', 1e-3);
    assert.equal((await w.t.api.get(`/api/production/plan?recipe_id=${w.recipe.id}&servings=0`, w.K)).status, 400);
    assert.equal((await w.t.api.get(`/api/production/plan?recipe_id=${w.recipe.id}&servings=4`, w.C)).status, 403);
  } finally { await w.t.close(); }
});

test('produire : stock sorti, coût réel, lot créé, journal cohérent', async () => {
  const w = await shop();
  try {
    const r = await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 8 }, w.K), 201); // 8 pers. = 2 × (2 tasses + 3 œufs) ; 16 crêpes
    near(r.qty_obtained, 16);
    assert.equal(r.cost_total, undefined, 'le cuisinier ne voit pas les coûts');
    near(w.stock(w.farine.id), 25000 - 480, 'farine');
    near(w.stock(w.oeuf.id), 30 - 6, 'oeufs');
    const m = await w.ok(w.t.api.get('/api/batches', w.M));
    const c = m.items.find((x) => x.id === w.crepe.id);
    assert.equal(c.balance, 16);
    near(c.unit_cost, 2.664 / 16, 'coût unitaire', 1e-9); // 2 × 1,332 € pour 16 crêpes
    const list = await w.ok(w.t.api.get('/api/productions', w.M));
    near(list.items[0].cost_total, 2.664, 'coût réel total', 1e-9);
    assert.equal(list.items[0].number, 'P-00001');
    assert.equal(verifyJournal(w.t.ctx.db).ok, true);
    assert.equal(verifyAudit(w.t.ctx.db).ok, true);
  } finally { await w.t.close(); }
});

test('quantité réellement utilisée ≠ prévue : le coût réel suit la réalité', async () => {
  const w = await shop();
  try {
    const r = await w.ok(w.t.api.post('/api/production', {
      recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4, qty_obtained: 7,
      used: [{ ingredient_id: w.farine.id, qty: 300, unit: 'g' }, { ingredient_id: w.oeuf.id, qty: 4, unit: 'piece' }],
    }, w.M), 201);
    near(r.cost_total, 300 * 0.0018 + 4 * 0.3, 'coût réel', 1e-9);
    near(r.unit_cost, (300 * 0.0018 + 1.2) / 7, 'coût par crêpe', 1e-9);
    near(w.stock(w.farine.id), 25000 - 300);
    const d = await w.ok(w.t.api.get(`/api/productions/${r.id}`, w.M));
    assert.equal(d.lines.find((l) => l.name === 'Farine').differs, true);
    assert.equal((await w.t.api.post('/api/production', { recipe_id: w.recipe.id, servings: 4, used: [{ ingredient_id: w.farine.id, qty: 1, unit: 'g' }, { ingredient_id: w.farine.id, qty: 2, unit: 'g' }] }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/production', { recipe_id: w.recipe.id, servings: 4, qty_obtained: 2.5, product_id: w.crepe.id }, w.M)).status, 400, 'des articles se comptent entiers');
  } finally { await w.t.close(); }
});

test('refus : stock insuffisant (liste précise), ingrédient non relié, mauvais article ; forçage réservé au gérant', async () => {
  const w = await shop();
  try {
    const big = { recipe_id: w.recipe.id, servings: 80000 };
    const r = await w.t.api.post('/api/production', big, w.K);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'insufficient');
    assert.match(r.data.error.message, /Farine/);
    assert.ok(r.data.error.shortages.length >= 1);
    assert.equal((await w.t.api.post('/api/production', { ...big, force: true }, w.K)).status, 409, 'le cuisinier ne force pas');
    assert.equal(w.stock(w.farine.id), 25000, 'rien n’a été écrit après le refus');
    const forced = await w.ok(w.t.api.post('/api/production', { ...big, force: true }, w.M), 201);
    assert.equal(forced.forced, true);
    assert.ok(w.stock(w.farine.id) < 0);

    const free = await w.ok(w.t.api.post('/api/recipes', { name: 'Libre', servings: 2, lines: [{ label: 'Épice rare', qty: 1, unit: 'pincée' }, { ingredient_id: w.farine.id, qty: 100, unit: 'g' }] }, w.O), 201);
    const u = await w.t.api.post('/api/production', { recipe_id: free.id, servings: 2 }, w.O);
    assert.equal(u.status, 400);
    assert.match(u.data.error.message, /Épice rare/);
    assert.equal((await w.t.api.post('/api/production', { recipe_id: free.id, product_id: w.crepe.id, servings: 2 }, w.O)).status, 400);
    assert.equal((await w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.minute.id, servings: 2 }, w.O)).status, 400, 'seul un article « préparé à l’avance » a des lots');
    assert.equal((await w.t.api.post('/api/production', { recipe_id: w.recipe.id, servings: 2 }, w.C)).status, 403);
  } finally { await w.t.close(); }
});

test('recette archivée : on peut produire (12 au lieu de 4)', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.post(`/api/recipes/${w.recipe.id}/archive`, {}, w.O));
    const r = await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 12 }, w.K), 201);
    near(r.qty_obtained, 24);
    near(w.stock(w.farine.id), 25000 - 720);
  } finally { await w.t.close(); }
});

test('annuler une production : stock remis au coût d’origine ; refusé si déjà vendu', async () => {
  const w = await shop();
  try {
    const before = w.avg(w.farine.id);
    const r = await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.M), 201);
    assert.equal((await w.t.api.post(`/api/productions/${r.id}/void`, { reason: 'x' }, w.K)).status, 403);
    assert.equal((await w.t.api.post(`/api/productions/${r.id}/void`, {}, w.M)).status, 400, 'motif obligatoire');
    await w.sellOk(w.C, [{ product_id: w.crepe.id, qty: 1 }], [{ method: 'cash', amount_cents: 150 }]);
    const blocked = await w.t.api.post(`/api/productions/${r.id}/void`, { reason: 'erreur' }, w.M);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error.code, 'already_sold');
    // un autre lot, rien vendu → annulable
    const r2 = await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.M), 201);
    const fa = w.stock(w.farine.id);
    await w.ok(w.t.api.post(`/api/productions/${r2.id}/void`, { reason: 'erreur de saisie' }, w.M));
    near(w.stock(w.farine.id), fa + 240);
    near(w.avg(w.farine.id), before, 'le coût moyen n’a pas bougé', 1e-12);
    assert.equal((await w.t.api.post(`/api/productions/${r2.id}/void`, { reason: 'encore' }, w.M)).status, 409);
    const bal = (await w.ok(w.t.api.get('/api/batches', w.M))).items.find((x) => x.id === w.crepe.id).balance;
    assert.equal(bal, 7, '8 produits − 1 vendu, le lot annulé disparaît');
    assert.equal(verifyJournal(w.t.ctx.db).ok, true);
  } finally { await w.t.close(); }
});

test('invendus et pertes d’articles préparés ; comptage', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.K), 201); // 8 crêpes
    const loss = (b, who = w.K) => w.t.api.post('/api/batches/loss', b, who);
    assert.equal((await loss({ product_id: w.crepe.id, qty: 3 })).status, 400, 'motif obligatoire');
    assert.equal((await loss({ product_id: w.crepe.id, qty: 3, reason: 'autre' })).status, 400, 'précisez');
    assert.equal((await loss({ product_id: w.crepe.id, qty: 9, reason: 'invendu' })).status, 409, 'plus que le stock');
    assert.equal((await loss({ product_id: w.crepe.id, qty: 1.5, reason: 'invendu' })).status, 400);
    const l = await w.ok(loss({ product_id: w.crepe.id, qty: 3, reason: 'invendu' }), 201);
    assert.equal(l.value, undefined, 'valeur cachée au cuisinier');
    const lm = await w.ok(loss({ product_id: w.crepe.id, qty: 1, reason: 'casse' }, w.M), 201);
    near(lm.value, 1.332 / 8, 'valeur de la perte', 1e-9);
    const c = await w.ok(w.t.api.post('/api/batches/count', { product_id: w.crepe.id, counted: 5 }, w.K));
    assert.equal(c.delta, 1);
    assert.equal((await w.ok(w.t.api.get('/api/batches', w.K))).items[0].balance, 5);
    assert.equal((await w.ok(w.t.api.get('/api/batches', w.K))).items[0].unit_cost, undefined);
    assert.equal((await w.t.api.post('/api/batches/count', { product_id: w.crepe.id, counted: -1 }, w.K)).status, 400);
  } finally { await w.t.close(); }
});

test('production liée à une commande traiteur : numéro invalide ou inexistant refusé', async () => {
  const w = await shop();
  try {
    const p = (order_id) => w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 1, order_id }, w.K);
    assert.equal((await p(99999)).status, 400);
    assert.equal((await p('abc')).status, 400);
    assert.equal((await p(1.5)).status, 400);
    assert.equal((await w.ok(w.t.api.get('/api/productions', w.M))).items?.length ?? 0, 0, 'rien n’a été produit');
  } finally { await w.t.close(); }
});
