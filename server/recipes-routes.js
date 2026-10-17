import express from 'express';
import { can } from './permissions.js';
import { bad, notFound } from './errors.js';
import { fmtBase } from '../shared/units.js';
import { loadIngredient, loadMeasures } from './stock.js';
import {
  createRecipe, updateRecipe, restoreVersion, setArchived, duplicateRecipe, getRecipe, loadVersion, costLines, scaleVersion,
  enteredText, freeText, addPhoto, removePhoto, setCaption, readPhoto, MAX_PHOTOS, MAX_PHOTO_BYTES,
} from './recipes.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // Express 4 n'attrape pas les erreurs des fonctions asynchrones
const intId = (v, label = 'Identifiant') => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw bad(`${label} invalide.`); return n; };

export function registerRecipes({ api, ctx, auth, need, iso, actorOf }) {
  const costsOk = (role) => can(role, 'costs.view');

  const photosOf = (id) => ctx.db.prepare('SELECT id, caption, bytes, created_at FROM recipe_photos WHERE recipe_id = ? ORDER BY pos, id').all(id);

  function lineView(l, measures) {
    if (l.ingredient_id == null) {
      const text = freeText(l.qty, l.unit);
      return { ingredient_id: null, unlinked: true, label: l.label, name: l.label, active: true, family: null, qty: l.qty, unit: l.unit, entered: text, baseText: text, note: l.note, hasLoss: false, yieldPct: 100 };
    }
    const ing = loadIngredient(ctx.db, l.ingredient_id);
    return {
      ingredient_id: l.ingredient_id, name: ing.name, active: ing.active, family: ing.family, qty: l.qty, unit: l.unit,
      entered: enteredText(ctx.db, ing, measures, l.qty, l.unit), baseText: fmtBase(l.base, ing.family), note: l.note,
      hasLoss: ing.yieldPct < 100, yieldPct: ing.yieldPct,
    };
  }

  function summary(rec, c) {
    const v = loadVersion(ctx.db, rec.id, null);
    const photos = photosOf(rec.id);
    const out = {
      id: rec.id, name: rec.name, category: rec.category, archived: Boolean(rec.archived), archived_at: rec.archived_at,
      version: v.version, servings: v.servings, prep_min: v.prep_min, cook_min: v.cook_min, lines: v.lines.length, unlinked: v.lines.filter((l) => l.ingredient_id == null).length,
      updated_at: rec.updated_at, photoCount: photos.length, cover: photos[0]?.id ?? null,
    };
    if (c.costs) {
      const cost = costLines(ctx.db, v.lines);
      out.cost_total = cost.total; out.cost_per_serving = cost.total / v.servings; out.cost_incomplete = cost.incomplete;
    }
    return out;
  }

  api.get('/recipes', auth, need('recipes.view'), (req, res) => {
    const c = { costs: costsOk(req.user.role) };
    const archived = req.query.archived === '1';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const rows = ctx.db.prepare('SELECT * FROM recipes WHERE archived = ? ORDER BY lower(name)').all(archived ? 1 : 0)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
    const counts = ctx.db.prepare('SELECT archived, COUNT(*) AS n FROM recipes GROUP BY archived').all();
    res.json({
      items: rows.map((r) => summary(r, c)), can: { edit: can(req.user.role, 'recipes.edit'), costs: c.costs },
      counts: { active: counts.find((x) => !x.archived)?.n ?? 0, archived: counts.find((x) => x.archived)?.n ?? 0 },
      categories: [...new Set(ctx.db.prepare('SELECT DISTINCT category FROM recipes WHERE category <> \'\' ORDER BY lower(category)').all().map((r) => r.category))],
      maxPhotos: MAX_PHOTOS,
    });
  });

  api.get('/recipes/:id', auth, need('recipes.view'), (req, res) => {
    const c = { costs: costsOk(req.user.role) };
    const rec = getRecipe(ctx.db, intId(req.params.id));
    const cur = loadVersion(ctx.db, rec.id, null);
    const n = req.query.version == null ? cur.version : intId(req.query.version, 'Version');
    const v = n === cur.version ? cur : loadVersion(ctx.db, rec.id, n);
    if (!v) throw notFound('Version introuvable.');
    const measures = loadMeasures(ctx.db, { all: true });
    const lines = v.lines.map((l) => lineView(l, measures));
    const out = {
      ...summary(rec, c), version: v.version, isCurrent: v.version === cur.version, currentVersion: cur.version,
      servings: v.servings, prep_min: v.prep_min, cook_min: v.cook_min, steps: v.steps, notes: v.notes,
      change_note: v.change_note, version_ts: v.ts, version_user: v.user_name, lines,
      versions: ctx.db.prepare('SELECT version, ts, user_name, change_note FROM recipe_versions WHERE recipe_id = ? ORDER BY version DESC').all(rec.id),
      photos: photosOf(rec.id), can: { edit: can(req.user.role, 'recipes.edit'), costs: c.costs },
    };
    if (c.costs) {
      const cost = costLines(ctx.db, v.lines);
      out.cost_total = cost.total; out.cost_per_serving = cost.total / v.servings; out.cost_incomplete = cost.incomplete;
      out.lines = lines.map((l, i) => ({ ...l, cost: cost.per[i].cost, priced: cost.per[i].priced }));
    }
    res.json(out);
  });

  api.get('/recipes/:id/scale', auth, need('recipes.view'), (req, res) => {
    const rec = getRecipe(ctx.db, intId(req.params.id));
    const servings = Number(String(req.query.servings ?? '').replace(',', '.'));
    if (!Number.isFinite(servings) || servings <= 0 || servings > 100000) throw bad('Le nombre de personnes doit être un nombre supérieur à zéro.');
    const v = req.query.version == null ? loadVersion(ctx.db, rec.id, null) : loadVersion(ctx.db, rec.id, intId(req.query.version, 'Version'));
    if (!v) throw notFound('Version introuvable.');
    const out = { name: rec.name, version: v.version, ...scaleVersion(ctx.db, v, servings) };
    if (costsOk(req.user.role)) {
      const cost = costLines(ctx.db, v.lines);
      out.cost_total = (cost.total / v.servings) * servings;
      out.cost_per_serving = cost.total / v.servings;
      out.cost_incomplete = cost.incomplete;
    }
    res.json(out);
  });

  api.post('/recipes', auth, need('recipes.edit'), (req, res) => {
    const id = createRecipe(ctx.db, iso(), actorOf(req.user), req.body);
    res.status(201).json({ id });
  });
  api.put('/recipes/:id', auth, need('recipes.edit'), (req, res) => {
    const basedOn = req.body?.based_on_version ?? null;
    res.json(updateRecipe(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body, basedOn));
  });
  api.post('/recipes/:id/archive', auth, need('recipes.edit'), (req, res) => { setArchived(ctx.db, iso(), actorOf(req.user), intId(req.params.id), true); res.json({ ok: true }); });
  api.post('/recipes/:id/unarchive', auth, need('recipes.edit'), (req, res) => { setArchived(ctx.db, iso(), actorOf(req.user), intId(req.params.id), false); res.json({ ok: true }); });
  api.post('/recipes/:id/duplicate', auth, need('recipes.edit'), (req, res) => res.status(201).json({ id: duplicateRecipe(ctx.db, iso(), actorOf(req.user), intId(req.params.id)) }));
  api.post('/recipes/:id/versions/:n/restore', auth, need('recipes.edit'), (req, res) => {
    res.json(restoreVersion(ctx.db, iso(), actorOf(req.user), intId(req.params.id), intId(req.params.n, 'Version')));
  });

  // ----- photos (recettes archivées comprises) -----
  api.post('/recipes/:id/photos', auth, need('recipes.edit'),
    express.raw({ type: 'application/octet-stream', limit: MAX_PHOTO_BYTES + 1024 }), wrap(async (req, res) => {
      const id = await addPhoto({ db: ctx.db, dataDir: ctx.dataDir, cloud: ctx.cloud }, iso(), actorOf(req.user), intId(req.params.id), req.body,
        typeof req.query.caption === 'string' ? req.query.caption : '');
      res.status(201).json({ id });
    }));
  api.get('/recipes/:id/photos/:photoId', auth, need('recipes.view'), wrap(async (req, res) => {
    const buf = await readPhoto({ db: ctx.db, dataDir: ctx.dataDir, cloud: ctx.cloud }, intId(req.params.id), intId(req.params.photoId));
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'Content-Length': String(buf.length) });
    res.end(buf);
  }));
  api.patch('/recipes/:id/photos/:photoId', auth, need('recipes.edit'), (req, res) => {
    setCaption(ctx.db, intId(req.params.id), intId(req.params.photoId), req.body?.caption);
    res.json({ ok: true });
  });
  api.delete('/recipes/:id/photos/:photoId', auth, need('recipes.edit'), (req, res) => {
    removePhoto(ctx.db, iso(), actorOf(req.user), intId(req.params.id), intId(req.params.photoId));
    res.json({ ok: true });
  });
}
