import { bad, conflict } from './errors.js';
import { tx } from './db.js';
import { writeAudit } from './audit.js';

const KINDS = {
  ingredient: { table: 'ingredients', label: 'ingrédients' },
  recipe: { table: 'recipes', label: 'recettes' },
  product: { table: 'products', label: 'articles de la caisse' },
};
const collator = new Intl.Collator('fr', { sensitivity: 'base' });

const kindOf = (k) => { if (!KINDS[k]) throw bad('Type de catégorie inconnu.'); return k; };
function cleanName(v) {
  if (typeof v !== 'string') throw bad('Le nom de la catégorie doit être un texte.');
  const t = v.trim().replace(/\s+/g, ' ');
  if (!t) throw bad('Le nom de la catégorie est obligatoire.');
  if (t.length > 40) throw bad('Le nom de la catégorie est trop long (40 caractères au maximum).');
  return t;
}
const usedCount = (db, kind, name) => {
  let n = db.prepare(`SELECT COUNT(*) AS n FROM ${KINDS[kind].table} WHERE lower(category) = lower(?)`).get(name).n;
  if (kind === 'product') n += db.prepare("SELECT COUNT(*) AS n FROM promotions WHERE scope = 'category' AND lower(category) = lower(?)").get(name).n;
  return n;
};

/** Liste d'un type : catégories enregistrées + celles déjà utilisées par des fiches (anciennes saisies libres). */
export function listCategories(db, kind) {
  kindOf(kind);
  const names = new Map(); // minuscule → nom
  for (const r of db.prepare('SELECT name FROM categories WHERE kind = ?').all(kind)) names.set(r.name.toLowerCase(), r.name);
  for (const r of db.prepare(`SELECT DISTINCT category AS name FROM ${KINDS[kind].table} WHERE category <> ''`).all()) if (!names.has(r.name.toLowerCase())) names.set(r.name.toLowerCase(), r.name);
  return [...names.values()].sort((a, b) => collator.compare(a, b)).map((name) => ({ name, count: usedCount(db, kind, name) }));
}
export const allCategories = (db) => Object.fromEntries(Object.keys(KINDS).map((k) => [k, listCategories(db, k)]));

export function addCategory(db, ts, actor, { kind, name }) {
  kindOf(kind); const n = cleanName(name);
  return tx(db, () => {
    if (listCategories(db, kind).some((c) => c.name.toLowerCase() === n.toLowerCase())) throw conflict(`La catégorie « ${n} » existe déjà.`, 'name_taken');
    db.prepare('INSERT INTO categories (kind, name) VALUES (?, ?)').run(kind, n);
    writeAudit(db, ts, actor, 'category.create', { entity: 'category', entityId: `${kind}:${n}`, detail: { type: KINDS[kind].label, name: n } });
    return { name: n };
  });
}

/** Renomme (ou fusionne avec une catégorie qui existe déjà) : toutes les fiches suivent. */
export function renameCategory(db, ts, actor, { kind, from, to }) {
  kindOf(kind); const a = cleanName(from); const b = cleanName(to);
  return tx(db, () => {
    const cur = listCategories(db, kind);
    const src = cur.find((c) => c.name.toLowerCase() === a.toLowerCase());
    if (!src) throw bad(`La catégorie « ${a} » n'existe pas.`);
    const merged = a.toLowerCase() !== b.toLowerCase() && cur.some((c) => c.name.toLowerCase() === b.toLowerCase());
    const target = merged ? cur.find((c) => c.name.toLowerCase() === b.toLowerCase()).name : b;
    const T = KINDS[kind].table;
    const upd = db.prepare(`UPDATE ${T} SET category = ?, updated_at = ? WHERE lower(category) = lower(?)`).run(target, ts, a).changes;
    if (kind === 'product') db.prepare("UPDATE promotions SET category = ? WHERE scope = 'category' AND lower(category) = lower(?)").run(target, a);
    db.prepare('DELETE FROM categories WHERE kind = ? AND lower(name) = lower(?)').run(kind, a);
    if (!db.prepare('SELECT 1 FROM categories WHERE kind = ? AND lower(name) = lower(?)').get(kind, target)) db.prepare('INSERT INTO categories (kind, name) VALUES (?, ?)').run(kind, target);
    else db.prepare('UPDATE categories SET name = ? WHERE kind = ? AND lower(name) = lower(?)').run(target, kind, target);
    writeAudit(db, ts, actor, 'category.rename', { entity: 'category', entityId: `${kind}:${a}`, detail: { type: KINDS[kind].label, from: a, to: target, fusion: merged, fiches: upd } });
    return { name: target, updated: upd, merged };
  });
}

/** Supprime une catégorie : seulement si plus rien ne l'utilise. */
export function deleteCategory(db, ts, actor, { kind, name }) {
  kindOf(kind); const n = cleanName(name);
  return tx(db, () => {
    const c = listCategories(db, kind).find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!c) throw bad(`La catégorie « ${n} » n'existe pas.`);
    if (c.count > 0) throw conflict(`« ${c.name} » est utilisée par ${c.count} élément${c.count > 1 ? 's' : ''} : changez-les de catégorie, ou renommez celle-ci.`, 'in_use');
    db.prepare('DELETE FROM categories WHERE kind = ? AND lower(name) = lower(?)').run(kind, n);
    writeAudit(db, ts, actor, 'category.delete', { entity: 'category', entityId: `${kind}:${n}`, detail: { type: KINDS[kind].label, name: c.name } });
    return { ok: true };
  });
}

export function registerCategories({ api, ctx, auth, need, iso, actorOf }) {
  api.get('/categories', auth, (req, res) => res.json(allCategories(ctx.db)));
  api.post('/categories', auth, need('categories.edit'), (req, res) => res.json(addCategory(ctx.db, iso(), actorOf(req.user), req.body ?? {})));
  api.post('/categories/rename', auth, need('categories.edit'), (req, res) => res.json(renameCategory(ctx.db, iso(), actorOf(req.user), req.body ?? {})));
  api.post('/categories/delete', auth, need('categories.edit'), (req, res) => res.json(deleteCategory(ctx.db, iso(), actorOf(req.user), req.body ?? {})));
}
