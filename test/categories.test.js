import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop } from './shop-world.js';

test('catégories : listes de départ, ajout, renommage (les fiches suivent), fusion, suppression refusée si utilisée', async () => {
  const w = await shop({ shifts: true });
  try {
    const L = async (tok = w.O) => w.ok(w.t.api.get('/api/categories', tok));
    let c = await L();
    assert.ok(c.ingredient.some((x) => x.name === 'Produits laitiers'));
    assert.ok(c.recipe.some((x) => x.name === 'Petit déjeuner') && c.recipe.some((x) => x.name === 'Dessert'));
    assert.ok(c.product.some((x) => x.name === 'Boissons chaudes'));
    // le caissier lit (pour les menus) mais ne modifie pas
    assert.equal((await w.t.api.get('/api/categories', w.C)).status, 200);
    assert.equal((await w.t.api.post('/api/categories', { kind: 'recipe', name: 'Brunch' }, w.C)).status, 403);
    assert.equal((await w.t.api.post('/api/categories', { kind: 'recipe', name: 'Brunch' }, w.K)).status, 403);
    // ajout par le gérant ; doublon (casse ignorée) refusé ; type inconnu / nom vide refusés
    await w.ok(w.t.api.post('/api/categories', { kind: 'recipe', name: '  Brunch  ' }, w.M));
    assert.equal((await w.t.api.post('/api/categories', { kind: 'recipe', name: 'brunch' }, w.M)).status, 409);
    assert.equal((await w.t.api.post('/api/categories', { kind: 'zzz', name: 'x' }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/categories', { kind: 'recipe', name: '   ' }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/categories', { kind: 'recipe', name: 'x'.repeat(41) }, w.M)).status, 400);
    // une recette l'utilise → impossible à supprimer
    const sucre = await w.ok(w.t.api.post('/api/ingredients', { name: 'Sucre test', family: 'mass' }, w.O), 201);
    await w.ok(w.t.api.post('/api/recipes', { name: 'Pain d\'épice', category: 'Brunch', servings: 4, steps: 'Cuire.', lines: [{ ingredient_id: sucre.id, qty: 100, unit: 'g' }] }, w.O), 201);
    c = await L(); assert.equal(c.recipe.find((x) => x.name === 'Brunch').count, 1);
    const del = await w.t.api.post('/api/categories/delete', { kind: 'recipe', name: 'Brunch' }, w.O);
    assert.equal(del.status, 409); assert.equal(del.data.error?.code ?? del.data.code, 'in_use');
    // renommage : la recette suit
    const r = await w.ok(w.t.api.post('/api/categories/rename', { kind: 'recipe', from: 'Brunch', to: 'Petit déjeuner' }, w.O));
    assert.equal(r.merged, true); assert.equal(r.updated, 1);
    assert.equal(w.t.ctx.db.prepare("SELECT category FROM recipes WHERE name = 'Pain d''épice'").get().category, 'Petit déjeuner');
    c = await L(); assert.equal(c.recipe.some((x) => x.name === 'Brunch'), false); assert.equal(c.recipe.find((x) => x.name === 'Petit déjeuner').count, 1);
    // une catégorie vide se supprime
    await w.ok(w.t.api.post('/api/categories/delete', { kind: 'recipe', name: 'Snack' }, w.O));
    assert.equal((await L()).recipe.some((x) => x.name === 'Snack'), false);
    // une ancienne saisie libre apparaît dans la liste ; renommer l'ingrédient + la promotion par catégorie suit
    await w.ok(w.t.api.post('/api/ingredients', { name: 'Poivre', family: 'mass', category: 'Épices du monde' }, w.O), 201);
    assert.ok((await L()).ingredient.some((x) => x.name === 'Épices du monde' && x.count === 1));
    await w.ok(w.t.api.post('/api/categories/rename', { kind: 'ingredient', from: 'Épices du monde', to: 'Épices' }, w.O));
    assert.equal(w.t.ctx.db.prepare("SELECT category FROM ingredients WHERE name = 'Poivre'").get().category, 'Épices');
    const prodCat = w.t.ctx.db.prepare('SELECT category FROM products WHERE id = ?').get(w.minute.id).category;
    const promo = await w.t.api.post('/api/promotions', { name: 'Promo cat', type: 'percent', percent: 10, scope: 'category', category: prodCat }, w.O);
    assert.ok(prodCat, 'article de test sans catégorie'); assert.equal(promo.status, 201, JSON.stringify(promo.data));
    {
      await w.ok(w.t.api.post('/api/categories/rename', { kind: 'product', from: prodCat, to: 'Nouvelle cat' }, w.O));
      assert.equal(w.t.ctx.db.prepare("SELECT category FROM promotions WHERE name = 'Promo cat'").get().category, 'Nouvelle cat');
    }
    // journal d'audit
    const acts = w.t.ctx.db.prepare("SELECT action FROM audit WHERE action LIKE 'category.%'").all().map((x) => x.action);
    for (const a of ['category.create', 'category.rename', 'category.delete']) assert.ok(acts.includes(a), a);
  } finally { await w.t.close(); }
});
