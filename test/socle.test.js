import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, OWNER_PIN } from './helpers.js';
import { verifyAudit } from '../server/audit.js';
import { MIGRATIONS } from '../server/db.js';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';

const auditRows = (ctx) => ctx.db.prepare('SELECT * FROM audit ORDER BY id').all();
const actions = (ctx) => auditRows(ctx).map((r) => r.action);

test('installation : un seul propriétaire créé, PIN faible refusé, réinstallation impossible', async () => {
  const t = await boot();
  try {
    assert.deepEqual((await t.api.get('/api/setup/status')).data, { needsSetup: true });
    for (const pin of ['12', '1234', '1111', '987654', 'abcd', '123456789']) {
      const r = await t.api.post('/api/setup', { shopName: 'X', ownerName: 'Karim', pin });
      assert.equal(r.status, 400, `PIN ${pin} devrait être refusé`);
    }
    const bad = await t.api.post('/api/setup', { shopName: 'X', ownerName: '   ', pin: OWNER_PIN });
    assert.equal(bad.status, 400);
    const ok = await t.api.post('/api/setup', { shopName: 'Chez Test', ownerName: 'Karim', pin: OWNER_PIN });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.user.role, 'owner');
    assert.equal((await t.api.get('/api/setup/status')).data.needsSetup, false);
    const again = await t.api.post('/api/setup', { shopName: 'Y', ownerName: 'Pirate', pin: '8642' });
    assert.equal(again.status, 409);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
    assert.equal((await t.api.get('/api/public')).data.shop_name, 'Chez Test');
  } finally { await t.close(); }
});

test('le PIN n\'est jamais stocké en clair ni écrit dans le journal', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    await t.staff(owner, 'Awa', 'cashier', '7531');
    const u = t.ctx.db.prepare('SELECT pin_hash FROM users').all();
    for (const row of u) {
      assert.match(row.pin_hash, /^scrypt\$/);
      for (const pin of [OWNER_PIN, '9753', '7531']) assert.ok(!row.pin_hash.includes(pin));
    }
    const dump = JSON.stringify(auditRows(t.ctx));
    for (const pin of [OWNER_PIN, '9753', '7531']) assert.ok(!dump.includes(pin), `PIN ${pin} trouvé dans le journal`);
  } finally { await t.close(); }
});

test('connexion : 5 erreurs bloquent une minute, puis la connexion refonctionne', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const awa = await t.addUser(owner, 'Awa', 'cashier', '7531');
    for (let i = 1; i <= 4; i++) {
      const r = await t.login(awa.id, '0000');
      assert.equal(r.status, 401);
      assert.match(r.data.error.message, new RegExp(`Il reste ${5 - i} essai`));
    }
    const fifth = await t.login(awa.id, '0000');
    assert.equal(fifth.status, 429);
    assert.equal(fifth.data.error.code, 'locked');
    // le bon code est refusé pendant le blocage
    t.clock.t = new Date(t.clock.t.getTime() + 30_000);
    const during = await t.login(awa.id, '7531');
    assert.equal(during.status, 429);
    assert.ok(during.data.error.retryAfter <= 30 && during.data.error.retryAfter >= 29);
    // après une minute
    t.clock.t = new Date(t.clock.t.getTime() + 31_000);
    const after = await t.login(awa.id, '7531');
    assert.equal(after.status, 200);
    const a = actions(t.ctx);
    assert.equal(a.filter((x) => x === 'auth.login_failed').length, 4);
    assert.ok(a.includes('auth.locked'));
    assert.ok(a.includes('auth.login'));
  } finally { await t.close(); }
});

test('un utilisateur inconnu ou désactivé ne peut pas se connecter, message identique', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const awa = await t.addUser(owner, 'Awa', 'cashier', '7531');
    const unknown = await t.login(9999, '7531');
    const wrong = await t.login(awa.id, '1470');
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    await t.api.patch(`/api/users/${awa.id}`, { active: false }, { token: owner });
    assert.equal((await t.login(awa.id, '7531')).status, 401);
    assert.equal((await t.api.get('/api/auth/users')).data.some((u) => u.id === awa.id), false);
  } finally { await t.close(); }
});

test('CRITÈRE : un caissier ne voit pas le stock ni les coûts ; droits de chaque rôle', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const manager = await t.staff(owner, 'Mina', 'manager');
    const cashier = await t.staff(owner, 'Awa', 'cashier');
    const cook = await t.staff(owner, 'Yann', 'cook');
    const o = { token: owner };
    const expect = async (who, method, url, status, body) => {
      const r = await t.api[method](url, ...(method === 'get' ? [{ token: who }] : [body ?? {}, { token: who }]));
      assert.equal(r.status, status, `${method.toUpperCase()} ${url} attendu ${status}, reçu ${r.status}`);
    };
    // stock et coûts
    await expect(cashier.token, 'get', '/api/stock', 403);
    await expect(cook.token, 'get', '/api/stock', 200);
    await expect(manager.token, 'get', '/api/stock', 200);
    await expect(owner, 'get', '/api/stock', 200);
    await expect(cashier.token, 'get', '/api/reports', 403);
    await expect(cook.token, 'get', '/api/reports', 403);
    await expect(manager.token, 'get', '/api/reports', 200);
    // utilisateurs : propriétaire seulement
    for (const w of [manager.token, cashier.token, cook.token]) {
      await expect(w, 'get', '/api/users', 403);
      await expect(w, 'post', '/api/users', 403, { name: 'Z', role: 'cook', pin: '8642' });
      await expect(w, 'patch', '/api/users/1', 403, { name: 'Z' });
      await expect(w, 'put', '/api/settings', 403, { shop_name: 'Piraté' });
      await expect(w, 'get', '/api/backups', 403);
      await expect(w, 'post', '/api/backups', 403);
    }
    // journal : propriétaire et gérant
    await expect(manager.token, 'get', '/api/audit', 200);
    await expect(owner, 'get', '/api/audit', 200);
    await expect(cashier.token, 'get', '/api/audit', 403);
    await expect(cook.token, 'get', '/api/audit', 403);
    // sans connexion
    assert.equal((await t.api.get('/api/me')).status, 401);
    assert.equal((await t.api.get('/api/me', { token: 'faux' })).status, 401);
    // permissions annoncées à l'interface
    const me = (await t.api.get('/api/me', { token: cashier.token })).data;
    assert.ok(me.permissions.includes('pos.sell'));
    assert.ok(!me.permissions.includes('stock.view'));
    assert.ok(!me.permissions.includes('costs.view'));
    void o;
  } finally { await t.close(); }
});

test('réglages visibles selon le rôle', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const manager = await t.staff(owner, 'Mina', 'manager');
    const cashier = await t.staff(owner, 'Awa', 'cashier');
    const vo = (await t.api.get('/api/settings', { token: owner })).data;
    const vm = (await t.api.get('/api/settings', { token: manager.token })).data;
    const vc = (await t.api.get('/api/settings', { token: cashier.token })).data;
    assert.ok('session_hours' in vo.values && 'backup_keep' in vo.values && 'target_margin' in vo.values);
    assert.ok('target_margin' in vm.values && !('session_hours' in vm.values) && !('backup_keep' in vm.values));
    assert.ok(!('target_margin' in vc.values) && !('vat_default' in vc.values) && 'shop_name' in vc.values);
    assert.equal(vo.canEdit, true);
    assert.equal(vm.canEdit, false);
  } finally { await t.close(); }
});

test('réglages : validation stricte, tout ou rien, journal des changements', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const put = (body) => t.api.put('/api/settings', body, { token: owner });
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ inconnu: 1 })).status, 400);
    assert.equal((await put({ target_margin: 120 })).status, 400);
    assert.equal((await put({ target_margin: 'abc' })).status, 400);
    assert.equal((await put({ session_hours: 1.5 })).status, 400);
    assert.equal((await put({ timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await put({ shop_name: '   ' })).status, 400);
    assert.equal((await put({ logo: 'data:text/html;base64,AAAA' })).status, 400);
    // tout ou rien : un champ invalide annule aussi le champ valide
    assert.equal((await put({ address: '12 rue du Port', target_margin: 999 })).status, 400);
    assert.equal((await t.api.get('/api/settings', { token: owner })).data.values.address, '');
    // valeurs valides (la virgule décimale est acceptée)
    const ok = await put({ address: '12 rue du Port', target_margin: '45,5', vat_default: 10, currency: '€', timezone: 'Indian/Mayotte' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.values.target_margin, 45.5);
    const row = auditRows(t.ctx).filter((r) => r.action === 'settings.update').at(-1);
    const d = JSON.parse(row.detail);
    assert.deepEqual(d.target_margin, { from: 50, to: 45.5 });
    assert.deepEqual(d.address, { from: '', to: '12 rue du Port' });
    assert.ok(!('currency' in d), 'une valeur inchangée ne doit pas figurer dans le journal');
    // aucun changement = aucune ligne de journal
    const before = auditRows(t.ctx).length;
    await put({ target_margin: 45.5 });
    assert.equal(auditRows(t.ctx).length, before);
    // logo : accepté, relu, jamais copié dans le journal
    const png = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
    assert.equal((await put({ logo: png })).status, 200);
    assert.equal((await t.api.get('/api/public')).data.logo, png);
    assert.ok(!JSON.stringify(auditRows(t.ctx)).includes('fake-png'));
    const huge = 'data:image/png;base64,' + 'A'.repeat(420_000);
    assert.equal((await put({ logo: huge })).status, 400);
    assert.equal((await put({ logo: '' })).status, 200);
  } finally { await t.close(); }
});

test('CRITÈRE : le journal garde chaque action et ne peut pas être modifié', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const awa = await t.staff(owner, 'Awa', 'cashier');
    await t.api.put('/api/settings', { shop_name: 'Nouveau nom' }, { token: owner });
    await t.api.patch(`/api/users/${awa.id}`, { role: 'cook' }, { token: owner });
    await t.api.post(`/api/users/${awa.id}/pin`, { pin: '8642' }, { token: owner });
    await t.api.patch(`/api/users/${awa.id}`, { active: false }, { token: owner });
    await t.api.patch(`/api/users/${awa.id}`, { active: true }, { token: owner });
    await t.api.post('/api/backups', {}, { token: owner });
    const extra = await t.staff(owner, 'Lou', 'cook');
    await t.api.post('/api/auth/logout', {}, { token: extra.token });
    const a = actions(t.ctx);
    for (const expected of ['setup.done', 'settings.update', 'user.create', 'auth.login', 'auth.pin_changed',
      'user.update', 'user.pin_reset', 'user.deactivate', 'user.reactivate', 'backup.create', 'auth.logout']) {
      assert.ok(a.includes(expected), `action manquante dans le journal : ${expected}`);
    }
    // qui / quand / quoi
    const upd = auditRows(t.ctx).find((r) => r.action === 'user.update');
    assert.equal(upd.user_name, 'Karim');
    assert.equal(upd.role, 'owner');
    assert.equal(upd.entity, 'user');
    assert.equal(upd.ts, '2026-10-07T08:00:00.000Z');
    assert.deepEqual(JSON.parse(upd.detail).role, { from: 'cashier', to: 'cook' });
    // lecture seule, même en SQL direct
    assert.throws(() => t.ctx.db.prepare("UPDATE audit SET action = 'x' WHERE id = 1").run(), /lecture seule/);
    assert.throws(() => t.ctx.db.prepare('DELETE FROM audit WHERE id = 1').run(), /lecture seule/);
    assert.deepEqual({ ok: verifyAudit(t.ctx.db).ok }, { ok: true });
    assert.equal((await t.api.get('/api/audit/verify', { token: owner })).data.ok, true);
  } finally { await t.close(); }
});

test('le journal détecte une falsification faite en contournant les protections', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    for (let i = 0; i < 3; i++) await t.api.put('/api/settings', { address: `adresse ${i}` }, { token: owner });
    const db = t.ctx.db;
    assert.equal(verifyAudit(db).ok, true);
    // 1) modification d'une ligne (on retire d'abord le verrou, comme le ferait quelqu'un qui ouvre le fichier)
    db.exec('DROP TRIGGER audit_no_update');
    db.prepare("UPDATE audit SET detail = '{\"falsifie\":true}' WHERE action = 'settings.update' AND id = (SELECT MIN(id) FROM audit WHERE action='settings.update')").run();
    const r1 = verifyAudit(db);
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /modifié/);
    // restauration du contenu d'origine pour tester le second cas : on rejoue depuis une copie propre
    const t2 = await boot();
    try {
      const owner2 = await t2.setup();
      for (let i = 0; i < 3; i++) await t2.api.put('/api/settings', { address: `adresse ${i}` }, { token: owner2 });
      t2.ctx.db.exec('DROP TRIGGER audit_no_delete');
      const mid = t2.ctx.db.prepare("SELECT id FROM audit WHERE action='settings.update' ORDER BY id LIMIT 1 OFFSET 1").get().id;
      t2.ctx.db.prepare('DELETE FROM audit WHERE id = ?').run(mid);
      const r2 = verifyAudit(t2.ctx.db);
      assert.equal(r2.ok, false);
      assert.match(r2.reason, /Chaînage rompu/);
    } finally { await t2.close(); }
  } finally { await t.close(); }
});

test('comptes : dernier propriétaire protégé, pas d\'auto-modification, noms uniques, sessions coupées', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const me = (await t.api.get('/api/me', { token: owner })).data;
    // on ne se rétrograde pas / ne se désactive pas
    assert.equal((await t.api.patch(`/api/users/${me.id}`, { role: 'manager' }, { token: owner })).status, 409);
    assert.equal((await t.api.patch(`/api/users/${me.id}`, { active: false }, { token: owner })).status, 409);
    // second propriétaire : il peut alors désactiver le premier, mais jamais le dernier
    const second = await t.staff(owner, 'Sam', 'owner');
    assert.equal((await t.api.patch(`/api/users/${me.id}`, { active: false }, { token: second.token })).status, 200);
    const r = await t.api.patch(`/api/users/${second.id}`, { role: 'manager' }, { token: second.token });
    assert.equal(r.status, 409); // soi-même
    // le premier propriétaire est désactivé : sa session est coupée
    assert.equal((await t.api.get('/api/me', { token: owner })).status, 401);
    // le dernier propriétaire actif ne peut pas être retiré (par quelqu'un d'autre : on réactive Karim puis on teste)
    assert.equal((await t.api.patch(`/api/users/${me.id}`, { active: true }, { token: second.token })).status, 200);
    const lg = await t.login(me.id, OWNER_PIN);
    assert.equal((await t.api.patch(`/api/users/${second.id}`, { active: false }, { token: lg.data.token })).status, 200);
    assert.equal((await t.api.patch(`/api/users/${me.id}`, { active: false }, { token: lg.data.token })).status, 409);
    // noms uniques parmi les comptes actifs, sans tenir compte de la casse
    await t.addUser(lg.data.token, 'Awa', 'cashier', '7531');
    const dup = await t.api.post('/api/users', { name: ' awa ', role: 'cook', pin: '7531' }, { token: lg.data.token });
    assert.equal(dup.status, 409);
    // rôle invalide, nom vide ou trop long
    assert.equal((await t.api.post('/api/users', { name: 'Zed', role: 'admin', pin: '7531' }, { token: lg.data.token })).status, 400);
    assert.equal((await t.api.post('/api/users', { name: '', role: 'cook', pin: '7531' }, { token: lg.data.token })).status, 400);
    assert.equal((await t.api.post('/api/users', { name: 'x'.repeat(41), role: 'cook', pin: '7531' }, { token: lg.data.token })).status, 400);
    assert.equal((await t.api.patch('/api/users/9999', { name: 'Zed' }, { token: lg.data.token })).status, 404);
    // changer le rôle coupe les sessions de la personne
    const cash = await t.staff(lg.data.token, 'Lou', 'cashier');
    assert.equal((await t.api.get('/api/me', { token: cash.token })).status, 200);
    await t.api.patch(`/api/users/${cash.id}`, { role: 'cook' }, { token: lg.data.token });
    assert.equal((await t.api.get('/api/me', { token: cash.token })).status, 401);
  } finally { await t.close(); }
});

test('PIN provisoire : la personne doit en choisir un nouveau avant tout le reste', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    await t.api.put('/api/settings', { self_pin_change: 1 }, { token: owner });
    const awa = await t.addUser(owner, 'Awa', 'cashier', '9753');
    assert.equal(awa.mustChangePin, true);
    const l = await t.login(awa.id, '9753');
    assert.equal(l.data.user.mustChangePin, true);
    const blocked = await t.api.get('/api/settings', { token: l.data.token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'pin_change_required');
    assert.equal((await t.api.get('/api/me', { token: l.data.token })).status, 200);
    // mauvais ancien code, même code, code trop simple
    const p = (cur, nw) => t.api.post('/api/me/pin', { currentPin: cur, newPin: nw }, { token: l.data.token });
    assert.equal((await p('0000', '8642')).status, 400);
    assert.equal((await p('9753', '9753')).status, 400);
    assert.equal((await p('9753', '1234')).status, 400);
    assert.equal((await p('9753', '8642')).status, 200);
    assert.equal((await t.api.get('/api/settings', { token: l.data.token })).status, 200);
    assert.equal((await t.login(awa.id, '9753')).status, 401);
    assert.equal((await t.login(awa.id, '8642')).status, 200);
    // une réinitialisation par le propriétaire débloque le compte et coupe ses sessions
    const s = (await t.login(awa.id, '8642')).data.token;
    await t.api.post(`/api/users/${awa.id}/pin`, { pin: '3579' }, { token: owner });
    assert.equal((await t.api.get('/api/me', { token: s })).status, 401);
    assert.equal((await t.login(awa.id, '3579')).data.user.mustChangePin, true);
    // le propriétaire ne se réinitialise pas lui-même par cette voie
    const me = (await t.api.get('/api/me', { token: owner })).data;
    assert.equal((await t.api.post(`/api/users/${me.id}/pin`, { pin: '3579' }, { token: owner })).status, 409);
  } finally { await t.close(); }
});

test('session : expire après inactivité, se prolonge si on s\'en sert', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const H = 3600_000;
    t.clock.t = new Date(t.clock.t.getTime() + 11 * H);
    assert.equal((await t.api.get('/api/me', { token: owner })).status, 200); // active : last_seen mis à jour
    t.clock.t = new Date(t.clock.t.getTime() + 11 * H);
    assert.equal((await t.api.get('/api/me', { token: owner })).status, 200); // 11 h après le dernier usage
    t.clock.t = new Date(t.clock.t.getTime() + 13 * H);
    const r = await t.api.get('/api/me', { token: owner });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'session_expired');
    assert.equal((await t.api.get('/api/me', { token: owner })).status, 401);
  } finally { await t.close(); }
});

test('déconnexion : le jeton ne sert plus', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    assert.equal((await t.api.post('/api/auth/logout', {}, { token: owner })).status, 200);
    assert.equal((await t.api.get('/api/me', { token: owner })).status, 401);
  } finally { await t.close(); }
});

test('CRITÈRE : une sauvegarde se restaure, avec copie de sécurité et connexions coupées', async () => {
  const t = await boot();
  try {
    const owner = await t.setup('Avant');
    await t.staff(owner, 'Awa', 'cashier');
    const b = await t.api.post('/api/backups', {}, { token: owner });
    assert.equal(b.status, 201);
    assert.match(b.data.name, /^manuelle-20261007-080000\.db$/);
    // des changements après la sauvegarde
    await t.api.put('/api/settings', { shop_name: 'Après' }, { token: owner });
    await t.addUser(owner, 'Nouveau', 'cook', '8642');
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 3);
    // sans confirmation : refus
    const noConf = await t.api.post(`/api/backups/${b.data.name}/restore`, {}, { token: owner });
    assert.equal(noConf.status, 400);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 3);
    t.clock.t = new Date(t.clock.t.getTime() + 60_000);
    const r = await t.api.post(`/api/backups/${b.data.name}/restore`, { confirm: 'RESTAURER' }, { token: owner });
    assert.equal(r.status, 200);
    assert.match(r.data.safetyCopy, /^avant-restauration-/);
    // l'état est celui de la sauvegarde
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 2);
    // les anciennes connexions sont coupées, on peut se reconnecter
    assert.equal((await t.api.get('/api/me', { token: owner })).status, 401);
    const users = (await t.api.get('/api/auth/users')).data;
    const karim = users.find((u) => u.name === 'Karim');
    const again = await t.login(karim.id, OWNER_PIN);
    assert.equal(again.status, 200);
    assert.equal((await t.api.get('/api/public')).data.shop_name, 'Avant');
    // la copie de sécurité contient l'état d'avant la restauration (3 comptes) et reste restaurable
    const files = (await t.api.get('/api/backups', { token: again.data.token })).data.items;
    assert.ok(files.some((f) => f.name === r.data.safetyCopy));
    const safety = new DatabaseSync(path.join(t.ctx.backupDir, r.data.safetyCopy), { readOnly: true });
    assert.equal(safety.prepare('SELECT COUNT(*) c FROM users').get().c, 3);
    safety.close();
    // la restauration est inscrite au journal, et la chaîne reste valide
    assert.ok(actions(t.ctx).includes('backup.restore'));
    assert.equal(verifyAudit(t.ctx.db).ok, true);
    // et la restauration de la copie de sécurité fonctionne aussi (retour en arrière)
    const back = await t.api.post(`/api/backups/${r.data.safetyCopy}/restore`, { confirm: 'RESTAURER' }, { token: again.data.token });
    assert.equal(back.status, 200);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) c FROM users').get().c, 3);
  } finally { await t.close(); }
});

test('sauvegardes : noms piégés refusés, fichiers invalides refusés, import d\'un fichier valide', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const o = { token: owner };
    for (const name of ['..%2F..%2Fetc%2Fpasswd', 'boutique.db', 'manuelle-1.db', '%2e%2e%2fx.db']) {
      const r = await t.api.post(`/api/backups/${name}/restore`, { confirm: 'RESTAURER' }, o);
      assert.ok([400, 404].includes(r.status), `${name} → ${r.status}`);
      const d = await t.api.get(`/api/backups/${name}/download`, o);
      assert.ok([400, 404].includes(d.status), `${name} download → ${d.status}`);
    }
    assert.equal((await t.api.post('/api/backups/manuelle-20200101-000000.db/restore', { confirm: 'RESTAURER' }, o)).status, 404);
    // fichiers invalides
    assert.equal((await t.api.post('/api/backups/import', undefined, { ...o, raw: Buffer.from('ceci n\'est pas une base') })).status, 400);
    const other = path.join(t.dataDir, 'autre.db');
    const odb = new DatabaseSync(other);
    odb.exec('CREATE TABLE truc (a)');
    odb.close();
    const wrongDb = await t.api.post('/api/backups/import', undefined, { ...o, raw: fs.readFileSync(other) });
    assert.equal(wrongDb.status, 400);
    assert.match(wrongDb.data.error.message, /pas une sauvegarde de cette application/);
    assert.deepEqual(fs.readdirSync(t.ctx.backupDir).filter((f) => f.endsWith('.part')), []);
    // une vraie sauvegarde téléchargée puis réimportée
    const b = (await t.api.post('/api/backups', {}, o)).data;
    const dl = await t.api.get(`/api/backups/${b.name}/download`, o);
    assert.equal(dl.status, 200);
    assert.ok(Buffer.isBuffer(dl.data) && dl.data.length === b.size);
    const imp = await t.api.post('/api/backups/import', undefined, { ...o, raw: dl.data });
    assert.equal(imp.status, 201);
    assert.match(imp.data.name, /^import-/);
    assert.ok(actions(t.ctx).includes('backup.import'));
    assert.ok(actions(t.ctx).includes('backup.download'));
    // base d'une version plus récente refusée
    const future = path.join(t.dataDir, 'futur.db');
    fs.copyFileSync(path.join(t.ctx.backupDir, b.name), future);
    const fdb = new DatabaseSync(future);
    fdb.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'futur', 'x')").run();
    fdb.close();
    const fut = await t.api.post('/api/backups/import', undefined, { ...o, raw: fs.readFileSync(future) });
    assert.equal(fut.status, 400);
    assert.match(fut.data.error.message, /plus récente/);
  } finally { await t.close(); }
});

test('sauvegarde automatique : une par jour, conservation limitée, copies manuelles jamais supprimées', async () => {
  const t = await boot();
  try {
    assert.equal(t.ctx.ensureDailyBackup(), null, 'rien à sauvegarder avant l\'installation');
    const owner = await t.setup();
    const first = t.ctx.ensureDailyBackup();
    assert.ok(first && first.kind === 'auto');
    assert.equal(t.ctx.ensureDailyBackup(), null, 'une seule par jour');
    await t.api.post('/api/backups', {}, { token: owner });
    await t.api.put('/api/settings', { backup_keep: 7 }, { token: owner });
    for (let d = 1; d <= 10; d++) {
      t.clock.t = new Date(t.clock.t.getTime() + 24 * 3600_000);
      assert.ok(t.ctx.ensureDailyBackup(), `jour ${d}`);
    }
    const karim = (await t.api.get('/api/auth/users')).data.find((u) => u.name === 'Karim');
    const fresh = (await t.login(karim.id, OWNER_PIN)).data.token; // l'ancienne session a expiré pendant les 10 jours
    const items = (await t.api.get('/api/backups', { token: fresh })).data.items;
    assert.equal(items.filter((b) => b.kind === 'auto').length, 7);
    assert.equal(items.filter((b) => b.kind === 'manuelle').length, 1);
    // les 7 conservées sont les plus récentes
    const autos = items.filter((b) => b.kind === 'auto').map((b) => b.createdAt).sort();
    assert.equal(autos.at(-1), '2026-10-17T08:00:00Z');
    assert.equal(autos[0], '2026-10-11T08:00:00Z');
    // le jour se compte dans le fuseau du commerce (Mayotte = UTC+3, minuit local = 21:00 UTC)
    const t2 = await boot({ start: '2026-10-07T20:30:00Z' }); // 23:30 le 7 à Mayotte
    try {
      await t2.setup();
      assert.ok(t2.ctx.ensureDailyBackup());
      t2.clock.t = new Date('2026-10-07T20:50:00Z'); // 23:50, même jour local
      assert.equal(t2.ctx.ensureDailyBackup(), null);
      t2.clock.t = new Date('2026-10-07T21:10:00Z'); // 00:10 le 8 à Mayotte : nouveau jour local, alors qu'il est encore le 7 en UTC
      assert.ok(t2.ctx.ensureDailyBackup());
      t2.clock.t = new Date('2026-10-07T23:30:00Z'); // 02:30 le 8, même jour local que la précédente
      assert.equal(t2.ctx.ensureDailyBackup(), null);
    } finally { await t2.close(); }
  } finally { await t.close(); }
});

test('données conservées après redémarrage, migrations jouées une seule fois', async () => {
  const t = await boot();
  const dir = t.dataDir;
  const owner = await t.setup('Persistant');
  await t.staff(owner, 'Awa', 'cashier');
  await t.close();
  const t2 = await boot({ dir });
  try {
    const users = (await t2.api.get('/api/auth/users')).data.map((u) => u.name).sort();
    assert.deepEqual(users, ['Awa', 'Karim']);
    assert.equal((await t2.api.get('/api/public')).data.shop_name, 'Persistant');
    const karim = (await t2.api.get('/api/auth/users')).data.find((u) => u.name === 'Karim');
    assert.equal((await t2.login(karim.id, OWNER_PIN)).status, 200);
    assert.equal(t2.ctx.db.prepare('SELECT COUNT(*) c FROM schema_version').get().c, MIGRATIONS.length);
    assert.equal(verifyAudit(t2.ctx.db).ok, true);
  } finally { await t2.close(); }
  // une base plus récente que le programme est refusée au démarrage
  const dbf = path.join(dir, 'boutique.db');
  const raw = new DatabaseSync(dbf);
  raw.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'futur', 'x')").run();
  raw.close();
  assert.throws(() => createApp({ dataDir: dir }), /plus récente/);
});

test('requêtes malformées : erreurs propres, aucun plantage', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const r1 = await fetch(`${t.base}/api/users`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: '{pas du json' });
    assert.equal(r1.status, 400);
    assert.equal((await t.api.post('/api/auth/login', { userId: 'abc', pin: 1234 })).status, 401);
    assert.equal((await t.api.post('/api/auth/login', undefined)).status, 401);
    assert.equal((await t.api.get('/api/inexistant', { token: owner })).status, 404);
    assert.equal((await t.api.get('/api/audit?limit=abc&beforeId=zzz', { token: owner })).status, 200);
    const long = await t.api.get(`/api/audit?action=${'%25'.repeat(10)}`, { token: owner });
    assert.equal(long.status, 200);
    assert.equal((await t.api.get('/api/health')).data.ok, true);
    assert.equal((await t.api.get('/api/health')).headers.get('x-content-type-options'), 'nosniff');
  } finally { await t.close(); }
});

test('journal consultable : filtres et pagination', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    for (let i = 0; i < 7; i++) await t.api.put('/api/settings', { address: `a${i}` }, { token: owner });
    const page1 = (await t.api.get('/api/audit?limit=5', { token: owner })).data;
    assert.equal(page1.rows.length, 5);
    assert.equal(page1.hasMore, true);
    const last = page1.rows.at(-1).id;
    const page2 = (await t.api.get(`/api/audit?limit=5&beforeId=${last}`, { token: owner })).data;
    assert.ok(page2.rows.every((r) => r.id < last));
    const onlySettings = (await t.api.get('/api/audit?action=settings.', { token: owner })).data;
    assert.equal(onlySettings.rows.length, 8, '7 modifications + le nom saisi à l\'installation');
    assert.ok(onlySettings.rows.every((r) => r.action.startsWith('settings.')));
    assert.ok(onlySettings.rows[0].detail.address);
    assert.ok(onlySettings.rows[0].id > onlySettings.rows.at(-1).id, 'du plus récent au plus ancien');
  } finally { await t.close(); }
});

test('Par défaut, seul l\'administrateur crée nom et code : pas de code provisoire, pas de changement par l\'employé', async () => {
  const t = await boot();
  try {
    const owner = await t.setup();
    const awa = await t.addUser(owner, 'Awa', 'cashier', '7531');
    assert.equal(awa.mustChangePin, false);
    const l = await t.login(awa.id, '7531');
    assert.equal(l.data.user.mustChangePin, false);
    assert.equal(l.data.user.canChangePin, false);
    const ch = await t.api.post('/api/me/pin', { currentPin: '7531', newPin: '8642' }, { token: l.data.token });
    assert.equal(ch.status, 403);
    assert.equal((await t.api.post('/api/users', { name: 'X', role: 'cashier', pin: '2468' }, { token: l.data.token })).status, 403);
    const rs = await t.api.post(`/api/users/${awa.id}/pin`, { pin: '8642' }, { token: owner });
    assert.equal(rs.status, 200);
    assert.equal((await t.login(awa.id, '8642')).data.user.mustChangePin, false);
  } finally { await t.close(); }
});
