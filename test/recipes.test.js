import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot } from './helpers.js';
import { fakeSupabase } from './fake-supabase.js';
import { restoreFromCloud, CloudSync } from '../server/cloud.js';
import { createApp } from '../server/app.js';
import { verifyAudit } from '../server/audit.js';

const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} attendu ${b}, reçu ${a}`);
const jpeg = (seed = 'a', size = 3000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.createHash('sha256').update(seed).digest(), Buffer.alloc(size, seed.charCodeAt(0)), Buffer.from([0xff, 0xd9])]);

async function world() {
  const t = await boot();
  const owner = await t.setup();
  const manager = await t.staff(owner, 'Mina', 'manager');
  const cook = await t.staff(owner, 'Yann', 'cook');
  const cashier = await t.staff(owner, 'Awa', 'cashier');
  const O = { token: owner }, M = { token: manager.token }, K = { token: cook.token }, C = { token: cashier.token };
  const mk = async (body) => { const r = await t.api.post('/api/ingredients', body, O); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
  const receive = async (body) => { const r = await t.api.post('/api/stock/receipts', body, O); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
  // farine 25 kg = 45 €, soit 1,80 €/kg ; oeufs à la pièce (boîte de 30) ; carotte avec 80 % de rendement
  const farine = await mk({ name: 'Farine', family: 'mass', packs: [{ label: 'sac', contains: 25000 }], equivalences: [{ unit: 'tasse', base_qty: 120 }] });
  const oeuf = await mk({ name: 'Oeuf', family: 'count', packs: [{ label: 'boîte', contains: 30 }], piece_g: 60 });
  const carotte = await mk({ name: 'Carotte', family: 'mass', yield_pct: 80 });
  const sel = await mk({ name: 'Sel', family: 'mass' });
  await receive({ ingredient_id: farine.id, qty: 25, unit: 'kg', total_price: 45 });
  await receive({ ingredient_id: oeuf.id, qty: 1, unit: 'pack:0', total_price: 9 }); // 0,30 € / oeuf
  await receive({ ingredient_id: carotte.id, qty: 10, unit: 'kg', total_price: 10 }); // 1 €/kg acheté
  const body = (over = {}) => ({
    name: 'Crêpes', category: 'Desserts', servings: 4, prep_min: 10, cook_min: 20, steps: 'Mélanger.', notes: '',
    lines: [{ ingredient_id: farine.id, qty: 2, unit: 'tasse' }, { ingredient_id: oeuf.id, qty: 3, unit: 'piece' }],
    ...over,
  });
  return { t, O, M, K, C, farine, oeuf, carotte, sel, body, mk, receive };
}

test('migration 3 : versions et lignes en lecture seule (triggers)', async () => {
  const { t, O, farine, body } = await world();
  try {
    const r = await t.api.post('/api/recipes', body(), O);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.throws(() => t.ctx.db.prepare('UPDATE recipe_versions SET steps = ? WHERE recipe_id = ?').run('x', r.data.id), /ne se modifie pas/);
    assert.throws(() => t.ctx.db.prepare('DELETE FROM recipe_versions').run(), /ne se supprime pas/);
    assert.throws(() => t.ctx.db.prepare('UPDATE recipe_lines SET qty = 9').run(), /ne se modifie pas/);
    assert.throws(() => t.ctx.db.prepare('DELETE FROM recipe_lines').run(), /ne se supprime pas/);
    assert.ok(farine.id);
  } finally { await t.close(); }
});

test('création : validations claires, doublon de nom, droits, journal', async () => {
  const { t, O, M, K, C, farine, body, mk } = await world();
  try {
    const post = (b, who = O) => t.api.post('/api/recipes', b, who);
    const refuse = async (b, re) => { const r = await post(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.data.error.message, re); };
    await refuse(body({ name: '  ' }), /nom/i);
    await refuse(body({ lines: [] }), /au moins un ingrédient/);
    await refuse(body({ servings: 0 }), /supérieur à 0/);
    await refuse(body({ servings: 'abc' }), /nombre/);
    await refuse(body({ prep_min: -1 }), /au moins 0/);
    await refuse(body({ lines: [{ ingredient_id: 9999, qty: 1, unit: 'g' }] }), /introuvable/);
    await refuse(body({ lines: [{ ingredient_id: farine.id, qty: 0, unit: 'g' }] }), /supérieur à 0/);
    await refuse(body({ lines: [{ ingredient_id: farine.id, qty: 1, unit: 'l' }] }), /Impossible de convertir/); // farine sans densité
    await refuse(body({ lines: [{ ingredient_id: farine.id, qty: 1, unit: 'truc' }] }), /Unité inconnue/);
    const same = await t.api.post('/api/ingredients', { name: 'FARINE', family: 'mass' }, O); // même nom, autre casse
    assert.equal(same.status, 409);
    assert.equal((await t.api.post('/api/ingredients', { name: 'Œuf', family: 'count' }, O)).status, 201);
    assert.equal((await t.api.post('/api/ingredients', { name: 'œuf', family: 'count' }, O)).status, 409); // lower() de SQLite ignore les accents
    const arch = await mk({ name: 'Vieux', family: 'mass' });
    await t.api.patch(`/api/ingredients/${arch.id}`, { active: false }, O);
    await refuse(body({ lines: [{ ingredient_id: arch.id, qty: 5, unit: 'g' }] }), /archivé/);

    const ok = await post(body());
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    const dup = await post(body({ name: 'CRÊPES' }));
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, 'name_taken');
    assert.equal((await post(body({ name: 'Autre' }), K)).status, 403);
    assert.equal((await post(body({ name: 'Autre' }), C)).status, 403);
    assert.equal((await post(body({ name: 'Du gérant' }), M)).status, 201);
    assert.equal((await t.api.get('/api/recipes', C)).status, 403);

    const d = (await t.api.get(`/api/recipes/${ok.data.id}`, O)).data;
    assert.equal(d.version, 1);
    assert.equal(d.change_note, 'Création');
    assert.equal(d.lines.length, 2);
    assert.equal(d.lines[0].entered, '2 tasse');
    assert.equal(d.lines[0].baseText, '240 g'); // 2 tasses x 120 g
    assert.equal(d.lines[1].baseText, '3 pièces');
    assert.equal(d.lines[1].entered, '3 pièces');
    assert.deepEqual(t.ctx.db.prepare("SELECT action FROM audit WHERE action LIKE 'recipe.%' ORDER BY id").all().map((r) => r.action), ['recipe.create', 'recipe.create']);
    assert.ok(verifyAudit(t.ctx.db).ok);
  } finally { await t.close(); }
});

test('coûts : coût moyen du stock, rendement, ingrédient sans prix, cachés au cuisinier', async () => {
  const { t, O, M, K, farine, carotte, sel, body } = await world();
  try {
    const r = await t.api.post('/api/recipes', body({
      servings: 2,
      lines: [
        { ingredient_id: farine.id, qty: 500, unit: 'g' },     // 0,5 kg x 1,80 = 0,90
        { ingredient_id: carotte.id, qty: 400, unit: 'g' },    // net 400 g, rendement 80 % => 500 g bruts x 1 €/kg = 0,50
      ],
    }), O);
    const d = (await t.api.get(`/api/recipes/${r.data.id}`, O)).data;
    near(d.cost_total, 1.4, 'coût total');
    near(d.cost_per_serving, 0.7, 'coût par personne');
    assert.equal(d.cost_incomplete, false);
    assert.equal(d.lines[1].priced, true);
    near(d.lines[1].cost, 0.5, 'carotte avec perte');
    // un ingrédient jamais acheté : coût incomplet, signalé
    const r2 = await t.api.post('/api/recipes', body({ name: 'Sale', lines: [{ ingredient_id: farine.id, qty: 100, unit: 'g' }, { ingredient_id: sel.id, qty: 5, unit: 'g' }] }), O);
    const d2 = (await t.api.get(`/api/recipes/${r2.data.id}`, M)).data;
    assert.equal(d2.cost_incomplete, true);
    assert.equal(d2.lines[1].priced, false);
    assert.equal(d2.lines[1].cost, null);
    near(d2.cost_total, 0.18, 'seul ce qui est chiffré est additionné');
    // le cuisinier voit la recette mais aucun coût, nulle part
    const dk = (await t.api.get(`/api/recipes/${r.data.id}`, K)).data;
    const lk = (await t.api.get('/api/recipes', K)).data;
    const sk = (await t.api.get(`/api/recipes/${r.data.id}/scale?servings=4`, K)).data;
    for (const o of [dk, lk, sk, ...dk.lines, ...lk.items]) for (const k of Object.keys(o)) assert.ok(!/cost|cout|price|prix/i.test(k), `fuite de coût : ${k}`);
    assert.equal(dk.can.edit, false);
    // quand le prix du stock change, le coût suit (coût moyen pondéré)
    await t.api.post('/api/stock/receipts', { ingredient_id: farine.id, qty: 25, unit: 'kg', total_price: 90 }, O); // moyenne : 135 € / 50 kg = 2,70
    const d3 = (await t.api.get(`/api/recipes/${r.data.id}`, O)).data;
    near(d3.lines[0].cost, 0.5 * 2.7, 'nouveau coût moyen');
  } finally { await t.close(); }
});

test('versions : modification = nouvelle version, historique intact, retour en arrière, conflit entre appareils', async () => {
  const { t, O, M, farine, oeuf, body } = await world();
  try {
    const id = (await t.api.post('/api/recipes', body(), O)).data.id;
    const put = (b, who = O) => t.api.put(`/api/recipes/${id}`, b, who);
    // rien ne change = pas de version
    let r = await put({ ...body(), based_on_version: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.unchanged, true);
    // nom seul : pas de nouvelle version
    r = await put({ ...body({ name: 'Crêpes maison' }), based_on_version: 1 });
    assert.deepEqual(r.data, { unchanged: false, version: 1 });
    // contenu : version 2
    r = await put({ ...body({ name: 'Crêpes maison', servings: 6, change_note: 'Plus de monde', lines: [{ ingredient_id: farine.id, qty: 3, unit: 'tasse' }, { ingredient_id: oeuf.id, qty: 4, unit: 'piece' }] }), based_on_version: 1 }, M);
    assert.deepEqual(r.data, { unchanged: false, version: 2 });
    // un autre appareil encore sur la version 1 ne peut pas écraser
    r = await put({ ...body({ name: 'Crêpes maison', steps: 'Autre' }), based_on_version: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'stale_version');
    assert.match(r.data.error.message, /Mina/);
    // l'ancienne version reste lisible, inchangée
    const v1 = (await t.api.get(`/api/recipes/${id}?version=1`, O)).data;
    assert.equal(v1.servings, 4);
    assert.equal(v1.isCurrent, false);
    assert.equal(v1.lines[0].qty, 2);
    const cur = (await t.api.get(`/api/recipes/${id}`, O)).data;
    assert.equal(cur.version, 2);
    assert.equal(cur.servings, 6);
    assert.deepEqual(cur.versions.map((v) => [v.version, v.user_name, v.change_note]), [[2, 'Mina', 'Plus de monde'], [1, 'Karim', 'Création']]);
    // retour à la version 1 : crée la version 3 (copie), n'efface rien
    const back = await t.api.post(`/api/recipes/${id}/versions/1/restore`, {}, O);
    assert.deepEqual(back.data, { version: 3 });
    const v3 = (await t.api.get(`/api/recipes/${id}`, O)).data;
    assert.equal(v3.servings, 4);
    assert.equal(v3.change_note, 'Retour à la version 1');
    assert.equal(v3.versions.length, 3);
    assert.equal((await t.api.post(`/api/recipes/${id}/versions/3/restore`, {}, O)).status, 400); // déjà en cours
    assert.equal((await t.api.post(`/api/recipes/${id}/versions/99/restore`, {}, O)).status, 404);
    assert.equal((await t.api.get(`/api/recipes/${id}?version=99`, O)).status, 404);
  } finally { await t.close(); }
});

test('calcul pour N personnes : proportions, unité saisie, pertes, achats en emballages', async () => {
  const { t, O, farine, oeuf, carotte, body } = await world();
  try {
    const id = (await t.api.post('/api/recipes', body({
      servings: 4,
      lines: [
        { ingredient_id: farine.id, qty: 2, unit: 'tasse' },       // 240 g
        { ingredient_id: oeuf.id, qty: 3, unit: 'piece' },          // 3 pièces
        { ingredient_id: carotte.id, qty: 400, unit: 'g' },        // 500 g bruts
      ],
    }), O)).data.id;
    const s = (await t.api.get(`/api/recipes/${id}/scale?servings=10`, O)).data;
    near(s.factor, 2.5);
    assert.equal(s.lines[0].entered, '5 tasse');
    assert.equal(s.lines[0].baseText, '600 g');
    assert.equal(s.lines[1].baseText, '7,5 pièces');
    assert.equal(s.lines[1].entered, '7,5 pièces');
    assert.equal(s.lines[2].baseText, '1 kg');         // net 400 g x 2,5
    assert.equal(s.lines[2].grossText, '1,25 kg');     // brut après 20 % de perte
    assert.equal(s.lines[2].hasLoss, true);
    assert.equal(s.lines[0].hasLoss, false);
    near(s.cost_total, 600 * 1.8 / 1000 + 7.5 * 0.3 + 1250 / 1000, 'coût pour 10');
    assert.equal(s.lines[0].shop.enough, true);        // 25 kg en stock
    // plus que le stock : on demande 1000 personnes
    const big = (await t.api.get(`/api/recipes/${id}/scale?servings=1000`, O)).data;
    const o = big.lines[1];
    assert.equal(o.shop.enough, false);                 // 750 oeufs pour 30 en stock
    assert.equal(o.shop.packLabel, 'boîte');
    assert.equal(o.shop.packs, 24);                     // 720 manquants → 24 boîtes de 30
    assert.match(o.shop.inStockText, /30/);
    // demi-portion et valeurs invalides
    assert.equal((await t.api.get(`/api/recipes/${id}/scale?servings=0.5`, O)).data.lines[0].baseText, '30 g');
    for (const bad of ['0', '-3', 'abc', '', '1000000']) assert.equal((await t.api.get(`/api/recipes/${id}/scale?servings=${bad}`, O)).status, 400, bad);
    // le calcul n'écrit rien dans le stock
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) n FROM stock_moves WHERE type <> 'receipt'").get().n, 0);
    // calcul sur une ancienne version
    await t.api.put(`/api/recipes/${id}`, { ...body({ servings: 8, lines: [{ ingredient_id: farine.id, qty: 1, unit: 'kg' }] }), based_on_version: 1 }, O);
    const old = (await t.api.get(`/api/recipes/${id}/scale?servings=4&version=1`, O)).data;
    assert.equal(old.lines.length, 3);
    assert.equal((await t.api.get(`/api/recipes/${id}/scale?servings=4`, O)).data.lines.length, 1);
  } finally { await t.close(); }
});

test('archive : masquée de la liste, consultable, modifiable, restaurable ; copie', async () => {
  const { t, O, K, body } = await world();
  try {
    const id = (await t.api.post('/api/recipes', body(), O)).data.id;
    assert.equal((await t.api.post(`/api/recipes/${id}/archive`, {}, K)).status, 403);
    assert.equal((await t.api.post(`/api/recipes/${id}/archive`, {}, O)).status, 200);
    assert.equal((await t.api.post(`/api/recipes/${id}/archive`, {}, O)).status, 400);
    assert.equal((await t.api.get('/api/recipes', O)).data.items.length, 0);
    const arch = (await t.api.get('/api/recipes?archived=1', O)).data;
    assert.equal(arch.items.length, 1);
    assert.deepEqual(arch.counts, { active: 0, archived: 1 });
    assert.equal(arch.items[0].archived, true);
    assert.equal((await t.api.get(`/api/recipes/${id}`, K)).status, 200); // consultable
    // une recette archivée reste modifiable (on la complète au fur et à mesure) et reste archivée
    const mod = await t.api.put(`/api/recipes/${id}`, { ...body({ steps: 'Retouchée dans l\'archive' }), based_on_version: 1 }, O);
    assert.equal(mod.status, 200);
    assert.equal(mod.data.version, 2);
    assert.equal((await t.api.get(`/api/recipes/${id}`, O)).data.archived, true);
    // le nom se libère : une nouvelle recette peut le reprendre, la restauration est alors refusée jusqu'au renommage
    const second = await t.api.post('/api/recipes', body(), O);
    assert.equal(second.status, 201);
    const un = await t.api.post(`/api/recipes/${id}/unarchive`, {}, O);
    assert.equal(un.status, 409);
    assert.equal(un.data.error.code, 'name_taken');
    await t.api.put(`/api/recipes/${second.data.id}`, { ...body({ name: 'Crêpes 2' }), based_on_version: 1 }, O);
    assert.equal((await t.api.post(`/api/recipes/${id}/unarchive`, {}, O)).status, 200);
    assert.equal((await t.api.get('/api/recipes', O)).data.items.length, 2);
    // copie
    const cp = await t.api.post(`/api/recipes/${id}/duplicate`, {}, O);
    assert.equal(cp.status, 201);
    const c = (await t.api.get(`/api/recipes/${cp.data.id}`, O)).data;
    assert.equal(c.name, 'Crêpes (copie)');
    assert.equal(c.version, 1);
    assert.equal(c.lines.length, 2);
    const cp2 = await t.api.post(`/api/recipes/${id}/duplicate`, {}, O);
    assert.equal((await t.api.get(`/api/recipes/${cp2.data.id}`, O)).data.name, 'Crêpes (copie 2)');
    // recherche
    assert.equal((await t.api.get('/api/recipes?q=copie', O)).data.items.length, 2);
    assert.equal((await t.api.get('/api/recipes?q=dessert', O)).data.items.length, 4);
  } finally { await t.close(); }
});

test('photos : ajout (même sur une recette archivée), contrôles, droits, suppression', async () => {
  const { t, O, K, body } = await world();
  try {
    const id = (await t.api.post('/api/recipes', body(), O)).data.id;
    const up = (buf, who = O, q = '') => t.api.post(`/api/recipes/${id}/photos${q}`, undefined, { ...who, raw: buf });
    const a = jpeg('a');
    let r = await up(a, O, '?caption=Vue%20dessus');
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const pid = r.data.id;
    const back = await t.api.get(`/api/recipes/${id}/photos/${pid}`, K);
    assert.equal(back.status, 200);
    assert.equal(back.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.compare(back.data, a) === 0, 'mêmes octets');
    assert.equal((await t.api.get(`/api/recipes/${id}`, K)).data.photos[0].caption, 'Vue dessus');
    // contrôles
    assert.equal((await up(Buffer.from('pas une image du tout '.repeat(30)))).status, 400);
    assert.equal((await up(Buffer.alloc(10))).status, 400);
    assert.equal((await up(jpeg('b', 800_000))).status, 413);
    assert.equal((await up(jpeg('c'), K)).status, 403);
    assert.equal((await t.api.get(`/api/recipes/${id}/photos/9999`, O)).status, 404);
    assert.equal((await t.api.get(`/api/recipes/${id}/photos/abc`, O)).status, 400);
    // même photo deux fois = deux lignes, un seul fichier
    await up(a);
    assert.equal(fs.readdirSync(path.join(t.dataDir, 'photos')).length, 1);
    // maximum 8
    for (let i = 0; i < 6; i += 1) assert.equal((await up(jpeg(`p${i}`))).status, 201);
    assert.equal((await up(jpeg('de-trop'))).status, 400);
    // recette archivée : on peut encore ajouter / supprimer des photos
    await t.api.delete(`/api/recipes/${id}/photos/${pid}`, O);
    await t.api.post(`/api/recipes/${id}/archive`, {}, O);
    assert.equal((await up(jpeg('archive'))).status, 201);
    const list = (await t.api.get('/api/recipes?archived=1', O)).data.items[0];
    assert.equal(list.photoCount, 8);
    assert.ok(list.cover);
    const rm = await t.api.delete(`/api/recipes/${id}/photos/${list.cover}`, O);
    assert.equal(rm.status, 200);
    assert.equal((await t.api.get(`/api/recipes/${id}/photos/${list.cover}`, O)).status, 404);
    assert.equal((await t.api.delete(`/api/recipes/${id}/photos/${list.cover}`, O)).status, 404);
    // une photo ne s'ouvre pas via une autre recette
    const id2 = (await t.api.post('/api/recipes', body({ name: 'Autre' }), O)).data.id;
    const mine = (await t.api.get(`/api/recipes/${id}`, O)).data.photos[0].id;
    assert.equal((await t.api.get(`/api/recipes/${id2}/photos/${mine}`, O)).status, 404);
    assert.equal((await t.api.delete(`/api/recipes/${id2}/photos/${mine}`, O)).status, 404); // pas de suppression par une autre recette
    assert.equal((await t.api.patch(`/api/recipes/${id2}/photos/${mine}`, { caption: 'x' }, O)).status, 404);
    assert.ok((await t.api.get(`/api/recipes/${id}`, O)).data.photos.some((x) => x.id === mine));
    // légende
    assert.equal((await t.api.patch(`/api/recipes/${id}/photos/${mine}`, { caption: 'Ma légende' }, O)).status, 200);
    assert.equal((await t.api.get(`/api/recipes/${id}`, O)).data.photos[0].caption, 'Ma légende');
  } finally { await t.close(); }
});

test('photos en ligne : envoyées à Supabase, rapatriées si le disque est vide, rien d\'enregistré si Supabase est indisponible', async () => {
  const sb = await fakeSupabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boutique-photo-'));
  const cfg = { url: sb.url, key: sb.key, bucket: 'boutique-data' };
  const silent = { log() {}, error() {} };
  const seq = await restoreFromCloud(cfg, dir, { log: silent });
  const cloud = new CloudSync(cfg, { seq, debounceMs: 20, log: silent });
  const ctx = createApp({ dataDir: dir, cloud });
  const srv = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, { body, raw, token } = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }) }, body: raw || (body ? JSON.stringify(body) : undefined) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  try {
    const tok = (await call('POST', '/api/setup', { body: { shopName: 'X', ownerName: 'Karim', pin: '2468' } })).data.token;
    const ing = (await call('POST', '/api/ingredients', { token: tok, body: { name: 'Farine', family: 'mass' } })).data;
    const id = (await call('POST', '/api/recipes', { token: tok, body: { name: 'Pain', servings: 2, lines: [{ ingredient_id: ing.id, qty: 100, unit: 'g' }] } })).data.id;
    const a = jpeg('z');
    const r = await call('POST', `/api/recipes/${id}/photos`, { token: tok, raw: a });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const name = `${crypto.createHash('sha256').update(a).digest('hex')}.jpg`;
    assert.ok(sb.objects.has(`boutique-data/photos/${name}`), 'photo en ligne');
    // disque vidé (serveur gratuit redémarré) : la photo revient de Supabase
    fs.rmSync(path.join(dir, 'photos'), { recursive: true });
    const back = await call('GET', `/api/recipes/${id}/photos/${r.data.id}`, { token: tok });
    assert.equal(back.status, 200);
    assert.ok(Buffer.compare(back.data, a) === 0);
    assert.ok(fs.existsSync(path.join(dir, 'photos', name)), 'remise en cache sur le disque');
    // même photo ajoutée une seconde fois : « existe déjà » n'est pas une erreur
    assert.equal((await call('POST', `/api/recipes/${id}/photos`, { token: tok, raw: a })).status, 201);
    // Supabase en panne : refus clair, aucune ligne ajoutée
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM recipe_photos').get().n;
    sb.state.fail = 5;
    const down = await call('POST', `/api/recipes/${id}/photos`, { token: tok, raw: jpeg('y') });
    assert.equal(down.status, 503);
    assert.equal(down.data.error.code, 'cloud_unavailable');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM recipe_photos').get().n, before);
    sb.state.fail = 0;
    // photo absente du disque ET de Supabase : 503 explicite, pas de plantage
    sb.objects.delete(`boutique-data/photos/${name}`); fs.rmSync(path.join(dir, 'photos'), { recursive: true, force: true });
    assert.equal((await call('GET', `/api/recipes/${id}/photos/${r.data.id}`, { token: tok })).status, 503);
  } finally { await cloud.flush().catch(() => {}); await new Promise((r) => srv.close(r)); try { ctx.db.close(); } catch { /* ok */ } await sb.close(); }
});

test('photos en ligne : « existe déjà » est normal, toute autre erreur 400 remonte', async () => {
  const mk = (status, body) => new CloudSync({ url: 'https://x.supabase.co', key: 'k', bucket: 'b' }, {
    fetchFn: async () => ({ status, ok: status < 300, text: async () => body, json: async () => JSON.parse(body) }), log: { log() {}, error() {} },
  });
  const name = `${'a'.repeat(64)}.jpg`;
  await mk(400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}').putPhoto(name, Buffer.from('x'));
  await assert.rejects(() => mk(400, '{"message":"Bucket not found"}').putPhoto(name, Buffer.from('x')), /400/);
  await assert.rejects(() => mk(503, '{"message":"down"}').putPhoto(name, Buffer.from('x')), /503/);
  await assert.rejects(() => mk(200, '{}').putPhoto('../../etc/passwd', Buffer.from('x')), /invalide/);
  await assert.rejects(() => mk(200, '{}').getPhoto('nimporte quoi.jpg'), /invalide/);
});

test('ingrédients pas encore dans la liste : recette rangée directement dans l\'archive, manque signalé à l\'ouverture', async () => {
  const { t, O, K, farine, body, mk } = await world();
  try {
    const lines = [{ label: 'Piment oiseau', qty: 3, unit: 'pincées' }, { ingredient_id: farine.id, qty: 200, unit: 'g' }];
    const post = (b) => t.api.post('/api/recipes', b, O);
    const refuse = async (b, re, code) => { const r = await post(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.data.error.message, re); if (code) assert.equal(r.data.error.code, code); };
    await refuse(body({ lines: [{ qty: 3, unit: 'g' }] }), /nom de l'ingrédient/);
    await refuse(body({ lines: [{ label: '  ', qty: 3, unit: 'g' }] }), /nom de l'ingrédient/);
    await refuse(body({ lines: [{ label: 'Piment', qty: 0, unit: 'g' }] }), /supérieur à 0/);
    await refuse(body({ lines: [{ label: 'Piment', qty: 'beaucoup', unit: 'g' }] }), /nombre/);
    await refuse(body({ lines: [{ label: 'Piment', qty: 1, unit: 'x'.repeat(40) }] }), /30 caractères/);
    await refuse(body({ lines: [{ label: 'FARINE', qty: 1, unit: 'g' }] }), /déjà dans vos ingrédients/, 'already_listed');

    const r = await post(body({ name: 'Poulet pimenté', archived: true, lines }));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const id = r.data.id;
    assert.equal((await t.api.get('/api/recipes', O)).data.items.length, 0);           // pas dans la liste de travail
    const arch = (await t.api.get('/api/recipes?archived=1', O)).data;
    assert.equal(arch.items[0].name, 'Poulet pimenté');
    assert.equal(arch.items[0].unlinked, 1);
    assert.equal(arch.items[0].cost_incomplete, true);
    assert.deepEqual({ ...t.ctx.db.prepare("SELECT json_extract(detail, '$.archive') a, json_extract(detail, '$.ingredients_libres') n FROM audit WHERE action = 'recipe.create' ORDER BY id DESC").get() }, { a: 1, n: 1 });

    // à l'ouverture : la ligne libre est reconnue, chiffrée « incomplète », sans aucun prix pour le cuisinier
    const d = (await t.api.get(`/api/recipes/${id}`, O)).data;
    assert.equal(d.archived, true);
    assert.equal(d.lines[0].unlinked, true);
    assert.equal(d.lines[0].entered, '3 pincées');
    assert.equal(d.lines[0].priced, false);
    assert.equal(d.cost_incomplete, true);
    const dk = (await t.api.get(`/api/recipes/${id}`, K)).data;
    assert.equal(dk.lines[0].unlinked, true);
    for (const k of Object.keys(dk.lines[0])) assert.ok(!/cost|price|prix/i.test(k), k);

    // pour 12 personnes (recette écrite pour 4) : ×3, et ce qui manque est dit
    const s = (await t.api.get(`/api/recipes/${id}/scale?servings=12`, K)).data;
    assert.equal(s.factor, 3);
    assert.equal(s.lines[0].entered, '9 pincées');
    assert.equal(s.lines[0].unlinked, true);
    assert.equal(s.lines[0].shop.enough, false);
    assert.equal(s.lines[0].shop.toBuyText, '9 pincées');
    assert.equal(s.lines[1].entered, '600 g');
    assert.equal(s.lines[1].shop.enough, true);          // 25 kg de farine en stock

    // copie et retour de version gardent les lignes libres
    const cp = await t.api.post(`/api/recipes/${id}/duplicate`, {}, O);
    assert.equal((await t.api.get(`/api/recipes/${cp.data.id}`, O)).data.lines[0].unlinked, true);
    await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'Poulet pimenté', lines: [lines[1]] }), based_on_version: 1 }, O);
    assert.equal((await t.api.post(`/api/recipes/${id}/versions/1/restore`, {}, O)).status, 200);
    assert.equal((await t.api.get(`/api/recipes/${id}`, O)).data.lines[0].unlinked, true);

    // changer seulement le nom d'une ligne libre = nouvelle version (rien ne se perd en silence)
    const v0 = (await t.api.get(`/api/recipes/${id}`, O)).data.version;
    const ren = await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'Poulet pimenté', lines: [{ label: 'Piment fort', qty: 3, unit: 'pincées' }, lines[1]] }), based_on_version: v0 }, O);
    assert.deepEqual(ren.data, { unchanged: false, version: v0 + 1 });
    assert.equal((await t.api.get(`/api/recipes/${id}`, O)).data.lines[0].name, 'Piment fort');
    await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'Poulet pimenté', lines }), based_on_version: v0 + 1 }, O); // retour à « Piment oiseau »
    // une recette archivée peut porter le nom d'une recette active ; sa restauration demandera alors de renommer
    assert.equal((await post(body({ name: 'Doublon' }))).status, 201);
    const clash = await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'doublon', lines }), based_on_version: v0 + 2 }, O);
    assert.equal(clash.status, 200, JSON.stringify(clash.data));
    assert.equal((await t.api.post(`/api/recipes/${id}/unarchive`, {}, O)).status, 409);
    await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'Poulet pimenté', lines }), based_on_version: v0 + 2 }, O);

    // plus tard : l'ingrédient est créé dans Stock, la ligne libre n'est plus acceptée, on la relie
    const piment = await mk({ name: 'Piment oiseau', family: 'mass' });
    const v = (await t.api.get(`/api/recipes/${id}`, O)).data.version;
    const again = await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'Poulet pimenté', lines }), based_on_version: v }, O);
    assert.equal(again.status, 400);
    assert.equal(again.data.error.code, 'already_listed');
    const linked = await t.api.put(`/api/recipes/${id}`, { ...body({ name: 'Poulet pimenté', change_note: 'Piment relié', lines: [{ ingredient_id: piment.id, qty: 1, unit: 'g' }, lines[1]] }), based_on_version: v }, O);
    assert.equal(linked.status, 200, JSON.stringify(linked.data));
    const after = (await t.api.get(`/api/recipes?archived=1`, O)).data.items.find((x) => x.id === id);
    assert.equal(after.unlinked, 0);
    assert.equal(after.archived, true);

    // la base elle-même refuse une ligne incohérente
    assert.throws(() => t.ctx.db.prepare("INSERT INTO recipe_lines (version_id, pos, ingredient_id, label, qty, unit, base, note) VALUES (1, 99, NULL, '', 1, 'g', NULL, '')").run(), /CHECK/);
    assert.throws(() => t.ctx.db.prepare("INSERT INTO recipe_lines (version_id, pos, ingredient_id, label, qty, unit, base, note) VALUES (1, 98, NULL, 'x', 1, 'g', 5, '')").run(), /CHECK/);
  } finally { await t.close(); }
});
