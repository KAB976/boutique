import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeSupabase } from './fake-supabase.js';
import { cloudConfig, restoreFromCloud, CloudSync } from '../server/cloud.js';
import { createApp } from '../server/app.js';
import { OWNER_PIN } from './helpers.js';

const silent = { log() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'boutique-cloud-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Démarre une « instance » du serveur comme le ferait index.js. */
async function instance(sb, dir, { debounceMs = 20, retryBaseMs = 4000 } = {}) {
  const cfg = { url: sb.url, key: sb.key, bucket: 'boutique-data' };
  const seq = await restoreFromCloud(cfg, dir, { log: silent });
  const cloud = new CloudSync(cfg, { seq, debounceMs, retryBaseMs, log: silent });
  const ctx = createApp({ dataDir: dir, cloud });
  const srv = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { cfg, cloud, ctx, call, close: async () => { await cloud.flush().catch(() => {}); await new Promise((r) => srv.close(r)); try { ctx.db.close(); } catch { /* ok */ } } };
}

test('configuration en ligne : absente, incomplète, valide', () => {
  assert.equal(cloudConfig({}), null);
  assert.throws(() => cloudConfig({ SUPABASE_URL: 'https://x.supabase.co' }), /tous deux/);
  assert.throws(() => cloudConfig({ SUPABASE_URL: 'http://x.example.com', SUPABASE_SERVICE_KEY: 'k' }), /https/);
  assert.deepEqual(cloudConfig({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_KEY: 'k' }), { url: 'https://x.supabase.co', key: 'k', bucket: 'boutique-data' });
});

test('CRITÈRE : le serveur redémarre sur un disque vide et retrouve toutes les données', async () => {
  const sb = await fakeSupabase();
  const d1 = tmp(), d2 = tmp();
  try {
    const a = await instance(sb, d1);
    const setup = await a.call('POST', '/api/setup', { shopName: 'Chez Karim', ownerName: 'Karim', pin: OWNER_PIN });
    assert.equal(setup.status, 201, JSON.stringify(setup.data));
    const token = setup.data.token;
    const ing = await a.call('POST', '/api/ingredients', { name: 'Farine', family: 'mass' }, token);
    assert.equal(ing.status, 201);
    const rec = await a.call('POST', '/api/stock/receipts', { ingredient_id: ing.data.id, qty: 25, unit: 'kg', total_price: 30 }, token);
    assert.equal(rec.status, 201);
    await a.close(); // vide l'envoi en attente comme à l'arrêt du serveur
    assert.ok([...sb.objects.keys()].some((k) => k.startsWith('boutique-data/db/')), 'une copie existe en ligne');

    // nouveau serveur, disque tout neuf (Render après redémarrage)
    const b = await instance(sb, d2);
    const login = await b.call('POST', '/api/auth/login', { userId: 1, pin: OWNER_PIN });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    const stock = await b.call('GET', '/api/stock', null, login.data.token);
    assert.equal(stock.data.items[0].name, 'Farine');
    assert.equal(stock.data.items[0].stock, 25000);
    assert.equal((await b.call('GET', '/api/public')).data.shop_name, 'Chez Karim');
    await b.close();
  } finally { await sb.close(); }
});

test('une écriture déclenche une copie ; une lecture non ; une copie contient bien la dernière écriture', async () => {
  const sb = await fakeSupabase();
  const d = tmp();
  try {
    const a = await instance(sb, d);
    const s = await a.call('POST', '/api/setup', { shopName: 'X', ownerName: 'K', pin: OWNER_PIN });
    await sleep(300);
    const before = [...sb.objects.keys()].filter((k) => k.includes('/db/')).length;
    assert.ok(before >= 1);
    await a.call('GET', '/api/me', null, s.data.token);
    await sleep(100);
    assert.equal([...sb.objects.keys()].filter((k) => k.includes('/db/')).length, before, 'une lecture n\'envoie rien');
    await a.call('POST', '/api/ingredients', { name: 'Sucre', family: 'mass' }, s.data.token);
    await sleep(300);
    const last = [...sb.objects.keys()].filter((k) => k.includes('/db/')).sort().at(-1);
    const f = path.join(tmp(), 'x.db'); fs.writeFileSync(f, sb.objects.get(last));
    const raw = new DatabaseSync(f, { readOnly: true });
    assert.equal(raw.prepare("SELECT name FROM ingredients").get().name, 'Sucre');
    assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    raw.close();
    assert.equal(a.cloud.status().lastError, null);
    assert.ok(a.cloud.status().lastOkAt);
    await a.close();
  } finally { await sb.close(); }
});

test('panne de Supabase : l\'application continue, réessaie, puis rattrape', async () => {
  const sb = await fakeSupabase();
  const d = tmp();
  try {
    const a = await instance(sb, d, { debounceMs: 10 });
    const s = await a.call('POST', '/api/setup', { shopName: 'X', ownerName: 'K', pin: OWNER_PIN });
    await a.cloud.flush();
    sb.state.fail = 2; // les deux prochaines écritures échouent
    const r = await a.call('POST', '/api/ingredients', { name: 'Sel', family: 'mass' }, s.data.token);
    assert.equal(r.status, 201, 'le travail n\'est jamais bloqué par la panne');
    await a.cloud.flush();
    assert.match(a.cloud.status().lastError, /impossible/);
    assert.equal(a.cloud.status().pending, true);
    for (let i = 0; i < 40 && a.cloud.status().lastError; i++) { await sleep(300); await a.cloud.flush(); }
    assert.equal(a.cloud.status().lastError, null, 'rattrapé');
    const last = [...sb.objects.keys()].filter((k) => k.includes('/db/')).sort().at(-1);
    const f = path.join(tmp(), 'x.db'); fs.writeFileSync(f, sb.objects.get(last));
    const raw = new DatabaseSync(f, { readOnly: true });
    assert.equal(raw.prepare('SELECT name FROM ingredients').get().name, 'Sel');
    raw.close();
    await a.close();
  } finally { await sb.close(); }
});

test('panne : nouvelle tentative automatique, sans aucune action de personne', async () => {
  const sb = await fakeSupabase();
  try {
    const a = await instance(sb, tmp(), { debounceMs: 5, retryBaseMs: 10 });
    const s = await a.call('POST', '/api/setup', { shopName: 'X', ownerName: 'K', pin: OWNER_PIN });
    await a.cloud.flush();
    sb.state.fail = 2;
    await a.call('POST', '/api/ingredients', { name: 'Poivre', family: 'mass' }, s.data.token);
    for (let i = 0; i < 100 && (a.cloud.status().pending || a.cloud.status().lastError); i++) await sleep(50);
    assert.equal(a.cloud.status().lastError, null);
    assert.equal(a.cloud.status().pending, false);
    const last = [...sb.objects.keys()].filter((k) => k.includes('/db/')).sort().at(-1);
    const f = path.join(tmp(), 'x.db'); fs.writeFileSync(f, sb.objects.get(last));
    const raw = new DatabaseSync(f, { readOnly: true });
    assert.equal(raw.prepare('SELECT name FROM ingredients').get().name, 'Poivre');
    raw.close();
    await a.close();
  } finally { await sb.close(); }
});

test('deux serveurs en même temps : le second est bloqué, rien n\'est écrasé', async () => {
  const sb = await fakeSupabase();
  const d1 = tmp(), d2 = tmp();
  try {
    const a = await instance(sb, d1);
    const s = await a.call('POST', '/api/setup', { shopName: 'A', ownerName: 'K', pin: OWNER_PIN });
    await a.cloud.flush();
    const b = await instance(sb, d2); // démarre sur la même copie
    // A écrit, puis B écrit à partir d'un état périmé
    await a.call('POST', '/api/ingredients', { name: 'DeA', family: 'mass' }, s.data.token);
    await a.cloud.flush();
    const lb = await b.call('POST', '/api/auth/login', { userId: 1, pin: OWNER_PIN });
    await b.call('POST', '/api/ingredients', { name: 'DeB', family: 'mass' }, lb.data.token);
    await b.cloud.flush();
    assert.equal(b.cloud.status().conflict, true);
    assert.match(b.cloud.status().lastError, /autre copie/);
    const last = [...sb.objects.keys()].filter((k) => k.includes('/db/')).sort().at(-1);
    const f = path.join(tmp(), 'x.db'); fs.writeFileSync(f, sb.objects.get(last));
    const raw = new DatabaseSync(f, { readOnly: true });
    assert.deepEqual(raw.prepare('SELECT name FROM ingredients').all().map((r) => r.name), ['DeA'], 'la copie en ligne n\'a pas été écrasée par B');
    raw.close();
    await a.close(); await b.close();
  } finally { await sb.close(); }
});

test('copie en ligne illisible ou clé fausse : le démarrage est refusé (jamais de base vide par erreur)', async () => {
  const sb = await fakeSupabase();
  try {
    await assert.rejects(() => restoreFromCloud({ url: sb.url, key: 'mauvaise', bucket: 'boutique-data' }, tmp(), { log: silent }), /401/);
    sb.objects.set('boutique-data/db/0000000001.db', Buffer.alloc(500, 'x'));
    await assert.rejects(() => restoreFromCloud({ url: sb.url, key: sb.key, bucket: 'boutique-data' }, tmp(), { log: silent }), /illisible/);
    await assert.rejects(() => restoreFromCloud({ url: 'http://127.0.0.1:1', key: 'k', bucket: 'b' }, tmp(), { log: silent }), /injoignable/);
  } finally { await sb.close(); }
});

test('ménage : au plus 20 copies courantes, une copie par jour, test de connexion', async () => {
  const sb = await fakeSupabase();
  const d = tmp();
  try {
    const a = await instance(sb, d, { debounceMs: 5 });
    const s = await a.call('POST', '/api/setup', { shopName: 'X', ownerName: 'K', pin: OWNER_PIN });
    for (let i = 0; i < 25; i++) { await a.call('POST', '/api/ingredients', { name: `I${i}`, family: 'mass' }, s.data.token); await a.cloud.flush(); }
    const keys = [...sb.objects.keys()];
    assert.equal(keys.filter((k) => k.includes('/db/')).length, 20);
    assert.equal(keys.filter((k) => k.includes('/daily/')).length, 1);
    assert.equal(await a.cloud.selfTest(), true);
    assert.ok(![...sb.objects.keys()].some((k) => k.includes('/test/')));
    await a.close();
  } finally { await sb.close(); }
});

test('état en ligne visible du propriétaire seulement', async () => {
  const sb = await fakeSupabase();
  const d = tmp();
  try {
    const a = await instance(sb, d);
    const s = await a.call('POST', '/api/setup', { shopName: 'X', ownerName: 'K', pin: OWNER_PIN });
    const st = await a.call('GET', '/api/cloud/status', null, s.data.token);
    assert.equal(st.status, 200); assert.equal(st.data.enabled, true);
    assert.equal((await a.call('GET', '/api/cloud/status')).status, 401);
    assert.ok(!JSON.stringify(st.data).includes(sb.key), 'la clé ne sort jamais du serveur');
    await a.close();
  } finally { await sb.close(); }
});
