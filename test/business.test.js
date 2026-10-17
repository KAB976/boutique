import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, near } from './shop-world.js';
import { verifyJournal } from '../server/stock.js';
import { verifyAudit } from '../server/audit.js';
import fs from 'node:fs';

const cash = (n) => [{ method: 'cash', amount_cents: n }];

test('fournisseurs : bon de commande, réception partielle puis totale, coût moyen, dette, paiement', async () => {
  const w = await shop();
  try {
    const sid = (await w.ok(w.t.api.post('/api/suppliers', { name: 'Grossiste Mayotte', phone: '0269' }, w.M), 201)).id;
    assert.equal((await w.t.api.post('/api/suppliers', { name: 'X' }, w.K)).status, 403);
    assert.equal((await w.t.api.get('/api/suppliers', w.C)).status, 403);
    const po = { supplier_id: sid, lines: [{ ingredient_id: w.farine.id, qty: 10, unit: 'kg', expected_total_cents: 1800 }, { ingredient_id: w.oeuf.id, qty: 60, unit: 'piece' }] };
    assert.equal((await w.t.api.post('/api/purchase-orders', { ...po, lines: [] }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/purchase-orders', { ...po, lines: [po.lines[0], po.lines[0]] }, w.M)).status, 400, 'doublon');
    assert.equal((await w.t.api.post('/api/purchase-orders', { ...po, supplier_id: 99 }, w.M)).status, 400);
    const id = (await w.ok(w.t.api.post('/api/purchase-orders', po, w.M), 201)).id;
    let v = await w.ok(w.t.api.get(`/api/purchase-orders/${id}`, w.M));
    assert.equal(v.number, 'BC-0001'); assert.equal(v.status, 'draft'); assert.equal(v.expected_cents, 1800);
    await w.ok(w.t.api.put(`/api/purchase-orders/${id}`, { lines: [po.lines[0], { ...po.lines[1], qty: 60 }] }, w.M));
    await w.ok(w.t.api.post(`/api/purchase-orders/${id}/status`, { status: 'sent' }, w.M));
    assert.equal((await w.t.api.put(`/api/purchase-orders/${id}`, po, w.M)).status, 409, 'plus modifiable une fois envoyé');
    const l0 = v.lines[0].id, l1 = v.lines[1].id;
    const r1 = await w.ok(w.t.api.post(`/api/purchase-orders/${id}/receive`, { invoice_ref: 'F-100', lines: [{ po_line_id: l0, qty: 10, unit: 'kg', total_cents: 2000 }] }, w.M), 201);
    assert.equal(r1.status, 'partial'); assert.equal(r1.invoice_cents, 2000);
    near(w.stock(w.farine.id), 35000);
    near(w.avg(w.farine.id), 65 / 35000, 'coût moyen pondéré', 1e-12);
    const r2 = await w.ok(w.t.api.post(`/api/purchase-orders/${id}/receive`, { lines: [{ po_line_id: l1, qty: 60, unit: 'piece', total_cents: 1800 }] }, w.M), 201);
    assert.equal(r2.status, 'received');
    near(w.stock(w.oeuf.id), 90);
    v = await w.ok(w.t.api.get(`/api/purchase-orders/${id}`, w.M));
    assert.equal(v.status, 'received'); assert.equal(v.receipts.length, 2);
    let s = await w.ok(w.t.api.get(`/api/suppliers/${sid}`, w.M));
    assert.equal(s.balance_cents, 3800);
    assert.equal((await w.t.api.post(`/api/purchase-orders/${id}/receive`, { lines: [{ po_line_id: l1, qty: 1, unit: 'piece' }] }, w.M)).status, 409, 'bon déjà reçu');
    assert.equal((await w.t.api.post(`/api/purchase-orders/${id}/status`, { status: 'cancelled' }, w.M)).status, 409);
    assert.equal((await w.t.api.post(`/api/suppliers/${sid}/payments`, { amount_cents: 4000, method: 'cash' }, w.M)).status, 409, 'plus que dû');
    await w.ok(w.t.api.post(`/api/suppliers/${sid}/payments`, { amount_cents: 1000, method: 'cash', from_drawer: true }, w.M), 201);
    await w.ok(w.t.api.post(`/api/suppliers/${sid}/payments`, { amount_cents: 800, method: 'transfer' }, w.M), 201);
    s = await w.ok(w.t.api.get(`/api/suppliers/${sid}`, w.M));
    assert.equal(s.balance_cents, 2000);
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.cash_expected_cents, -1000, 'paiement en espèces pris dans la caisse');
    assert.equal((await w.t.api.put(`/api/suppliers/${sid}`, { active: false }, w.M)).status, 409);
    assert.throws(() => w.t.ctx.db.prepare('UPDATE supplier_ledger SET amount_cents = 1').run(), /lecture seule/);
    assert.throws(() => w.t.ctx.db.prepare('UPDATE po_receipts SET invoice_cents = 1').run(), /ne se modifie pas/);
    // annulation d'un brouillon / envoyé
    const id2 = (await w.ok(w.t.api.post('/api/purchase-orders', po, w.M), 201)).id;
    await w.ok(w.t.api.post(`/api/purchase-orders/${id2}/status`, { status: 'cancelled' }, w.M));
    assert.equal((await w.t.api.post(`/api/purchase-orders/${id2}/receive`, { lines: [{ po_line_id: 1, qty: 1, unit: 'g' }] }, w.M)).status, 409);
    assert.equal(verifyJournal(w.t.ctx.db).ok, true);
  } finally { await w.t.close(); }
});

test('traiteur : devis, acompte, droits du cuisinier, annulation, liste de courses', async () => {
  const w = await shop();
  try {
    const lines = [{ kind: 'recipe', recipe_id: w.recipe.id, qty: 40, unit_price_cents: 1500 }, { kind: 'product', product_id: w.bouteille.id, qty: 40 }, { kind: 'free', label: 'Location de plats', qty: 1, unit_price_cents: 3000 }];
    const base = { contact_name: 'Mme Soilihi', contact_phone: '0639', event_date: '2026-10-20', event_time: '12:30', place: 'Salle des fêtes', guests: 40 };
    assert.equal((await w.t.api.post('/api/catering', { ...base, lines }, w.K)).status, 403);
    assert.equal((await w.t.api.post('/api/catering', { ...base, event_date: '20/10', lines }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/catering', { ...base, contact_name: '', lines }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/catering', { ...base, discount_cents: 99999999, lines }, w.M)).status, 400);
    const id = (await w.ok(w.t.api.post('/api/catering', { ...base, lines }, w.M), 201)).id;
    let o = await w.ok(w.t.api.get(`/api/catering/${id}`, w.M));
    assert.equal(o.number, 'T-0001'); assert.equal(o.status, 'quote');
    assert.equal(o.total_cents, 40 * 1500 + 40 * 200 + 3000);
    near(o.est_cost, (1.332 / 4) * 40 + 40 * 0.5, 'coût estimé', 1e-9);
    assert.equal((await w.t.api.post(`/api/catering/${id}/payments`, { kind: 'deposit', method: 'cash', amount_cents: 1000 }, w.M)).status, 409, 'confirmer d’abord');
    assert.equal((await w.t.api.post(`/api/catering/${id}/status`, { status: 'delivered' }, w.M)).status, 409, 'on ne saute pas d’étape');
    await w.ok(w.t.api.post(`/api/catering/${id}/status`, { status: 'confirmed' }, w.M));
    assert.equal((await w.t.api.post(`/api/catering/${id}/payments`, { kind: 'deposit', method: 'cash', amount_cents: 99999999 }, w.M)).status, 409);
    await w.ok(w.t.api.post(`/api/catering/${id}/payments`, { kind: 'deposit', method: 'cash', amount_cents: 20000 }, w.M), 201);
    o = await w.ok(w.t.api.get(`/api/catering/${id}`, w.M));
    assert.equal(o.paid_cents, 20000); assert.equal(o.balance_cents, o.total_cents - 20000);
    assert.equal((await w.ok(w.t.api.get('/api/closure/preview', w.M))).cash_expected_cents, 20000);
    // le cuisinier voit quoi préparer, pas l'argent
    const k = await w.ok(w.t.api.get(`/api/catering/${id}`, w.K));
    assert.equal(k.total_cents, undefined); assert.equal(k.payments, undefined); assert.equal(k.lines[0].unit_price_cents, undefined);
    assert.equal(k.lines[0].label, 'Crêpes');
    const kl = await w.ok(w.t.api.get('/api/catering', w.K));
    assert.equal(kl.items[0].total_cents, undefined);
    // annulation : l'acompte doit d'abord être remboursé
    const c1 = await w.t.api.post(`/api/catering/${id}/status`, { status: 'cancelled', reason: 'événement annulé' }, w.M);
    assert.equal(c1.status, 409); assert.equal(c1.data.error.code, 'refund_first');
    assert.equal((await w.t.api.post(`/api/catering/${id}/payments`, { kind: 'refund', method: 'cash', amount_cents: 25000 }, w.M)).status, 409, 'plus que reçu');
    await w.ok(w.t.api.post(`/api/catering/${id}/payments`, { kind: 'refund', method: 'cash', amount_cents: 20000 }, w.M), 201);
    await w.ok(w.t.api.post(`/api/catering/${id}/status`, { status: 'cancelled', reason: 'événement annulé' }, w.M));
    assert.equal((await w.ok(w.t.api.get('/api/closure/preview', w.M))).cash_expected_cents, 0);
    assert.equal((await w.t.api.put(`/api/catering/${id}`, { contact_name: 'X' }, w.M)).status, 409);
    assert.throws(() => w.t.ctx.db.prepare('DELETE FROM catering_payments').run(), /ne se modifie pas/);
    assert.equal((await w.t.api.post('/api/catering', { ...base, lines: [] }, w.M)).status, 201);
  } finally { await w.t.close(); }
});

test('traiteur : liste de courses = besoins de toutes les commandes − stock, en emballages', async () => {
  const w = await shop();
  try {
    const mk = async (date, qty) => {
      const id = (await w.ok(w.t.api.post('/api/catering', { contact_name: 'C', event_date: date, lines: [{ kind: 'recipe', recipe_id: w.recipe.id, qty, unit_price_cents: 1000 }] }, w.M), 201)).id;
      await w.ok(w.t.api.post(`/api/catering/${id}/status`, { status: 'confirmed' }, w.M));
      return id;
    };
    await mk('2026-10-20', 4000); // 4000 pers. = 1000 × (240 g + 3 œufs) = 240 kg de farine, 3000 œufs
    await mk('2026-10-21', 40);
    const day1 = await w.ok(w.t.api.get('/api/catering/shopping?from=2026-10-20&to=2026-10-20', w.K));
    const f1 = day1.items.find((i) => i.name === 'Farine');
    assert.equal(f1.needText, '240 kg');
    assert.ok(f1.missing > 0);
    const both = await w.ok(w.t.api.get('/api/catering/shopping?from=2026-10-20&to=2026-10-21', w.K));
    assert.equal(both.orders.length, 2);
    assert.equal(both.items.find((i) => i.name === 'Farine').needText, '242,4 kg');
    const none = await w.ok(w.t.api.get('/api/catering/shopping?from=2030-01-01&to=2030-01-02', w.K));
    assert.equal(none.items.length, 0);
    // un devis non confirmé ne compte pas
    await w.ok(w.t.api.post('/api/catering', { contact_name: 'D', event_date: '2026-10-22', lines: [{ kind: 'recipe', recipe_id: w.recipe.id, qty: 4, unit_price_cents: 1000 }] }, w.M), 201);
    assert.equal((await w.ok(w.t.api.get('/api/catering/shopping?from=2026-10-22&to=2026-10-22', w.K))).orders.length, 0);
  } finally { await w.t.close(); }
});

test('dépenses : annulables seulement, caisse touchée si payé en espèces', async () => {
  const w = await shop();
  try {
    assert.equal((await w.t.api.post('/api/expenses', { category: 'Loyer', label: 'Octobre', amount_cents: 50000 }, w.C)).status, 403);
    assert.equal((await w.t.api.post('/api/expenses', { category: 'Loyer', label: 'Octobre', amount_cents: 0 }, w.M)).status, 400);
    assert.equal((await w.t.api.post('/api/expenses', { category: '', label: 'Octobre', amount_cents: 100 }, w.M)).status, 400);
    const a = (await w.ok(w.t.api.post('/api/expenses', { category: 'Loyer', label: 'Octobre', amount_cents: 50000 }, w.M), 201)).id;
    const b = (await w.ok(w.t.api.post('/api/expenses', { category: 'Transport', label: 'Taxi marché', amount_cents: 1500, from_drawer: true }, w.M), 201)).id;
    assert.equal((await w.ok(w.t.api.get('/api/closure/preview', w.M))).cash_expected_cents, -1500);
    assert.throws(() => w.t.ctx.db.prepare('UPDATE expenses SET amount_cents = 1').run(), /ne se modifie pas/);
    assert.throws(() => w.t.ctx.db.prepare('DELETE FROM expenses').run(), /ne se supprime pas/);
    assert.equal((await w.t.api.post(`/api/expenses/${b}/void`, {}, w.M)).status, 400);
    await w.ok(w.t.api.post(`/api/expenses/${b}/void`, { reason: 'erreur' }, w.M));
    assert.equal((await w.ok(w.t.api.get('/api/closure/preview', w.M))).cash_expected_cents, 0, 'espèces remises en caisse');
    assert.equal((await w.t.api.post(`/api/expenses/${b}/void`, { reason: 'encore' }, w.M)).status, 409);
    const list = await w.ok(w.t.api.get('/api/expenses?from=2026-10-01&to=2026-10-31', w.M));
    assert.equal(list.items.length, 2); assert.ok(a);
  } finally { await w.t.close(); }
});

test('statistiques : résultat réel recalculé à la main, export Excel valide', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.K), 201); // 8 crêpes à 0,1665
    await w.sellOk(w.C, [{ product_id: w.crepe.id, qty: 3 }, { product_id: w.bouteille.id, qty: 2 }], cash(1000)); // 4,50 + 4,00 = 8,50
    const refunded = await w.sellOk(w.C, [{ product_id: w.cafe.id, qty: 1 }], cash(100));
    await w.ok(w.t.api.post(`/api/sales/${refunded.id}/refund`, { reason: 'erreur' }, w.C), 201);
    await w.ok(w.t.api.post('/api/batches/loss', { product_id: w.crepe.id, qty: 1, reason: 'invendu' }, w.K), 201);   // 0,1665
    await w.ok(w.t.api.post('/api/stock/losses', { ingredient_id: w.farine.id, qty: 100, unit: 'g', reason: 'casse' }, w.K), 201); // 0,18
    await w.ok(w.t.api.post('/api/expenses', { category: 'Loyer', label: 'Octobre', amount_cents: 5000 }, w.M), 201);
    const cid = (await w.ok(w.t.api.post('/api/catering', { contact_name: 'Mme X', event_date: '2026-10-07', lines: [{ kind: 'recipe', recipe_id: w.recipe.id, qty: 8, unit_price_cents: 2000 }] }, w.M), 201)).id;
    for (const st of ['confirmed', 'prepared', 'delivered']) await w.ok(w.t.api.post(`/api/catering/${cid}/status`, { status: st }, w.M));
    const r = await w.ok(w.t.api.get('/api/reports?from=2026-10-01&to=2026-10-31', w.M));
    assert.equal(r.sales.count, 2); assert.equal(r.sales.refunds, 1);
    assert.equal(r.sales.revenue_cents, 850);
    assert.equal(r.sales.vat_cents, 41 + 67);
    near(r.sales.cost, 3 * 0.1665 + 2 * 0.5, 'coût des ventes', 0.006);
    near(r.sales.margin, (850 - 108) / 100 - (3 * 0.1665 + 1), 'marge', 0.006);
    assert.equal(r.catering.revenue_cents, 16000);
    near(r.catering.cost, (1.332 / 4) * 8, 'coût traiteur estimé', 0.006);
    near(r.losses.value, 0.1665 + 0.18, 'pertes', 0.006);
    assert.equal(r.expenses.total_cents, 5000);
    const expected = (850 - 108) / 100 - (3 * 0.1665 + 1) + (160 - 2.664) - 50 - (0.1665 + 0.18);
    near(r.profit, expected, 'résultat réel', 0.02);
    assert.equal(r.products[0].name, 'Crêpe'.length ? r.products[0].name : '');
    const crepe = r.products.find((p) => p.name === 'Crêpe');
    assert.equal(crepe.qty, 3); assert.equal(crepe.cents, 450);
    assert.equal(r.by_hour[0].hour, 11, 'heure locale de Mayotte');
    assert.equal(r.now.customers_total_cents, 0);
    assert.ok(r.now.stock_value > 0);
    assert.equal((await w.t.api.get('/api/reports?from=2026-10-31&to=2026-10-01', w.M)).status, 400);
    assert.equal((await w.t.api.get('/api/reports?from=2020-01-01&to=2026-10-01', w.M)).status, 400);
    assert.equal((await w.t.api.get('/api/reports?from=abc', w.M)).status, 400);
    assert.equal((await w.t.api.get('/api/reports', w.K)).status, 403);
    const x = await w.t.api.get('/api/reports/export.xlsx?from=2026-10-01&to=2026-10-31', w.M);
    assert.equal(x.status, 200);
    assert.match(x.headers.get('content-type'), /spreadsheetml/);
    assert.equal(x.data.subarray(0, 2).toString(), 'PK');
    fs.writeFileSync(process.env.XLSX_OUT || '/dev/null', x.data);
    assert.equal(verifyJournal(w.t.ctx.db).ok, true);
    assert.equal(verifyAudit(w.t.ctx.db).ok, true);
  } finally { await w.t.close(); }
});

test('droits : matrice des routes des étapes 4 à 9', async () => {
  const w = await shop();
  try {
    const rows = [
      // [méthode, url, propriétaire, gérant, caissier, cuisinier]
      ['get', '/api/catalog', 200, 200, 200, 200],
      ['get', '/api/products', 200, 200, 200, 200],
      ['get', '/api/products?all=1', 200, 200, 200, 200],
      ['get', '/api/production/plan?recipe_id=1&servings=4', 200, 200, 403, 200],
      ['get', '/api/productions', 200, 200, 403, 200],
      ['get', '/api/batches', 200, 200, 403, 200],
      ['get', '/api/sales', 200, 200, 200, 403],
      ['get', '/api/closure/preview', 200, 200, 200, 403],
      ['get', '/api/closures', 200, 200, 200, 403],
      ['get', '/api/customers', 200, 200, 200, 403],
      ['get', '/api/promotions', 200, 200, 403, 403],
      ['get', '/api/suppliers', 200, 200, 403, 403],
      ['get', '/api/purchase-orders', 200, 200, 403, 403],
      ['get', '/api/catering', 200, 200, 403, 200],
      ['get', '/api/catering/shopping', 200, 200, 403, 200],
      ['get', '/api/expenses', 200, 200, 403, 403],
      ['get', '/api/reports', 200, 200, 403, 403],
      ['get', '/api/reports/export.xlsx', 200, 200, 403, 403],
      ['get', '/api/ticket-info', 200, 200, 200, 403],
    ];
    const who = [w.O, w.M, w.C, w.K];
    for (const [m, url, ...exp] of rows) {
      for (let i = 0; i < 4; i++) {
        const r = await w.t.api[m](url, who[i]);
        assert.equal(r.status, exp[i], `${m} ${url} pour ${['propriétaire', 'gérant', 'caissier', 'cuisinier'][i]} : attendu ${exp[i]}, reçu ${r.status}`);
      }
      assert.equal((await w.t.api[m](url)).status, 401, `${url} sans connexion`);
    }
  } finally { await w.t.close(); }
});
