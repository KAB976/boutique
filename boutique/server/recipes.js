import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from './db.js';
import { bad, conflict, notFound, HttpError } from './errors.js';
import { writeAudit } from './audit.js';
import { loadIngredient, loadMeasures, convertOrThrow, stateOf, unitLabel, shoppingCalc } from './stock.js';
import { fmtBase, round6, nameKey } from '../shared/units.js';

export const MAX_LINES = 60;
export const MAX_PHOTOS = 8;
export const MAX_PHOTO_BYTES = 700_000;
const MAX_SERVINGS = 100_000;
const nfq = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

// ---------- validation ----------

function num(v, label, { min = null, max = null, exclusiveMin = false, nullable = false, integer = false } = {}) {
  if (v === null || v === undefined || v === '') { if (nullable) return null; throw bad(`${label} : une valeur est nécessaire.`); }
  const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(`${label} doit être un nombre.`);
  if (integer && !Number.isInteger(n)) throw bad(`${label} doit être un nombre entier.`);
  if (exclusiveMin ? n <= min : min != null && n < min) throw bad(`${label} doit être ${exclusiveMin ? 'supérieur à' : 'au moins'} ${min}.`);
  if (max != null && n > max) throw bad(`${label} ne peut pas dépasser ${max}.`);
  return n;
}
const text = (v, label, max, { required = false } = {}) => {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${label} doit être du texte.`);
  const t = v.replace(/\r\n/g, '\n').trim();
  if (required && !t) throw bad(`${label} est obligatoire.`);
  if (t.length > max) throw bad(`${label} : ${max} caractères au maximum.`);
  return t;
};

/** Valide le corps d'une recette et convertit chaque ligne dans l'unité de base de l'ingrédient. */
export function cleanBody(db, b) {
  if (!b || typeof b !== 'object') throw bad('Recette illisible.');
  if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Ajoutez au moins un ingrédient à la recette.');
  if (b.lines.length > MAX_LINES) throw bad(`Une recette ne peut pas dépasser ${MAX_LINES} lignes.`);
  const out = {
    name: text(b.name, 'Le nom', 80, { required: true }),
    category: text(b.category, 'La catégorie', 40),
    servings: num(b.servings, 'Le nombre de personnes', { min: 0, exclusiveMin: true, max: MAX_SERVINGS }),
    prepMin: num(b.prep_min, 'La préparation (minutes)', { min: 0, max: 10000, nullable: true, integer: true }),
    cookMin: num(b.cook_min, 'La cuisson (minutes)', { min: 0, max: 10000, nullable: true, integer: true }),
    steps: text(b.steps, 'Les étapes', 8000),
    notes: text(b.notes, 'Les notes', 2000),
    changeNote: text(b.change_note, 'La note de modification', 200),
    lines: [],
  };
  const listed = db.prepare('SELECT name FROM ingredients WHERE active = 1').all();
  b.lines.forEach((l, i) => {
    const where = `Ligne ${i + 1}`;
    if (!l || typeof l !== 'object') throw bad(`${where} : illisible.`);
    const note = text(l.note, `${where} : la remarque`, 120);
    if (l.ingredient_id === null || l.ingredient_id === undefined || l.ingredient_id === '' || Number.isNaN(l.ingredient_id)) {
      // ingrédient pas encore dans la liste : nom et unité libres (« à créer » plus tard dans Stock)
      const label = text(l.label, `${where} : le nom de l'ingrédient`, 80, { required: true });
      const unit = text(l.unit, `${where} : l'unité`, 30);
      const qty = num(l.qty, `${where} (${label}) : la quantité`, { min: 0, exclusiveMin: true, max: 1e9 });
      if (listed.some((r) => nameKey(r.name) === nameKey(label))) {
        throw bad(`${where} : « ${label} » est déjà dans vos ingrédients : choisissez-le dans la liste pour que le stock et le coût soient calculés.`, 'already_listed');
      }
      out.lines.push({ ingredient_id: null, label, qty, unit, base: null, note });
      return;
    }
    const ing = loadIngredient(db, Number(l.ingredient_id));
    if (!ing) throw bad(`${where} : ingrédient introuvable.`);
    if (!ing.active) throw bad(`${where} : « ${ing.name} » est archivé. Remplacez-le ou réactivez-le dans Stock.`, 'ingredient_archived');
    const qty = num(l.qty, `${where} (${ing.name}) : la quantité`, { min: 0, exclusiveMin: true });
    let conv;
    try { conv = convertOrThrow(db, ing, qty, String(l.unit || '')); } catch (e) { throw bad(`${where} : ${e.message}`, e.code || 'conversion'); }
    out.lines.push({ ingredient_id: ing.id, label: '', qty, unit: String(l.unit), base: conv.base, note });
  });
  return out;
}

const signature = (c) => JSON.stringify([c.servings, c.prepMin, c.cookMin, c.steps, c.notes, c.lines.map((l) => [l.ingredient_id, l.label || '', l.qty, l.unit, l.note])]);

// ---------- lecture ----------

/** « 7,5 pièces », « 5 tasse » : quantité saisie + libellé de l'unité (pluriel pour pièce et douzaine). */
export function enteredText(db, ing, measures, qty, unit) {
  let label = unitLabel(ing, measures, unit);
  if (qty > 1 && (unit === 'piece' || unit === 'douzaine')) label += 's';
  return `${nfq.format(round6(qty))} ${label}`;
}

/** Ligne dont l'ingrédient n'est pas (encore) dans la liste : quantité et unité en texte libre. */
export const freeText = (qty, unit) => `${nfq.format(round6(qty))}${unit ? ` ${unit}` : ''}`;

export function loadVersion(db, recipeId, n) {
  const v = n == null
    ? db.prepare('SELECT v.* FROM recipe_versions v JOIN recipes r ON r.current_version = v.id WHERE r.id = ?').get(recipeId)
    : db.prepare('SELECT * FROM recipe_versions WHERE recipe_id = ? AND version = ?').get(recipeId, n);
  if (!v) return null;
  v.lines = db.prepare('SELECT * FROM recipe_lines WHERE version_id = ? ORDER BY pos').all(v.id);
  return v;
}

export function contentOf(version) {
  return {
    servings: version.servings, prepMin: version.prep_min, cookMin: version.cook_min, steps: version.steps, notes: version.notes,
    lines: version.lines.map((l) => ({ ingredient_id: l.ingredient_id, label: l.label, qty: l.qty, unit: l.unit, base: l.base, note: l.note })),
  };
}

/** Coût d'une liste de lignes, au coût moyen pondéré actuel. Le rendement de l'ingrédient majore la quantité à sortir du stock. */
export function costLines(db, lines) {
  let total = 0, incomplete = false;
  const per = lines.map((l) => {
    if (l.ingredient_id == null) { incomplete = true; return { ingredient_id: null, gross: null, cost: null, priced: false, unlinked: true }; }
    const ing = loadIngredient(db, l.ingredient_id);
    const st = stateOf(db, l.ingredient_id);
    const gross = l.base / (ing.yieldPct / 100);
    const priced = st.hasMoves && st.avg > 0;
    if (priced) total += gross * st.avg; else incomplete = true;
    return { ingredient_id: l.ingredient_id, gross, cost: priced ? gross * st.avg : null, priced };
  });
  return { total, incomplete, per };
}

/** Quantités pour N personnes (+ achats en emballages entiers). Rien n'est écrit. */
export function scaleVersion(db, version, servings) {
  const factor = servings / version.servings;
  const measures = loadMeasures(db, { all: true });
  return {
    servings, baseServings: version.servings, factor: round6(factor),
    lines: version.lines.map((l) => {
      if (l.ingredient_id == null) {
        const text = freeText(l.qty * factor, l.unit);
        return {
          ingredient_id: null, unlinked: true, name: l.label, family: null, note: l.note, qty: round6(l.qty * factor), unit: l.unit,
          entered: text, base: null, baseText: text, gross: null, grossText: text, hasLoss: false, yieldPct: 100,
          shop: { unlinked: true, inStockText: '—', missing: null, missingText: text, toBuyText: text, packs: null, packLabel: null, leftoverText: null, enough: false },
        };
      }
      const ing = loadIngredient(db, l.ingredient_id);
      const base = round6(l.base * factor);
      const gross = round6(base / (ing.yieldPct / 100));
      const shop = shoppingCalc(db, ing, gross);
      return {
        ingredient_id: ing.id, name: ing.name, family: ing.family, note: l.note,
        qty: round6(l.qty * factor), unit: l.unit, entered: enteredText(db, ing, measures, l.qty * factor, l.unit),
        base, baseText: fmtBase(base, ing.family),
        gross, grossText: fmtBase(gross, ing.family), hasLoss: ing.yieldPct < 100, yieldPct: ing.yieldPct,
        shop: {
          inStockText: fmtBase(shop.inStock, ing.family), missing: shop.missing, missingText: fmtBase(shop.missing, ing.family),
          toBuyText: shop.missing > 0 ? fmtBase(shop.toBuyBase, ing.family) : null,
          packs: shop.packs, packLabel: shop.packLabel ?? null, leftoverText: shop.packs ? fmtBase(Math.max(0, shop.leftover), ing.family) : null,
          enough: shop.missing <= 1e-9,
        },
      };
    }),
  };
}

// ---------- écriture ----------

function insertVersion(db, ts, actor, recipeId, n, c) {
  const r = db.prepare(`INSERT INTO recipe_versions (recipe_id, version, ts, user_id, user_name, servings, prep_min, cook_min, steps, notes, change_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(recipeId, n, ts, actor?.id ?? null, actor?.name ?? null, c.servings, c.prepMin, c.cookMin, c.steps, c.notes, c.changeNote || '');
  const vid = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO recipe_lines (version_id, pos, ingredient_id, label, qty, unit, base, note) VALUES (?,?,?,?,?,?,?,?)');
  c.lines.forEach((l, i) => ins.run(vid, i, l.ingredient_id, l.label || '', l.qty, l.unit, l.base, l.note));
  return vid;
}

const nameTaken = (db, name, exceptId = 0) => db.prepare('SELECT id, name FROM recipes WHERE archived = 0 AND id <> ?').all(exceptId).find((r) => nameKey(r.name) === nameKey(name));
const clash = (name) => conflict(`Une recette « ${name} » existe déjà. Choisissez un autre nom.`, 'name_taken');

export function getRecipe(db, id) {
  const r = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!r) throw notFound('Recette introuvable.');
  return r;
}

export function createRecipe(db, ts, actor, body) {
  const c = cleanBody(db, body);
  return tx(db, () => {
    const archived = body.archived === true;
    if (!archived && nameTaken(db, c.name)) throw clash(c.name);
    const r = db.prepare('INSERT INTO recipes (name, category, archived, archived_at, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(c.name, c.category, archived ? 1 : 0, archived ? ts : null, ts, ts);
    const id = Number(r.lastInsertRowid);
    const vid = insertVersion(db, ts, actor, id, 1, { ...c, changeNote: c.changeNote || 'Création' });
    db.prepare('UPDATE recipes SET current_version = ? WHERE id = ?').run(vid, id);
    writeAudit(db, ts, actor, 'recipe.create', { entity: 'recipe', entityId: String(id), detail: { name: c.name, lignes: c.lines.length, personnes: c.servings, archive: archived, ingredients_libres: c.lines.filter((l) => l.ingredient_id == null).length } });
    return id;
  });
}

export function updateRecipe(db, ts, actor, id, body, basedOn) {
  const c = cleanBody(db, body);
  return tx(db, () => {
    const rec = getRecipe(db, id);
    const cur = loadVersion(db, id, null);
    if (basedOn != null && Number(basedOn) !== cur.version) {
      throw conflict(`Cette recette a été modifiée entre-temps (version ${cur.version} par ${cur.user_name || 'quelqu\'un'}). Rouvrez-la pour voir ses changements.`, 'stale_version');
    }
    if (!rec.archived && nameKey(c.name) !== nameKey(rec.name) && nameTaken(db, c.name, id)) throw clash(c.name);
    const changes = [];
    if (c.name !== rec.name) changes.push('nom');
    if (c.category !== rec.category) changes.push('catégorie');
    const contentChanged = signature(c) !== signature({ ...contentOf(cur) });
    let version = cur.version;
    if (contentChanged) {
      version = cur.version + 1;
      const vid = insertVersion(db, ts, actor, id, version, c);
      db.prepare('UPDATE recipes SET current_version = ? WHERE id = ?').run(vid, id);
      changes.push('contenu');
    }
    if (!changes.length) return { unchanged: true, version };
    db.prepare('UPDATE recipes SET name = ?, category = ?, updated_at = ? WHERE id = ?').run(c.name, c.category, ts, id);
    writeAudit(db, ts, actor, 'recipe.update', { entity: 'recipe', entityId: String(id), detail: { name: c.name, version, changements: changes } });
    return { unchanged: false, version };
  });
}

/** Revient à une ancienne version en créant une NOUVELLE version identique (l'historique reste intact). */
export function restoreVersion(db, ts, actor, id, n) {
  return tx(db, () => {
    const rec = getRecipe(db, id);
    const old = loadVersion(db, id, n);
    if (!old) throw notFound('Version introuvable.');
    const cur = loadVersion(db, id, null);
    if (old.version === cur.version) throw bad('C\'est déjà la version en cours.');
    for (const l of old.lines.filter((x) => x.ingredient_id != null)) {
      const ing = loadIngredient(db, l.ingredient_id);
      if (!ing?.active) throw conflict(`« ${ing?.name ?? 'Un ingrédient'} » est archivé : impossible de revenir à cette version telle quelle.`, 'ingredient_archived');
    }
    const version = cur.version + 1;
    const vid = insertVersion(db, ts, actor, id, version, { ...contentOf(old), changeNote: `Retour à la version ${old.version}` });
    db.prepare('UPDATE recipes SET current_version = ?, updated_at = ? WHERE id = ?').run(vid, ts, id);
    writeAudit(db, ts, actor, 'recipe.restore_version', { entity: 'recipe', entityId: String(id), detail: { name: rec.name, depuis: old.version, version } });
    return { version };
  });
}

export function setArchived(db, ts, actor, id, archived) {
  return tx(db, () => {
    const rec = getRecipe(db, id);
    if (Boolean(rec.archived) === archived) throw bad(archived ? 'Cette recette est déjà archivée.' : 'Cette recette n\'est pas archivée.');
    if (!archived && nameTaken(db, rec.name, id)) throw conflict(`Une recette « ${rec.name} » existe déjà : renommez l'une des deux avant de restaurer.`, 'name_taken');
    db.prepare('UPDATE recipes SET archived = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, archived ? ts : null, ts, id);
    writeAudit(db, ts, actor, archived ? 'recipe.archive' : 'recipe.unarchive', { entity: 'recipe', entityId: String(id), detail: { name: rec.name } });
  });
}

export function duplicateRecipe(db, ts, actor, id) {
  return tx(db, () => {
    const rec = getRecipe(db, id);
    const cur = loadVersion(db, id, null);
    for (const l of cur.lines.filter((x) => x.ingredient_id != null)) {
      const ing = loadIngredient(db, l.ingredient_id);
      if (!ing?.active) throw conflict(`« ${ing?.name ?? 'Un ingrédient'} » est archivé : remplacez-le avant de dupliquer.`, 'ingredient_archived');
    }
    let name = `${rec.name} (copie)`;
    for (let i = 2; nameTaken(db, name); i += 1) name = `${rec.name} (copie ${i})`;
    const r = db.prepare('INSERT INTO recipes (name, category, created_at, updated_at) VALUES (?,?,?,?)').run(name, rec.category, ts, ts);
    const nid = Number(r.lastInsertRowid);
    const vid = insertVersion(db, ts, actor, nid, 1, { ...contentOf(cur), changeNote: `Copie de « ${rec.name} »` });
    db.prepare('UPDATE recipes SET current_version = ? WHERE id = ?').run(vid, nid);
    writeAudit(db, ts, actor, 'recipe.duplicate', { entity: 'recipe', entityId: String(nid), detail: { name, source: rec.name } });
    return nid;
  });
}

// ---------- photos ----------
// Les photos ne vont PAS dans la base (elle est recopiée en ligne à chaque modification) : un fichier par photo,
// nommé d'après son empreinte (donc jamais modifié), sur le disque ET dans Supabase.

const PHOTO_NAME = /^[0-9a-f]{64}\.jpg$/;
const photoDir = (dataDir) => path.join(dataDir, 'photos');

export function checkJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 200) throw bad('Aucune photo reçue.');
  if (buf.length > MAX_PHOTO_BYTES) throw bad(`Photo trop lourde (${Math.round(buf.length / 1024)} ko, maximum ${Math.round(MAX_PHOTO_BYTES / 1024)} ko). Elle est normalement réduite automatiquement.`, 'too_large');
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw bad('Ce fichier n\'est pas une photo JPEG.', 'not_jpeg');
}

export async function addPhoto({ db, dataDir, cloud }, ts, actor, recipeId, buf, caption = '') {
  checkJpeg(buf);
  const rec = getRecipe(db, recipeId); // les recettes archivées acceptent aussi des photos
  const cap = text(caption, 'La légende', 80);
  if (db.prepare('SELECT COUNT(*) AS n FROM recipe_photos WHERE recipe_id = ?').get(recipeId).n >= MAX_PHOTOS) {
    throw bad(`Maximum ${MAX_PHOTOS} photos par recette. Supprimez-en une avant d'en ajouter.`, 'too_many');
  }
  const file = `${crypto.createHash('sha256').update(buf).digest('hex')}.jpg`;
  fs.mkdirSync(photoDir(dataDir), { recursive: true });
  const dest = path.join(photoDir(dataDir), file);
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, dest);
  }
  if (cloud) {
    try { await cloud.putPhoto(file, buf); }
    catch (e) { throw new HttpError(503, 'cloud_unavailable', `La photo n'a pas pu être enregistrée en ligne (${e.message}). Rien n'a été ajouté : réessayez dans un instant.`); }
  }
  return tx(db, () => {
    const pos = db.prepare('SELECT COALESCE(MAX(pos), -1) + 1 AS p FROM recipe_photos WHERE recipe_id = ?').get(recipeId).p;
    const r = db.prepare('INSERT INTO recipe_photos (recipe_id, file, bytes, caption, pos, created_at, user_name) VALUES (?,?,?,?,?,?,?)')
      .run(recipeId, file, buf.length, cap, pos, ts, actor?.name ?? null);
    writeAudit(db, ts, actor, 'recipe.photo_add', { entity: 'recipe', entityId: String(recipeId), detail: { name: rec.name, ko: Math.round(buf.length / 1024), archivee: Boolean(rec.archived) } });
    return Number(r.lastInsertRowid);
  });
}

export function removePhoto(db, ts, actor, recipeId, photoId) {
  return tx(db, () => {
    const rec = getRecipe(db, recipeId);
    const p = db.prepare('SELECT id FROM recipe_photos WHERE id = ? AND recipe_id = ?').get(photoId, recipeId);
    if (!p) throw notFound('Photo introuvable.');
    db.prepare('DELETE FROM recipe_photos WHERE id = ?').run(photoId);
    writeAudit(db, ts, actor, 'recipe.photo_remove', { entity: 'recipe', entityId: String(recipeId), detail: { name: rec.name } });
  });
}

export function setCaption(db, recipeId, photoId, caption) {
  const cap = text(caption, 'La légende', 80);
  const r = db.prepare('UPDATE recipe_photos SET caption = ? WHERE id = ? AND recipe_id = ?').run(cap, photoId, recipeId);
  if (!r.changes) throw notFound('Photo introuvable.');
}

/** Octets d'une photo : disque d'abord, sinon rapatriée depuis Supabase (le disque du serveur gratuit s'efface). */
export async function readPhoto({ db, dataDir, cloud }, recipeId, photoId) {
  const p = db.prepare('SELECT file FROM recipe_photos WHERE id = ? AND recipe_id = ?').get(photoId, recipeId);
  if (!p || !PHOTO_NAME.test(p.file)) throw notFound('Photo introuvable.');
  const local = path.join(photoDir(dataDir), p.file);
  if (fs.existsSync(local)) return fs.readFileSync(local);
  if (!cloud) throw notFound('Le fichier de cette photo est introuvable.');
  let buf;
  try { buf = await cloud.getPhoto(p.file); } catch (e) { throw new HttpError(503, 'cloud_unavailable', `Photo indisponible pour l'instant (${e.message}).`); }
  fs.mkdirSync(photoDir(dataDir), { recursive: true });
  const tmp = `${local}.${crypto.randomBytes(4).toString('hex')}.part`;
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, local);
  return buf;
}
