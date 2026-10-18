import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, tx, LATEST_VERSION } from './db.js';
import { HttpError, bad, forbidden, notFound, conflict } from './errors.js';
import { hashPin, verifyPin, pinProblem, burnTime, newToken, sha256 } from './security.js';
import { can, permissionsOf, ROLES, ROLE_LABELS } from './permissions.js';
import { writeAudit, verifyAudit, listAudit } from './audit.js';
import { registerStock } from './stock-routes.js';
import { registerRecipes } from './recipes-routes.js';
import { registerCategories } from './categories.js';
import { registerPos } from './pos-routes.js';
import { registerOrders } from './orders-routes.js';
import { createRequire } from 'node:module';
import { settingsFor, settingsMeta, updateSettings, getSetting } from './settings.js';
import {
  createBackup, reserveName, listBackups, backupPath, verifyBackupFile, prune, dayIn, parseName, safeName, KIND_LABELS,
} from './backup.js';

export const LOCK_AFTER = 5;
export const LOCK_SECONDS = 60;
const MAX_NAME = 40;

const APP_VERSION = createRequire(import.meta.url)('../package.json').version;
export const VERSION = APP_VERSION;

export function createApp({ dataDir, now = () => new Date(), staticDir = null, cloud = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const ctx = {
    dataDir,
    dbFile: path.join(dataDir, 'boutique.db'),
    backupDir: path.join(dataDir, 'sauvegardes'),
    now,
    db: null,
  };
  ctx.db = openDb(ctx.dbFile, now);
  ctx.cloud = cloud;
  cloud?.attach(ctx);
  const iso = () => ctx.now().toISOString();

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    next();
  });
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (cloud) { // copie en ligne après chaque écriture réussie
    app.use('/api', (req, res, next) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) res.on('finish', () => { if (res.statusCode < 500) cloud.onWrite(); });
      next();
    });
  }
  app.use(express.json({ limit: '1mb' }));

  // ---------- authentification ----------
  const actorOf = (u) => (u ? { id: u.id, name: u.name, role: u.role } : null);

  function authenticate(req) {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw new HttpError(401, 'unauthenticated', 'Connexion requise.');
    const db = ctx.db;
    const row = db.prepare(`SELECT s.token_hash, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1`).get(sha256(token));
    if (!row) throw new HttpError(401, 'unauthenticated', 'Session inconnue ou terminée. Reconnectez-vous.');
    const idleMs = getSetting(db, 'session_hours') * 3600_000;
    const nowMs = ctx.now().getTime();
    const lastMs = Date.parse(row.last_seen);
    if (nowMs - lastMs > idleMs) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      throw new HttpError(401, 'session_expired', 'Session expirée par inactivité. Reconnectez-vous.');
    }
    if (nowMs - lastMs > 60_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(iso(), row.token_hash);
    return { user: row, tokenHash: row.token_hash };
  }

  const selfPinOn = () => Number(getSetting(ctx.db, 'self_pin_change')) === 1;
  const canSelfPin = (u) => u.role === 'owner' || selfPinOn();
  const PIN_EXEMPT = new Set(['/api/me', '/api/me/pin', '/api/auth/logout']);
  const auth = (req, res, next) => {
    const { user, tokenHash } = authenticate(req);
    req.user = user;
    req.tokenHash = tokenHash;
    if (user.must_change_pin && canSelfPin(user) && !PIN_EXEMPT.has(req.baseUrl + req.path)) {
      throw new HttpError(403, 'pin_change_required', 'Vous devez d\'abord choisir un nouveau code PIN.');
    }
    next();
  };
  const need = (perm) => (req, res, next) => {
    if (!can(req.user.role, perm)) throw forbidden();
    next();
  };

  const mePayload = (u) => ({
    id: u.id, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role],
    mustChangePin: Boolean(u.must_change_pin) && canSelfPin(u), canChangePin: canSelfPin(u), permissions: permissionsOf(u.role),
  });

  const cleanName = (v) => {
    if (typeof v !== 'string') throw bad('Le nom est obligatoire.');
    const t = v.trim().replace(/\s+/g, ' ');
    if (!t) throw bad('Le nom est obligatoire.');
    if (t.length > MAX_NAME) throw bad(`Le nom est trop long (${MAX_NAME} caractères au maximum).`);
    return t;
  };
  const nameTaken = (name, exceptId = 0) =>
    Boolean(ctx.db.prepare('SELECT 1 FROM users WHERE active = 1 AND lower(name) = lower(?) AND id <> ?').get(name, exceptId));
  const checkPin = (pin) => { const p = pinProblem(pin); if (p) throw bad(p, 'weak_pin'); };

  const startSession = (userId) => {
    const token = newToken();
    const t = iso();
    ctx.db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(new Date(ctx.now().getTime() - 72 * 3600_000).toISOString());
    ctx.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?,?,?,?)').run(sha256(token), userId, t, t);
    return token;
  };

  // ---------- anti-force-brute par adresse (en plus du blocage par compte) ----------
  const hits = new Map();
  const ipLimiter = (max, windowMs) => (req, res, next) => {
    const t = ctx.now().getTime();
    const k = req.ip;
    const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) throw new HttpError(429, 'too_many', 'Trop de tentatives. Patientez une minute.');
    arr.push(t);
    hits.set(k, arr);
    next();
  };

  // ---------- routes publiques ----------
  const api = express.Router();

  api.get('/health', (req, res) => {
    ctx.db.prepare('SELECT 1').get();
    res.json({ ok: true, schema: LATEST_VERSION });
  });

  api.get('/setup/status', (req, res) => {
    res.json({ needsSetup: ctx.db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0 });
  });

  api.post('/setup', ipLimiter(20, 60_000), (req, res) => {
    const { shopName, ownerName, pin } = req.body || {};
    const out = tx(ctx.db, () => {
      if (ctx.db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) throw conflict('L\'application est déjà installée.', 'already_setup');
      const name = cleanName(ownerName);
      checkPin(pin);
      const t = iso();
      const r = ctx.db.prepare(`INSERT INTO users (name, pin_hash, role, created_at, updated_at) VALUES (?,?, 'owner', ?, ?)`)
        .run(name, hashPin(pin), t, t);
      const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
      updateSettings(ctx.db, t, actorOf(user), { shop_name: shopName ?? 'Mon snack' });
      writeAudit(ctx.db, t, actorOf(user), 'setup.done', { entity: 'user', entityId: user.id, detail: { owner: name } });
      return { token: startSession(user.id), user };
    });
    res.status(201).json({ token: out.token, user: mePayload(out.user) });
  });

  api.get('/auth/users', (req, res) => {
    res.json(ctx.db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY lower(name)').all()
      .map((u) => ({ ...u, roleLabel: ROLE_LABELS[u.role] })));
  });

  api.get('/public', (req, res) => {
    const s = settingsFor(ctx.db, 'cook');
    res.json({ shop_name: s.shop_name, logo: s.logo, timezone: s.timezone, version: APP_VERSION });
  });

  api.post('/auth/login', ipLimiter(60, 60_000), (req, res) => {
    const { userId, pin } = req.body || {};
    const db = ctx.db;
    const u = Number.isInteger(userId) ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId) : null;
    if (!u) { burnTime(pin); throw new HttpError(401, 'bad_credentials', 'Nom ou code PIN incorrect.'); }
    const nowMs = ctx.now().getTime();
    if (u.locked_until && Date.parse(u.locked_until) > nowMs) {
      const wait = Math.ceil((Date.parse(u.locked_until) - nowMs) / 1000);
      throw new HttpError(429, 'locked', `Compte bloqué après trop d'erreurs. Réessayez dans ${wait} s.`, { retryAfter: wait });
    }
    if (typeof pin !== 'string' || !verifyPin(pin, u.pin_hash)) {
      tx(db, () => {
        const failed = u.failed_count + 1;
        const t = iso();
        if (failed >= LOCK_AFTER) {
          db.prepare('UPDATE users SET failed_count = 0, locked_until = ? WHERE id = ?')
            .run(new Date(nowMs + LOCK_SECONDS * 1000).toISOString(), u.id);
          writeAudit(db, t, null, 'auth.locked', { entity: 'user', entityId: u.id, detail: { name: u.name, seconds: LOCK_SECONDS } });
        } else {
          db.prepare('UPDATE users SET failed_count = ? WHERE id = ?').run(failed, u.id);
          writeAudit(db, t, null, 'auth.login_failed', { entity: 'user', entityId: u.id, detail: { name: u.name, failures: failed } });
        }
      });
      const left = LOCK_AFTER - (u.failed_count + 1);
      if (left <= 0) throw new HttpError(429, 'locked', `Trop d'erreurs : compte bloqué ${LOCK_SECONDS} secondes.`, { retryAfter: LOCK_SECONDS });
      throw new HttpError(401, 'bad_credentials', `Nom ou code PIN incorrect. Il reste ${left} essai${left > 1 ? 's' : ''}.`);
    }
    const token = tx(db, () => {
      db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?').run(u.id);
      writeAudit(db, iso(), actorOf(u), 'auth.login', { entity: 'user', entityId: u.id });
      return startSession(u.id);
    });
    res.json({ token, user: mePayload(u) });
  });

  // ---------- routes connectées ----------
  api.post('/auth/logout', auth, (req, res) => {
    tx(ctx.db, () => {
      ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
      writeAudit(ctx.db, iso(), actorOf(req.user), 'auth.logout', { entity: 'user', entityId: req.user.id });
    });
    res.json({ ok: true });
  });

  api.get('/me', auth, (req, res) => res.json(mePayload(req.user)));

  api.post('/me/pin', auth, need('account.self'), (req, res) => {
    if (!canSelfPin(req.user)) throw forbidden('Seul l\'administrateur peut changer votre code. Demandez-lui.');
    const { currentPin, newPin } = req.body || {};
    if (typeof currentPin !== 'string' || !verifyPin(currentPin, req.user.pin_hash)) throw bad('Le code PIN actuel est incorrect.', 'bad_pin');
    checkPin(newPin);
    if (newPin === currentPin) throw bad('Le nouveau code doit être différent de l\'ancien.');
    tx(ctx.db, () => {
      ctx.db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 0, updated_at = ? WHERE id = ?').run(hashPin(newPin), iso(), req.user.id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.tokenHash);
      writeAudit(ctx.db, iso(), actorOf(req.user), 'auth.pin_changed', { entity: 'user', entityId: req.user.id });
    });
    res.json({ ok: true });
  });


  // ---------- ingrédients et stock (étape 2) ----------
  registerStock({ api, ctx, auth, need, iso, actorOf });

  // ---------- recettes (étape 3) ----------
  registerRecipes({ api, ctx, auth, need, iso, actorOf });
  registerCategories({ api, ctx, auth, need, iso, actorOf });

  // ---------- produits, production, caisse, clients, fournisseurs, traiteur, gestion (étapes 4 à 9) ----------
  registerPos({ api, ctx, auth, need, iso, actorOf });
  // ---------- commandes envoyées à la cuisine et notifications (version 1.1) ----------
  registerOrders({ api, ctx, auth, need, actorOf });

  // ---------- réglages ----------
  api.get('/settings', auth, (req, res) => {
    res.json({ values: settingsFor(ctx.db, req.user.role), meta: settingsMeta(req.user.role), canEdit: can(req.user.role, 'settings.edit') });
  });
  api.put('/settings', auth, need('settings.edit'), (req, res) => {
    const changes = updateSettings(ctx.db, iso(), actorOf(req.user), req.body);
    res.json({ changes, values: settingsFor(ctx.db, req.user.role) });
  });

  // ---------- utilisateurs ----------
  const userRow = (u) => ({
    id: u.id, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role], active: Boolean(u.active),
    mustChangePin: Boolean(u.must_change_pin),
    locked: Boolean(u.locked_until && Date.parse(u.locked_until) > ctx.now().getTime()),
    createdAt: u.created_at,
  });
  const activeOwners = () => ctx.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='owner' AND active=1").get().c;

  api.get('/users', auth, need('users.manage'), (req, res) => {
    res.json(ctx.db.prepare('SELECT * FROM users ORDER BY active DESC, lower(name)').all().map(userRow));
  });

  api.post('/users', auth, need('users.manage'), (req, res) => {
    const { name, role, pin } = req.body || {};
    const n = cleanName(name);
    if (!ROLES.includes(role)) throw bad('Rôle invalide.');
    checkPin(pin);
    const u = tx(ctx.db, () => {
      if (nameTaken(n)) throw conflict('Un compte actif porte déjà ce nom.', 'name_taken');
      const t = iso();
      const r = ctx.db.prepare('INSERT INTO users (name, pin_hash, role, must_change_pin, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(n, hashPin(pin), role, selfPinOn() ? 1 : 0, t, t);
      const id = Number(r.lastInsertRowid);
      writeAudit(ctx.db, t, actorOf(req.user), 'user.create', { entity: 'user', entityId: id, detail: { name: n, role } });
      return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    });
    res.status(201).json(userRow(u));
  });

  api.patch('/users/:id', auth, need('users.manage'), (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const u = tx(ctx.db, () => {
      const cur = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!cur) throw notFound('Compte introuvable.');
      const next = { name: cur.name, role: cur.role, active: cur.active };
      const changes = {};
      if ('name' in body) { next.name = cleanName(body.name); }
      if ('role' in body) {
        if (!ROLES.includes(body.role)) throw bad('Rôle invalide.');
        next.role = body.role;
      }
      if ('active' in body) {
        if (typeof body.active !== 'boolean') throw bad('Valeur « actif » invalide.');
        next.active = body.active ? 1 : 0;
      }
      const isSelf = cur.id === req.user.id;
      if (isSelf && (next.role !== cur.role || next.active !== cur.active)) {
        throw conflict('Vous ne pouvez pas modifier votre propre rôle ni désactiver votre propre compte.', 'self_change');
      }
      const losesOwner = cur.role === 'owner' && cur.active === 1 && (next.role !== 'owner' || next.active === 0);
      if (losesOwner && activeOwners() <= 1) throw conflict('Il doit toujours rester au moins un propriétaire actif.', 'last_owner');
      if (next.active === 1 && nameTaken(next.name, cur.id)) throw conflict('Un compte actif porte déjà ce nom.', 'name_taken');
      for (const k of ['name', 'role']) if (next[k] !== cur[k]) changes[k] = { from: cur[k], to: next[k] };
      if (next.active !== cur.active) changes.active = { from: Boolean(cur.active), to: Boolean(next.active) };
      if (!Object.keys(changes).length) return cur;
      const t = iso();
      ctx.db.prepare('UPDATE users SET name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?').run(next.name, next.role, next.active, t, id);
      if (changes.role || changes.active) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      const action = changes.active ? (next.active ? 'user.reactivate' : 'user.deactivate') : 'user.update';
      writeAudit(ctx.db, t, actorOf(req.user), action, { entity: 'user', entityId: id, detail: { name: cur.name, ...changes } });
      return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    });
    res.json(userRow(u));
  });

  api.post('/users/:id/pin', auth, need('users.manage'), (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw conflict('Pour changer votre propre code, utilisez « Mon compte ».', 'self_change');
    checkPin(req.body?.pin);
    tx(ctx.db, () => {
      const cur = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!cur) throw notFound('Compte introuvable.');
      ctx.db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = ?, failed_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
        .run(hashPin(req.body.pin), selfPinOn() ? 1 : 0, iso(), id);
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      writeAudit(ctx.db, iso(), actorOf(req.user), 'user.pin_reset', { entity: 'user', entityId: id, detail: { name: cur.name } });
    });
    res.json({ ok: true });
  });

  // ---------- journal ----------
  api.get('/audit', auth, need('audit.view'), (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(listAudit(ctx.db, {
      limit,
      beforeId: Number(req.query.beforeId) || null,
      actionPrefix: typeof req.query.action === 'string' && req.query.action ? req.query.action.slice(0, 40) : null,
      userId: Number(req.query.userId) || null,
    }));
  });
  api.get('/audit/verify', auth, need('audit.view'), (req, res) => res.json(verifyAudit(ctx.db)));

  // ---------- sauvegardes ----------
  const decorate = (b) => ({ ...b, kindLabel: KIND_LABELS[b.kind] });

  function pruneAll() {
    return prune(ctx.backupDir, { auto: getSetting(ctx.db, 'backup_keep'), 'avant-restauration': 10 });
  }

  function makeBackup(kind, actor, extra = {}) {
    const b = createBackup(ctx.db, ctx.backupDir, kind, ctx.now());
    writeAudit(ctx.db, iso(), actor, 'backup.create', { entity: 'backup', entityId: b.name, detail: { kind, size: b.size, ...extra } });
    const removed = pruneAll();
    return { backup: decorate(b), removed };
  }

  /** Une sauvegarde automatique par jour (jour du fuseau du commerce). Appelée au démarrage puis régulièrement. */
  ctx.ensureDailyBackup = () => {
    if (ctx.db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) return null;
    const tz = getSetting(ctx.db, 'timezone');
    const today = dayIn(ctx.now(), tz);
    const done = listBackups(ctx.backupDir).some((b) => b.kind === 'auto' && dayIn(new Date(b.createdAt), tz) === today);
    return done ? null : makeBackup('auto', null).backup;
  };

  api.get('/cloud/status', auth, need('backup.manage'), (req, res) => res.json(cloud ? cloud.status() : { enabled: false }));

  api.get('/backups', auth, need('backup.manage'), (req, res) => {
    res.json({ items: listBackups(ctx.backupDir).map(decorate), keepAuto: getSetting(ctx.db, 'backup_keep') });
  });
  api.post('/backups', auth, need('backup.manage'), (req, res) => {
    res.status(201).json(makeBackup('manuelle', actorOf(req.user)).backup);
  });
  api.get('/backups/:name/download', auth, need('backup.manage'), (req, res) => {
    const p = backupPath(ctx.backupDir, req.params.name);
    writeAudit(ctx.db, iso(), actorOf(req.user), 'backup.download', { entity: 'backup', entityId: req.params.name });
    res.download(p, req.params.name);
  });
  api.post('/backups/import', auth, need('backup.manage'),
    express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Aucun fichier reçu.');
      fs.mkdirSync(ctx.backupDir, { recursive: true });
      const tmp = path.join(ctx.backupDir, `tmp-${crypto.randomBytes(6).toString('hex')}.part`);
      fs.writeFileSync(tmp, req.body);
      const check = verifyBackupFile(tmp);
      if (!check.ok) { fs.rmSync(tmp, { force: true }); throw bad(check.reason, 'bad_backup'); }
      const name = reserveName(ctx.backupDir, 'import', ctx.now());
      fs.renameSync(tmp, path.join(ctx.backupDir, name));
      writeAudit(ctx.db, iso(), actorOf(req.user), 'backup.import', { entity: 'backup', entityId: name, detail: { size: req.body.length, activeUsers: check.activeUsers } });
      res.status(201).json(decorate({ name, kind: 'import', createdAt: parseName(name).createdAt, size: req.body.length }));
    });
  api.post('/backups/:name/restore', auth, need('backup.manage'), (req, res) => {
    if (req.body?.confirm !== 'RESTAURER') throw bad('Confirmation manquante : tapez RESTAURER.', 'confirm_required');
    const file = backupPath(ctx.backupDir, req.params.name);
    const check = verifyBackupFile(file);
    if (!check.ok) throw bad(check.reason, 'bad_backup');
    const actor = actorOf(req.user);
    const safety = createBackup(ctx.db, ctx.backupDir, 'avant-restauration', ctx.now());
    ctx.db.close();
    try {
      const tmp = `${ctx.dbFile}.restore`;
      fs.copyFileSync(file, tmp);
      fs.rmSync(`${ctx.dbFile}-wal`, { force: true });
      fs.rmSync(`${ctx.dbFile}-shm`, { force: true });
      fs.renameSync(tmp, ctx.dbFile);
    } finally {
      ctx.db = openDb(ctx.dbFile, ctx.now);
    }
    // une sauvegarde ne doit jamais ressusciter d'anciennes connexions
    ctx.db.prepare('DELETE FROM sessions').run();
    writeAudit(ctx.db, iso(), actor, 'backup.restore', {
      entity: 'backup', entityId: req.params.name, detail: { safetyCopy: safety.name, version: check.version },
    });
    res.json({ ok: true, safetyCopy: safety.name, relogin: true });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => { throw notFound('Route inconnue.'); });

  // ---------- interface ----------
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, {
      setHeaders: (res, p) => {
        if (/sw\.js$|index\.html$/.test(p)) res.set('Cache-Control', 'no-cache');
        else if (/\/assets\//.test(p)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'Envoi trop volumineux.' } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid', message: 'Requête illisible.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'server', message: 'Erreur interne. Rien n\'a été perdu ; réessayez.' } });
  });

  ctx.app = app;
  return ctx;
}
