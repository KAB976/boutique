import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, uuid } from './shop-world.js';

const cash = (c) => [{ method: 'cash', amount_cents: c }];
const L = (w) => [{ product_id: w.minute.id, qty: 1 }];

test('remise libre : le caissier ne peut pas la donner seul ; le gérant l’autorise en tapant SON code ; tout est tracé', async () => {
  const w = await shop(); // quart non exigé ici
  try {
    const base = { discount_cents: 100, discount_reason: 'Client fidèle' };
    // seul : refusé
    const r0 = await w.sell(w.C, L(w), cash(300), base);
    assert.equal(r0.status, 403);
    // mauvais code : refusé, aucune vente
    const r1 = await w.sell(w.C, L(w), cash(300), { ...base, discount_approval: { user_id: w.manager.id, pin: '0000' } });
    assert.equal(r1.status, 403); assert.equal(r1.data.error.code, 'bad_pin');
    // un caissier ou un cuisinier ne peut pas autoriser
    const r2 = await w.sell(w.C, L(w), cash(300), { ...base, discount_approval: { user_id: w.cashier.id, pin: '1357' } });
    assert.equal(r2.status, 403);
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 0);
    // le gérant tape son code : la remise est accordée
    const ok = await w.sellOk(w.C, L(w), cash(300), { ...base, discount_approval: { user_id: w.manager.id, pin: '1357' } });
    assert.equal(ok.total_cents, 300); assert.equal(ok.discount_cents, 100);
    assert.equal(ok.discount_by_name, 'Mina'); assert.equal(ok.discount_reason, 'Client fidèle'); assert.equal(ok.user_name, 'Awa');
    const a = JSON.parse(w.t.ctx.db.prepare("SELECT detail FROM audit WHERE action = 'sale.discount'").get().detail);
    assert.equal(a.authorized_by, 'Mina'); assert.equal(a.requested_by, 'Awa'); assert.equal(a.discount_cents, 100);
    // le gérant n'a pas besoin d'approbation pour sa propre vente
    const own = await w.sellOk(w.M, L(w), cash(300), base);
    assert.equal(own.discount_by_name, 'Mina');
    // le motif reste obligatoire et la remise ne dépasse pas le total
    assert.equal((await w.sell(w.C, L(w), cash(300), { discount_cents: 100, discount_reason: '', discount_approval: { user_id: w.manager.id, pin: '1357' } })).status, 400);
    assert.equal((await w.sell(w.C, L(w), cash(0), { discount_cents: 9999, discount_reason: 'x', discount_approval: { user_id: w.manager.id, pin: '1357' } })).status, 400);
  } finally { await w.t.close(); }
});

test('remise : le code du gérant se bloque après 5 erreurs (comme à la connexion) ; vérification préalable ; impossible hors-ligne', async () => {
  const w = await shop();
  try {
    const chk = (pin, user_id = w.manager.id) => w.t.api.post('/api/discount/check', { user_id, pin }, w.C);
    assert.equal((await chk('1357')).data.name, 'Mina');
    for (let i = 0; i < 4; i++) assert.equal((await chk('0000')).data.error.code, 'bad_pin');
    assert.equal((await chk('0000')).status, 429, '5e erreur : blocage');
    assert.equal((await chk('1357')).status, 429, 'même le bon code est refusé pendant le blocage');
    assert.equal((await chk('1357', w.cook.id)).status, 403, 'un cuisinier ne peut pas autoriser');
    assert.equal((await w.t.api.post('/api/discount/check', { user_id: 99999, pin: '1357' }, w.C)).status, 400);
    // une vente hors-ligne avec remise libre d'un caissier est refusée
    const off = { client_uuid: uuid(), provisional: 'H1-1', offline: true, ts: new Date().toISOString(), lines: [{ product_id: w.minute.id, qty: 1, unit_price_cents: 400 }], payments: cash(300), discount_cents: 100, discount_reason: 'x', discount_approval: { user_id: w.manager.id, pin: '1357' } };
    const r = await w.ok(w.t.api.post('/api/sales/sync', { sales: [off] }, w.C));
    assert.equal(r.results[0].ok, false);
  } finally { await w.t.close(); }
});
