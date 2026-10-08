import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, OWNER_PIN } from './helpers.js';
import { verifyJournal } from '../server/stock.js';
import { verifyAudit } from '../server/audit.js';
import { MIGRATIONS } from '../server/db.js';
import { createApp } from '../server/app.js';

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} attendu ${b}, reçu ${a}`);
const actions = (ctx) => ctx.db.prepare('SELECT action FROM audit ORDER BY id').all().map((r) => r.action);
const DAY = 86400000;
const ymd = (clock, plusDays = 0) => new Date(clock.t.getTime() + plusDays * DAY).toISOString().slice(0, 10);

/** Monde de test : propriétaire, gérant, cuisinier, caissier + quelques ingrédients. */
async function world() {
  const t = await boot();
  const owner = await t.setup();
  const manager = await t.staff(owner, 'Mina', 'manager');
  const cook = await t.staff(owner, 'Yann', 'cook');
  const cashier = await t.staff(owner, 'Awa', 'cashier');
  const O = { token: owner }, M = { token: manager.token }, K = { token: cook.token }, C = { token: cashier.token };
  const mk = async (body, who = O) => {
    const r = await t.api.post('/api/ingredients', body, who);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const receive = (body, who = O) => t.api.post('/api/stock/receipts', body, who);
  const stockOf = async (id, who = O) => (await t.api.get(`/api/ingredients/${id}`, who)).data;
  return { t, O, M, K, C, mk, receive, stockOf };
}

test('mise à jour : une base de l\'étape 1 est migrée sans rien perdre', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boutique-mig-'));
  const raw = new DatabaseSync(path.join(dir, 'boutique.db'));
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  raw.exec(MIGRATIONS[0].sql);
  raw.prepare("INSERT INTO schema_version VALUES (1, 'socle', 'x')").run();
  raw.prepare("INSERT INTO users (name, pin_hash, role, created_at, updated_at) VALUES ('Karim','scrypt$x','owner','x','x')").run();
  raw.close();
  const ctx = createApp({ dataDir: dir });
  try {
    assert.equal(ctx.db.prepare('SELECT MAX(version) v FROM schema_version').get().v, MIGRATIONS.at(-1).version);
    assert.equal(ctx.db.prepare('SELECT name FROM users').get().name, 'Karim');
    assert.ok(fs.existsSync(path.join(dir, 'avant-mise-a-niveau-v1.db')), 'copie de sécurité avant mise à niveau');
    assert.deepEqual(ctx.db.prepare('SELECT code FROM measures ORDER BY id').all().map((r) => r.code), ['cc', 'cs', 'tasse', 'pincee']);
  } finally { ctx.db.close(); }
});

test('ingrédients : création, validation, doublons, archivage, conditionnements', async () => {
  const { t, O, M, K, C, mk } = await world();
  try {
    const farine = await mk({ name: 'Farine', family: 'mass', packs: [{ label: 'sac', contains: 25000 }], equivalences: [{ unit: 'tasse', base_qty: 120 }], threshold: { qty: 5, unit: 'kg' }, yield_pct: 100 });
    assert.equal(farine.threshold, 5000);
    assert.equal(farine.stock, 0);
    assert.deepEqual(farine.units.map((u) => u.code).slice(0, 3), ['pack:0', 'mg', 'g']);
    const bad = (body, re) => t.api.post('/api/ingredients', body, O).then((r) => { assert.equal(r.status, 400, JSON.stringify(body)); if (re) assert.match(r.data.error.message, re); });
    await bad({ name: '', family: 'mass' }, /nom/i);
    await bad({ name: 'X', family: 'poids' }, /poids, volume ou pièces/);
    await bad({ name: 'X', family: 'mass', yield_pct: 0 }, /Rendement/);
    await bad({ name: 'X', family: 'mass', yield_pct: 120 }, /trop grand/);
    await bad({ name: 'X', family: 'mass', density: -1 }, /Densité/);
    await bad({ name: 'X', family: 'mass', equivalences: [{ unit: 'inconnue', base_qty: 5 }] }, /Mesure inconnue/);
    await bad({ name: 'X', family: 'mass', equivalences: [{ unit: 'tasse', base_qty: 5 }, { unit: 'tasse', base_qty: 6 }] }, /deux fois/);
    await bad({ name: 'X', family: 'mass', packs: [{ label: 'a', contains: 2.5 }, { label: 'b', contains: 1 }] }, /nombre entier/);
    await bad({ name: 'X', family: 'mass', threshold: { qty: 2, unit: 'l' } }, /Impossible de convertir/);
    await bad({ name: 'X', family: 'mass', purchase_depth: 3 }, /Niveau d'achat/);
    assert.equal((await t.api.post('/api/ingredients', { name: ' farine ', family: 'mass' }, O)).status, 409);
    // droits : le gérant crée, le cuisinier et le caissier non
    assert.equal((await t.api.post('/api/ingredients', { name: 'Sel', family: 'mass' }, M)).status, 201);
    assert.equal((await t.api.post('/api/ingredients', { name: 'Poivre', family: 'mass' }, K)).status, 403);
    assert.equal((await t.api.post('/api/ingredients', { name: 'Poivre', family: 'mass' }, C)).status, 403);
    // modification : le journal garde l'avant/après
    const upd = await t.api.patch(`/api/ingredients/${farine.id}`, { storage: 'Réserve', threshold: { qty: 8, unit: 'kg' } }, M);
    assert.equal(upd.status, 200);
    assert.equal(upd.data.threshold, 8000);
    const row = t.ctx.db.prepare("SELECT detail, user_name FROM audit WHERE action = 'ingredient.update'").get();
    assert.equal(row.user_name, 'Mina');
    assert.deepEqual(JSON.parse(row.detail).stockage, { from: '', to: 'Réserve' });
    // archivage : refusé s'il reste du stock, accepté à zéro ; le nom se libère
    await t.api.post('/api/stock/receipts', { ingredient_id: farine.id, qty: 1, unit: 'kg', total_price: 2 }, O);
    const refuse = await t.api.patch(`/api/ingredients/${farine.id}`, { active: false }, O);
    assert.equal(refuse.status, 409);
    assert.match(refuse.data.error.message, /stock n'est pas vide/);
    await t.api.post('/api/stock/losses', { ingredient_id: farine.id, qty: 1, unit: 'kg', reason: 'jete' }, O);
    assert.equal((await t.api.patch(`/api/ingredients/${farine.id}`, { active: false }, O)).status, 200);
    assert.equal((await t.api.post('/api/ingredients', { name: 'Farine', family: 'mass' }, O)).status, 201, 'le nom archivé est libre');
    assert.equal((await t.api.patch(`/api/ingredients/${farine.id}`, { active: true }, O)).status, 409, 'on ne ressuscite pas un doublon');
    // la façon de compter ne change plus une fois qu'il y a des mouvements
    const fam = await t.api.patch(`/api/ingredients/${farine.id}`, { family: 'volume' }, O);
    assert.equal(fam.status, 409);
    assert.equal(fam.data.error.code, 'family_locked');
    // un ingrédient archivé ne reçoit plus de stock
    assert.equal((await t.api.post('/api/stock/receipts', { ingredient_id: farine.id, qty: 1, unit: 'kg', total_price: 2 }, O)).status, 404);
  } finally { await t.close(); }
});

test('CRITÈRE : le coût moyen pondéré correspond au calcul fait à la main', async () => {
  const { t, O, mk, receive, stockOf } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass', packs: [{ label: 'sac', contains: 25000 }] });
    // 1) 25 kg à 42,90 € : coût = 42,90 / 25 000 g
    let r = await receive({ ingredient_id: f.id, qty: 1, unit: 'pack:0', total_price: 42.9 });
    assert.equal(r.status, 201);
    let s = await stockOf(f.id);
    near(s.stock, 25000, 'stock');
    near(s.avg_cost, 42.9 / 25000, 'coût moyen 1', 1e-12);
    // 2) on jette 5 kg : le coût moyen ne bouge pas, la perte est valorisée au coût moyen
    r = await t.api.post('/api/stock/losses', { ingredient_id: f.id, qty: 5, unit: 'kg', reason: 'casse' }, O);
    assert.equal(r.status, 201);
    near(r.data.value, 5000 * (42.9 / 25000), 'valeur de la perte', 1e-9);
    s = await stockOf(f.id);
    near(s.stock, 20000, 'stock après perte');
    near(s.avg_cost, 42.9 / 25000, 'coût moyen inchangé', 1e-12);
    // 3) 25 kg à 45,00 € : (20 000 × 0,001716 + 25 000 × 0,0018) / 45 000 = 79,32 / 45 000
    await receive({ ingredient_id: f.id, qty: 25, unit: 'kg', total_price: 45 });
    s = await stockOf(f.id);
    near(s.stock, 45000, 'stock');
    near(s.avg_cost, 79.32 / 45000, 'coût moyen 2', 1e-12);
    near(s.value, 79.32, 'valeur du stock = 79,32 €', 1e-9);
    // 4) le prix par gramme du dernier achat et du précédent sont conservés
    near(s.last_price, 45 / 25000, 'dernier prix', 1e-12);
    near(s.prev_price, 42.9 / 25000, 'prix précédent', 1e-12);
    // 5) CRITÈRE : stock = somme du journal, et le journal rejoué donne les mêmes chiffres
    const sum = t.ctx.db.prepare('SELECT SUM(qty) q FROM stock_moves WHERE ingredient_id = ?').get(f.id).q;
    near(sum, 45000, 'somme des lignes');
    const v = (await t.api.get('/api/stock/verify', O)).data;
    assert.deepEqual({ ok: v.ok, problems: v.problems }, { ok: true, problems: [] });
    // 6) un seul achat d'un ingrédient neuf : le coût moyen = le prix
    const g = await mk({ name: 'Sucre', family: 'mass' });
    await receive({ ingredient_id: g.id, qty: 10, unit: 'kg', total_price: 12 });
    near((await stockOf(g.id)).avg_cost, 0.0012, 'sucre', 1e-12);
    // 7) après stock vide, le coût repart du dernier prix (pas de mélange avec le passé)
    await t.api.post('/api/stock/losses', { ingredient_id: g.id, qty: 10, unit: 'kg', reason: 'jete' }, O);
    await receive({ ingredient_id: g.id, qty: 1, unit: 'kg', total_price: 2 });
    near((await stockOf(g.id)).avg_cost, 0.002, 'repart du dernier prix', 1e-12);
  } finally { await t.close(); }
});

test('conditionnements : lot de 3 paquets de 4 sachets de 4 g, utilisation en g ou en cuillères', async () => {
  const { t, O, K, mk, receive, stockOf } = await world();
  try {
    const lev = await mk({
      name: 'Levure', family: 'mass', purchase_depth: 1,
      packs: [{ label: 'lot', contains: 3 }, { label: 'paquet', contains: 4 }, { label: 'sachet', contains: 4 }],
    });
    // 2 lots à 12,00 € = 96 g, 0,125 € le gramme
    await receive({ ingredient_id: lev.id, qty: 2, unit: 'pack:0', total_price: 12 });
    let s = await stockOf(lev.id);
    near(s.stock, 96); near(s.avg_cost, 0.125, 'prix du gramme', 1e-12);
    assert.deepEqual(s.breakdown, { parts: [{ label: 'lot', n: 2 }], rest: 0 });
    // on utilise 1 sachet : 92 g = 1 lot + 2 paquets + 3 sachets
    await t.api.post('/api/stock/losses', { ingredient_id: lev.id, qty: 1, unit: 'pack:2', reason: 'jete' }, O);
    s = await stockOf(lev.id);
    near(s.stock, 92);
    assert.deepEqual(s.breakdown, { parts: [{ label: 'lot', n: 1 }, { label: 'paquet', n: 2 }, { label: 'sachet', n: 3 }], rest: 0 });
    assert.equal(s.stockText, '92 g');
    // la cuillère à café est refusée tant qu'on ne sait pas ce qu'elle pèse...
    const refus = await t.api.post('/api/stock/losses', { ingredient_id: lev.id, qty: 1, unit: 'cc', reason: 'jete' }, O);
    assert.equal(refus.status, 400);
    assert.equal(refus.data.error.code, 'conversion');
    assert.match(refus.data.error.message, /cuillère à café/);
    assert.ok(!s.units.some((u) => u.code === 'cc'), 'elle n\'est pas proposée non plus');
    // ... puis acceptée dès qu'on l'indique : 1 c. à café = 3,5 g
    const eq = await t.api.patch(`/api/ingredients/${lev.id}`, { equivalences: [{ unit: 'cc', base_qty: 3.5 }] }, O);
    assert.equal(eq.status, 200);
    assert.ok(eq.data.units.some((u) => u.code === 'cc'));
    await t.api.post('/api/stock/losses', { ingredient_id: lev.id, qty: 2, unit: 'cc', reason: 'jete' }, O);
    near((await stockOf(lev.id)).stock, 85, '92 − 2 × 3,5 = 85 g');
    // le cuisinier peut déclarer en emballages
    assert.equal((await t.api.post('/api/stock/losses', { ingredient_id: lev.id, qty: 1, unit: 'pack:1', reason: 'perime' }, { token: K.token })).status, 201);
    near((await stockOf(lev.id)).stock, 69, '85 − 16');
    // liste de courses : 14 g de levure → 4 sachets de 4 g → à acheter : 1 paquet
    const need = async (qty, unit) => (await t.api.get(`/api/stock/shopping-calc?ingredient_id=${lev.id}&qty=${qty}&unit=${unit}`, O)).data;
    // stock actuel 69 g couvre 14 g : rien à acheter
    assert.equal((await need(14, 'g')).packs, 0);
    // on vide le stock pour le calcul (69 g = 1 lot + 1 paquet + 5 g)
    await t.api.post('/api/stock/losses', { ingredient_id: lev.id, qty: 69, unit: 'g', reason: 'jete' }, O);
    let c = await need(14, 'g');
    assert.equal(c.packs, 1); assert.equal(c.packLabel, 'paquet'); near(c.toBuyBase, 16); near(c.leftover, 2);
    c = await need(40, 'g');
    assert.equal(c.packs, 3); near(c.toBuyBase, 48);
    c = await need(17, 'g');
    assert.equal(c.packs, 2, '17 g demandent 2 paquets de 16 g');
    await t.api.patch(`/api/ingredients/${lev.id}`, { purchase_depth: 2 }, O);
    c = await need(14, 'g');
    assert.equal(c.packs, 4); assert.equal(c.packLabel, 'sachet');
    await t.api.patch(`/api/ingredients/${lev.id}`, { purchase_depth: 0 }, O);
    assert.equal((await need(49, 'g')).packs, 2, '49 g = 2 lots');
    assert.equal((await t.api.get(`/api/stock/shopping-calc?ingredient_id=${lev.id}&qty=1&unit=l`, O)).status, 400);
  } finally { await t.close(); }
});

test('capsules de café : carton de 10 boîtes de 10 capsules, comptées à la pièce', async () => {
  const { t, O, mk, receive, stockOf } = await world();
  try {
    const cap = await mk({ name: 'Capsule café', family: 'count', packs: [{ label: 'carton', contains: 10 }, { label: 'boîte', contains: 10 }, { label: 'capsule', contains: 1 }] });
    await receive({ ingredient_id: cap.id, qty: 2, unit: 'pack:0', total_price: 100 });
    let s = await stockOf(cap.id);
    near(s.stock, 200); near(s.avg_cost, 0.5, 'une capsule revient à 0,50', 1e-12);
    await t.api.post('/api/stock/losses', { ingredient_id: cap.id, qty: 13, unit: 'piece', reason: 'jete' }, O);
    s = await stockOf(cap.id);
    assert.equal(s.stockText, '187 pièces');
    assert.deepEqual(s.breakdown.parts, [{ label: 'carton', n: 1 }, { label: 'boîte', n: 8 }, { label: 'capsule', n: 7 }]);
    assert.equal((await t.api.post('/api/stock/losses', { ingredient_id: cap.id, qty: 1, unit: 'g', reason: 'jete' }, O)).status, 400);
  } finally { await t.close(); }
});

test('CRITÈRE : une conversion impossible est refusée par le serveur, jamais approchée', async () => {
  const { t, O, mk, receive } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass' });
    const h = await mk({ name: 'Huile', family: 'volume', density: 0.92 });
    const o = await mk({ name: 'Œuf', family: 'count' });
    const refused = async (body, re) => {
      const r = await receive(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.error.code, 'conversion');
      assert.match(r.data.error.message, re);
    };
    await refused({ ingredient_id: f.id, qty: 1, unit: 'l', total_price: 1 }, /Impossible de convertir « l » en g pour « Farine »/);
    await refused({ ingredient_id: o.id, qty: 100, unit: 'g', total_price: 1 }, /poids d'une pièce/);
    await refused({ ingredient_id: h.id, qty: 1, unit: 'piece', total_price: 1 }, /poids d'une pièce|densité/);
    await refused({ ingredient_id: f.id, qty: 1, unit: 'tasse', total_price: 1 }, /densité/);
    // avec la densité de l'huile : 1 kg d'huile = 1086,956522 ml
    const ok = await receive({ ingredient_id: h.id, qty: 1, unit: 'kg', total_price: 2 });
    assert.equal(ok.status, 201);
    near(ok.data.lines[0].base, 1086.956522, 'kg → ml via la densité', 1e-6);
    // inconnue, vide, négative, nulle, absurde
    for (const [qty, unit] of [[1, 'furlong'], [1, ''], [-1, 'kg'], [0, 'kg'], ['abc', 'kg'], [1e12, 'kg']]) {
      assert.equal((await receive({ ingredient_id: f.id, qty, unit, total_price: 1 })).status, 400, `${qty} ${unit}`);
    }
    // et rien n'a été écrit pour la farine
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM stock_moves WHERE ingredient_id = ?').get(f.id).c, 0);
    // le calcul d'aide refuse aussi
    const cv = await t.api.post('/api/stock/convert', { ingredient_id: f.id, qty: 2, unit: 'l' }, O);
    assert.equal(cv.status, 400);
  } finally { await t.close(); }
});

test('mesures générales : le propriétaire en ajoute et en modifie, elles servent aux conversions', async () => {
  const { t, O, M, K, mk, receive } = await world();
  try {
    assert.equal((await t.api.post('/api/measures', { label: 'verre', ml: 200 }, M)).status, 403);
    assert.equal((await t.api.post('/api/measures', { label: 'verre', ml: 200 }, K)).status, 403);
    const v = await t.api.post('/api/measures', { label: 'Verre', ml: 200 }, O);
    assert.equal(v.status, 201);
    assert.match(v.data.code, /^m-verre/);
    assert.equal((await t.api.post('/api/measures', { label: ' verre ', ml: 100 }, O)).status, 409);
    for (const bad of [{ label: '', ml: 5 }, { label: 'x', ml: 0 }, { label: 'x', ml: -3 }, { label: 'x', ml: 'abc' }, { label: 'x'.repeat(31), ml: 5 }]) {
      assert.equal((await t.api.post('/api/measures', bad, O)).status, 400, JSON.stringify(bad));
    }
    const lait = await mk({ name: 'Lait', family: 'volume' });
    const r = await receive({ ingredient_id: lait.id, qty: 2, unit: v.data.code, total_price: 1 });
    assert.equal(r.status, 201);
    near(r.data.lines[0].base, 400, '2 verres = 400 ml');
    // les mesures de base : modifiables, mais pas supprimables
    assert.equal((await t.api.patch('/api/measures/cs', { ml: 12 }, O)).status, 200);
    const r2 = await receive({ ingredient_id: lait.id, qty: 1, unit: 'cs', total_price: 1 });
    near(r2.data.lines[0].base, 12, 'la c. à soupe vaut maintenant 12 ml');
    assert.equal((await t.api.patch('/api/measures/cs', { active: false }, O)).status, 409);
    // mesure utilisée dans une fiche : on ne la retire pas
    await mk({ name: 'Sucre', family: 'mass', equivalences: [{ unit: v.data.code, base_qty: 150 }] });
    assert.equal((await t.api.patch(`/api/measures/${v.data.code}`, { active: false }, O)).status, 409);
    // une mesure inutilisée se retire ; elle disparaît des listes
    const w = (await t.api.post('/api/measures', { label: 'bol', ml: 300 }, O)).data;
    assert.equal((await t.api.patch(`/api/measures/${w.code}`, { active: false }, O)).status, 200);
    const list = (await t.api.get('/api/measures', O)).data.map((m) => m.code);
    assert.ok(list.includes('cc') && list.includes(v.data.code) && !list.includes(w.code));
    assert.ok(actions(t.ctx).includes('measure.create') && actions(t.ctx).includes('measure.update'));
  } finally { await t.close(); }
});

test('droits : le cuisinier voit le stock mais jamais un prix ni une valeur ; le caissier rien', async () => {
  const { t, O, M, K, C, mk, receive } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass' });
    await receive({ ingredient_id: f.id, qty: 10, unit: 'kg', total_price: 15 }, M);
    const sees = async (who) => (await t.api.get('/api/stock', who));
    for (const who of [O, M]) {
      const r = await sees(who);
      assert.equal(r.status, 200);
      assert.ok('avg_cost' in r.data.items[0] && 'value' in r.data.items[0] && 'last_price' in r.data.items[0]);
      assert.ok('totalValue' in r.data);
    }
    const kc = await sees(K);
    assert.equal(kc.status, 200);
    const item = kc.data.items[0];
    assert.equal(item.stock, 10000);
    for (const k of ['avg_cost', 'value', 'last_price', 'prev_price']) assert.ok(!(k in item), `le cuisinier ne doit pas recevoir ${k}`);
    assert.ok(!('totalValue' in kc.data));
    const dump = JSON.stringify([kc.data, (await t.api.get('/api/stock/moves', K)).data, (await t.api.get(`/api/ingredients/${f.id}`, K)).data, (await t.api.get('/api/stock/alerts', K)).data]);
    for (const k of ['avg_cost', 'avg_after', 'unit_cost', 'last_price', 'priceHistory', 'priceRises', '"value"']) assert.ok(!dump.includes(k), `fuite de « ${k} » vers le cuisinier`);
    // le cuisinier ne saisit pas de prix, ne corrige pas de prix, ne gère pas les mesures
    assert.equal((await receive({ ingredient_id: f.id, qty: 1, unit: 'kg', total_price: 5 }, K)).status, 403);
    assert.equal((await t.api.get('/api/stock/pending-prices', K)).status, 403);
    assert.equal((await t.api.post('/api/stock/price-fix', { move_id: 1, total_price: 5 }, K)).status, 403);
    // le caissier n'a accès à rien du stock
    for (const [m, u, b] of [['get', '/api/stock'], ['get', '/api/stock/moves'], ['get', '/api/stock/alerts'], ['get', `/api/ingredients/${f.id}`], ['get', '/api/measures'],
      ['post', '/api/stock/receipts', { ingredient_id: f.id, qty: 1, unit: 'kg' }], ['post', '/api/stock/losses', { ingredient_id: f.id, qty: 1, unit: 'kg', reason: 'jete' }],
      ['post', '/api/stock/inventory', { counts: [] }], ['get', '/api/stock/verify']]) {
      const r = m === 'get' ? await t.api.get(u, C) : await t.api.post(u, b, C);
      assert.equal(r.status, 403, `${m} ${u}`);
    }
  } finally { await t.close(); }
});

test('réception sans prix par le cuisinier, prix complété ensuite par le gérant', async () => {
  const { t, O, M, K, mk, receive, stockOf } = await world();
  try {
    // 1) ingrédient jamais acheté : la réception du cuisinier est valorisée à zéro puis corrigée
    const sucre = await mk({ name: 'Sucre', family: 'mass' });
    const r = await receive({ ingredient_id: sucre.id, qty: 10, unit: 'kg' }, K);
    assert.equal(r.status, 201);
    assert.equal(r.data.lines[0].pricePending, true);
    assert.ok(!('unitCost' in r.data.lines[0]));
    let pend = (await t.api.get('/api/stock/pending-prices', M)).data;
    assert.equal(pend.length, 1);
    assert.equal(pend[0].name, 'Sucre');
    assert.equal((await t.api.get('/api/stock', M)).data.counts.pricePending, 1);
    near((await stockOf(sucre.id, M)).avg_cost, 0);
    let fx = await t.api.post('/api/stock/price-fix', { move_id: pend[0].id, total_price: 20 }, M);
    assert.equal(fx.status, 200);
    near((await stockOf(sucre.id, M)).avg_cost, 0.002, 'coût corrigé = 20 / 10 000 g', 1e-12);
    assert.equal((await t.api.post('/api/stock/price-fix', { move_id: pend[0].id, total_price: 20 }, M)).status, 409, 'une seule correction');
    assert.equal((await t.api.get('/api/stock/pending-prices', M)).data.length, 0);
    // 2) avec un coût déjà connu : 10 kg à 0,002 puis 10 kg sans prix (valorisés 0,002) puis prix réel 30 € → moyenne 0,0025
    const riz = await mk({ name: 'Riz', family: 'mass' });
    await receive({ ingredient_id: riz.id, qty: 10, unit: 'kg', total_price: 20 }, M);
    await receive({ ingredient_id: riz.id, qty: 10, unit: 'kg' }, K);
    near((await stockOf(riz.id, M)).avg_cost, 0.002, 'valorisée au coût moyen en attendant', 1e-12);
    pend = (await t.api.get('/api/stock/pending-prices', M)).data;
    await t.api.post('/api/stock/price-fix', { move_id: pend[0].id, total_price: 30 }, M);
    near((await stockOf(riz.id, M)).avg_cost, (20 + 30) / 20000, 'moyenne des deux prix', 1e-12);
    // 3) si une partie du lot est déjà partie, seule la part restante est réévaluée : 10 000 g reçus, 6 000 g sortis, prix 20 €
    const sel = await mk({ name: 'Sel', family: 'mass' });
    await receive({ ingredient_id: sel.id, qty: 10, unit: 'kg' }, K);
    await t.api.post('/api/stock/losses', { ingredient_id: sel.id, qty: 6, unit: 'kg', reason: 'jete' }, K);
    pend = (await t.api.get('/api/stock/pending-prices', M)).data;
    await t.api.post('/api/stock/price-fix', { move_id: pend[0].id, total_price: 20 }, M);
    near((await stockOf(sel.id, M)).avg_cost, 0.002, '40 % du lot restant : 8 € sur 4 000 g', 1e-12);
    // mauvais usages
    assert.equal((await t.api.post('/api/stock/price-fix', { move_id: 99999, total_price: 5 }, M)).status, 404);
    assert.equal((await t.api.post('/api/stock/price-fix', { move_id: pend[0]?.id ?? 1, total_price: -5 }, M)).status, 400);
    assert.equal(verifyJournal(t.ctx.db).ok, true);
  } finally { await t.close(); }
});

test('pertes : motif obligatoire, jamais plus que le stock', async () => {
  const { t, O, mk, receive, stockOf } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass' });
    await receive({ ingredient_id: f.id, qty: 100, unit: 'g', total_price: 1 });
    const lose = (body) => t.api.post('/api/stock/losses', { ingredient_id: f.id, unit: 'g', ...body }, O);
    assert.equal((await lose({ qty: 200, reason: 'jete' })).status, 409);
    assert.match((await lose({ qty: 200, reason: 'jete' })).data.error.message, /il reste 100 g, vous voulez retirer 200 g/);
    assert.equal((await lose({ qty: 10 })).status, 400);
    assert.equal((await lose({ qty: 10, reason: 'invente' })).status, 400);
    assert.equal((await lose({ qty: 10, reason: 'autre' })).status, 400, 'motif « autre » : une note est obligatoire');
    assert.equal((await lose({ qty: 10, reason: 'autre', note: 'sac troué' })).status, 201);
    assert.equal((await lose({ qty: 0, reason: 'jete' })).status, 400);
    assert.equal((await lose({ qty: -5, reason: 'jete' })).status, 400);
    assert.equal((await lose({ qty: 90, reason: 'donne' })).status, 201, 'on peut retirer exactement tout le stock');
    assert.equal((await stockOf(f.id)).stock, 0);
    assert.equal((await lose({ qty: 1, reason: 'jete' })).status, 409);
    const moves = (await t.api.get(`/api/stock/moves?ingredient_id=${f.id}&type=loss`, O)).data.rows;
    assert.deepEqual(moves.map((m) => m.reasonText), ['Donné', 'Autre']);
  } finally { await t.close(); }
});

test('inventaire : comptage par emballages, aperçu sans écriture, écart valorisé, validation', async () => {
  const { t, O, K, mk, receive, stockOf } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass', packs: [{ label: 'sac', contains: 25000 }], equivalences: [{ unit: 'tasse', base_qty: 120 }] });
    const g = await mk({ name: 'Sucre', family: 'mass' });
    await receive({ ingredient_id: f.id, qty: 20, unit: 'kg', total_price: 36 });
    await receive({ ingredient_id: g.id, qty: 5, unit: 'kg', total_price: 6 });
    const counts = [
      { ingredient_id: f.id, parts: [{ qty: 15, unit: 'kg' }, { qty: 4, unit: 'tasse' }] },
      { ingredient_id: g.id, parts: [{ qty: 5000, unit: 'g' }] },
    ];
    const before = t.ctx.db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c;
    const pv = await t.api.post('/api/stock/inventory/preview', { counts }, O);
    assert.equal(pv.status, 200);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, before, 'l\'aperçu n\'écrit rien');
    const [lf, lg] = pv.data.lines;
    near(lf.counted, 15480); near(lf.theoretical, 20000); near(lf.delta, -4520);
    near(lf.value, -4520 * 0.0018, 'écart valorisé', 1e-9);
    assert.equal(lg.delta, 0); assert.equal(lg.deltaText, 'conforme');
    near(pv.data.variance, -4520 * 0.0018, 'écart total', 1e-9);
    // le cuisinier fait l'inventaire mais ne voit pas les valeurs
    const kc = await t.api.post('/api/stock/inventory', { counts, note: 'Fin de semaine' }, { token: K.token });
    assert.equal(kc.status, 201);
    assert.ok(!('variance' in kc.data) && !('value' in kc.data.lines[0]));
    near((await stockOf(f.id)).stock, 15480);
    near((await stockOf(g.id)).stock, 5000);
    // une seule ligne d'écart dans le journal, la ligne conforme n'écrit rien
    const inv = t.ctx.db.prepare("SELECT * FROM stock_moves WHERE type = 'inventory'").all();
    assert.equal(inv.length, 1);
    near(inv[0].qty, -4520); near(inv[0].value, -4520 * 0.0018, '', 1e-9);
    near((await stockOf(f.id)).avg_cost, 0.0018, 'un inventaire ne change pas le coût moyen', 1e-12);
    assert.equal(t.ctx.db.prepare('SELECT lines FROM inventories').get().lines, 2);
    // inventaire positif : on retrouve 1 kg de plus
    await t.api.post('/api/stock/inventory', { counts: [{ ingredient_id: g.id, parts: [{ qty: 6, unit: 'kg' }] }] }, O);
    near((await stockOf(g.id)).stock, 6000);
    // refus : doublon, ingrédient inconnu, conversion impossible, vide, quantité négative
    const bad = async (c) => assert.equal((await t.api.post('/api/stock/inventory/preview', { counts: c }, O)).status >= 400, true, JSON.stringify(c));
    await bad([counts[0], counts[0]]);
    await bad([{ ingredient_id: 9999, parts: [{ qty: 1, unit: 'g' }] }]);
    await bad([{ ingredient_id: f.id, parts: [{ qty: 1, unit: 'l' }] }]);
    await bad([{ ingredient_id: f.id, parts: [] }]);
    await bad([{ ingredient_id: f.id, parts: [{ qty: -1, unit: 'g' }] }]);
    await bad([]);
    // compter zéro est permis (stock réellement épuisé)
    await t.api.post('/api/stock/inventory', { counts: [{ ingredient_id: g.id, parts: [{ qty: 0, unit: 'g' }] }] }, O);
    near((await stockOf(g.id)).stock, 0);
    assert.equal(verifyJournal(t.ctx.db).ok, true);
    assert.ok(actions(t.ctx).includes('stock.inventory'));
  } finally { await t.close(); }
});

test('CRITÈRE : le journal de stock est en lecture seule et sa falsification est détectée', async () => {
  const { t, O, mk, receive } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass' });
    await receive({ ingredient_id: f.id, qty: 10, unit: 'kg', total_price: 12 });
    await receive({ ingredient_id: f.id, qty: 10, unit: 'kg', total_price: 14 });
    assert.throws(() => t.ctx.db.prepare('UPDATE stock_moves SET qty = 99999 WHERE id = 1').run(), /lecture seule/);
    assert.throws(() => t.ctx.db.prepare('DELETE FROM stock_moves WHERE id = 1').run(), /lecture seule/);
    assert.equal((await t.api.get('/api/stock/verify', O)).data.ok, true);
    // quelqu'un contourne le verrou et change une quantité : la vérification le voit
    t.ctx.db.exec('DROP TRIGGER stock_moves_no_update');
    t.ctx.db.prepare('UPDATE stock_moves SET qty = 99999 WHERE id = 1').run();
    const v = (await t.api.get('/api/stock/verify', O)).data;
    assert.equal(v.ok, false);
    assert.ok(v.problems.length >= 1);
    // une valeur retouchée sans toucher à la quantité est vue aussi
    const t2 = await world();
    try {
      const g = await t2.mk({ name: 'Sucre', family: 'mass' });
      await t2.receive({ ingredient_id: g.id, qty: 10, unit: 'kg', total_price: 12 });
      t2.t.ctx.db.exec('DROP TRIGGER stock_moves_no_update');
      t2.t.ctx.db.prepare('UPDATE stock_moves SET avg_after = 0.5 WHERE id = 1').run();
      assert.equal(verifyJournal(t2.t.ctx.db).ok, false);
    } finally { await t2.t.close(); }
  } finally { await t.close(); }
});

test('péremption : lots présents, alertes et rejet des dates absurdes', async () => {
  const { t, O, M, K, mk, receive } = await world();
  try {
    const y = await mk({ name: 'Yaourt', family: 'count' });
    const today = ymd(t.clock);
    for (const [expiry, re] of [[ymd(t.clock, -1), /déjà dépassée/], ['2026-13-40', /invalide/], ['demain', /invalide/], ['2026-02-30', /invalide/]]) {
      const r = await receive({ ingredient_id: y.id, qty: 10, unit: 'piece', total_price: 5, expiry });
      assert.equal(r.status, 400, expiry); assert.match(r.data.error.message, re);
    }
    assert.equal((await receive({ ingredient_id: y.id, qty: 10, unit: 'piece', total_price: 5, expiry: today })).status, 201, 'le jour même est accepté');
    // lot A (1000 g, périme dans 2 jours) puis lot B (1000 g, dans 10 jours)
    const lait = await mk({ name: 'Lait', family: 'volume', density: 1.03 });
    await receive({ ingredient_id: lait.id, qty: 1, unit: 'l', total_price: 1, expiry: ymd(t.clock, 2) });
    await receive({ ingredient_id: lait.id, qty: 1, unit: 'l', total_price: 1, expiry: ymd(t.clock, 10) });
    let a = (await t.api.get('/api/stock/alerts', K)).data;
    const mine = a.expiring.filter((e) => e.name === 'Lait');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].daysLeft, 2); near(mine[0].remaining, 1000);
    assert.ok(a.expiring.some((e) => e.name === 'Yaourt' && e.daysLeft === 0));
    // on en utilise 1 200 ml : on suppose le plus ancien parti en premier, il ne reste que du lot B
    await t.api.post('/api/stock/losses', { ingredient_id: lait.id, qty: 1200, unit: 'ml', reason: 'jete' }, O);
    a = (await t.api.get('/api/stock/alerts', K)).data;
    assert.equal(a.expiring.filter((e) => e.name === 'Lait').length, 0);
    const det = (await t.api.get(`/api/ingredients/${lait.id}`, M)).data;
    assert.equal(det.lots.length, 1); near(det.lots[0].remaining, 800); assert.equal(det.lots[0].expiry, ymd(t.clock, 10));
    assert.deepEqual(det.nextExpiry, { date: ymd(t.clock, 10), daysLeft: 10, qty: 800 });
    // fenêtre d'alerte réglable
    assert.equal((await t.api.put('/api/settings', { expiry_alert_days: 61 }, O)).status, 400);
    await t.api.put('/api/settings', { expiry_alert_days: 12 }, O);
    a = (await t.api.get('/api/stock/alerts', K)).data;
    assert.equal(a.expiring.filter((e) => e.name === 'Lait')[0].daysLeft, 10);
    // le temps passe : le lot B approche, puis dépasse
    t.clock.t = new Date(t.clock.t.getTime() + 11 * DAY);
    const login = await t.login((await t.api.get('/api/auth/users')).data.find((u) => u.name === 'Yann').id, '1357');
    a = (await t.api.get('/api/stock/alerts', { token: login.data.token })).data;
    assert.equal(a.expiring.filter((e) => e.name === 'Lait')[0].daysLeft, -1, 'périmé depuis hier');
  } finally { await t.close(); }
});

test('alertes : stock bas, vide, hausse de prix, réceptions sans prix', async () => {
  const { t, O, M, K, mk, receive } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass', threshold: { qty: 5, unit: 'kg' } });
    const g = await mk({ name: 'Sucre', family: 'mass', threshold: { qty: 2, unit: 'kg' } });
    await mk({ name: 'Sel', family: 'mass' });
    await receive({ ingredient_id: f.id, qty: 4, unit: 'kg', total_price: 4 });
    let a = (await t.api.get('/api/stock/alerts', K)).data;
    assert.deepEqual(a.low.map((l) => [l.name, l.empty]), [['Farine', false], ['Sucre', true]]);
    await receive({ ingredient_id: f.id, qty: 4, unit: 'kg', total_price: 4 });
    a = (await t.api.get('/api/stock/alerts', K)).data;
    assert.deepEqual(a.low.map((l) => l.name), ['Sucre']);
    // hausse de prix : +20 % déclenche (seuil 10 %), +5 % non ; le cuisinier ne voit pas ces alertes
    const r1 = await receive({ ingredient_id: g.id, qty: 10, unit: 'kg', total_price: 10 }, M);
    assert.equal(r1.data.lines[0].priceRise, null);
    const r2 = await receive({ ingredient_id: g.id, qty: 10, unit: 'kg', total_price: 12 }, M);
    near(r2.data.lines[0].priceRise.pct, 20, '', 1e-9);
    a = (await t.api.get('/api/stock/alerts', M)).data;
    assert.equal(a.priceRises.length, 1);
    assert.equal(a.priceRises[0].name, 'Sucre'); near(a.priceRises[0].pct, 20, '', 1e-9);
    assert.ok(!('priceRises' in (await t.api.get('/api/stock/alerts', K)).data));
    const r3 = await receive({ ingredient_id: f.id, qty: 10, unit: 'kg', total_price: 10.5 }, M);
    assert.equal(r3.data.lines[0].priceRise, null);
    // seuil modifiable
    await t.api.put('/api/settings', { price_alert_pct: 30 }, O);
    assert.equal((await t.api.get('/api/stock/alerts', M)).data.priceRises.length, 0);
    assert.equal((await t.api.put('/api/settings', { price_alert_pct: 0 }, O)).status, 400);
    // réception sans prix par le cuisinier (comptée pour le gérant seulement)
    await receive({ ingredient_id: g.id, qty: 1, unit: 'kg' }, K);
    const K0 = { token: (await t.login((await t.api.get('/api/auth/users')).data.find((u) => u.name === 'Yann').id, '1357')).data.token };
    // ancienneté : au bout de 30 jours l'alerte disparaît
    await t.api.put('/api/settings', { price_alert_pct: 10 }, O);
    t.clock.t = new Date(t.clock.t.getTime() + 31 * DAY);
    const ml = await t.login((await t.api.get('/api/auth/users')).data.find((u) => u.name === 'Mina').id, '1357');
    assert.equal((await t.api.get('/api/stock/alerts', { token: ml.data.token })).data.priceRises.length, 0);
    // réception sans prix : comptée pour le gérant seulement
    assert.equal((await t.api.get('/api/stock/alerts', { token: ml.data.token })).data.pricePending, 1);
    assert.ok(!('pricePending' in (await t.api.get('/api/stock/alerts', K0)).data));
  } finally { await t.close(); }
});

test('réception groupée : tout ou rien, historique des prix, journal des actions', async () => {
  const { t, O, M, mk, receive } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass' });
    const g = await mk({ name: 'Sucre', family: 'mass' });
    const ok = await receive({ lines: [
      { ingredient_id: f.id, qty: 5, unit: 'kg', total_price: 6 },
      { ingredient_id: g.id, qty: 2, unit: 'kg', total_price: 3 },
    ] }, M);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.lines.length, 2);
    // une ligne invalide annule toute la réception
    const before = t.ctx.db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c;
    const ko = await receive({ lines: [
      { ingredient_id: f.id, qty: 1, unit: 'kg', total_price: 1 },
      { ingredient_id: g.id, qty: 1, unit: 'l', total_price: 1 },
    ] }, M);
    assert.equal(ko.status, 400);
    assert.match(ko.data.error.message, /Impossible de convertir/);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c, before, 'rien n\'est écrit');
    assert.equal((await receive({ lines: [] }, M)).status, 400);
    assert.equal((await receive({ ingredient_id: 9999, qty: 1, unit: 'kg', total_price: 1 }, M)).status, 404);
    assert.equal((await receive({ ingredient_id: f.id, qty: 1, unit: 'kg', total_price: -3 }, M)).status, 400);
    assert.equal((await receive({ ingredient_id: f.id, qty: 1, unit: 'kg', total_price: 'abc' }, M)).status, 400);
    // historique des prix (visible du gérant)
    await receive({ ingredient_id: f.id, qty: 5, unit: 'kg', total_price: 7 }, M);
    const det = (await t.api.get(`/api/ingredients/${f.id}`, M)).data;
    assert.equal(det.priceHistory.length, 2);
    near(det.priceHistory[0].unit_cost, 6 / 5000, '', 1e-12); near(det.priceHistory[1].unit_cost, 7 / 5000, '', 1e-12);
    assert.ok(actions(t.ctx).filter((x) => x === 'stock.receipt').length >= 2);
    const row = t.ctx.db.prepare("SELECT user_name, detail FROM audit WHERE action = 'stock.receipt' ORDER BY id LIMIT 1").get();
    assert.equal(row.user_name, 'Mina');
    assert.match(row.detail, /Farine/);
    assert.equal(verifyAudit(t.ctx.db).ok, true);
  } finally { await t.close(); }
});

test('repères courants proposés (jamais appliqués sans validation)', async () => {
  const { t, O, M, K, mk } = await world();
  try {
    const s = (await t.api.get('/api/ingredients/suggest?name=Farine%20T55', M)).data;
    assert.deepEqual(s.equivalences, [{ unit: 'tasse', base_qty: 120 }]);
    assert.equal((await t.api.get('/api/ingredients/suggest?name=Huile', O)).data.density, 0.92);
    assert.equal((await t.api.get('/api/ingredients/suggest?name=Capsule', O)).data, null);
    assert.equal((await t.api.get('/api/ingredients/suggest?name=Farine', K)).status, 403);
    const f = await mk({ name: 'Farine', family: 'mass' });
    assert.deepEqual(f.equivalences, [], 'rien n\'est enregistré sans demande');
  } finally { await t.close(); }
});

test('une restauration remet le stock dans l\'état de la sauvegarde', async () => {
  const { t, O, mk, receive, stockOf } = await world();
  try {
    const f = await mk({ name: 'Farine', family: 'mass' });
    await receive({ ingredient_id: f.id, qty: 10, unit: 'kg', total_price: 12 });
    const b = (await t.api.post('/api/backups', {}, O)).data;
    await receive({ ingredient_id: f.id, qty: 5, unit: 'kg', total_price: 9 });
    near((await stockOf(f.id)).stock, 15000);
    t.clock.t = new Date(t.clock.t.getTime() + 60000);
    assert.equal((await t.api.post(`/api/backups/${b.name}/restore`, { confirm: 'RESTAURER' }, O)).status, 200);
    const lg = await t.login((await t.api.get('/api/auth/users')).data.find((u) => u.name === 'Karim').id, OWNER_PIN);
    const s = (await t.api.get(`/api/ingredients/${f.id}`, { token: lg.data.token })).data;
    near(s.stock, 10000); near(s.avg_cost, 0.0012, '', 1e-12);
    assert.equal(verifyJournal(t.ctx.db).ok, true);
  } finally { await t.close(); }
});
