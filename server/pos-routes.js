import { can } from './permissions.js';
import { bad, notFound, forbidden } from './errors.js';
import { getSetting } from './settings.js';
import { dayIn } from './backup.js';
import { atOf, isActiveAt } from '../shared/promo.js';
import { wrap, intId, dateStr } from './common.js';
import { loadMeasures, loadIngredient, stateOf, unitOptions } from './stock.js';
import { fmtBase } from '../shared/units.js';
import { createProduct, updateProduct, unitCost, available, batchBalance, KINDS } from './products.js';
import { planProduction, produce, voidProduction, batchLoss, batchCount, BATCH_LOSS_REASONS } from './production.js';
import { createSale, syncSales, refundSale, saleView, cashMove, closurePreview, closeCash, closureView, lastClosure, METHOD_LABELS } from './sales.js';
import { createCustomer, updateCustomer, receivePayment, adjustLedger, adjustStamps, balanceOf as custBal, stampsOf } from './customers.js';
import { createPromo, updatePromo, setLoyalty, TYPES as PROMO_TYPES } from './promotions.js';
import * as sup from './suppliers.js';
import * as cat from './catering.js';
import { createExpense, voidExpense, EXPENSE_CATEGORIES } from './expenses.js';
import { report, reportSheets } from './reports.js';
import { buildXlsx } from './xlsx.js';

export function registerPos({ api, ctx, auth, need, iso, actorOf }) {
  const db = () => ctx.db;
  ctx.tz = () => getSetting(ctx.db, 'timezone');
  const today = () => dayIn(ctx.now(), ctx.tz());
  const costsOk = (role) => can(role, 'costs.view');

  // ---------- catalogue (caisse) ----------
  const productRow = (p, role) => {
    const o = {
      id: p.id, name: p.name, category: p.category, kind: p.kind, kindLabel: KINDS[p.kind], price_cents: p.price_cents, vat_pct: p.vat_pct, sort: p.sort, active: Boolean(p.active),
      to_kitchen: Boolean(p.to_kitchen), recipe_id: p.recipe_id, portions: p.portions, ingredient_id: p.ingredient_id, ingredient_qty: p.ingredient_qty, available: available(ctx.db, p),
    };
    if (p.recipe_id) { const r = ctx.db.prepare('SELECT name, archived FROM recipes WHERE id = ?').get(p.recipe_id); o.recipe_name = r?.name; o.recipe_archived = Boolean(r?.archived); }
    if (p.ingredient_id) o.ingredient_name = loadIngredient(ctx.db, p.ingredient_id)?.name;
    if (costsOk(role)) {
      const c = unitCost(ctx.db, p);
      o.cost = c.cost; o.cost_incomplete = c.incomplete; o.cost_source = c.source;
      o.margin_cents = c.cost == null ? null : Math.round(p.price_cents - vatShare(p) - c.cost * 100);
    }
    return o;
  };
  const vatShare = (p) => (p.vat_pct > 0 ? Math.round((p.price_cents * p.vat_pct) / (100 + p.vat_pct)) : 0);

  api.get('/catalog', auth, need('catalog.view'), (req, res) => {
    const at = atOf(ctx.now(), ctx.tz());
    const products = ctx.db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, lower(category), lower(name)').all();
    res.json({
      products: products.map((p) => { const r = productRow(p, 'cashier'); delete r.recipe_id; delete r.ingredient_id; delete r.ingredient_qty; delete r.portions; return r; }),
      categories: [...new Set(products.map((p) => p.category).filter(Boolean))],
      promotions: ctx.db.prepare('SELECT * FROM promotions WHERE active = 1').all(),
      loyalty: ctx.db.prepare('SELECT enabled, spend_cents_per_stamp, stamps_needed, reward_cents FROM loyalty_program WHERE id = 1').get(),
      customers: can(req.user.role, 'customers.view') ? ctx.db.prepare('SELECT id, name, phone, credit_limit_cents FROM customers WHERE active = 1 ORDER BY lower(name)').all() : [],
      tz: ctx.tz(), today: at.day, serverTime: iso(), methods: METHOD_LABELS,
      canDiscount: can(req.user.role, 'promotions.manage'), canCredit: can(req.user.role, 'pos.sell'),
    });
  });

  // ---------- articles (gestion) ----------
  api.get('/products', auth, need('catalog.view'), (req, res) => {
    const all = req.query.all === '1' && can(req.user.role, 'products.edit');
    const rows = ctx.db.prepare(`SELECT * FROM products ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, sort, lower(category), lower(name)`).all();
    res.json({
      items: rows.map((p) => productRow(p, req.user.role)), kinds: KINDS, can: { edit: can(req.user.role, 'products.edit'), costs: costsOk(req.user.role) },
      recipes: can(req.user.role, 'products.edit') ? ctx.db.prepare('SELECT id, name, archived FROM recipes ORDER BY archived, lower(name)').all().map((r) => ({ ...r, archived: Boolean(r.archived) })) : [],
      ingredients: can(req.user.role, 'products.edit') ? ctx.db.prepare('SELECT id, name, family FROM ingredients WHERE active = 1 ORDER BY lower(name)').all() : [],
    });
  });
  api.post('/products', auth, need('products.edit'), (req, res) => res.status(201).json({ id: createProduct(ctx.db, iso(), actorOf(req.user), req.body) }));
  api.put('/products/:id', auth, need('products.edit'), (req, res) => res.json({ changes: updateProduct(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body) }));

  // ---------- production ----------
  api.get('/production/plan', auth, need('production.do'), (req, res) => {
    const servings = Number(String(req.query.servings ?? '').replace(',', '.'));
    if (!Number.isFinite(servings) || servings <= 0 || servings > 100000) throw bad('Le nombre de personnes doit être un nombre supérieur à zéro.');
    const plan = planProduction(ctx.db, intId(req.query.recipe_id, 'Recette'), servings);
    const products = ctx.db.prepare("SELECT id, name, portions FROM products WHERE kind = 'made' AND active = 1 AND recipe_id = ?").all(plan.recipe.id);
    if (!costsOk(req.user.role)) for (const l of plan.lines) { delete l.avg; delete l.priced; }
    else {
      plan.cost = plan.lines.reduce((s, l) => s + (l.avg ?? 0) * l.planned, 0);
      plan.cost_incomplete = plan.lines.some((l) => !l.priced) || plan.unlinked.length > 0;
    }
    res.json({ ...plan, products, defaultQty: products[0] ? servings * (products[0].portions ?? 1) : servings, canForce: can(req.user.role, 'purchasing.manage') });
  });
  api.post('/production', auth, need('production.do'), (req, res) => {
    const out = produce(ctx.db, iso(), today(), actorOf(req.user), req.body, { canForce: can(req.user.role, 'purchasing.manage') });
    if (!costsOk(req.user.role)) { delete out.cost_total; delete out.unit_cost; for (const l of out.lines) delete l.value; }
    res.status(201).json(out);
  });
  api.get('/productions', auth, need('production.do'), (req, res) => {
    const rows = ctx.db.prepare(`SELECT p.*, r.name AS recipe_name, pr.name AS product_name FROM productions p JOIN recipes r ON r.id = p.recipe_id LEFT JOIN products pr ON pr.id = p.product_id ORDER BY p.id DESC LIMIT ?`).all(Math.min(Number(req.query.limit) || 50, 200));
    const c = costsOk(req.user.role);
    res.json({ items: rows.map((p) => ({ ...p, ...(c ? {} : { cost_total: undefined, unit_cost: undefined }) })), can: { void: can(req.user.role, 'production.void'), costs: c } });
  });
  api.get('/productions/:id', auth, need('production.do'), (req, res) => {
    const p = ctx.db.prepare('SELECT p.*, r.name AS recipe_name FROM productions p JOIN recipes r ON r.id = p.recipe_id WHERE p.id = ?').get(intId(req.params.id));
    if (!p) throw notFound('Production introuvable.');
    const lines = ctx.db.prepare('SELECT l.*, i.name, i.family FROM production_lines l JOIN ingredients i ON i.id = l.ingredient_id WHERE l.production_id = ? ORDER BY l.pos').all(p.id)
      .map((l) => ({ ingredient_id: l.ingredient_id, name: l.name, plannedText: fmtBase(l.planned_base, l.family), usedText: fmtBase(l.used_base, l.family), differs: Math.abs(l.used_base - l.planned_base) > 1e-9, ...(costsOk(req.user.role) ? { value: l.value } : {}) }));
    if (!costsOk(req.user.role)) { delete p.cost_total; delete p.unit_cost; }
    res.json({ ...p, lines });
  });
  api.post('/productions/:id/void', auth, need('production.void'), (req, res) => { voidProduction(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body?.reason); res.json({ ok: true }); });

  api.get('/batches', auth, need('production.do'), (req, res) => {
    const c = costsOk(req.user.role);
    res.json({
      reasons: BATCH_LOSS_REASONS,
      items: ctx.db.prepare("SELECT * FROM products WHERE kind = 'made' AND active = 1 ORDER BY lower(name)").all().map((p) => {
        const bal = batchBalance(ctx.db, p.id);
        const last = ctx.db.prepare("SELECT ts FROM batch_moves WHERE product_id = ? AND type = 'produce' ORDER BY id DESC LIMIT 1").get(p.id);
        const uc = c ? unitCost(ctx.db, p).cost : undefined;
        return { id: p.id, name: p.name, category: p.category, balance: bal, last_produced: last?.ts ?? null, ...(c ? { unit_cost: uc, value: uc == null ? null : uc * Math.max(0, bal) } : {}) };
      }),
    });
  });
  api.post('/batches/loss', auth, need('production.do'), (req, res) => {
    const out = batchLoss(ctx.db, iso(), actorOf(req.user), req.body);
    if (!costsOk(req.user.role)) delete out.value;
    res.status(201).json(out);
  });
  api.post('/batches/count', auth, need('production.do'), (req, res) => res.json(batchCount(ctx.db, iso(), actorOf(req.user), req.body)));

  // ---------- ventes ----------
  const costStrip = (s, role) => {
    if (costsOk(role)) return s;
    const { cost, ...rest } = s;
    return { ...rest, lines: s.lines.map(({ cost: c, ...l }) => l) };
  };
  const salesView = (v, role) => costStrip(v, role);
  api.post('/sales', auth, need('pos.sell'), (req, res) => {
    const out = createSale(ctx, actorOf(req.user), { ...req.body, offline: false });
    res.status(out.duplicate ? 200 : 201).json({ duplicate: out.duplicate, sale: salesView(out.sale, req.user.role) });
  });
  api.post('/sales/sync', auth, need('sales.sync'), (req, res) => {
    if (!can(req.user.role, 'pos.sell')) throw forbidden();
    res.json({ results: syncSales(ctx, actorOf(req.user), req.body?.sales) });
  });
  api.get('/sales', auth, (req, res) => {
    const all = can(req.user.role, 'sales.view_all');
    if (!all && !can(req.user.role, 'sales.view_own')) throw forbidden();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const where = [], args = [];
    if (!all) { where.push('user_id = ?'); args.push(req.user.id); where.push('id > ?'); args.push(lastClosure(ctx.db)?.to_sale_id ?? 0); }
    if (req.query.day) { where.push('day = ?'); args.push(dateStr(req.query.day, 'Jour')); }
    if (req.query.customer_id) { where.push('customer_id = ?'); args.push(intId(req.query.customer_id)); }
    const rows = ctx.db.prepare(`SELECT * FROM sales ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit);
    const closed = lastClosure(ctx.db)?.to_sale_id ?? 0;
    res.json({ items: rows.map((s) => { const x = { ...s, flags: JSON.parse(s.flags), closed: s.id <= closed, refunded: s.kind === 'sale' && Boolean(ctx.db.prepare('SELECT 1 FROM sales WHERE refund_of = ?').get(s.id)) }; if (!costsOk(req.user.role)) delete x.cost; return x; }), scope: all ? 'all' : 'own', day: today() });
  });
  api.get('/sales/:id', auth, (req, res) => {
    const v = saleView(ctx.db, intId(req.params.id));
    if (!v) throw notFound('Vente introuvable.');
    if (!can(req.user.role, 'sales.view_all') && !(can(req.user.role, 'sales.view_own') && v.user_id === req.user.id)) throw forbidden();
    res.json(salesView(v, req.user.role));
  });
  api.post('/sales/:id/refund', auth, (req, res) => {
    if (!can(req.user.role, 'sales.void_own') && !can(req.user.role, 'sales.void_any')) throw forbidden();
    res.status(201).json(salesView(refundSale(ctx, actorOf(req.user), intId(req.params.id), req.body), req.user.role));
  });

  // ---------- caisse ----------
  api.get('/closure/preview', auth, need('closure.do'), (req, res) => {
    const pv = closurePreview(ctx.db);
    res.json({ ...pv, today: today(), cashier: !can(req.user.role, 'sales.view_all') });
  });
  api.post('/closure', auth, need('closure.do'), (req, res) => res.status(201).json(closeCash(ctx, actorOf(req.user), req.body)));
  api.get('/closures', auth, need('closure.do'), (req, res) => {
    res.json({ items: ctx.db.prepare('SELECT * FROM closures ORDER BY id DESC LIMIT 60').all().map((c) => ({ ...c, by_method: JSON.parse(c.by_method) })) });
  });
  api.get('/closures/:id', auth, need('closure.do'), (req, res) => { const c = closureView(ctx.db, intId(req.params.id)); if (!c) throw notFound('Clôture introuvable.'); res.json(c); });
  api.post('/cash-moves', auth, need('cash.move'), (req, res) => res.status(201).json(cashMove(ctx, actorOf(req.user), req.body)));

  // ---------- clients ----------
  const customerRow = (c) => ({ ...c, active: Boolean(c.active), balance_cents: custBal(ctx.db, c.id), stamps: stampsOf(ctx.db, c.id) });
  api.get('/customers', auth, need('customers.view'), (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const rows = ctx.db.prepare('SELECT * FROM customers ORDER BY active DESC, lower(name)').all().filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q)).map(customerRow);
    res.json({ items: req.query.owing === '1' ? rows.filter((c) => c.balance_cents > 0) : rows, can: { edit: can(req.user.role, 'customers.edit'), credit: can(req.user.role, 'customers.credit'), payment: can(req.user.role, 'customers.payment') }, loyalty: ctx.db.prepare('SELECT * FROM loyalty_program WHERE id = 1').get() });
  });
  api.post('/customers', auth, need('customers.edit'), (req, res) => res.status(201).json({ id: createCustomer(ctx.db, iso(), actorOf(req.user), req.body) }));
  api.put('/customers/:id', auth, need('customers.edit'), (req, res) => res.json({ changes: updateCustomer(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body, { canCredit: can(req.user.role, 'customers.credit') }) }));
  api.get('/customers/:id', auth, need('customers.view'), (req, res) => {
    const c = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(intId(req.params.id));
    if (!c) throw notFound('Client introuvable.');
    res.json({
      ...customerRow(c),
      ledger: ctx.db.prepare('SELECT l.*, s.number AS sale_number FROM customer_ledger l LEFT JOIN sales s ON s.id = l.sale_id WHERE l.customer_id = ? ORDER BY l.id DESC LIMIT 200').all(c.id),
      stamps_log: ctx.db.prepare('SELECT * FROM loyalty_moves WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(c.id),
      recent_sales: ctx.db.prepare("SELECT id, number, ts, total_cents, kind FROM sales WHERE customer_id = ? ORDER BY id DESC LIMIT 20").all(c.id),
    });
  });
  api.post('/customers/:id/payments', auth, need('customers.payment'), (req, res) => res.status(201).json(receivePayment(ctx.db, iso(), today(), actorOf(req.user), intId(req.params.id), req.body)));
  api.post('/customers/:id/adjust', auth, need('customers.credit'), (req, res) => res.json(adjustLedger(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body)));
  api.post('/customers/:id/stamps', auth, need('customers.credit'), (req, res) => res.json(adjustStamps(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body)));

  // ---------- promotions et fidélité ----------
  api.get('/promotions', auth, need('promotions.manage'), (req, res) => {
    const at = atOf(ctx.now(), ctx.tz());
    res.json({
      items: ctx.db.prepare('SELECT p.*, pr.name AS product_name FROM promotions p LEFT JOIN products pr ON pr.id = p.product_id ORDER BY p.active DESC, p.id DESC').all().map((p) => ({ ...p, active: Boolean(p.active), runningNow: isActiveAt(p, at) })),
      types: PROMO_TYPES, loyalty: ctx.db.prepare('SELECT * FROM loyalty_program WHERE id = 1').get(),
      products: ctx.db.prepare('SELECT id, name, category FROM products WHERE active = 1 ORDER BY lower(name)').all(),
      categories: [...new Set(ctx.db.prepare("SELECT category FROM products WHERE active = 1 AND category <> ''").all().map((r) => r.category))],
    });
  });
  api.post('/promotions', auth, need('promotions.manage'), (req, res) => res.status(201).json({ id: createPromo(ctx.db, iso(), actorOf(req.user), req.body) }));
  api.put('/promotions/:id', auth, need('promotions.manage'), (req, res) => res.json({ changes: updatePromo(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body) }));
  api.put('/loyalty', auth, need('promotions.manage'), (req, res) => res.json({ changes: setLoyalty(ctx.db, iso(), actorOf(req.user), req.body) }));

  // ---------- fournisseurs et bons de commande ----------
  const supRow = (s) => ({ ...s, active: Boolean(s.active), balance_cents: sup.balanceOf(ctx.db, s.id) });
  api.get('/suppliers', auth, need('purchasing.manage'), (req, res) => res.json({ items: ctx.db.prepare('SELECT * FROM suppliers ORDER BY active DESC, lower(name)').all().map(supRow) }));
  api.post('/suppliers', auth, need('purchasing.manage'), (req, res) => res.status(201).json({ id: sup.createSupplier(ctx.db, iso(), actorOf(req.user), req.body) }));
  api.put('/suppliers/:id', auth, need('purchasing.manage'), (req, res) => res.json({ changes: sup.updateSupplier(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body) }));
  api.get('/suppliers/:id', auth, need('purchasing.manage'), (req, res) => {
    const s = ctx.db.prepare('SELECT * FROM suppliers WHERE id = ?').get(intId(req.params.id));
    if (!s) throw notFound('Fournisseur introuvable.');
    res.json({ ...supRow(s), ledger: ctx.db.prepare('SELECT * FROM supplier_ledger WHERE supplier_id = ? ORDER BY id DESC LIMIT 200').all(s.id), orders: ctx.db.prepare('SELECT id, number, status, created_at FROM purchase_orders WHERE supplier_id = ? ORDER BY id DESC LIMIT 30').all(s.id) });
  });
  api.post('/suppliers/:id/payments', auth, need('purchasing.manage'), (req, res) => res.status(201).json(sup.paySupplier(ctx.db, iso(), today(), actorOf(req.user), intId(req.params.id), req.body)));
  api.post('/suppliers/:id/adjust', auth, need('purchasing.manage'), (req, res) => res.json(sup.adjustSupplier(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body)));

  const poView = (id) => {
    const po = ctx.db.prepare('SELECT o.*, s.name AS supplier_name FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ?').get(id);
    if (!po) return null;
    const measures = loadMeasures(ctx.db, { all: true });
    const lines = ctx.db.prepare('SELECT * FROM po_lines WHERE po_id = ? ORDER BY pos').all(id).map((l) => {
      const ing = loadIngredient(ctx.db, l.ingredient_id);
      const got = sup.receivedBase(ctx.db, l.id);
      const label = unitOptions(ing, measures).find((u) => u.code === l.unit)?.label ?? l.unit;
      return { ...l, name: ing.name, family: ing.family, unitLabel: label, ordered: `${l.qty} ${label}`, orderedBase: fmtBase(l.base, ing.family), receivedText: fmtBase(got, ing.family), received: got, left: Math.max(0, l.base - got), leftText: fmtBase(Math.max(0, l.base - got), ing.family), units: unitOptions(ing, measures) };
    });
    const receipts = ctx.db.prepare('SELECT * FROM po_receipts WHERE po_id = ? ORDER BY id').all(id);
    return { ...po, status_label: sup.PO_STATUS[po.status], lines, receipts, expected_cents: lines.reduce((a, l) => a + (l.expected_total_cents ?? 0), 0) };
  };
  api.get('/purchase-orders', auth, need('purchasing.manage'), (req, res) => {
    res.json({ items: ctx.db.prepare(`SELECT o.*, s.name AS supplier_name, (SELECT COUNT(*) FROM po_lines WHERE po_id = o.id) AS lines FROM purchase_orders o JOIN suppliers s ON s.id = o.supplier_id ORDER BY o.id DESC LIMIT 100`).all().map((o) => ({ ...o, status_label: sup.PO_STATUS[o.status] })), statuses: sup.PO_STATUS });
  });
  api.post('/purchase-orders', auth, need('purchasing.manage'), (req, res) => res.status(201).json({ id: sup.createPO(ctx.db, iso(), actorOf(req.user), req.body) }));
  api.get('/purchase-orders/:id', auth, need('purchasing.manage'), (req, res) => { const v = poView(intId(req.params.id)); if (!v) throw notFound('Bon de commande introuvable.'); res.json(v); });
  api.put('/purchase-orders/:id', auth, need('purchasing.manage'), (req, res) => { sup.updatePO(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body); res.json({ ok: true }); });
  api.post('/purchase-orders/:id/status', auth, need('purchasing.manage'), (req, res) => { sup.setPOStatus(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body?.status); res.json({ ok: true }); });
  api.post('/purchase-orders/:id/receive', auth, need('purchasing.manage'), (req, res) => res.status(201).json(sup.receivePO(ctx.db, iso(), today(), actorOf(req.user), intId(req.params.id), req.body)));

  // ---------- traiteur ----------
  const money = (role) => costsOk(role);
  const cateringStrip = (o, role) => {
    if (money(role)) return o;
    const lines = o.lines.map(({ unit_price_cents, total_cents, est_cost, ...l }) => l);
    const { discount_cents, total_cents, est_cost, paid_cents, balance_cents, payments, ...rest } = o;
    return { ...rest, lines };
  };
  api.get('/catering', auth, need('catering.view'), (req, res) => {
    const where = [], args = [];
    if (req.query.from) { where.push('event_date >= ?'); args.push(dateStr(req.query.from, 'Début')); }
    if (req.query.to) { where.push('event_date <= ?'); args.push(dateStr(req.query.to, 'Fin')); }
    if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
    const rows = ctx.db.prepare(`SELECT * FROM catering_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY event_date DESC, event_time DESC LIMIT 200`).all(...args)
      .map((o) => ({ ...o, status_label: cat.STATUS[o.status], paid_cents: cat.paidOf(ctx.db, o.id) }));
    res.json({
      items: rows.map((o) => (money(req.user.role) ? o : (({ total_cents, est_cost, discount_cents, paid_cents, ...r }) => r)(o))), statuses: cat.STATUS,
      can: { edit: can(req.user.role, 'catering.edit'), money: money(req.user.role) }, today: today(),
    });
  });
  api.get('/catering/shopping', auth, need('catering.view'), (req, res) => {
    const from = dateStr(req.query.from ?? today(), 'Début'), to = dateStr(req.query.to ?? from, 'Fin');
    res.json({ from, to, ...cat.shoppingList(ctx.db, { from, to }) });
  });
  api.get('/catering/:id', auth, need('catering.view'), (req, res) => { const v = cat.orderView(ctx.db, intId(req.params.id)); if (!v) throw notFound('Commande introuvable.'); res.json({ ...cateringStrip(v, req.user.role), can: { edit: can(req.user.role, 'catering.edit'), money: money(req.user.role) } }); });
  api.post('/catering', auth, need('catering.edit'), (req, res) => res.status(201).json({ id: cat.createOrder(ctx.db, iso(), actorOf(req.user), req.body) }));
  api.put('/catering/:id', auth, need('catering.edit'), (req, res) => { cat.updateOrder(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body); res.json({ ok: true }); });
  api.post('/catering/:id/status', auth, need('catering.edit'), (req, res) => { cat.setStatus(ctx.db, iso(), actorOf(req.user), intId(req.params.id), req.body?.status, req.body?.reason); res.json({ ok: true }); });
  api.post('/catering/:id/payments', auth, need('catering.edit'), (req, res) => res.status(201).json(cat.addPayment(ctx.db, iso(), today(), actorOf(req.user), intId(req.params.id), req.body)));

  // ---------- dépenses ----------
  api.get('/expenses', auth, need('expenses.manage'), (req, res) => {
    const from = dateStr(req.query.from ?? `${today().slice(0, 8)}01`, 'Début'), to = dateStr(req.query.to ?? today(), 'Fin');
    res.json({ items: ctx.db.prepare('SELECT * FROM expenses WHERE day BETWEEN ? AND ? ORDER BY id DESC').all(from, to), categories: EXPENSE_CATEGORIES, from, to });
  });
  api.post('/expenses', auth, need('expenses.manage'), (req, res) => res.status(201).json({ id: createExpense(ctx.db, iso(), today(), actorOf(req.user), req.body) }));
  api.post('/expenses/:id/void', auth, need('expenses.manage'), (req, res) => { voidExpense(ctx.db, iso(), today(), actorOf(req.user), intId(req.params.id), req.body?.reason); res.json({ ok: true }); });

  // ---------- statistiques et exports ----------
  const period = (q) => {
    const t = today();
    const from = dateStr(q.from ?? `${t.slice(0, 8)}01`, 'Début'), to = dateStr(q.to ?? t, 'Fin');
    return { from, to };
  };
  api.get('/reports', auth, need('stats.view'), (req, res) => {
    const r = report(ctx.db, ctx.tz(), period(req.query));
    delete r.sales_list; r.expenses.items = r.expenses.items.slice(0, 200);
    res.json(r);
  });
  api.get('/reports/export.xlsx', auth, need('stats.view'), (req, res) => {
    const r = report(ctx.db, ctx.tz(), period(req.query));
    const buf = buildXlsx(reportSheets(r, getSetting(ctx.db, 'shop_name')));
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="rapport-${r.from}-${r.to}.xlsx"`, 'Content-Length': String(buf.length) });
    res.end(buf);
  });
  api.get('/ticket-info', auth, need('pos.sell'), (req, res) => {
    const s = (k) => getSetting(ctx.db, k);
    res.json({ shop_name: s('shop_name'), address: s('address'), phone: s('phone'), footer: s('ticket_footer'), logo: s('logo'), tz: s('timezone') });
  });
}
