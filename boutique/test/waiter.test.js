import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, uuid } from './shop-world.js';
import { can, ROLES } from '../server/permissions.js';

test('rôle Serveur : prend et sert les commandes depuis son téléphone, sans toucher à la caisse ni aux comptes', async () => {
  const w = await shop({ shifts: true });
  try {
    await w.ok(w.t.api.put('/api/settings', { self_pin_change: 0 }, w.O));
    const u = await w.ok(w.t.api.post('/api/users', { name: 'Sami', role: 'waiter', pin: '8642' }, w.O), 201);
    assert.equal(u.role, 'waiter');
    const l = await w.t.login(u.id, '8642');
    assert.equal(l.status, 200); assert.equal(l.data.user.mustChangePin, false);
    const S = { token: l.data.token };
    for (const p of ['orders.take', 'orders.serve', 'orders.view', 'catalog.view']) assert.ok(l.data.user.permissions.includes(p), p);
    for (const p of ['pos.sell', 'cash.move', 'closure.do', 'shift.open', 'customers.view', 'cash.review', 'stats.view']) assert.equal(l.data.user.permissions.includes(p), false, p);
    // il voit le catalogue et envoie une commande SANS quart de caisse ouvert
    const cat = await w.ok(w.t.api.get('/api/catalog', S));
    assert.ok(cat.products.length > 0); assert.deepEqual(cat.customers, []);
    const o = await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'Table 4', lines: [{ product_id: w.minute.id, qty: 2 }] }, S), 201);
    assert.equal(o.order.user_name, 'Sami'); assert.equal(o.order.status, 'sent');
    // il ne vend pas, ne touche pas aux espèces, ne voit ni clôtures ni clients
    assert.equal((await w.sell(S, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'cash', amount_cents: 400 }])).status, 403);
    for (const [m, p] of [['get', '/api/closure/preview'], ['get', '/api/cash-review'], ['get', '/api/customers'], ['post', '/api/shift/deposit'], ['post', '/api/cash-moves'], ['get', '/api/users']]) assert.equal((await (m === 'get' ? w.t.api.get(p, S) : w.t.api.post(p, {}, S))).status, 403, p);
    // le tableau est visible ; la cuisine prépare ; il sert
    const k = w.t.ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get();
    await w.ok(w.t.api.post(`/api/orders/${o.order.id}/prepare`, {}, w.O)); await w.ok(w.t.api.post(`/api/orders/${o.order.id}/ready`, {}, w.O));
    await w.ok(w.t.api.post(`/api/orders/${o.order.id}/serve`, {}, S));
    // il ne peut pas annuler la commande d'un autre ni créer de compte
    assert.equal((await w.t.api.post('/api/users', { name: 'X', role: 'cashier', pin: '2468' }, S)).status, 403);
    assert.ok(k);
    // ses codes : jamais de changement par lui-même (réglage par défaut)
    assert.equal((await w.t.api.post('/api/me/pin', { currentPin: '8642', newPin: '9753' }, S)).status, 403);
    assert.ok(ROLES.includes('waiter') && can('waiter', 'orders.take') && !can('waiter', 'pos.sell'));
  } finally { await w.t.close(); }
});

test('additions ouvertes : le solde d’ardoise s’affiche pour le caissier quand la table porte le nom d’un client (un seul)', async () => {
  const w = await shop({ shifts: true });
  try {
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Mme Diallo' }, w.M), 201)).id;
    await w.ok(w.t.api.put(`/api/customers/${cid}`, { credit_limit_cents: 5000 }, w.M));
    await w.ok(w.t.api.post('/api/customers', { name: 'Ali' }, w.M), 201);
    await w.ok(w.t.api.post('/api/customers', { name: 'ali' }, w.M), 201); // doublon de nom : jamais rattaché
    await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'mme  DIALLO', lines: [{ product_id: w.minute.id, qty: 1 }] }, w.M), 201);
    await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'Ali', lines: [{ product_id: w.minute.id, qty: 1 }] }, w.M), 201);
    await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'Table 2', lines: [{ product_id: w.minute.id, qty: 1 }] }, w.M), 201);
    await openOk(w);
    // une dette existante de Mme Diallo : une vente à l'ardoise
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'credit', amount_cents: 400 }], { customer_id: cid });
    const t = (await w.ok(w.t.api.get('/api/orders/tabs', w.C))).tabs;
    const by = Object.fromEntries(t.map((x) => [x.key, x]));
    assert.equal(by['mme diallo'].customer.balance_cents, 400); assert.equal(by['mme diallo'].customer.credit_limit_cents, 5000);
    assert.equal(by.ali.customer, undefined, 'deux clients du même nom : pas de rattachement automatique');
    assert.equal(by['table 2'].customer, undefined);
    // le serveur ne voit jamais les dettes
    await w.ok(w.t.api.put('/api/settings', { self_pin_change: 0 }, w.O));
    const u = await w.ok(w.t.api.post('/api/users', { name: 'Sami', role: 'waiter', pin: '8642' }, w.O), 201);
    const S = { token: (await w.t.login(u.id, '8642')).data.token };
    const t2 = (await w.ok(w.t.api.get('/api/orders/tabs', S))).tabs;
    assert.equal(t2.every((x) => x.customer === undefined), true);
    // encaissement de l'addition de Mme Diallo sur son ardoise
    const tab = by['mme diallo'];
    const r = await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'credit', amount_cents: 400 }], { customer_id: cid, order_ids: tab.order_ids });
    assert.ok(r);
    const after = (await w.ok(w.t.api.get('/api/orders/tabs', w.C))).tabs.map((x) => x.key);
    assert.equal(after.includes('mme diallo'), false, 'addition soldée');
    assert.equal((await w.ok(w.t.api.get(`/api/customers/${cid}`, w.M))).balance_cents, 800);
  } finally { await w.t.close(); }
});

async function openOk(w) { const r = await w.t.api.post('/api/shifts/open', { counted_cents: 1000, pin: '1357' }, w.C); assert.equal(r.status, 201, JSON.stringify(r.data)); }

test('mise à jour d’une base existante (version 12) : le rôle Serveur devient possible, rien n’est perdu', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { MIGRATIONS, migrate } = await import('../server/db.js');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= 12)) { db.exec(m.sql); db.prepare('INSERT INTO schema_version VALUES (?,?,?)').run(m.version, m.name, 'x'); }
  db.prepare("INSERT INTO users (name, pin_hash, role, created_at, updated_at) VALUES ('Karim','h','owner','t','t')").run();
  assert.throws(() => db.prepare("INSERT INTO users (name, pin_hash, role, created_at, updated_at) VALUES ('S','h','waiter','t','t')").run(), /CHECK/);
  migrate(db);
  db.prepare("INSERT INTO users (name, pin_hash, role, created_at, updated_at) VALUES ('Sami','h','waiter','t','t')").run();
  assert.throws(() => db.prepare("INSERT INTO users (name, pin_hash, role, created_at, updated_at) VALUES ('Z','h','pirate','t','t')").run(), /CHECK/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM users').get().c, 2);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('Table 4 + Table 1 mises ensemble sur le compte d’un client : une seule vente à l’ardoise, les deux additions soldées ; limite respectée', async () => {
  const w = await shop({ shifts: true });
  try {
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Mme Diallo' }, w.M), 201)).id;
    await w.ok(w.t.api.put(`/api/customers/${cid}`, { credit_limit_cents: 1000 }, w.M));
    const L = [{ product_id: w.minute.id, qty: 1 }];
    const o4 = (await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'Table 4', lines: [{ product_id: w.minute.id, qty: 2 }] }, w.M), 201)).order;
    const o1 = (await w.ok(w.t.api.post('/api/orders', { client_uuid: uuid(), label: 'Table 1', lines: L }, w.M), 201)).order;
    await w.ok(w.t.api.post('/api/shifts/open', { counted_cents: 1000, pin: '1357' }, w.C), 201);
    const all = [{ product_id: w.minute.id, qty: 3 }];
    // 12 € > limite de 10 € : refusé, les additions restent ouvertes
    const no = await w.sell(w.C, all, [{ method: 'credit', amount_cents: 1200 }], { customer_id: cid, order_ids: [o4.id, o1.id] });
    assert.equal(no.status, 409); assert.equal(no.data.error.code, 'over_limit');
    assert.equal((await w.ok(w.t.api.get('/api/orders/tabs', w.C))).tabs.length, 2);
    // le gérant relève la limite : une seule vente, tout sur le compte
    await w.ok(w.t.api.put(`/api/customers/${cid}`, { credit_limit_cents: 5000 }, w.M));
    const sale = await w.sellOk(w.C, all, [{ method: 'credit', amount_cents: 1200 }], { customer_id: cid, order_ids: [o4.id, o1.id] });
    assert.equal(sale.total_cents, 1200);
    assert.equal((await w.ok(w.t.api.get('/api/orders/tabs', w.C))).tabs.length, 0, 'les deux additions sont soldées');
    const c = await w.ok(w.t.api.get(`/api/customers/${cid}`, w.M));
    assert.equal(c.balance_cents, 1200); assert.equal(c.ledger.length, 1);
    // elles ne peuvent pas être encaissées une seconde fois
    assert.equal((await w.sell(w.C, all, [{ method: 'cash', amount_cents: 1200 }], { order_ids: [o4.id] })).data.error.code, 'order_paid');
    // plus tard : le client règle sa dette en espèces, dans la caisse
    await w.ok(w.t.api.post(`/api/customers/${cid}/payments`, { amount_cents: 1200, method: 'cash' }, w.C), 201);
    assert.equal((await w.ok(w.t.api.get(`/api/customers/${cid}`, w.M))).balance_cents, 0);
  } finally { await w.t.close(); }
});
