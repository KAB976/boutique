/**
 * Remise à zéro de fin de période de test : efface les VENTES et tout ce qui en dépend
 * (quarts, clôtures, mouvements de caisse, commandes cuisine, soldes et tampons des clients),
 * et en option les dépenses et le traiteur.
 * Ne touche JAMAIS : ingrédients, stock, recettes (et leur archive), articles, catégories, fournisseurs,
 * fiches clients (noms, téléphones, plafonds), comptes du personnel, réglages, promotions, journal d'audit.
 */
import { bad } from './errors.js';
import { tx } from './db.js';
import { writeAudit } from './audit.js';
import { confirmPin } from './shifts.js';

export const PHRASE = 'REMETTRE A ZERO';

// Ordre : les tables « enfants » d'abord.
const CORE = ['cash_reviews', 'order_lines', 'orders', 'sale_lines', 'payments', 'loyalty_moves', 'customer_ledger', 'sales', 'closures', 'shifts', 'cash_moves'];
const EXPENSES = ['expenses'];
const CATERING = ['catering_payments', 'catering_lines', 'catering_orders'];

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const n = (db, sql) => db.prepare(sql).get().n;

export function tablesFor(opts = {}) {
  return [...CORE, ...(opts.expenses ? EXPENSES : []), ...(opts.catering ? CATERING : [])];
}

/** Ce qui va être effacé, pour l'afficher avant de confirmer. */
export function resetPreview(db) {
  const sales = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents FROM sales").get();
  const debt = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(b),0) AS cents FROM (SELECT SUM(amount_cents) AS b FROM customer_ledger GROUP BY customer_id HAVING SUM(amount_cents) <> 0)`).get();
  return {
    sales: sales.n, sales_cents: sales.cents,
    closures: n(db, 'SELECT COUNT(*) AS n FROM closures'), shifts: n(db, 'SELECT COUNT(*) AS n FROM shifts'),
    cash_moves: n(db, 'SELECT COUNT(*) AS n FROM cash_moves'), orders: n(db, 'SELECT COUNT(*) AS n FROM orders'),
    customers_with_balance: debt.n, balances_cents: debt.cents,
    customers: n(db, 'SELECT COUNT(*) AS n FROM customers'), loyalty_moves: n(db, 'SELECT COUNT(*) AS n FROM loyalty_moves'),
    expenses: n(db, 'SELECT COUNT(*) AS n FROM expenses'), catering_orders: n(db, 'SELECT COUNT(*) AS n FROM catering_orders'),
    kept: { ingredients: n(db, 'SELECT COUNT(*) AS n FROM ingredients'), recipes: n(db, 'SELECT COUNT(*) AS n FROM recipes'), recipes_archived: n(db, 'SELECT COUNT(*) AS n FROM recipes WHERE archived = 1'), products: n(db, 'SELECT COUNT(*) AS n FROM products'), users: n(db, 'SELECT COUNT(*) AS n FROM users WHERE active = 1') },
  };
}

/** L'effacement lui-même (une seule transaction : tout ou rien). Les verrous « lecture seule » sont retirés puis remis à l'identique. */
export function wipe(db, opts = {}) {
  const tables = tablesFor(opts);
  const ph = tables.map(() => '?').join(',');
  const triggers = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${ph})`).all(...tables);
  db.exec('PRAGMA defer_foreign_keys = ON');
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  const counts = {};
  for (const t of tables) counts[t] = db.prepare(`DELETE FROM "${t}"`).run().changes;
  for (const t of triggers) db.exec(t.sql);
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${ph})`).run(...tables);
  // la numérotation repart de 1 (V…, Z-0001, Q-0001, C…)
  db.prepare("DELETE FROM counters WHERE name IN ('closure','shift') OR name LIKE 'sale:%' OR name LIKE 'refund:%' OR name LIKE 'order:%'").run();
  if (opts.catering) db.prepare("DELETE FROM counters WHERE name = 'catering'").run();
  return counts;
}

export function resetAll(ctx, actor, user, body, { makeBackup, iso }) {
  const { db } = ctx;
  if (norm(body?.phrase) !== PHRASE) throw bad(`Pour confirmer, écrivez exactement : ${PHRASE}`, 'phrase');
  confirmPin(ctx, user, body?.pin);
  const opts = { expenses: Boolean(body?.expenses), catering: Boolean(body?.catering) };
  const before = resetPreview(db);
  const { backup } = makeBackup('avant-restauration', actor, { raison: 'remise à zéro' }); // copie de sécurité AVANT d'effacer
  const counts = tx(db, () => {
    const c = wipe(db, opts);
    writeAudit(db, iso(), actor, 'data.reset', { entity: 'data', entityId: 'reset', detail: { ventes: before.sales, chiffre_affaires_cents: before.sales_cents, clotures: before.closures, quarts: before.shifts, soldes_clients: before.customers_with_balance, depenses_effacees: opts.expenses, traiteur_efface: opts.catering, sauvegarde: backup.name } });
    return c;
  });
  return { ok: true, backup: backup.name, counts, before };
}

export function registerReset({ api, ctx, auth, need, iso, actorOf, makeBackup }) {
  api.get('/reset/preview', auth, need('data.reset'), (req, res) => res.json(resetPreview(ctx.db)));
  api.post('/reset', auth, need('data.reset'), (req, res) => res.json(resetAll(ctx, actorOf(req.user), req.user, req.body ?? {}, { makeBackup, iso })));
}
