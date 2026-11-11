import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shop, uuid } from './shop-world.js';
import { OWNER_PIN } from './helpers.js';
import { verifyAudit } from '../server/audit.js';

const PIN = '1357';
const L = (w) => [{ product_id: w.minute.id, qty: 1 }];
const rows = (w, t) => w.t.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

async function activity(w) {
  const r = await w.t.api.post('/api/shifts/open', { counted_cents: 5000, pin: PIN }, w.C); assert.equal(r.status, 201, JSON.stringify(r.data));
  const c = await w.ok(w.t.api.post('/api/customers', { name: 'Fatima' }, w.C), 201);
  await w.t.api.put(`/api/customers/${c.id}`, { credit_limit_cents: 50000 }, w.M);
  await w.sellOk(w.C, L(w), [{ method: 'cash', amount_cents: 400 }]);
  await w.sellOk(w.C, L(w), [{ method: 'credit', amount_cents: 400 }], { customer_id: c.id });
  await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'Table 2', lines: [{ product_id: w.minute.id, qty: 1 }] }, w.C), 201);
  await w.ok(w.t.api.post('/api/expenses', { category: 'Loyer', label: 'Test', amount_cents: 1000 }, w.M), 201);
  const z = await w.t.api.post('/api/closure', { pin: PIN, counted_cents: 5400, float_out_cents: 5000 }, w.C); assert.equal(z.status, 201, JSON.stringify(z.data));
  return c;
}

test('remise à zéro : efface ventes, caisse, soldes ; garde ingrédients, recettes, articles, clients, comptes', async () => {
  const w = await shop({ shifts: true });
  try {
    const c = await activity(w);
    const stockBefore = w.stock(w.farine?.id ?? 1);
    const pv = await w.ok(w.t.api.get('/api/reset/preview', w.O));
    assert.equal(pv.sales, 2); assert.equal(pv.customers_with_balance, 1); assert.equal(pv.balances_cents, 400); assert.equal(pv.closures, 1);
    // droits
    for (const who of [w.M, w.C, w.K]) assert.equal((await w.t.api.get('/api/reset/preview', who)).status, 403);
    assert.equal((await w.t.api.post('/api/reset', { pin: OWNER_PIN, phrase: 'REMETTRE A ZERO' }, w.M)).status, 403);
    // phrase et PIN obligatoires
    assert.equal((await w.t.api.post('/api/reset', { pin: OWNER_PIN, phrase: 'oui' }, w.O)).data.error.code, 'phrase');
    assert.equal((await w.t.api.post('/api/reset', { pin: '0000', phrase: 'REMETTRE A ZERO' }, w.O)).status, 403);
    assert.equal((await w.t.api.post('/api/reset', { phrase: 'REMETTRE A ZERO' }, w.O)).status, 400);
    assert.equal(rows(w, 'sales'), 2, 'rien n\'est effacé tant que ce n\'est pas confirmé');

    const ing = rows(w, 'ingredients'), rec = rows(w, 'recipes'), prod = rows(w, 'products'), users = rows(w, 'users'), cat = rows(w, 'categories');
    const r = await w.ok(w.t.api.post('/api/reset', { pin: OWNER_PIN, phrase: ' remettre à zéro ' }, w.O));
    assert.ok(r.backup);
    assert.ok(fs.existsSync(`${w.t.ctx.backupDir}/${r.backup}`), 'copie de sécurité faite avant d\'effacer');
    for (const t of ['sales', 'sale_lines', 'payments', 'closures', 'shifts', 'cash_moves', 'cash_reviews', 'customer_ledger', 'loyalty_moves', 'orders', 'order_lines']) assert.equal(rows(w, t), 0, t);
    // les dépenses ne sont effacées que si on le demande
    assert.equal(rows(w, 'expenses'), 1);
    // conservé
    assert.equal(rows(w, 'ingredients'), ing); assert.equal(rows(w, 'recipes'), rec); assert.equal(rows(w, 'products'), prod); assert.equal(rows(w, 'users'), users); assert.equal(rows(w, 'categories'), cat);
    assert.equal(rows(w, 'customers'), 1);
    assert.equal((await w.ok(w.t.api.get(`/api/customers/${c.id}`, w.M))).balance_cents, 0);
    assert.equal(w.stock(w.farine?.id ?? 1), stockBefore, 'le stock n\'est pas touché');
    // l'audit est intact et garde la trace
    assert.equal(verifyAudit(w.t.ctx.db).ok, true);
    assert.ok(w.t.ctx.db.prepare("SELECT 1 FROM audit WHERE action = 'data.reset'").get());
    // verrous « lecture seule » remis en place
    for (const t of ['sales_no_delete', 'sales_no_update', 'closures_no_delete', 'cash_moves_no_delete', 'customer_ledger_no_delete', 'shifts_no_delete', 'cash_reviews_no_update']) assert.ok(w.t.ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t), t);
    // on repart proprement : le quart d'avant n'existe plus, la numérotation repart de 1
    const sh = await w.t.api.post('/api/shifts/open', { counted_cents: 5000, pin: PIN }, w.C);
    assert.equal(sh.status, 201, JSON.stringify(sh.data)); assert.match(sh.data.number ?? sh.data.shift?.number ?? '', /0001$/);
    const s = await w.sellOk(w.C, L(w), [{ method: 'cash', amount_cents: 400 }]);
    assert.match(s.number, /-0001$/);
    assert.equal(w.t.ctx.db.prepare('SELECT MIN(id) AS i FROM sales').get().i, 1);
    assert.throws(() => w.t.ctx.db.prepare('DELETE FROM sales').run(), /ne se modifie pas/);
  } finally { await w.t.close(); }
});

test('remise à zéro : dépenses et traiteur effacés seulement si demandé', async () => {
  const w = await shop({ shifts: true });
  try {
    await w.ok(w.t.api.post('/api/expenses', { category: 'Loyer', label: 'Test', amount_cents: 1000 }, w.M), 201);
    assert.equal(rows(w, 'expenses'), 1);
    await w.ok(w.t.api.post('/api/reset', { pin: OWNER_PIN, phrase: 'REMETTRE A ZERO', expenses: true }, w.O));
    assert.equal(rows(w, 'expenses'), 0);
    assert.equal(verifyAudit(w.t.ctx.db).ok, true);
  } finally { await w.t.close(); }
});
