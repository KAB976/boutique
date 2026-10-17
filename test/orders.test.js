import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, uuid } from './shop-world.js';
import { vapidKeys } from '../server/push.js';

const fakePush = (w) => {
  const sent = []; const behaviour = { fail: null };
  w.t.ctx.push.sender = async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload });
    if (behaviour.fail && behaviour.fail[sub.endpoint]) return behaviour.fail[sub.endpoint];
    return { ok: true };
  };
  return { sent, behaviour };
};
const sub = (n) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: 'BP' + 'x'.repeat(86), auth: 'a'.repeat(22) }, device: `tel-${n}` });
const order = (w, who, label, lines, extra = {}) => w.t.api.post('/api/orders', { client_uuid: uuid(), label, lines, ...extra }, who);
const orderOk = async (w, who, label, lines, extra) => { const r = await order(w, who, label, lines, extra); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.order; };
const act = (w, who, id, a, body) => w.t.api.post(`/api/orders/${id}/${a}`, body ?? {}, who);

test('prise de commande : étiquette obligatoire, articles contrôlés, idempotente, cuisinier refusé', async () => {
  const w = await shop();
  try {
    const L = [{ product_id: w.crepe.id, qty: 2 }, { product_id: w.cafe.id, qty: 1 }];
    assert.equal((await order(w, w.K, 'Table 1', L)).status, 403, 'le cuisinier ne prend pas de commande');
    assert.equal((await order(w, w.C, '', L)).status, 400);
    assert.equal((await order(w, w.C, 'Table 1', [])).status, 400);
    assert.equal((await order(w, w.C, 'Table 1', [{ product_id: 9999, qty: 1 }])).status, 400);
    assert.equal((await order(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 0 }])).status, 400);
    assert.equal((await order(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 1.5 }])).status, 400);
    assert.equal((await order(w, w.C, 'T'.repeat(41), L)).status, 400);
    const id = uuid();
    const a = await w.t.api.post('/api/orders', { client_uuid: id, label: ' Table  1 ', lines: L }, w.C);
    assert.equal(a.status, 201);
    assert.equal(a.data.order.label, 'Table 1', 'espaces nettoyés');
    assert.equal(a.data.order.status, 'sent');
    assert.match(a.data.order.number, /^C\d{8}-0001$/);
    assert.equal(a.data.order.total_cents, 2 * 150 + 100);
    const b = await w.t.api.post('/api/orders', { client_uuid: id, label: 'Table 1', lines: L }, w.C);
    assert.equal(b.status, 200, 'double envoi : même commande');
    assert.equal(b.data.order.id, a.data.order.id);
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM orders').get().c, 1);
    assert.equal(w.stock(w.farine.id), 25000, 'le stock n’est pas touché par une commande');
  } finally { await w.t.close(); }
});

test('article « pas pour la cuisine » : commande servie d’office, pas de notification', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    await w.t.api.post('/api/push/subscribe', sub('cuisine'), w.K);
    const o = await orderOk(w, w.C, 'Table 2', [{ product_id: w.bouteille.id, qty: 2 }]);
    assert.equal(o.status, 'served');
    assert.equal(o.has_kitchen, false);
    await w.t.ctx.push.idle();
    assert.equal(p.sent.length, 0);
    // on peut changer le réglage d'un article
    await w.ok(w.t.api.put(`/api/products/${w.cafe.id}`, { to_kitchen: false }, w.O));
    const o2 = await orderOk(w, w.C, 'Table 2', [{ product_id: w.cafe.id, qty: 1 }]);
    assert.equal(o2.status, 'served');
    const aud = w.t.ctx.db.prepare("SELECT detail FROM audit WHERE action = 'product.update' ORDER BY id DESC LIMIT 1").get();
    assert.match(aud.detail, /to_kitchen/);
  } finally { await w.t.close(); }
});

test('cuisine : envoyée → en préparation → prête → servie, droits par rôle, double clic sans erreur', async () => {
  const w = await shop();
  try {
    const o = await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 1 }]);
    assert.equal((await act(w, w.C, o.id, 'prepare')).status, 403, 'le caissier ne prépare pas');
    assert.equal((await act(w, w.C, o.id, 'serve')).status, 409, 'pas servie avant d’être prête');
    const p1 = await w.ok(act(w, w.K, o.id, 'prepare'));
    assert.equal(p1.order.status, 'preparing'); assert.equal(p1.order.preparing_by, 'Yann'); assert.equal(p1.changed, true);
    const p2 = await w.ok(act(w, w.K, o.id, 'prepare'));
    assert.equal(p2.changed, false, 'double clic');
    assert.equal((await act(w, w.C, o.id, 'ready')).status, 403);
    const r = await w.ok(act(w, w.K, o.id, 'ready'));
    assert.equal(r.order.status, 'ready'); assert.ok(r.order.ready_at);
    const u = await w.ok(act(w, w.K, o.id, 'unready'));
    assert.equal(u.order.status, 'preparing', 'erreur corrigée');
    assert.equal(u.order.ready_at, null);
    await w.ok(act(w, w.K, o.id, 'ready'));
    assert.equal((await act(w, w.K, o.id, 'serve')).status, 403, 'le cuisinier ne sert pas');
    const s = await w.ok(act(w, w.C2, o.id, 'serve'));
    assert.equal(s.order.status, 'served'); assert.equal(s.order.served_by, 'Bao');
    assert.equal((await act(w, w.K, o.id, 'ready')).status, 409, 'plus de retour en arrière après service');
    assert.equal((await act(w, w.K, 9999, 'ready')).status, 404);
    assert.equal((await act(w, w.K, o.id, 'nimporte')).status, 404, 'route inconnue');
  } finally { await w.t.close(); }
});

test('« prête » directement depuis « envoyée » (cuisine rapide) et écran cuisine', async () => {
  const w = await shop();
  try {
    const a = await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 1 }]);
    const b = await orderOk(w, w.C2, 'Mme Diallo', [{ product_id: w.minute.id, qty: 2, note: 'sans sucre' }]);
    let bd = await w.ok(w.t.api.get('/api/orders/board', w.K));
    assert.deepEqual(bd.active.map((o) => o.label), ['Table 1', 'Mme Diallo'], 'plus ancienne en premier');
    assert.equal(bd.active[1].lines[0].note, 'sans sucre');
    assert.equal(bd.can.kitchen, true); assert.equal(bd.can.take, false);
    await w.ok(act(w, w.K, a.id, 'ready'));
    bd = await w.ok(w.t.api.get('/api/orders/board', w.C));
    assert.equal(bd.active.find((o) => o.id === a.id).status, 'ready');
    assert.equal(bd.active.find((o) => o.id === a.id).preparing_by, 'Yann');
    await w.ok(act(w, w.C, a.id, 'serve'));
    bd = await w.ok(w.t.api.get('/api/orders/board', w.C));
    assert.deepEqual(bd.active.map((o) => o.id), [b.id]);
    assert.deepEqual(bd.recent.map((o) => o.id), [a.id]);
  } finally { await w.t.close(); }
});

test('annulation : le serveur seulement tant que la cuisine n’a pas commencé ; le gérant toujours ; motif obligatoire', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    await w.t.api.post('/api/push/subscribe', sub('cuisine'), w.K);
    const o = await orderOk(w, w.C, 'Table 3', [{ product_id: w.crepe.id, qty: 1 }]);
    assert.equal((await act(w, w.C, o.id, 'cancel', { reason: '' })).status, 400);
    assert.equal((await act(w, w.C2, o.id, 'cancel', { reason: 'erreur' })).status, 403, 'pas la commande d’un collègue');
    assert.equal((await act(w, w.K, o.id, 'cancel', { reason: 'erreur' })).status, 403, 'le cuisinier n’annule pas');
    const c = await w.ok(act(w, w.C, o.id, 'cancel', { reason: 'Le client a changé d’avis' }));
    assert.equal(c.order.status, 'cancelled');
    await w.t.ctx.push.idle();
    assert.ok(p.sent.some((x) => x.payload.kind === 'cancel'), 'la cuisine est prévenue');
    assert.equal((await w.ok(act(w, w.C, o.id, 'cancel', { reason: 'encore' }))).changed, false);
    assert.equal((await act(w, w.K, o.id, 'prepare')).status, 409, 'on ne prépare pas une commande annulée');
    const o2 = await orderOk(w, w.C, 'Table 3', [{ product_id: w.crepe.id, qty: 1 }]);
    await w.ok(act(w, w.K, o2.id, 'prepare'));
    assert.equal((await act(w, w.C, o2.id, 'cancel', { reason: 'trop tard' })).status, 403);
    await w.ok(act(w, w.M, o2.id, 'cancel', { reason: 'Rupture de farine' }));
    assert.match(w.t.ctx.db.prepare("SELECT detail FROM audit WHERE action = 'order.cancel' ORDER BY id DESC LIMIT 1").get().detail, /Rupture de farine/);
  } finally { await w.t.close(); }
});

test('additions ouvertes : regroupées par étiquette (casse et espaces ignorés), annulées exclues', async () => {
  const w = await shop();
  try {
    await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 2 }, { product_id: w.cafe.id, qty: 1 }]);
    const o2 = await orderOk(w, w.C2, 'table  1', [{ product_id: w.crepe.id, qty: 1 }]);
    await orderOk(w, w.C, 'Table 2', [{ product_id: w.cafe.id, qty: 3 }]);
    const x = await orderOk(w, w.C, 'Table 2', [{ product_id: w.cafe.id, qty: 1 }]);
    await w.ok(act(w, w.C, x.id, 'cancel', { reason: 'erreur' }));
    const { tabs } = await w.ok(w.t.api.get('/api/orders/tabs', w.C));
    assert.equal(tabs.length, 2);
    const t1 = tabs.find((t) => t.label === 'Table 1');
    assert.equal(t1.order_ids.length, 2);
    assert.equal(t1.total_cents, 3 * 150 + 100);
    assert.equal(t1.lines.find((l) => l.name === 'Crêpe').qty, 3);
    assert.equal(tabs.find((t) => t.label === 'Table 2').lines[0].qty, 3, 'la commande annulée n’est pas comptée');
    assert.equal((await w.t.api.get('/api/orders/tabs', w.K)).status, 403);
    assert.ok(o2.id);
  } finally { await w.t.close(); }
});

test('paiement à la fin du repas : la vente rattache les commandes, l’addition disparaît, pas de double encaissement', async () => {
  const w = await shop();
  try {
    await w.ok(w.t.api.post('/api/production', { recipe_id: w.recipe.id, product_id: w.crepe.id, servings: 4 }, w.K), 201); // 8 crêpes
    const a = await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 2 }]);
    const b = await orderOk(w, w.C, 'Table 1', [{ product_id: w.cafe.id, qty: 1 }]);
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 0, 'commander n’encaisse rien');
    const lines = [{ product_id: w.crepe.id, qty: 2 }, { product_id: w.cafe.id, qty: 1 }];
    const sale = await w.sellOk(w.C2, lines, [{ method: 'cash', amount_cents: 500 }], { order_ids: [a.id, b.id] });
    assert.equal(sale.total_cents, 400);
    const rows = w.t.ctx.db.prepare('SELECT id, sale_id FROM orders ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.sale_id), [sale.id, sale.id]);
    assert.equal((await w.ok(w.t.api.get('/api/orders/tabs', w.C))).tabs.length, 0);
    assert.equal((await w.ok(w.t.api.get(`/api/orders/${a.id}`, w.C))).paid, true);
    // un autre caissier essaie d'encaisser la même addition
    const salesBefore = w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;
    const again = await w.sell(w.C, lines, [{ method: 'cash', amount_cents: 500 }], { order_ids: [a.id] });
    assert.equal(again.status, 409); assert.equal(again.data.error.code, 'order_paid');
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, salesBefore, 'aucune vente en double');
    assert.equal((await act(w, w.C, a.id, 'cancel', { reason: 'test' })).status, 409, 'une commande encaissée ne s’annule pas');
    // la commande reste suivie par la cuisine
    await w.ok(act(w, w.K, a.id, 'ready'));
  } finally { await w.t.close(); }
});

test('encaissement avec une commande annulée entre-temps : la vente est refusée en entier (rien d’enregistré, stock intact)', async () => {
  const w = await shop();
  try {
    const a = await orderOk(w, w.C, 'Table 4', [{ product_id: w.minute.id, qty: 1 }]);
    await w.ok(act(w, w.C, a.id, 'cancel', { reason: 'départ du client' }));
    const farine = w.stock(w.farine.id);
    const r = await w.sell(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'cash', amount_cents: 400 }], { order_ids: [a.id] });
    assert.equal(r.status, 409); assert.equal(r.data.error.code, 'order_cancelled');
    assert.equal(w.stock(w.farine.id), farine, 'le stock n’a pas bougé');
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 0);
    assert.equal((await w.sell(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'cash', amount_cents: 400 }], { order_ids: [99999] })).status, 400);
    assert.equal((await w.sell(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'cash', amount_cents: 400 }], { order_ids: 'x' })).status, 400);
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 0);
  } finally { await w.t.close(); }
});

test('paiement à l’avance : on commande puis on encaisse tout de suite ; la cuisine voit « payée »', async () => {
  const w = await shop();
  try {
    const o = await orderOk(w, w.C, 'Mme Diallo', [{ product_id: w.minute.id, qty: 1 }]);
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], [{ method: 'card', amount_cents: 400 }], { order_ids: [o.id] });
    const bd = await w.ok(w.t.api.get('/api/orders/board', w.K));
    assert.equal(bd.active[0].paid, true);
    assert.equal((await w.ok(w.t.api.get('/api/orders/tabs', w.C))).tabs.length, 0);
  } finally { await w.t.close(); }
});

test('lignes de commande et commandes : non supprimables, lignes non modifiables (même en SQL)', async () => {
  const w = await shop();
  try {
    const o = await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 1 }]);
    const db = w.t.ctx.db;
    assert.throws(() => db.prepare('UPDATE order_lines SET qty = 5 WHERE order_id = ?').run(o.id), /ne se modifie pas/);
    assert.throws(() => db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(o.id), /ne se supprime pas/);
    assert.throws(() => db.prepare('DELETE FROM orders WHERE id = ?').run(o.id), /ne se supprime pas/);
  } finally { await w.t.close(); }
});

// ------------------------------------------------------------------ notifications
test('notifications : abonnement validé, nouvelle commande → cuisine (pas l’auteur), prête → le serveur qui l’a prise', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    assert.equal((await w.t.api.post('/api/push/subscribe', { endpoint: 'http://non-https', keys: {} }, w.K)).status, 400);
    assert.equal((await w.t.api.post('/api/push/subscribe', { endpoint: 'https://x.example/abc12345', keys: { p256dh: 1 } }, w.K)).status, 400);
    assert.equal((await w.t.api.post('/api/push/subscribe', sub('x'), {})).status, 401);
    const key = await w.ok(w.t.api.get('/api/push/key', w.C));
    assert.match(key.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    await w.ok(w.t.api.post('/api/push/subscribe', sub('cuisine'), w.K), 201);
    await w.ok(w.t.api.post('/api/push/subscribe', sub('cuisine'), w.K), 201); // même appareil : pas de doublon
    await w.ok(w.t.api.post('/api/push/subscribe', sub('awa'), w.C), 201);
    await w.ok(w.t.api.post('/api/push/subscribe', sub('bao'), w.C2), 201);
    await w.ok(w.t.api.post('/api/push/subscribe', sub('gerant'), w.M), 201);
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get().c, 4);

    const o = await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 2 }, { product_id: w.bouteille.id, qty: 1 }]);
    await w.t.ctx.push.idle();
    const targets = p.sent.map((s) => s.endpoint).sort();
    assert.deepEqual(targets, [sub('cuisine').endpoint, sub('gerant').endpoint].sort(), 'cuisinier + gérant (droit cuisine), pas les caissiers');
    const msg = p.sent[0].payload;
    assert.match(msg.title, /Nouvelle commande · Table 1/);
    assert.equal(msg.body, '2 × Crêpe', 'seulement ce que la cuisine prépare (pas l’eau)');
    assert.equal(msg.kind, 'new');

    p.sent.length = 0;
    await w.ok(act(w, w.K, o.id, 'prepare'));
    await w.ok(act(w, w.K, o.id, 'ready'));
    await w.t.ctx.push.idle();
    assert.deepEqual(p.sent.map((s) => s.endpoint), [sub('awa').endpoint], 'seul le serveur qui a pris la commande');
    assert.match(p.sent[0].payload.title, /Table 1 : commande prête/);
    p.sent.length = 0;
    await w.ok(act(w, w.K, o.id, 'ready')); // double clic : pas de 2e notification
    await w.t.ctx.push.idle();
    assert.equal(p.sent.length, 0);
  } finally { await w.t.close(); }
});

test('notification « prête » : si le serveur n’a aucun appareil abonné, toute la salle est prévenue', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    await w.t.api.post('/api/push/subscribe', sub('bao'), w.C2);
    await w.t.api.post('/api/push/subscribe', sub('cuisine'), w.K);
    const o = await orderOk(w, w.C, 'Table 5', [{ product_id: w.crepe.id, qty: 1 }]);
    await w.ok(act(w, w.K, o.id, 'ready'));
    await w.t.ctx.push.idle();
    const ready = p.sent.filter((s) => s.payload.kind === 'ready');
    assert.deepEqual(ready.map((s) => s.endpoint), [sub('bao').endpoint]);
  } finally { await w.t.close(); }
});

test('notifications : appareil disparu (410) retiré, erreur gardée, panne sans effet sur la commande', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    await w.t.api.post('/api/push/subscribe', sub('vieux'), w.K);
    await w.t.api.post('/api/push/subscribe', sub('capricieux'), w.M);
    p.behaviour.fail = { [sub('vieux').endpoint]: { gone: true }, [sub('capricieux').endpoint]: { error: '503 service indisponible' } };
    const o = await order(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 1 }]);
    assert.equal(o.status, 201, 'la commande est enregistrée même si les notifications échouent');
    await w.t.ctx.push.idle();
    const left = w.t.ctx.db.prepare('SELECT endpoint, last_error FROM push_subscriptions').all();
    assert.equal(left.length, 1);
    assert.equal(left[0].endpoint, sub('capricieux').endpoint);
    assert.match(left[0].last_error, /503/);
    // un sender qui plante n'a pas d'effet non plus
    w.t.ctx.push.sender = async () => { throw new Error('boum'); };
    assert.equal((await order(w, w.C, 'Table 2', [{ product_id: w.crepe.id, qty: 1 }])).status, 201);
    await w.t.ctx.push.idle();
  } finally { await w.t.close(); }
});

test('notifications : test, liste, désabonnement ; un compte désactivé ne reçoit plus rien', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    await w.t.api.post('/api/push/subscribe', sub('a'), w.C);
    const mine = await w.ok(w.t.api.get('/api/push/mine', w.C));
    assert.equal(mine.devices.length, 1);
    assert.equal((await w.ok(w.t.api.get('/api/push/mine', w.K))).devices.length, 0, 'chacun ne voit que ses appareils');
    const t = await w.ok(w.t.api.post('/api/push/test', {}, w.C));
    assert.equal(t.sent, 1);
    assert.equal(p.sent.at(-1).payload.kind, 'test');
    // un autre utilisateur ne peut pas retirer l'appareil d'un collègue
    await w.ok(w.t.api.post('/api/push/unsubscribe', { endpoint: sub('a').endpoint }, w.K));
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get().c, 1);
    await w.t.api.post('/api/push/subscribe', sub('k'), w.K);
    await w.ok(w.t.api.patch(`/api/users/${w.cook.user?.id ?? w.cook.id}`, { active: false }, w.O));
    p.sent.length = 0;
    await orderOk(w, w.C, 'Table 1', [{ product_id: w.crepe.id, qty: 1 }]);
    await w.t.ctx.push.idle();
    assert.ok(!p.sent.some((s) => s.endpoint === sub('k').endpoint), 'compte désactivé : pas de notification');
    await w.ok(w.t.api.post('/api/push/unsubscribe', { endpoint: sub('a').endpoint }, w.C));
    assert.equal((await w.ok(w.t.api.get('/api/push/mine', w.C))).devices.length, 0);
  } finally { await w.t.close(); }
});

test('clés d’identification (VAPID) : créées une fois, conservées, jamais envoyées par les réglages', async () => {
  const w = await shop();
  try {
    const a = vapidKeys(w.t.ctx.db); const b = vapidKeys(w.t.ctx.db);
    assert.equal(a.publicKey, b.publicKey); assert.equal(a.privateKey, b.privateKey);
    const key = await w.ok(w.t.api.get('/api/push/key', w.C));
    assert.equal(key.publicKey, a.publicKey);
    for (const url of ['/api/settings', '/api/me', '/api/public']) {
      const r = await w.t.api.get(url, w.O);
      assert.ok(!JSON.stringify(r.data).includes(a.privateKey), `${url} ne révèle pas la clé privée`);
    }
  } finally { await w.t.close(); }
});

// ------------------------------------------------------------------ envoi réel (service de notification imité)
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { realSender } from '../server/push.js';

function decryptAes128gcm(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16); const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen); const cipher = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const prk = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString('utf8');
}

test('envoi réel : message chiffré selon la norme Web Push, signé VAPID, lisible par l’appareil ; 410 = appareil disparu', async () => {
  const w = await shop();
  const got = [];
  let status = 201;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(status); res.end(); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const s = { endpoint: `https://127.0.0.1:${srv.address().port}/push/abc`, p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const vapid = vapidKeys(w.t.ctx.db);
    const agent = new https.Agent({ rejectUnauthorized: false });
    const r = await realSender(s, { title: 'Table 1 prête', body: 'À servir', kind: 'ready' }, vapid, { agent });
    assert.equal(r.ok, true);
    const q = got[0];
    assert.equal(q.headers['content-encoding'], 'aes128gcm');
    assert.match(q.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.ok(q.headers.authorization.includes(`k=${vapid.publicKey}`));
    assert.equal(q.headers.urgency, 'high'); assert.ok(Number(q.headers.ttl) > 0);
    const clear = JSON.parse(decryptAes128gcm(q.body, ua.getPrivateKey(), ua.getPublicKey(), auth));
    assert.deepEqual(clear, { title: 'Table 1 prête', body: 'À servir', kind: 'ready' });
    status = 410; assert.deepEqual(await realSender(s, { title: 'x' }, vapid, { agent }), { gone: true });
    status = 404; assert.deepEqual(await realSender(s, { title: 'x' }, vapid, { agent }), { gone: true });
    status = 500; assert.match((await realSender(s, { title: 'x' }, vapid, { agent })).error, /500/);
  } finally { srv.closeAllConnections?.(); srv.close(); await w.t.close(); }
});

test('commande prête : si le serveur qui l’a prise a été désactivé, la salle est prévenue à sa place', async () => {
  const w = await shop(); const p = fakePush(w);
  try {
    await w.t.api.post('/api/push/subscribe', sub('awa'), w.C);
    await w.t.api.post('/api/push/subscribe', sub('bao'), w.C2);
    const o = await orderOk(w, w.C, 'Table 7', [{ product_id: w.crepe.id, qty: 1 }]);
    await w.ok(w.t.api.patch(`/api/users/${w.cashier.user?.id ?? w.cashier.id}`, { active: false }, w.O));
    await w.ok(act(w, w.K, o.id, 'ready'));
    await w.t.ctx.push.idle();
    assert.deepEqual(p.sent.filter((s) => s.payload.kind === 'ready').map((s) => s.endpoint), [sub('bao').endpoint]);
  } finally { await w.t.close(); }
});
