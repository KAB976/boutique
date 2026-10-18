import { can } from './permissions.js';
import { bad, notFound } from './errors.js';
import { getSetting } from './settings.js';
import { dayIn } from './backup.js';
import { breakdown, unitOptions, fmtBase, suggestFor, round6 } from '../shared/units.js';
import {
  loadMeasures, loadIngredient, stateOf, lotsOnHand, receive, lose, inventory, fixPrice, verifyJournal, alerts, pendingPrices,
  shoppingCalc, createIngredient, updateIngredient, createMeasure, updateMeasure, convertOrThrow, priceHistory, lastPrices, dayDiff,
  LOSS_REASONS,
} from './stock.js';

const caps = (role) => ({
  costs: can(role, 'costs.view'), prices: can(role, 'purchase_prices.view'), price: can(role, 'purchasing.manage'),
  edit: can(role, 'ingredients.edit'), move: can(role, 'stock.move'),
});

export function registerStock({ api, ctx, auth, need, iso, actorOf }) {
  const tzToday = () => dayIn(ctx.now(), getSetting(ctx.db, 'timezone'));
  const measuresMap = () => loadMeasures(ctx.db);

  const unitsFor = (ing) => unitOptions(ing, measuresMap());

  /** Vue d'un ingrédient pour un rôle : les coûts ne sortent du serveur que pour ceux qui y ont droit. */
  function ingredientView(ing, c, today) {
    const st = stateOf(ctx.db, ing.id);
    const lots = lotsOnHand(ctx.db, ing.id);
    const dated = lots.filter((l) => l.expiry).sort((a, b) => (a.expiry < b.expiry ? -1 : 1))[0];
    const v = {
      id: ing.id, name: ing.name, category: ing.category, family: ing.family, storage: ing.storage, notes: ing.notes, active: ing.active,
      yield_pct: ing.yieldPct, density: ing.density, piece_g: ing.pieceG, threshold: ing.threshold, purchase_depth: ing.purchaseDepth,
      packs: ing.packs, equivalences: [...ing.equivs].map(([unit, base_qty]) => ({ unit, base_qty })),
      stock: st.stock, stockText: fmtBase(st.stock, ing.family), breakdown: ing.packs.length ? breakdown(Math.max(0, st.stock), ing.packs) : null,
      low: ing.threshold != null && st.stock <= ing.threshold + 1e-9, empty: st.stock <= 1e-9,
      nextExpiry: dated ? { date: dated.expiry, daysLeft: dayDiff(dated.expiry, today), qty: dated.remaining } : null,
      units: unitsFor(ing),
    };
    if (v.breakdown && (v.breakdown.parts.length || v.breakdown.rest)) {
      v.breakdownText = [...v.breakdown.parts.map((x) => `${x.n} ${x.label}`), ...(v.breakdown.rest ? [fmtBase(v.breakdown.rest, ing.family)] : [])].join(' + ');
    }
    if (c.costs) { v.avg_cost = st.avg; v.value = st.stock > 0 ? st.stock * st.avg : 0; }
    if (c.prices) { const [last, prev] = lastPrices(ctx.db, ing.id); v.last_price = last?.unit_cost ?? null; v.prev_price = prev?.unit_cost ?? null; }
    return v;
  }

  const moveView = (m, c) => {
    const v = {
      id: m.id, ts: m.ts, ingredient_id: m.ingredient_id, ingredient: m.name, family: m.family, type: m.type, qty: m.qty, stock_after: m.stock_after,
      expiry: m.expiry, price_pending: Boolean(m.price_pending), reason: m.reason, reasonText: LOSS_REASONS[m.reason] || null,
      note: m.note, entered: m.entered, user_name: m.user_name, inventory_id: m.inventory_id,
    };
    if (c.costs) { v.value = m.value; v.avg_after = m.avg_after; }
    if (c.prices && m.type === 'receipt') v.unit_cost = m.unit_cost;
    return v;
  };

  // ----- liste et alertes -----
  const al = (c) => {
    const a = alerts(ctx.db, { today: tzToday(), expiryDays: getSetting(ctx.db, 'expiry_alert_days'), pricePct: getSetting(ctx.db, 'price_alert_pct') });
    const out = { low: a.low, expiring: a.expiring };
    if (c.prices) out.priceRises = a.priceRises;
    if (c.price) out.pricePending = a.pricePending;
    return out;
  };

  api.get('/stock', auth, need('stock.view'), (req, res) => {
    const c = caps(req.user.role);
    const today = tzToday();
    const showArchived = req.query.archived === '1';
    const rows = ctx.db.prepare(`SELECT id FROM ingredients ${showArchived ? '' : 'WHERE active = 1'} ORDER BY active DESC, lower(name)`).all();
    const items = rows.map((r) => ingredientView(loadIngredient(ctx.db, r.id), c, today));
    const a = al(c);
    res.json({
      items, can: c, today, expiryDays: getSetting(ctx.db, 'expiry_alert_days'),
      counts: { low: a.low.length, expiring: a.expiring.length, ...(c.prices ? { priceRises: a.priceRises.length } : {}), ...(c.price ? { pricePending: a.pricePending } : {}) },
      lossReasons: LOSS_REASONS,
      totalValue: c.costs ? items.reduce((s, i) => s + (i.value || 0), 0) : undefined,
    });
  });
  api.get('/stock/alerts', auth, need('stock.view'), (req, res) => res.json(al(caps(req.user.role))));

  api.get('/stock/moves', auth, need('stock.view'), (req, res) => {
    const c = caps(req.user.role);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = [], args = [];
    if (Number(req.query.ingredient_id)) { where.push('m.ingredient_id = ?'); args.push(Number(req.query.ingredient_id)); }
    if (typeof req.query.type === 'string' && req.query.type) { where.push('m.type = ?'); args.push(req.query.type); }
    if (Number(req.query.beforeId)) { where.push('m.id < ?'); args.push(Number(req.query.beforeId)); }
    const rows = ctx.db.prepare(`SELECT m.*, i.name, i.family FROM stock_moves m JOIN ingredients i ON i.id = m.ingredient_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT ?`).all(...args, limit + 1);
    res.json({ rows: rows.slice(0, limit).map((m) => moveView(m, c)), hasMore: rows.length > limit });
  });

  api.get('/stock/verify', auth, need('audit.view'), (req, res) => res.json(verifyJournal(ctx.db)));

  // ----- réception -----
  api.post('/stock/receipts', auth, need('stock.move'), (req, res) => {
    const body = req.body || {};
    const lines = Array.isArray(body.lines) ? body.lines : [body];
    const c = caps(req.user.role);
    const out = receive(ctx.db, iso(), actorOf(req.user), lines, { canPrice: c.price, today: tzToday(), ref: typeof body.ref === 'string' ? body.ref.slice(0, 60) : null });
    const th = getSetting(ctx.db, 'price_alert_pct');
    res.status(201).json({
      lines: out.map((o) => ({
        moveId: o.moveId, ingredient: o.ingredient.name, entered: o.entered, base: o.base, stockText: fmtBase(o.stock, o.ingredient.family),
        priceRise: c.prices && o.unitCost != null && o.prevPrice > 0 && ((o.unitCost - o.prevPrice) / o.prevPrice) * 100 >= th
          ? { pct: ((o.unitCost - o.prevPrice) / o.prevPrice) * 100 } : null,
        ...(c.costs ? { unitCost: o.unitCost, newAvg: o.newAvg } : {}),
        pricePending: o.total == null,
      })),
    });
  });

  api.get('/stock/pending-prices', auth, need('purchasing.manage'), (req, res) => res.json(pendingPrices(ctx.db)));
  api.post('/stock/price-fix', auth, need('purchasing.manage'), (req, res) => {
    const r = fixPrice(ctx.db, iso(), actorOf(req.user), req.body || {});
    res.json({ ok: true, ingredient: r.ingredient.name, newAvg: r.avg, prevAvg: r.prevAvg });
  });

  // ----- perte -----
  api.post('/stock/losses', auth, need('stock.move'), (req, res) => {
    const c = caps(req.user.role);
    const r = lose(ctx.db, iso(), actorOf(req.user), req.body || {});
    res.status(201).json({ moveId: r.moveId, ingredient: r.ingredient.name, stockText: fmtBase(r.stock, r.ingredient.family), ...(c.costs ? { value: r.value } : {}) });
  });

  // ----- inventaire -----
  const invView = (r, c) => ({
    inventoryId: r.inventoryId,
    ...(c.costs ? { variance: r.variance } : {}),
    lines: r.lines.map((l) => ({
      ingredient_id: l.ing.id, name: l.ing.name, family: l.ing.family, entered: l.entered,
      theoretical: l.theoretical, counted: l.counted, delta: l.delta,
      theoreticalText: fmtBase(l.theoretical, l.ing.family), countedText: fmtBase(l.counted, l.ing.family), deltaText: l.delta === 0 ? 'conforme' : `${l.delta > 0 ? '+' : '−'}${fmtBase(Math.abs(l.delta), l.ing.family)}`,
      ...(c.costs ? { value: l.delta * l.avg } : {}),
    })),
  });
  api.post('/stock/inventory/preview', auth, need('stock.move'), (req, res) => {
    res.json(invView(inventory(ctx.db, iso(), actorOf(req.user), req.body?.counts, { commit: false }), caps(req.user.role)));
  });
  api.post('/stock/inventory', auth, need('stock.move'), (req, res) => {
    res.status(201).json(invView(inventory(ctx.db, iso(), actorOf(req.user), req.body?.counts, { commit: true, note: req.body?.note }), caps(req.user.role)));
  });
  api.get('/stock/inventories', auth, need('stock.view'), (req, res) => {
    const c = caps(req.user.role);
    res.json(ctx.db.prepare('SELECT id, ts, user_name, note, lines, variance_value FROM inventories ORDER BY id DESC LIMIT 50').all()
      .map((r) => (c.costs ? r : { ...r, variance_value: undefined })));
  });

  // ----- liste de courses en emballages (aide au calcul ; l'écran traiteur viendra à l'étape 8) -----
  api.get('/stock/shopping-calc', auth, need('stock.view'), (req, res) => {
    const ing = loadIngredient(ctx.db, Number(req.query.ingredient_id));
    if (!ing) throw notFound('Ingrédient introuvable.');
    const q = Number(String(req.query.qty ?? '').replace(',', '.'));
    if (!Number.isFinite(q)) throw bad('La quantité doit être un nombre.');
    const { base } = convertOrThrow(ctx.db, ing, q, String(req.query.unit || ''));
    const r = shoppingCalc(ctx.db, ing, base);
    res.json({ ingredient: ing.name, ...r, stockText: fmtBase(r.inStock, ing.family), needText: fmtBase(r.needBase, ing.family), toBuyText: fmtBase(r.toBuyBase, ing.family) });
  });

  // ----- ingrédients -----
  api.get('/ingredients/suggest', auth, need('ingredients.edit'), (req, res) => {
    const s = typeof req.query.name === 'string' ? suggestFor(req.query.name) : null;
    if (!s) return res.json(null);
    const measures = measuresMap();
    res.json({
      family: s.family, density: s.density ?? null, piece_g: s.pieceG ?? null, note: s.note,
      equivalences: Object.entries(s.equivs || {}).filter(([u]) => measures.has(u)).map(([unit, base_qty]) => ({ unit, base_qty })),
    });
  });
  api.get('/ingredients/:id', auth, need('stock.view'), (req, res) => {
    const c = caps(req.user.role);
    const ing = loadIngredient(ctx.db, Number(req.params.id));
    if (!ing) throw notFound('Ingrédient introuvable.');
    const v = ingredientView(ing, c, tzToday());
    v.lots = lotsOnHand(ctx.db, ing.id).map((l) => ({ ...l, remainingText: fmtBase(l.remaining, ing.family) }));
    if (c.prices) v.priceHistory = priceHistory(ctx.db, ing.id);
    res.json(v);
  });
  api.post('/ingredients', auth, need('ingredients.edit'), (req, res) => {
    const ing = createIngredient(ctx.db, iso(), actorOf(req.user), req.body);
    res.status(201).json(ingredientView(ing, caps(req.user.role), tzToday()));
  });
  api.patch('/ingredients/:id', auth, need('ingredients.edit'), (req, res) => {
    const ing = updateIngredient(ctx.db, iso(), actorOf(req.user), Number(req.params.id), req.body);
    res.json(ingredientView(ing, caps(req.user.role), tzToday()));
  });

  // ----- mesures générales (Réglages) -----
  api.get('/measures', auth, need('stock.view'), (req, res) => {
    const all = req.query.all === '1' && can(req.user.role, 'settings.edit');
    res.json([...loadMeasures(ctx.db, { all }).entries()].map(([code, m]) => ({ code, ...m })));
  });
  api.post('/measures', auth, need('settings.edit'), (req, res) => res.status(201).json(createMeasure(ctx.db, iso(), actorOf(req.user), req.body || {})));
  api.patch('/measures/:code', auth, need('settings.edit'), (req, res) => res.json(updateMeasure(ctx.db, iso(), actorOf(req.user), req.params.code, req.body)));

  api.post('/stock/convert', auth, need('stock.view'), (req, res) => {
    const ing = loadIngredient(ctx.db, Number(req.body?.ingredient_id));
    if (!ing) throw notFound('Ingrédient introuvable.');
    const q = typeof req.body.qty === 'string' ? Number(req.body.qty.replace(',', '.')) : req.body.qty;
    const r = convertOrThrow(ctx.db, ing, q, req.body.unit, { allowZero: true });
    res.json({ base: r.base, text: fmtBase(r.base, ing.family), entered: r.entered });
  });
}
