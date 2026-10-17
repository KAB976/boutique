import { dateStr } from './common.js';
import { stateOf } from './stock.js';
import { batchBalance, unitCost } from './products.js';
import { balanceOf as custBal } from './customers.js';
import { balanceOf as supBal } from './suppliers.js';
import { dayIn } from './backup.js';
import { bad } from './errors.js';

const WD = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const e2 = (x) => Math.round(x * 100) / 100;

/** Rapport d'une période [from, to] (jours du commerce). Toutes les sommes d'argent des ventes sont en centimes ; les coûts en euros (réels). */
export function report(db, tz, { from, to }) {
  dateStr(from, 'Début'); dateStr(to, 'Fin');
  if (to < from) throw bad('La date de fin est avant la date de début.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 800) throw bad('Période trop longue (2 ans au maximum).');
  const dayOf = (() => { const f = new Map(); return (ts) => { let d = f.get(ts); if (!d) { d = dayIn(new Date(ts), tz); f.set(ts, d); } return d; }; })();
  const hourOf = (ts) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ts)));
  const wdOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
  const pad = (iso, d) => new Date(Date.parse(iso) + d * 86400000).toISOString();
  const lo = pad(`${from}T00:00:00Z`, -1), hi = pad(`${to}T23:59:59Z`, 1); // bornes larges, affinées par le jour local
  const inRange = (day) => day >= from && day <= to;

  // ----- ventes -----
  const sales = db.prepare('SELECT * FROM sales WHERE day BETWEEN ? AND ? ORDER BY id').all(from, to);
  const sold = sales.filter((s) => s.kind === 'sale');
  const sum = (a, k) => a.reduce((t, x) => t + x[k], 0);
  const revenue = sum(sales, 'total_cents'), vat = sum(sales, 'vat_cents'), cost = sum(sales, 'cost');
  const marginSales = (revenue - vat) / 100 - cost;
  const byDay = {}, byHour = Array.from({ length: 24 }, () => ({ count: 0, cents: 0 })), byWd = WD.map((name) => ({ name, count: 0, cents: 0 })), byUser = {};
  for (const s of sales) {
    (byDay[s.day] ||= { day: s.day, count: 0, cents: 0, cost: 0 });
    byDay[s.day].cents += s.total_cents; byDay[s.day].cost += s.cost; if (s.kind === 'sale') byDay[s.day].count += 1;
    if (s.kind === 'sale') {
      const h = hourOf(s.ts); byHour[h].count += 1; byHour[h].cents += s.total_cents;
      const w = byWd[wdOf(s.day)]; w.count += 1; w.cents += s.total_cents;
    }
    const u = (byUser[s.user_name ?? '—'] ||= { name: s.user_name ?? '—', count: 0, cents: 0, refunds: 0 });
    u.cents += s.total_cents; if (s.kind === 'sale') u.count += 1; else u.refunds += 1;
  }
  const byMethod = db.prepare('SELECT p.method, SUM(p.amount_cents) AS cents FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.day BETWEEN ? AND ? GROUP BY p.method').all(from, to);
  const products = db.prepare(`SELECT l.product_id, l.name, SUM(l.qty) AS qty, SUM(l.total_cents) AS cents, SUM(l.cost) AS cost, SUM(l.discount_cents) AS discount FROM sale_lines l JOIN sales s ON s.id = l.sale_id
    WHERE s.day BETWEEN ? AND ? GROUP BY l.product_id, l.name ORDER BY cents DESC`).all(from, to)
    .map((r) => ({ ...r, margin: e2(r.cents / 100 - r.cost) }));

  // ----- traiteur (comptabilisé le jour de l'événement, une fois livré) -----
  const cat = db.prepare("SELECT * FROM catering_orders WHERE status = 'delivered' AND event_date BETWEEN ? AND ?").all(from, to).map((o) => {
    const prod = db.prepare('SELECT COALESCE(SUM(cost_total),0) AS c, COUNT(*) AS n FROM productions WHERE order_id = ? AND voided_at IS NULL').get(o.id);
    return { number: o.number, event_date: o.event_date, contact: o.contact_name, total_cents: o.total_cents, cost: prod.n ? prod.c : o.est_cost, costSource: prod.n ? 'réel' : 'estimé' };
  });
  const cateringRevenue = sum(cat, 'total_cents'), cateringCost = sum(cat, 'cost');

  // ----- dépenses, pertes, achats -----
  const expenses = db.prepare('SELECT * FROM expenses WHERE day BETWEEN ? AND ? AND voided_at IS NULL ORDER BY id').all(from, to);
  const expByCat = {};
  for (const x of expenses) expByCat[x.category] = (expByCat[x.category] ?? 0) + x.amount_cents;
  const stockRows = db.prepare('SELECT m.*, i.name AS ing FROM stock_moves m JOIN ingredients i ON i.id = m.ingredient_id WHERE m.ts BETWEEN ? AND ? ORDER BY m.id').all(lo, hi).filter((m) => inRange(dayOf(m.ts)));
  const losses = [];
  let purchases = 0;
  for (const m of stockRows) {
    if (m.type === 'loss') losses.push({ day: dayOf(m.ts), what: m.ing, kind: 'Ingrédient', reason: m.reason, qty: -m.qty, value: -m.value });
    if (m.type === 'inventory' && m.qty < 0) losses.push({ day: dayOf(m.ts), what: m.ing, kind: 'Écart d’inventaire', reason: 'inventaire', qty: -m.qty, value: -m.value });
    if (m.type === 'inventory' && m.qty > 0) losses.push({ day: dayOf(m.ts), what: m.ing, kind: 'Écart d’inventaire (gain)', reason: 'inventaire', qty: -m.qty, value: -m.value });
    if (m.type === 'receipt') purchases += m.value;
  }
  const batchRows = db.prepare(`SELECT b.*, p.name AS pname FROM batch_moves b JOIN products p ON p.id = b.product_id WHERE b.ts BETWEEN ? AND ? AND b.type IN ('loss','adjust') ORDER BY b.id`).all(lo, hi).filter((m) => inRange(dayOf(m.ts)));
  for (const m of batchRows) if (m.qty < 0 || m.type === 'adjust') losses.push({ day: dayOf(m.ts), what: m.pname, kind: m.type === 'loss' ? 'Article préparé' : 'Comptage d’articles préparés', reason: m.reason, qty: -m.qty, value: -m.qty * m.unit_cost });
  const lossValue = losses.reduce((a, l) => a + l.value, 0);
  const expensesCents = sum(expenses, 'amount_cents');

  const prod = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_total),0) AS c FROM productions WHERE day BETWEEN ? AND ? AND voided_at IS NULL').get(from, to);

  const profit = marginSales + (cateringRevenue / 100 - cateringCost) - expensesCents / 100 - lossValue;

  // ----- situation à ce jour (indépendante de la période) -----
  const ings = db.prepare('SELECT id FROM ingredients WHERE active = 1').all();
  let stockValue = 0;
  for (const i of ings) { const st = stateOf(db, i.id); if (st.stock > 0) stockValue += st.stock * st.avg; }
  let batchValue = 0;
  for (const p of db.prepare("SELECT * FROM products WHERE kind = 'made'").all()) { const b = batchBalance(db, p.id); if (b > 0) batchValue += b * (unitCost(db, p).cost ?? 0); }
  const customers = db.prepare('SELECT id, name FROM customers').all().map((c) => ({ ...c, balance_cents: custBal(db, c.id) })).filter((c) => c.balance_cents !== 0).sort((a, b) => b.balance_cents - a.balance_cents);
  const suppliers = db.prepare('SELECT id, name FROM suppliers').all().map((s) => ({ ...s, balance_cents: supBal(db, s.id) })).filter((s) => s.balance_cents !== 0).sort((a, b) => b.balance_cents - a.balance_cents);

  return {
    from, to,
    sales: {
      count: sold.length, refunds: sales.length - sold.length, revenue_cents: revenue, vat_cents: vat, ht_cents: revenue - vat, discount_cents: sum(sales, 'discount_cents'), cost: e2(cost), margin: e2(marginSales),
      margin_pct: revenue - vat > 0 ? Math.round((marginSales / ((revenue - vat) / 100)) * 1000) / 10 : null, average_cents: sold.length ? Math.round(sum(sold, 'total_cents') / sold.length) : 0,
      offline: sold.filter((s) => s.offline).length,
    },
    catering: { count: cat.length, revenue_cents: cateringRevenue, cost: e2(cateringCost), margin: e2(cateringRevenue / 100 - cateringCost), orders: cat },
    expenses: { total_cents: expensesCents, by_category: Object.entries(expByCat).map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents), items: expenses },
    losses: { value: e2(lossValue), items: losses },
    purchases: e2(purchases), production: { count: prod.n, cost: e2(prod.c) },
    profit: e2(profit),
    by_day: Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({ ...d, cost: e2(d.cost) })),
    by_hour: byHour.map((h, hour) => ({ hour, ...h })).filter((h) => h.count),
    by_weekday: byWd, by_method: byMethod, by_user: Object.values(byUser), products,
    now: { stock_value: e2(stockValue), batch_value: e2(batchValue), customers, customers_total_cents: sum(customers, 'balance_cents'), suppliers, suppliers_total_cents: sum(suppliers, 'balance_cents') },
    sales_list: sales,
  };
}

const eur = (c) => ({ v: c / 100, fmt: 'money' });
export function reportSheets(r, shop) {
  const H = (...a) => a.map((v) => ({ v, bold: true }));
  const summary = [
    [{ v: `${shop} — rapport du ${r.from} au ${r.to}`, bold: true }], [],
    H('Ventes', ''), ['Nombre de ventes', { v: r.sales.count, fmt: 'int' }], ['Annulations', { v: r.sales.refunds, fmt: 'int' }], ['Chiffre d’affaires TTC', eur(r.sales.revenue_cents)], ['dont TVA', eur(r.sales.vat_cents)],
    ['Chiffre d’affaires HT', eur(r.sales.ht_cents)], ['Remises accordées', eur(r.sales.discount_cents)], ['Coût des articles vendus', { v: r.sales.cost, fmt: 'money' }], ['Marge sur ventes', { v: r.sales.margin, fmt: 'money' }], [],
    H('Traiteur', ''), ['Commandes livrées', { v: r.catering.count, fmt: 'int' }], ['Chiffre d’affaires', eur(r.catering.revenue_cents)], ['Coût', { v: r.catering.cost, fmt: 'money' }], ['Marge', { v: r.catering.margin, fmt: 'money' }], [],
    H('Charges', ''), ['Dépenses', eur(r.expenses.total_cents)], ['Pertes et écarts de stock', { v: r.losses.value, fmt: 'money' }], ['Achats d’ingrédients (information)', { v: r.purchases, fmt: 'money' }], [],
    [{ v: 'RÉSULTAT RÉEL DE LA PÉRIODE', bold: true }, { v: r.profit, fmt: 'money', bold: true }], [],
    H('Situation à ce jour', ''), ['Valeur du stock d’ingrédients', { v: r.now.stock_value, fmt: 'money' }], ['Valeur des articles préparés en stock', { v: r.now.batch_value, fmt: 'money' }], ['Ardoises clients à encaisser', eur(r.now.customers_total_cents)], ['Dettes fournisseurs', eur(r.now.suppliers_total_cents)],
  ];
  return [
    { name: 'Résumé', rows: summary, widths: [46, 18] },
    { name: 'Par jour', rows: [H('Jour', 'Ventes', 'Chiffre d’affaires', 'Coût'), ...r.by_day.map((d) => [d.day, { v: d.count, fmt: 'int' }, eur(d.cents), { v: d.cost, fmt: 'money' }])], widths: [14, 10, 18, 14] },
    { name: 'Articles', rows: [H('Article', 'Quantité', 'Chiffre d’affaires', 'Coût', 'Marge', 'Remises'), ...r.products.map((p) => [p.name, p.qty, eur(p.cents), { v: e2(p.cost), fmt: 'money' }, { v: p.margin, fmt: 'money' }, eur(p.discount)])], widths: [30, 10, 18, 14, 14, 14] },
    { name: 'Ventes', rows: [H('Numéro', 'Date', 'Type', 'Vendeur', 'Total TTC', 'TVA', 'Remise', 'Coût', 'Hors-ligne'), ...r.sales_list.map((s) => [s.number, s.ts, s.kind === 'sale' ? 'Vente' : 'Annulation', s.user_name ?? '', eur(s.total_cents), eur(s.vat_cents), eur(s.discount_cents), { v: e2(s.cost), fmt: 'money' }, s.offline ? 'oui' : ''])], widths: [18, 26, 12, 16, 14, 12, 12, 12, 11] },
    { name: 'Dépenses', rows: [H('Jour', 'Catégorie', 'Libellé', 'Montant'), ...r.expenses.items.map((x) => [x.day, x.category, x.label, eur(x.amount_cents)])], widths: [14, 22, 40, 14] },
    { name: 'Pertes', rows: [H('Jour', 'Quoi', 'Nature', 'Motif', 'Valeur'), ...r.losses.items.map((l) => [l.day, l.what, l.kind, l.reason ?? '', { v: e2(l.value), fmt: 'money' }])], widths: [14, 28, 28, 18, 14] },
    { name: 'Traiteur', rows: [H('Commande', 'Date', 'Contact', 'Total', 'Coût', 'Coût (source)'), ...r.catering.orders.map((o) => [o.number, o.event_date, o.contact, eur(o.total_cents), { v: e2(o.cost), fmt: 'money' }, o.costSource])], widths: [14, 14, 26, 14, 14, 14] },
    { name: 'Ardoises', rows: [H('Client', 'Doit'), ...r.now.customers.map((c) => [c.name, eur(c.balance_cents)])], widths: [30, 14] },
    { name: 'Fournisseurs', rows: [H('Fournisseur', 'Solde dû'), ...r.now.suppliers.map((c) => [c.name, eur(c.balance_cents)])], widths: [30, 14] },
  ];
}
