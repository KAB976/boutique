import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, near, uuid } from './shop-world.js';
import { verifyJournal } from '../server/stock.js';
import { verifyAudit } from '../server/audit.js';
import { batchBalance } from '../server/products.js';

const cash = (n) => [{ method: 'cash', amount_cents: n }];

test('migration 5/6 : ventes, lignes, paiements, clôtures, compte client en lecture seule', async () => {
  const w = await shop();
  try {
    const s = await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], cash(100));
    const db = w.t.ctx.db;
    for (const sql of ['UPDATE sales SET total_cents = 1', 'DELETE FROM sales', 'UPDATE sale_lines SET qty = 9', 'DELETE FROM sale_lines', 'UPDATE payments SET amount_cents = 5', 'DELETE FROM payments']) {
      assert.throws(() => db.prepare(sql).run(), /ne se modifie pas|lannule|modifie/, sql);
    }
    assert.ok(s.id);
    await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], cash(100));
    await w.ok(w.t.api.post('/api/cash-moves', { amount_cents: 100, category: 'Monnaie / change', reason: 'test' }, w.C), 201);
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Zoé' }, w.C), 201)).id;
    await w.ok(w.t.api.put(`/api/customers/${cid}`, { credit_limit_cents: 1000 }, w.M));
    await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], [{ method: 'credit', amount_cents: 100 }], { customer_id: cid });
    await w.ok(w.t.api.put('/api/loyalty', { enabled: true, spend_cents_per_stamp: 100 }, w.M));
    await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], cash(100), { customer_id: cid });
    await w.ok(w.t.api.post('/api/closure', { counted_cents: 400, float_out_cents: 0 }, w.C), 201);
    assert.throws(() => db.prepare('UPDATE closures SET variance_cents = 0').run(), /ne se modifie pas/);
    assert.throws(() => db.prepare('DELETE FROM cash_moves').run(), /lecture seule/);
    assert.throws(() => db.prepare('DELETE FROM customer_ledger').run(), /lecture seule/);
    assert.throws(() => db.prepare('UPDATE loyalty_moves SET delta = 1').run(), /lecture seule/);
  } finally { await w.t.close(); }
});

test('vente simple : totaux, TVA, rendu de monnaie, numéro, coût, stock de chaque type d’article', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.K), 201); // 8 crêpes à 0,1665 €
    const s = await w.sellOk(w.C, [{ product_id: w.crepe.id, qty: 2 }, { product_id: w.bouteille.id, qty: 1 }, { product_id: w.cafe.id, qty: 1 }, { product_id: w.minute.id, qty: 2 }], cash(2000));
    // 2×1,50 + 2,00 + 1,00 + 2×4,00 = 14,00 €
    assert.equal(s.total_cents, 1400);
    assert.equal(s.subtotal_cents, 1400);
    assert.equal(s.discount_cents, 0);
    assert.equal(s.change_cents, 600);
    assert.deepEqual(s.payments, [{ method: 'cash', amount_cents: 1400, ref: null }]);
    assert.equal(s.vat_cents, 27 + 33 + 0 + 73); // 300 à 10 % → 27 ; 200 à 20 % → 33 ; 800 à 10 % → 73
    assert.match(s.number, /^V20261007-0001$/);
    assert.equal(s.cost, undefined, 'le caissier ne voit pas les coûts');
    const full = await w.ok(w.t.api.get(`/api/sales/${s.id}`, w.M));
    near(full.cost, 2 * (1.332 / 8) + 0.5 + 0 + 2 * (1.332 / 4), 'coût de la vente', 1e-9);
    assert.equal(batchBalance(w.t.ctx.db, w.crepe.id), 6);
    near(w.stock(w.eau.id), 23);
    near(w.stock(w.farine.id), 25000 - 240 - 120, 'farine : lot + 2 crêpes minute');
    near(w.stock(w.oeuf.id), 30 - 3 - 1.5);
    const s2 = await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], cash(100));
    assert.match(s2.number, /^V20261007-0002$/);
    assert.equal(verifyJournal(w.t.ctx.db).ok, true);
    assert.equal(verifyAudit(w.t.ctx.db).ok, true);
  } finally { await w.t.close(); }
});

test('paiement : incomplet refusé, mixte espèces + carte, dépassement hors espèces refusé, vente à zéro', async () => {
  const w = await shop();
  try {
    const L = [{ product_id: w.bouteille.id, qty: 2 }]; // 4,00 €
    const refuse = async (payments, status, re, extra) => { const r = await w.sell(w.C, L, payments, extra); assert.equal(r.status, status, JSON.stringify(r.data)); assert.match(r.data.error.message, re); };
    await refuse([], 400, /incomplet/);
    await refuse(cash(399), 400, /manque 0,01/);
    await refuse([{ method: 'card', amount_cents: 500 }], 400, /dépassent/);
    await refuse([{ method: 'bitcoin', amount_cents: 400 }], 400, /inconnu/);
    await refuse([{ method: 'cash', amount_cents: 4.5 }], 400, /invalide/);
    await refuse([{ method: 'cash', amount_cents: -400 }], 400, /inférieur/);
    await refuse(cash(400), 400, /identifiant/i, { client_uuid: 'x' });
    assert.equal((await w.sell(w.C, [], cash(0))).status, 400);
    assert.equal((await w.sell(w.C, [{ product_id: 9999, qty: 1 }], cash(100))).status, 400);
    assert.equal((await w.sell(w.C, [{ product_id: w.cafe.id, qty: 0 }], cash(100))).status, 400);
    assert.equal((await w.sell(w.C, [{ product_id: w.cafe.id, qty: 1.5 }], cash(100))).status, 400);
    assert.equal((await w.sell(w.K, [{ product_id: w.cafe.id, qty: 1 }], cash(100))).status, 403, 'le cuisinier ne vend pas');
    assert.equal(w.stock(w.eau.id), 24, 'aucun refus n’a touché au stock');
    const mixed = await w.sellOk(w.C, L, [{ method: 'card', amount_cents: 250 }, { method: 'cash', amount_cents: 200 }]);
    assert.equal(mixed.change_cents, 50);
    assert.deepEqual(mixed.payments.map((p) => [p.method, p.amount_cents]), [['card', 250], ['cash', 150]]);
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.by_method.cash, 150);
    assert.equal(pv.cash_expected_cents, 150);
  } finally { await w.t.close(); }
});

test('idempotence : le même identifiant ne crée jamais deux ventes ; prix périmé refusé en ligne', async () => {
  const w = await shop();
  try {
    const body = { client_uuid: uuid(), lines: [{ product_id: w.bouteille.id, qty: 1 }], payments: cash(200) };
    const a = await w.t.api.post('/api/sales', body, w.C);
    const b = await w.t.api.post('/api/sales', body, w.C);
    assert.equal(a.status, 201); assert.equal(b.status, 200);
    assert.equal(b.data.duplicate, true);
    assert.equal(a.data.sale.id, b.data.sale.id);
    assert.equal(w.stock(w.eau.id), 23, 'le stock n’est sorti qu’une fois');
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 1);
    await w.ok(w.t.api.put(`/api/products/${w.bouteille.id}`, { price_cents: 250 }, w.M));
    const stale = await w.t.api.post('/api/sales', { client_uuid: uuid(), lines: [{ product_id: w.bouteille.id, qty: 1, unit_price_cents: 200 }], payments: cash(200) }, w.C);
    assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'price_changed');
    const fresh = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1, unit_price_cents: 250 }], cash(250));
    assert.equal(fresh.total_cents, 250);
    await w.ok(w.t.api.put(`/api/products/${w.bouteille.id}`, { active: false }, w.M));
    assert.equal((await w.sell(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(250))).status, 400, 'article retiré de la vente');
  } finally { await w.t.close(); }
});

test('promotions de bout en bout : 2+1, lot, calendrier ; les centimes tombent juste', async () => {
  const w = await shop();
  try {
    const promo = (b) => w.ok(w.t.api.post('/api/promotions', b, w.M), 201);
    assert.equal((await w.t.api.post('/api/promotions', { name: 'x', type: 'bogo', scope: 'all', buy_qty: 2, free_qty: 1 }, w.C)).status, 403);
    await promo({ name: 'Crêpes 2+1', type: 'bogo', scope: 'product', product_id: w.crepe.id, buy_qty: 2, free_qty: 1 });
    let s = await w.sellOk(w.C, [{ product_id: w.crepe.id, qty: 3 }], cash(300));
    assert.equal(s.total_cents, 300);
    assert.equal(s.discount_cents, 150);
    assert.equal(s.lines[0].promo_label, 'Crêpes 2+1');
    s = await w.sellOk(w.C, [{ product_id: w.crepe.id, qty: 2 }], cash(300));
    assert.equal(s.total_cents, 300, 'seulement 2 : pas de remise');
    await promo({ name: '5 cafés 4 €', type: 'bundle', scope: 'product', product_id: w.cafe.id, bundle_qty: 5, bundle_price_cents: 400 });
    s = await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 5 }], cash(400));
    assert.equal(s.total_cents, 400);
    const lunch = await promo({ name: 'Happy hour', type: 'percent', scope: 'category', category: 'Boissons', percent: 50, time_from: '17:00', time_to: '19:00' });
    s = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200)); // 08:00 UTC = 11:00 à Mayotte : hors plage
    assert.equal(s.total_cents, 200);
    w.t.clock.t = new Date('2026-10-07T15:00:00Z'); // 18:00 à Mayotte
    s = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200));
    assert.equal(s.total_cents, 100);
    await w.ok(w.t.api.put(`/api/promotions/${lunch.id}`, { active: false }, w.M));
    s = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200));
    assert.equal(s.total_cents, 200);
    assert.equal((await w.t.api.post('/api/promotions', { name: 'x', type: 'percent', scope: 'all', percent: 150 }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/promotions', { name: 'x', type: 'bundle', scope: 'all', bundle_qty: 1, bundle_price_cents: 100 }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/promotions', { name: 'x', type: 'percent', scope: 'all', percent: 10, time_from: '10:00' }, w.M)).status, 400);
  } finally { await w.t.close(); }
});

test('remise libre : réservée au gérant, motif obligatoire, tracée ; répartie au centime', async () => {
  const w = await shop();
  try {
    const L = [{ product_id: w.crepe.id, qty: 1 }, { product_id: w.bouteille.id, qty: 1 }, { product_id: w.cafe.id, qty: 1 }]; // 4,50 €
    assert.equal((await w.sell(w.C, L, cash(500), { discount_cents: 100, discount_reason: 'client fidèle' })).status, 403);
    assert.equal((await w.sell(w.M, L, cash(500), { discount_cents: 100 })).status, 400);
    assert.equal((await w.sell(w.M, L, cash(500), { discount_cents: 451, discount_reason: 'x' })).status, 400);
    const s = await w.sellOk(w.M, L, cash(500), { discount_cents: 100, discount_reason: 'geste commercial' });
    assert.equal(s.total_cents, 350);
    assert.equal(s.lines.reduce((a, l) => a + l.total_cents, 0), 350, 'la somme des lignes = le total');
    assert.equal(s.lines.reduce((a, l) => a + l.discount_cents, 0), 100);
    const audit = await w.ok(w.t.api.get('/api/audit?actionPrefix=sale.discount', w.O));
    assert.ok(JSON.stringify(audit).includes('geste commercial'));
  } finally { await w.t.close(); }
});

test('fidélité : tampons gagnés, récompense utilisée, restitués à l’annulation', async () => {
  const w = await shop();
  try {
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Fatima', phone: '0639' }, w.C), 201)).id;
    await w.ok(w.t.api.put('/api/loyalty', { enabled: true, spend_cents_per_stamp: 100, stamps_needed: 5, reward_cents: 500 }, w.M));
    assert.equal((await w.t.api.put('/api/loyalty', { enabled: true }, w.C)).status, 403);
    assert.equal((await w.t.api.put('/api/loyalty', { stamps_needed: 0 }, w.M)).status, 400);
    const none = await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400)); // sans client : pas de tampons
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM loyalty_moves').get().c, 0); assert.ok(none.id);
    const s1 = await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }, { product_id: w.bouteille.id, qty: 1 }], cash(600), { customer_id: cid }); // 6 € → 6 tampons
    const stamps = async () => (await w.ok(w.t.api.get(`/api/customers/${cid}`, w.C))).stamps;
    assert.equal(await stamps(), 6);
    assert.equal((await w.sell(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400), { redeem_loyalty: true })).status, 400, 'il faut un client');
    const s2 = await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 2 }], cash(400), { customer_id: cid, redeem_loyalty: true }); // 8 € − 5 € = 3 €
    assert.equal(s2.total_cents, 300);
    assert.equal(s2.discount_cents, 500);
    assert.equal(await stamps(), 6 - 5 + 3);
    const poor = await w.ok(w.t.api.post('/api/customers', { name: 'Nouveau' }, w.C), 201);
    assert.equal((await w.sell(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400), { customer_id: poor.id, redeem_loyalty: true })).status, 400, 'pas assez de tampons');
    await w.ok(w.t.api.post(`/api/sales/${s2.id}/refund`, { reason: 'erreur' }, w.C), 201);
    assert.equal(await stamps(), 6, 'tampons dépensés rendus, tampons gagnés retirés');
    await w.ok(w.t.api.post(`/api/sales/${s1.id}/refund`, { reason: 'erreur' }, w.C), 201);
    assert.equal(await stamps(), 0);
    assert.equal((await w.t.api.post(`/api/customers/${cid}/stamps`, { delta: -1, note: 'x' }, w.M)).status, 409, 'jamais de tampons négatifs');
    assert.equal((await w.ok(w.t.api.post(`/api/customers/${cid}/stamps`, { delta: 2, note: 'cadeau' }, w.M))).stamps, 2);
  } finally { await w.t.close(); }
});

test('annulation (avoir) : stock rendu, paiements inversés, une seule fois, droits du caissier', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.K), 201);
    const L = [{ product_id: w.crepe.id, qty: 2 }, { product_id: w.bouteille.id, qty: 1 }, { product_id: w.minute.id, qty: 1 }];
    const farine = w.stock(w.farine.id), eau = w.stock(w.eau.id);
    const s = await w.sellOk(w.C, L, [{ method: 'card', amount_cents: 300 }, { method: 'cash', amount_cents: 1000 }]); // 3 + 2 + 4 = 9 €
    assert.equal(s.total_cents, 900);
    assert.equal((await w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'x' }, w.C2)).status, 403, 'pas la vente d’un collègue');
    assert.equal((await w.t.api.post(`/api/sales/${s.id}/refund`, {}, w.C)).status, 400, 'motif obligatoire');
    assert.equal((await w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'x' }, w.K)).status, 403);
    const r = await w.ok(w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'erreur de saisie' }, w.C), 201);
    assert.match(r.number, /^A20261007-0001$/);
    assert.equal(r.kind, 'refund'); assert.equal(r.total_cents, -900);
    assert.deepEqual(r.payments.map((p) => [p.method, p.amount_cents]), [['card', -300], ['cash', -600]]);
    assert.equal(r.lines[0].qty, -2);
    assert.equal(batchBalance(w.t.ctx.db, w.crepe.id), 8);
    near(w.stock(w.eau.id), eau); near(w.stock(w.farine.id), farine, 'farine rendue', 1e-9);
    const dbl = await w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'encore' }, w.C);
    assert.equal(dbl.status, 409); assert.equal(dbl.data.error.code, 'already_refunded');
    assert.equal((await w.t.api.post(`/api/sales/${r.id}/refund`, { reason: 'x' }, w.M)).status, 400, 'on n’annule pas une annulation');
    const orig = await w.ok(w.t.api.get(`/api/sales/${s.id}`, w.C));
    assert.equal(orig.refunded_by.number, r.number);
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.sales_cents - pv.refunds_cents, 0);
    assert.equal(pv.cash_expected_cents, 0, 'la caisse revient à zéro');
    assert.equal(verifyJournal(w.t.ctx.db).ok, true);

    // sans remise en stock (produit jeté)
    const s2 = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200));
    const r2 = await w.ok(w.t.api.post(`/api/sales/${s2.id}/refund`, { reason: 'client parti', restock: false }, w.C), 201);
    near(w.stock(w.eau.id), eau - 1);
    assert.ok(r2.flags.includes('no_restock'));
  } finally { await w.t.close(); }
});

test('annulation après clôture ou un autre jour : le caissier ne peut plus, le gérant oui (tracé)', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.put('/api/settings', { session_hours: 72 }, w.O));
    const s = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200));
    const s2 = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200));
    await w.ok(w.t.api.post('/api/closure', { counted_cents: 400, float_out_cents: 0 }, w.C), 201);
    const late = await w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'x' }, w.C);
    assert.equal(late.status, 403); assert.match(late.data.error.message, /clôture/);
    const r = await w.ok(w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'erreur découverte plus tard' }, w.M), 201);
    assert.ok(r.flags.includes('after_closure'));
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.cash_expected_cents, -200, 'le remboursement pèse sur la période suivante');
    w.t.clock.t = new Date('2026-10-08T08:00:00Z');
    const s3 = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 1 }], cash(200));
    w.t.clock.t = new Date('2026-10-09T08:00:00Z');
    assert.equal((await w.t.api.post(`/api/sales/${s3.id}/refund`, { reason: 'x' }, w.C)).status, 403, 'le lendemain');
    assert.ok(s2.id);
  } finally { await w.t.close(); }
});

test('clôture : attendu, écart (note obligatoire), fond de caisse, dépôt, périodes consécutives', async () => {
  const w = await shop();
  try {
    assert.equal((await w.t.api.post('/api/closure', { counted_cents: 0 }, w.C)).status, 409, 'rien à clôturer');
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(500));   // 4,00 espèces
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'card', amount_cents: 400 }]);
    await w.ok(w.t.api.post('/api/cash-moves', { amount_cents: 5000, category: 'Ajout de fond de caisse', reason: 'Fond de caisse du matin' }, w.C), 201);
    await w.ok(w.t.api.post('/api/cash-moves', { amount_cents: -250, category: 'Achat de marchandises', reason: 'Achat de pain' }, w.C), 201);
    assert.equal((await w.t.api.post('/api/cash-moves', { amount_cents: 100, category: 'Autre', reason: 'xyz' }, w.K)).status, 403);
    assert.equal((await w.t.api.post('/api/cash-moves', { amount_cents: 0, category: 'Autre', reason: 'xyz' }, w.C)).status, 400);
    assert.equal((await w.t.api.post('/api/cash-moves', { amount_cents: 100, category: 'Autre' }, w.C)).status, 400);
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.cash_expected_cents, 5000 + 400 - 250);
    assert.equal(pv.sales_cents, 800);
    assert.equal(pv.by_method.card, 400);
    assert.equal((await w.t.api.post('/api/closure', { counted_cents: 1000, float_out_cents: 2000, note: 'x' }, w.C)).status, 400, 'fond > comptage');
    // le caissier ferme à l'aveugle : pas de note exigée, aucun total ni écart dans la réponse
    const z = await w.ok(w.t.api.post('/api/closure', { counted_cents: 5100, float_out_cents: 5000 }, w.C), 201);
    assert.equal(z.blind, true); assert.equal(z.deposit_cents, 100); assert.equal(z.number, 'Z-0001');
    for (const k of ['variance_cents', 'cash_expected_cents', 'sales_cents', 'by_method']) assert.equal(k in z, false, `${k} ne doit pas être visible du caissier`);
    const det = (await w.ok(w.t.api.get('/api/closures', w.M))).items[0];
    assert.equal(det.variance_cents, -50);
    // période suivante : le fond laissé est le point de départ
    const pv2 = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv2.empty, true);
    assert.equal(pv2.float_in_cents, 5000);
    assert.equal(pv2.cash_expected_cents, 5000);
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400));
    const z2 = await w.ok(w.t.api.post('/api/closure', { counted_cents: 5400, float_out_cents: 5000 }, w.C), 201);
    assert.equal(z2.number, 'Z-0002');
    assert.equal((await w.ok(w.t.api.get('/api/closures', w.M))).items[0].sales_count, 1, 'la période ne reprend pas les ventes déjà clôturées');
    const list = await w.ok(w.t.api.get('/api/closures', w.M));
    assert.equal(list.items.length, 2);
  } finally { await w.t.close(); }
});

test('droits de lecture : le caissier ne voit que ses ventes de la période ; coûts cachés', async () => {
  const w = await shop();
  try {
    const mine = await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], cash(100));
    const theirs = await w.sellOk(w.C2, [{ product_id: w.cafe.id, qty: 1 }], cash(100));
    const list = await w.ok(w.t.api.get('/api/sales', w.C));
    assert.deepEqual(list.items.map((x) => x.id), [mine.id]);
    assert.equal(list.items[0].cost, undefined);
    assert.equal((await w.t.api.get(`/api/sales/${theirs.id}`, w.C)).status, 403);
    const all = await w.ok(w.t.api.get('/api/sales', w.M));
    assert.equal(all.items.length, 2);
    assert.equal((await w.t.api.get('/api/sales', w.K)).status, 403);
    assert.equal((await w.t.api.get('/api/reports', w.C)).status, 403);
    const cat = await w.ok(w.t.api.get('/api/catalog', w.C));
    assert.ok(cat.products.every((p) => p.cost === undefined && p.recipe_id === undefined));
    const prods = await w.ok(w.t.api.get('/api/products', w.M));
    assert.ok(prods.items.find((p) => p.name === 'Eau').cost > 0);
    const prodsC = await w.ok(w.t.api.get('/api/products', w.C));
    assert.equal(prodsC.items[0].cost, undefined);
    assert.equal((await w.t.api.post('/api/products', { name: 'Pirate', kind: 'free', price_cents: 1 }, w.C)).status, 403);
  } finally { await w.t.close(); }
});

test('ardoise : limite fixée par le gérant, plafond respecté, règlement en espèces dans la caisse', async () => {
  const w = await shop();
  try {
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Monsieur Ali' }, w.C), 201)).id;
    const L = [{ product_id: w.minute.id, qty: 1 }];
    const credit = (n, extra) => w.sell(w.C, L, [{ method: 'credit', amount_cents: n }], { customer_id: cid, ...extra });
    const no = await credit(400);
    assert.equal(no.status, 400); assert.equal(no.data.error.code, 'no_credit');
    assert.equal((await w.sell(w.C, L, [{ method: 'credit', amount_cents: 400 }])).status, 400, 'ardoise sans client');
    assert.equal((await w.t.api.put(`/api/customers/${cid}`, { credit_limit_cents: 1000 }, w.C)).status, 400, 'le caissier ne fixe pas la limite');
    await w.ok(w.t.api.put(`/api/customers/${cid}`, { credit_limit_cents: 1000 }, w.M));
    assert.equal((await credit(400)).status, 201);
    assert.equal((await credit(400)).status, 201);
    const over = await credit(400);
    assert.equal(over.status, 409); assert.equal(over.data.error.code, 'over_limit');
    let c = await w.ok(w.t.api.get(`/api/customers/${cid}`, w.C));
    assert.equal(c.balance_cents, 800);
    // ardoise partielle + espèces
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'credit', amount_cents: 200 }, { method: 'cash', amount_cents: 200 }], { customer_id: cid });
    c = await w.ok(w.t.api.get(`/api/customers/${cid}`, w.C));
    assert.equal(c.balance_cents, 1000);
    // règlement
    assert.equal((await w.t.api.post(`/api/customers/${cid}/payments`, { amount_cents: 1100, method: 'cash' }, w.C)).status, 409, 'plus que dû');
    assert.equal((await w.t.api.post(`/api/customers/${cid}/payments`, { amount_cents: 0, method: 'cash' }, w.C)).status, 400);
    const p = await w.ok(w.t.api.post(`/api/customers/${cid}/payments`, { amount_cents: 600, method: 'cash' }, w.C), 201);
    assert.equal(p.balance, 400);
    await w.ok(w.t.api.post(`/api/customers/${cid}/payments`, { amount_cents: 400, method: 'transfer' }, w.C), 201);
    c = await w.ok(w.t.api.get(`/api/customers/${cid}`, w.C));
    assert.equal(c.balance_cents, 0);
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.cash_expected_cents, 200 + 600, 'espèces de la vente mixte + règlement en espèces (pas le virement)');
    assert.equal(pv.by_method.credit, 1000);
    assert.equal((await w.t.api.put(`/api/customers/${cid}`, { active: false }, w.M)).status, 200);
    // annulation d'une vente à l'ardoise
    await w.ok(w.t.api.put(`/api/customers/${cid}`, { active: true }, w.M));
    const s = await w.sellOk(w.C, L, [{ method: 'credit', amount_cents: 400 }], { customer_id: cid });
    await w.ok(w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'erreur' }, w.C), 201);
    assert.equal((await w.ok(w.t.api.get(`/api/customers/${cid}`, w.C))).balance_cents, 0);
    await w.sellOk(w.C, L, [{ method: 'credit', amount_cents: 400 }], { customer_id: cid });
    assert.equal((await w.t.api.put(`/api/customers/${cid}`, { active: false }, w.M)).status, 409, 'ardoise non soldée');
    assert.equal((await w.t.api.post(`/api/customers/${cid}/adjust`, { amount_cents: -500, note: 'x' }, w.M)).status, 409);
    assert.equal((await w.ok(w.t.api.post(`/api/customers/${cid}/adjust`, { amount_cents: -100, note: 'geste' }, w.M))).balance, 300);
    assert.equal((await w.t.api.post(`/api/customers/${cid}/adjust`, { amount_cents: -100, note: 'geste' }, w.C)).status, 403);
  } finally { await w.t.close(); }
});

test('hors-ligne : ventes synchronisées une fois, prix affiché honoré, doublon et erreur isolés', async () => {
  const w = await shop();
  try {
    const mk = (over = {}) => ({ client_uuid: uuid(), provisional: 'H1-1', ts: '2026-10-07T07:50:00Z', lines: [{ product_id: w.bouteille.id, qty: 1, unit_price_cents: 180 }], payments: cash(180), ...over });
    const a = mk(), bad = mk({ lines: [{ product_id: 9999, qty: 1 }] }), c = mk({ lines: [{ product_id: w.cafe.id, qty: 2 }], payments: cash(200) });
    const r = await w.ok(w.t.api.post('/api/sales/sync', { sales: [a, bad, c, a] }, w.C));
    assert.deepEqual(r.results.map((x) => x.ok), [true, false, true, true]);
    assert.equal(r.results[3].duplicate, true);
    assert.equal(r.results[1].code, 'invalid');
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 2);
    const s = await w.ok(w.t.api.get(`/api/sales/${r.results[0].id}`, w.M));
    assert.equal(s.total_cents, 180, 'le client a payé le prix affiché');
    assert.equal(s.offline, 1);
    assert.equal(s.ts, '2026-10-07T07:50:00.000Z', 'heure de la vente conservée');
    assert.ok(s.flags.includes('offline') && s.flags.includes('price_differs'));
    assert.equal(s.provisional, 'H1-1');
    // heure future → ramenée à maintenant
    const f = await w.ok(w.t.api.post('/api/sales/sync', { sales: [mk({ ts: '2027-01-01T00:00:00Z' })] }, w.C));
    const fs = await w.ok(w.t.api.get(`/api/sales/${f.results[0].id}`, w.M));
    assert.ok(fs.flags.includes('ts_future')); assert.equal(fs.ts, '2026-10-07T08:00:00.000Z');
    assert.equal((await w.t.api.post('/api/sales/sync', { sales: [] }, w.C)).status, 400);
    assert.equal((await w.t.api.post('/api/sales/sync', { sales: [mk()] }, w.K)).status, 403);
    // une vente hors-ligne à l'ardoise dépassant la limite est acceptée (le client est déjà servi) mais signalée
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Zed' }, w.C), 201)).id;
    const cr = await w.ok(w.t.api.post('/api/sales/sync', { sales: [mk({ customer_id: cid, payments: [{ method: 'credit', amount_cents: 180 }] })] }, w.C));
    assert.equal(cr.results[0].ok, true); assert.ok(cr.results[0].flags.includes('over_limit'));
  } finally { await w.t.close(); }
});

test('hors-ligne : le total affiché au client est celui enregistré, même si les promotions ont changé', async () => {
  const w = await shop();
  try {
    const off = (over) => ({ client_uuid: uuid(), ts: '2026-10-07T07:50:00Z', lines: [{ product_id: w.crepe.id, qty: 3, unit_price_cents: 150 }], ...over });
    // promotion supprimée sur le serveur, mais la caisse hors-ligne l'appliquait : le client a payé 3,00 €
    const a = await w.ok(w.t.api.post('/api/sales/sync', { sales: [off({ expected_total_cents: 300, payments: cash(300) })] }, w.C));
    const sa = await w.ok(w.t.api.get(`/api/sales/${a.results[0].id}`, w.M));
    assert.equal(sa.total_cents, 300); assert.equal(sa.discount_cents, 150);
    assert.ok(sa.flags.includes('offline_gap')); assert.equal(sa.lines[0].promo_label, 'Écart hors-ligne');
    // promotion ajoutée sur le serveur, la caisse affichait 4,50 € : le client a payé 4,50 € ; on enregistre le total le plus bas, la monnaie est rendue en conséquence
    await w.ok(w.t.api.post('/api/promotions', { name: '2+1', type: 'bogo', scope: 'product', product_id: w.crepe.id, buy_qty: 2, free_qty: 1 }, w.M), 201);
    const b = await w.ok(w.t.api.post('/api/sales/sync', { sales: [off({ expected_total_cents: 450, payments: cash(450) })] }, w.C));
    const sb = await w.ok(w.t.api.get(`/api/sales/${b.results[0].id}`, w.M));
    assert.equal(sb.total_cents, 300); assert.equal(sb.change_cents, 150); assert.ok(sb.flags.includes('offline_gap'));
    // sans écart : pas de drapeau
    const c = await w.ok(w.t.api.post('/api/sales/sync', { sales: [off({ expected_total_cents: 300, payments: cash(300) })] }, w.C));
    assert.ok(!(await w.ok(w.t.api.get(`/api/sales/${c.results[0].id}`, w.M))).flags.includes('offline_gap'));
  } finally { await w.t.close(); }
});

test('le stock peut devenir négatif à la vente (on ne bloque pas le client) mais c’est signalé', async () => {
  const w = await shop();
  try {
    const s = await w.sellOk(w.C, [{ product_id: w.crepe.id, qty: 3 }], cash(450)); // aucun lot produit
    assert.ok(s.flags.includes('stock_negative'));
    assert.equal(batchBalance(w.t.ctx.db, w.crepe.id), -3);
    const big = await w.sellOk(w.C, [{ product_id: w.bouteille.id, qty: 30 }], cash(6000));
    assert.ok(big.flags.includes('stock_negative'));
    assert.equal(w.stock(w.eau.id), -6);
    const cat = await w.ok(w.t.api.get('/api/catalog', w.C));
    assert.equal(cat.products.find((p) => p.name === 'Eau').available, 0);
  } finally { await w.t.close(); }
});
