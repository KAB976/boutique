import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop } from './shop-world.js';

const PIN = '1357';
const cash = (c) => [{ method: 'cash', amount_cents: c }];
const openOk = async (w, who, counted) => { const r = await w.t.api.post('/api/shifts/open', { counted_cents: counted, pin: PIN }, who); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
const close = (w, who, body) => w.t.api.post('/api/closure', { pin: PIN, ...body }, who);
const L = (w) => [{ product_id: w.minute.id, qty: 1 }];
const dep = (w, who, amount_cents, note) => w.t.api.post('/api/shift/deposit', { amount_cents, note }, who);

test('le caissier ne voit aucun total : ni à l’aperçu de fermeture, ni dans la réponse, ni dans les listes', async () => {
  const w = await shop({ shifts: true });
  try {
    await openOk(w, w.C, 5000);
    await w.sellOk(w.C, L(w), cash(400));
    await w.ok(w.t.api.post('/api/cash-moves', { amount_cents: -300, category: 'Achat de marchandises', reason: 'Pain' }, w.C), 201);
    const blind = await w.ok(w.t.api.get('/api/closure/preview', w.C));
    assert.equal(blind.blind, true);
    for (const k of ['cash_expected_cents', 'sales_cents', 'sales_count', 'by_method', 'by_product', 'float_in_cents']) assert.equal(k in blind, false, k);
    assert.equal(blind.cash_moves.length, 1);
    const full = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(full.cash_expected_cents, 5000 + 400 - 300); assert.equal(full.sales_cents, 400);
    for (const p of ['/api/closures', '/api/shifts', '/api/cash-review']) assert.equal((await w.t.api.get(p, w.C)).status, 403, p);
    const z = await w.ok(close(w, w.C, { counted_cents: 5200, float_out_cents: 5000 }), 201); // 1 € en trop, sans le savoir
    assert.deepEqual(Object.keys(z).sort(), ['blind', 'cash_counted_cents', 'deposit_cents', 'float_out_cents', 'number', 'shift', 'ts']);
    assert.equal(z.deposit_cents, 200);
  } finally { await w.t.close(); }
});

test('versements en cours de quart : numérotés, sans montant attendu, comptés dans la vérification', async () => {
  const w = await shop({ shifts: true });
  try {
    assert.equal((await dep(w, w.C, 1000)).data.error.code, 'no_shift');
    await openOk(w, w.C, 5000);
    for (const bad of [0, -5, 1.5, 'x', undefined]) assert.equal((await dep(w, w.C, bad)).status, 400, String(bad));
    assert.equal((await dep(w, w.C2, 1000)).data.error.code, 'shift_other', 'seul le titulaire du quart verse');
    assert.equal((await dep(w, w.K, 1000)).status, 403);
    await w.sellOk(w.C, L(w), cash(400)); await w.sellOk(w.C, L(w), cash(400));
    const v1 = await w.ok(dep(w, w.C, 500), 201); const v2 = await w.ok(dep(w, w.C, 300, 'remis à Mina'), 201);
    assert.deepEqual([v1.number, v1.amount_cents, v2.number, v2.amount_cents], [1, 500, 2, 300]);
    assert.deepEqual(Object.keys(v1).sort(), ['amount_cents', 'number', 'ts']);
    const st = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.equal(st.deposits.length, 2); assert.equal(st.deposits[1].note, 'Versement 2 — remis à Mina');
    assert.equal((await w.ok(w.t.api.get('/api/closure/preview', w.C))).deposits.length, 2);
    // attendu = 5000 + 800 − 800 ; le caissier compte 5000 et laisse 5000 : tout est juste
    const z = await w.ok(close(w, w.C, { counted_cents: 5000, float_out_cents: 5000 }), 201);
    assert.equal(z.deposit_cents, 0);
    const d = (await w.ok(w.t.api.get('/api/cash-review', w.M))).days[0].items[0];
    assert.equal(d.variance_cents, 0); assert.equal(d.versed_cents, 800); assert.equal(d.closing_deposit_cents, 0); assert.equal(d.handed_total_cents, 800);
    assert.equal(d.cash_sales_cents, 800); assert.deepEqual(d.versements.map((x) => x.number), [1, 2]); assert.equal(d.late_cash_cents, 0);
    // le journal garde les versements
    assert.equal(w.t.ctx.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'cash.deposit'").get().c, 2);
    // un nouveau quart repart de 1
    await openOk(w, w.C2, 5000);
    assert.equal((await w.ok(dep(w, w.C2, 100), 201)).number, 1);
  } finally { await w.t.close(); }
});

test('l’écart est visible de l’administrateur seulement ; manque et excédent ; vérification une seule fois', async () => {
  const w = await shop({ shifts: true });
  try {
    await openOk(w, w.C, 5000);
    await w.sellOk(w.C, L(w), cash(400));
    await dep(w, w.C, 200);
    // attendu 5000 + 400 − 200 = 5200 ; le caissier compte 5150 (il manque 0,50 €), laisse 5000
    const z = await w.ok(close(w, w.C, { counted_cents: 5150, float_out_cents: 5000 }), 201);
    const id = w.t.ctx.db.prepare('SELECT id FROM closures').get().id;
    const ov = await w.ok(w.t.api.get('/api/cash-review', w.M));
    assert.equal(ov.pending_total, 1);
    const day = ov.days[0];
    assert.equal(day.totals.variance_cents, -50); assert.equal(day.totals.pending, 1); assert.equal(day.totals.handed_cents, 200 + 150);
    assert.equal(day.items[0].cash_expected_cents, 5200);
    // droits
    assert.equal((await w.t.api.post(`/api/cash-review/${id}`, { note: 'ok' }, w.C)).status, 403);
    assert.equal((await w.t.api.post(`/api/cash-review/${id}`, {}, w.M)).data.error.code, 'review_note', 'un écart exige une conclusion');
    const ok = await w.ok(w.t.api.post(`/api/cash-review/${id}`, { note: 'Monnaie rendue en trop, accepté' }, w.M), 201);
    assert.equal(ok.review.reviewer_name, 'Mina'); assert.equal(ok.review.variance_cents, -50);
    assert.equal((await w.t.api.post(`/api/cash-review/${id}`, { note: 'encore' }, w.M)).data.error.code, 'already_reviewed');
    assert.equal((await w.ok(w.t.api.get('/api/cash-review', w.M))).pending_total, 0);
    assert.throws(() => w.t.ctx.db.prepare('UPDATE cash_reviews SET note = \'x\'').run(), /ne se modifie pas/);
    assert.throws(() => w.t.ctx.db.prepare('DELETE FROM cash_reviews').run(), /ne se supprime pas/);
    assert.equal(w.t.ctx.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'cash.review'").get().c, 1);
    assert.equal((await w.t.api.post('/api/cash-review/9999', { note: 'x' }, w.M)).status, 404);
  } finally { await w.t.close(); }
});

test('une caisse juste se valide sans note ; un gérant ne vérifie pas sa propre caisse, le propriétaire si ; le gérant voit l’écart quand il ferme', async () => {
  const w = await shop({ shifts: true });
  try {
    await openOk(w, w.M, 1000);
    await w.sellOk(w.M, L(w), cash(400));
    const noNote = await close(w, w.M, { counted_cents: 1500, float_out_cents: 1000 });
    assert.equal(noNote.data.error.code, 'variance_note', 'celui qui voit l’écart doit l’expliquer');
    await w.ok(close(w, w.M, { counted_cents: 1400, float_out_cents: 1000 }), 201);
    const id = w.t.ctx.db.prepare('SELECT id FROM closures').get().id;
    assert.equal((await w.t.api.post(`/api/cash-review/${id}`, {}, w.M)).data.error.code, 'self_review');
    await w.ok(w.t.api.post(`/api/cash-review/${id}`, {}, w.O), 201);
    await openOk(w, w.C, 1000);
    await w.ok(close(w, w.C, { counted_cents: 1000, float_out_cents: 1000 }), 201);
    const id2 = w.t.ctx.db.prepare('SELECT id FROM closures ORDER BY id DESC').get().id;
    await w.ok(w.t.api.post(`/api/cash-review/${id2}`, {}, w.M), 201); // juste : pas de note
  } finally { await w.t.close(); }
});

test('seuil d’espèces : le caissier est prévenu de verser le seuil, sans blocage, relancé toutes les 10 minutes ; il ne voit jamais le total', async () => {
  const w = await shop({ shifts: true });
  try {
    const { cashReminderTick } = await import('../server/cash-review.js');
    const sent = []; w.t.ctx.push = { notify: (ids, p) => { sent.push([ids, p]); return Promise.resolve({ sent: 0 }); } };
    assert.equal((await w.ok(w.t.api.get('/api/cash-review', w.M))).live, null);
    await w.ok(w.t.api.put('/api/settings', { cash_alert_eur: 10 }, w.O));
    assert.equal((await w.t.api.post('/api/shift/request-deposit', {}, w.M)).data.error.code, 'no_shift');
    await openOk(w, w.C, 500);                       // fond de 5 € : il ne compte pas dans le seuil
    await w.sellOk(w.C, L(w), cash(400)); await w.sellOk(w.C, L(w), cash(400));
    let st = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.equal(st.deposit_due_cents, 0); assert.equal(sent.length, 0);
    let live = (await w.ok(w.t.api.get('/api/cash-review', w.M))).live;
    assert.equal(live.over, false); assert.equal(live.expected_now_cents, 1300); assert.equal(live.in_drawer_cents, 800);
    await w.sellOk(w.C, L(w), cash(400));            // 12 € hors fond > 10 €
    st = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.equal(st.deposit_due_cents, 1000, 'il doit verser le seuil');
    assert.equal(JSON.stringify(st).includes('1700'), false, 'aucun total dans ce que reçoit le caissier');
    assert.equal(sent.length, 1, 'prévenu dès la vente qui dépasse'); assert.deepEqual(sent[0][0], [st.shift.user_id]); assert.match(sent[0][1].body, /10,00 €/);
    await w.sellOk(w.C, L(w), cash(400));            // il continue à vendre : pas de blocage
    assert.equal(sent.length, 1, 'pas de nouveau rappel avant 10 minutes');
    assert.equal(cashReminderTick(w.t.ctx), false);
    w.t.clock.t = new Date(w.t.clock.t.getTime() + 11 * 60 * 1000);
    assert.equal(cashReminderTick(w.t.ctx), true); assert.equal(sent.length, 2, 'relance');
    live = (await w.ok(w.t.api.get('/api/cash-review', w.M))).live;
    assert.equal(live.over, true);
    assert.equal((await w.t.api.post('/api/shift/request-deposit', {}, w.C)).status, 403);
    await w.ok(w.t.api.post('/api/shift/request-deposit', { note: 'Versez 10 €' }, w.M));
    st = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.equal(st.shift.deposit_requested_by, 'Mina'); assert.equal(st.shift.deposit_request_note, 'Versez 10 €');
    await w.ok(dep(w, w.C, 1000), 201);
    st = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.equal(st.shift.deposit_requested_at, null); assert.equal(st.deposit_due_cents, 0, 'après le versement, plus de rappel');
    w.t.clock.t = new Date(w.t.clock.t.getTime() + 11 * 60 * 1000);
    assert.equal(cashReminderTick(w.t.ctx), false);
    // seuil à 0 : jamais
    await w.ok(w.t.api.put('/api/settings', { cash_alert_eur: 0 }, w.O));
    await w.sellOk(w.C, L(w), cash(400)); await w.sellOk(w.C, L(w), cash(400)); await w.sellOk(w.C, L(w), cash(400));
    assert.equal((await w.ok(w.t.api.get('/api/shift/current', w.C))).deposit_due_cents, 0);
    assert.equal(w.t.ctx.db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'cash.deposit_request'").get().c, 1);
  } finally { await w.t.close(); }
});
