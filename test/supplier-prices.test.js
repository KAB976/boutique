import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop } from './shop-world.js';

test('prix par fournisseur : comparaison au kg, moins cher repéré, historique, droits, bon de commande pré-rempli', async () => {
  const w = await shop({ shifts: true });
  try {
    const mk = async (name) => w.ok(w.t.api.post('/api/suppliers', { name }, w.M), 201);
    const a = await mk('Metro'), b = await mk('Grossiste Mamoudzou'), c = await mk('Marché');
    const sid = (x) => x.id ?? x;
    // farine = 1 (Farine, masse). Metro : 12,50 € pour 5 kg = 2,50 €/kg ; Grossiste : 4,60 € pour 2 kg = 2,30 €/kg ; Marché : 300 € pour 100 g (absurde mais valide) -> très cher
    const put = (body, who = w.M) => w.t.api.put('/api/ingredients/1/prices', body, who);
    const r = await w.ok(put({ prices: [
      { supplier_id: sid(a), price_cents: 1250, qty: 5, unit: 'kg' },
      { supplier_id: sid(b), price_cents: 460, qty: 2, unit: 'kg' },
    ] }));
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].supplier_name, 'Grossiste Mamoudzou'); assert.equal(r.items[0].cheapest, true); assert.equal(r.items[0].per_cents, 230); assert.equal(r.items[0].per_label, 'kg');
    assert.equal(r.items[1].cheapest, false); assert.equal(r.items[1].over_pct, 8.7); // 250 vs 230
    // la quantité peut être saisie dans une autre unité : 500 g à 1,10 € = 2,20 €/kg
    const r2 = await w.ok(put({ prices: [...r.items.map((x) => ({ supplier_id: x.supplier_id, price_cents: x.price_cents, qty: x.qty, unit: x.unit })), { supplier_id: sid(c), price_cents: 110, qty: 500, unit: 'g' }] }));
    assert.equal(r2.items[0].supplier_name, 'Marché'); assert.equal(r2.items[0].per_cents, 220);
    // validations
    for (const bad of [
      [{ supplier_id: sid(a), price_cents: -1, qty: 1, unit: 'kg' }], [{ supplier_id: sid(a), price_cents: 100, qty: 0, unit: 'kg' }],
      [{ supplier_id: 9999, price_cents: 100, qty: 1, unit: 'kg' }], [{ supplier_id: sid(a), price_cents: 100, qty: 1, unit: 'zzz' }],
      [{ supplier_id: sid(a), price_cents: 100, qty: 1, unit: 'kg' }, { supplier_id: sid(a), price_cents: 90, qty: 1, unit: 'kg' }],
    ]) assert.equal((await put({ prices: bad })).status, 400);
    assert.equal((await put({ prices: 'x' })).status, 400);
    // droits : le caissier et le cuisinier ne voient ni ne modifient
    for (const who of [w.C, w.K]) { assert.equal((await put({ prices: [] }, who)).status, 403); assert.equal((await w.t.api.get('/api/ingredients/1/prices', who)).status, 403); assert.equal((await w.t.api.get('/api/prices/compare', who)).status, 403); }
    // comparaison globale
    const cmp = await w.ok(w.t.api.get('/api/prices/compare', w.M));
    assert.equal(cmp.items.length, 1); assert.equal(cmp.items[0].name, 'Farine'); assert.equal(cmp.items[0].items[0].supplier_name, 'Marché'); assert.ok(cmp.items[0].saving_pct > 0);
    assert.ok(cmp.items[0].last_paid_cents > 0, 'dernier prix payé (réception)');
    assert.equal((await w.ok(w.t.api.get('/api/prices/compare?q=zzz', w.M))).items.length, 0);
    // historique : un seul enregistrement par changement de prix réel
    const n0 = w.t.ctx.db.prepare('SELECT COUNT(*) AS n FROM supplier_price_log').get().n; assert.equal(n0, 3);
    await w.ok(put({ prices: r2.items.map((x) => ({ supplier_id: x.supplier_id, price_cents: x.price_cents, qty: x.qty, unit: x.unit })) })); // rien ne change
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS n FROM supplier_price_log').get().n, 3);
    assert.throws(() => w.t.ctx.db.prepare('DELETE FROM supplier_price_log').run(), /lecture seule/);
    // bon de commande : le prix prévu se remplit tout seul avec le prix de CE fournisseur
    const po = await w.ok(w.t.api.post('/api/purchase-orders', { supplier_id: sid(b), lines: [{ ingredient_id: 1, qty: 3, unit: 'kg' }] }, w.M), 201);
    const id = po.id ?? po;
    const det = await w.ok(w.t.api.get(`/api/purchase-orders/${id}`, w.M));
    assert.equal(det.lines[0].expected_total_cents, 690); // 3 kg × 2,30 €
    const po2 = await w.ok(w.t.api.post('/api/purchase-orders', { supplier_id: sid(b), lines: [{ ingredient_id: 1, qty: 3, unit: 'kg', expected_total_cents: 800 }] }, w.M), 201);
    assert.equal((await w.ok(w.t.api.get(`/api/purchase-orders/${po2.id ?? po2}`, w.M))).lines[0].expected_total_cents, 800, 'un prix saisi à la main est respecté');
    // retirer un fournisseur
    const r3 = await w.ok(put({ prices: [{ supplier_id: sid(b), price_cents: 460, qty: 2, unit: 'kg' }] }));
    assert.equal(r3.items.length, 1);
    assert.ok(w.t.ctx.db.prepare("SELECT 1 FROM audit WHERE action = 'supplier_price.set'").get());
  } finally { await w.t.close(); }
});

test('le libellé d\'unité lisible est fourni avec chaque prix', async () => {
  const w = await shop({ shifts: true });
  try {
    const sup = await w.ok(w.t.api.post('/api/suppliers', { name: 'Metro' }, w.M), 201);
    const r = await w.ok(w.t.api.put('/api/ingredients/1/prices', { prices: [{ supplier_id: sup.id ?? sup, price_cents: 160, qty: 200, unit: 'g' }] }, w.M));
    assert.equal(r.items[0].unit_label, 'g');
    assert.equal(r.items[0].per_cents, 800); // 1,60 € les 200 g = 8,00 €/kg
  } finally { await w.t.close(); }
});
