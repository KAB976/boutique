import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shop, uuid } from './shop-world.js';

const PIN = '1357'; // code des comptes créés par shop-world
const cash = (c) => [{ method: 'cash', amount_cents: c }];
const open = (w, who, body) => w.t.api.post('/api/shifts/open', body, who);
const openOk = async (w, who, counted, extra = {}) => { const r = await open(w, who, { counted_cents: counted, pin: PIN, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
const close = (w, who, body) => w.t.api.post('/api/closure', { pin: PIN, ...body }, who);
const OWNER_PIN = '2468';

test('sans quart ouvert : pas d’encaissement ; seul le titulaire encaisse ; le gérant aussi doit attendre', async () => {
  const w = await shop({ shifts: true });
  try {
    const L = [{ product_id: w.minute.id, qty: 1 }];
    const r0 = await w.sell(w.C, L, cash(400));
    assert.equal(r0.status, 409); assert.equal(r0.data.error.code, 'no_shift');
    const cur = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.equal(cur.required, true); assert.equal(cur.shift, null); assert.equal(cur.expected_float_cents, null);
    const sh = await openOk(w, w.C, 10000);
    assert.equal(sh.number, 'Q-0001'); assert.equal(sh.user_name, 'Awa'); assert.equal(sh.opening_variance_cents, null, 'tout premier quart : rien à comparer');
    await w.sellOk(w.C, L, cash(400));
    const r1 = await w.sell(w.C2, L, cash(400));
    assert.equal(r1.status, 409); assert.equal(r1.data.error.code, 'shift_other'); assert.match(r1.data.error.message, /Awa/);
    assert.equal((await w.sell(w.M, L, cash(400))).data.error.code, 'shift_other');
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM sales').get().c, 1);
    const cur2 = await w.ok(w.t.api.get('/api/shift/current', w.C2));
    assert.equal(cur2.mine, false); assert.equal(cur2.shift.user_name, 'Awa');
    assert.equal((await w.ok(w.t.api.get('/api/shift/current', w.C))).mine, true);
  } finally { await w.t.close(); }
});

test('ouverture : code PIN obligatoire, mauvais code refusé puis blocage, droits, un seul quart à la fois', async () => {
  const w = await shop({ shifts: true });
  try {
    assert.equal((await open(w, w.C, { counted_cents: 5000 })).data.error.code, 'pin_required');
    const bad1 = await open(w, w.C, { counted_cents: 5000, pin: '9999' });
    assert.equal(bad1.status, 403); assert.equal(bad1.data.error.code, 'bad_pin'); assert.match(bad1.data.error.message, /Il reste 4 essais/);
    assert.equal((await open(w, w.C, { counted_cents: -1, pin: PIN })).status, 400);
    assert.equal((await open(w, w.C, { counted_cents: 12.5, pin: PIN })).status, 400);
    assert.equal((await open(w, w.K, { counted_cents: 5000, pin: PIN })).status, 403, 'le cuisinier n’ouvre pas de quart');
    assert.equal(w.t.ctx.db.prepare('SELECT COUNT(*) AS c FROM shifts').get().c, 0);
    await openOk(w, w.C, 5000); // le bon code remet le compteur à zéro
    const again = await open(w, w.C, { counted_cents: 5000, pin: PIN });
    assert.equal(again.status, 409); assert.match(again.data.error.message, /déjà ouvert/);
    const other = await open(w, w.C2, { counted_cents: 5000, pin: PIN });
    assert.equal(other.status, 409); assert.equal(other.data.error.code, 'shift_open'); assert.match(other.data.error.message, /Awa/);
    // cinq mauvais codes : compte bloqué
    let last; for (let i = 0; i < 5; i++) last = await open(w, w.C2, { counted_cents: 5000, pin: '0000' });
    assert.equal(last.status, 429); assert.equal(last.data.error.code, 'locked');
    const aud = w.t.ctx.db.prepare("SELECT action FROM audit WHERE action IN ('shift.open','auth.locked') ORDER BY id").all().map((x) => x.action);
    assert.deepEqual(aud, ['shift.open', 'auth.locked']);
  } finally { await w.t.close(); }
});

test('passage de relais : fond laissé = fond attendu ; un écart à l’ouverture exige une note et reste enregistré', async () => {
  const w = await shop({ shifts: true });
  try {
    await openOk(w, w.C, 10000);
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(500)); // 4,00 € d'espèces nettes (rendu 1,00 €)
    await w.ok(w.t.api.post('/api/cash-moves', { amount_cents: -1000, category: 'Achat de marchandises', reason: 'Pain et lait chez Ali' }, w.C), 201);
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.float_in_cents, 10000); assert.equal(pv.cash_expected_cents, 10000 + 400 - 1000);
    // PIN obligatoire à la fermeture
    assert.equal((await w.t.api.post('/api/closure', { counted_cents: 9400, float_out_cents: 5000 }, w.C)).data.error.code, 'pin_required');
    assert.equal((await close(w, w.C, { counted_cents: 9400, float_out_cents: 5000, pin: '0000' })).data.error.code, 'bad_pin');
    const z = await w.ok(close(w, w.C, { counted_cents: 9400, float_out_cents: 5000 }), 201);
    assert.equal(z.deposit_cents, 4400); assert.equal(z.float_out_cents, 5000); assert.equal(z.blind, true);
    assert.equal(z.shift.number, 'Q-0001');
    const zl = (await w.ok(w.t.api.get('/api/closures', w.M))).items[0];
    assert.equal(zl.variance_cents, 0); assert.equal(zl.shift.closed_by_name, 'Awa');
    const cur = await w.ok(w.t.api.get('/api/shift/current', w.C2));
    assert.equal(cur.shift, null); assert.equal(cur.expected_float_cents, 5000, 'Bao doit trouver 50 € dans le tiroir');
    assert.equal((await w.sell(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400))).data.error.code, 'no_shift', 'après la fermeture, plus d’encaissement');
    // Bao compte 48 € : écart de −2 €, note obligatoire
    const nonote = await open(w, w.C2, { counted_cents: 4800, pin: PIN });
    assert.equal(nonote.status, 400); assert.equal(nonote.data.error.code, 'variance_note');
    const sh = await openOk(w, w.C2, 4800, { note: 'Il manquait 2 € : pièces de 1 € non trouvées' });
    assert.equal(sh.opening_expected_cents, 5000); assert.equal(sh.opening_counted_cents, 4800); assert.equal(sh.opening_variance_cents, -200);
    assert.match(sh.opening_note, /pièces/);
    // la fermeture de Bao part du fond COMPTÉ (48 €), pas de 50 €
    const pv2 = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv2.float_in_cents, 4800); assert.equal(pv2.cash_expected_cents, 4800);
    assert.equal(pv2.sales_count, 0, 'les ventes du quart précédent ne comptent plus');
    // fermer sans rien vendre est possible (simple relais)
    const z2 = await w.ok(close(w, w.C2, { counted_cents: 4800, float_out_cents: 4800 }), 201);
    assert.equal(z2.deposit_cents, 0);
    // Awa rouvre : le fond attendu est celui laissé par Bao (48 €) ; 48 € comptés = juste
    const s3 = await openOk(w, w.C, 4800);
    assert.equal(s3.opening_variance_cents, 0); assert.equal(s3.number, 'Q-0003');
    // l'écart d'ouverture est dans le journal
    const j = w.t.ctx.db.prepare("SELECT detail FROM audit WHERE action = 'shift.open' ORDER BY id").all().map((x) => JSON.parse(x.detail));
    assert.equal(j[1].variance, -200); assert.match(j[1].note, /pièces/);
  } finally { await w.t.close(); }
});

test('fermeture : écart de caisse → note ; seul le titulaire ou le gérant ; fermeture forcée motivée et tracée', async () => {
  const w = await shop({ shifts: true });
  try {
    await openOk(w, w.C, 5000);
    await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400));
    assert.equal((await close(w, w.C2, { counted_cents: 5400, float_out_cents: 5000 })).status, 403, 'un autre caissier ne ferme pas ce quart');
    const noNote = await close(w, w.M, { counted_cents: 5400, float_out_cents: 5000 });
    assert.equal(noNote.data.error.code, 'force_note');
    // le code du gérant (1357) est celui de shop-world ; mauvais code = refusé
    assert.equal((await close(w, w.M, { counted_cents: 5400, float_out_cents: 5000, note: 'Awa est partie sans fermer', pin: '0000' })).data.error.code, 'bad_pin');
    const z = await w.ok(close(w, w.M, { counted_cents: 5400, float_out_cents: 5000, note: 'Awa est partie sans fermer' }), 201);
    assert.equal(z.shift.forced, true);
    assert.equal(z.shift.user_name, 'Awa'); assert.equal(z.shift.closed_by_name, 'Mina');
    assert.equal(z.variance_cents, 0, 'le gérant, lui, voit l’écart');
    const a = JSON.parse(w.t.ctx.db.prepare("SELECT detail FROM audit WHERE action = 'cash.closure'").get().detail);
    assert.equal(a.forced, true); assert.match(a.note, /partie sans fermer/);
    // tentative de fermer alors qu'aucun quart n'est ouvert
    assert.equal((await close(w, w.C, { counted_cents: 0, float_out_cents: 0 })).data.error.code, 'no_shift');
  } finally { await w.t.close(); }
});

test('sorties et entrées d’espèces : motif dans la liste + note obligatoires, quart ouvert nécessaire', async () => {
  const w = await shop({ shifts: true });
  try {
    const mv = (who, b) => w.t.api.post('/api/cash-moves', b, who);
    assert.equal((await mv(w.C, { amount_cents: -500, category: 'Dépôt en banque', reason: 'banque' })).data.error.code, 'no_shift');
    await openOk(w, w.C, 5000);
    assert.equal((await mv(w.C, { amount_cents: -500, reason: 'Pain' })).data.error.code, 'category_required');
    assert.equal((await mv(w.C, { amount_cents: -500, category: 'Ajout de fond de caisse', reason: 'Pain' })).data.error.code, 'category_required', 'un motif d’entrée ne sert pas à une sortie');
    assert.equal((await mv(w.C, { amount_cents: 500, category: 'Achat de marchandises', reason: 'Pain' })).data.error.code, 'category_required', 'ni l’inverse');
    assert.equal((await mv(w.C, { amount_cents: -500, category: 'Achat de marchandises', reason: '' })).data.error.code, 'note_required');
    assert.equal((await mv(w.C, { amount_cents: -500, category: 'Achat de marchandises', reason: 'ab' })).data.error.code, 'note_required');
    await w.ok(mv(w.C, { amount_cents: -500, category: 'Achat de marchandises', reason: 'Pain chez Ali' }), 201);
    await w.ok(mv(w.M, { amount_cents: 2000, category: 'Ajout de fond de caisse', reason: 'Complément du matin' }), 201); // le gérant peut aussi, sur le quart ouvert
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.deepEqual(pv.cash_moves.map((m) => [m.category, m.reason, m.user_name, m.amount_cents]), [['Achat de marchandises', 'Pain chez Ali', 'Awa', -500], ['Ajout de fond de caisse', 'Complément du matin', 'Mina', 2000]]);
    assert.equal(pv.cash_expected_cents, 5000 - 500 + 2000);
    const a = JSON.parse(w.t.ctx.db.prepare("SELECT detail FROM audit WHERE action = 'cash.move' ORDER BY id").get().detail);
    assert.equal(a.category, 'Achat de marchandises'); assert.equal(a.note, 'Pain chez Ali'); assert.equal(a.shift, 'Q-0001');
    const cur = await w.ok(w.t.api.get('/api/shift/current', w.C));
    assert.ok(cur.out_reasons.includes('Dépôt en banque') && cur.in_reasons.includes('Monnaie / change'));
  } finally { await w.t.close(); }
});

test('autres mouvements d’espèces (dépense du tiroir, règlement d’ardoise, fournisseur, annulation de vente) : quart ouvert exigé', async () => {
  const w = await shop({ shifts: true });
  try {
    const cid = (await w.ok(w.t.api.post('/api/customers', { name: 'Fatima', credit_limit_cents: 10000 }, w.M), 201)).id;
    const exp = (b) => w.t.api.post('/api/expenses', { category: 'Divers', label: 'Sacs', amount_cents: 300, from_drawer: true, ...b }, w.M);
    assert.equal((await exp()).data.error.code, 'no_shift');
    assert.equal((await exp({ from_drawer: false })).status, 201, 'une dépense payée autrement n’a pas besoin du tiroir');
    await openOk(w, w.C, 5000);
    const s = await w.sellOk(w.C, [{ product_id: w.minute.id, qty: 1 }], cash(400), { customer_id: cid });
    await w.ok(exp(), 201);
    // fermer pour tester le refus d'une annulation sans quart
    await w.ok(close(w, w.C, { counted_cents: 5100, float_out_cents: 5100 }), 201);
    const rf = await w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'erreur de saisie' }, w.M);
    assert.equal(rf.data.error.code, 'no_shift');
    await openOk(w, w.M, 5100, {});
    await w.ok(w.t.api.post(`/api/sales/${s.id}/refund`, { reason: 'erreur de saisie' }, w.M), 201);
  } finally { await w.t.close(); }
});

test('ventes faites sans réseau : acceptées même sans quart (signalées) ; l’argent d’avant l’ouverture ne fausse pas le quart suivant', async () => {
  const w = await shop({ shifts: true });
  try {
    await w.ok(w.t.api.put('/api/settings', { session_hours: 72 }, w.O));
    await openOk(w, w.C, 10000);
    await w.ok(close(w, w.C, { counted_cents: 10000, float_out_cents: 10000 }), 201); // Awa part avec 100 € dans le tiroir
    w.t.clock.t = new Date('2026-10-07T09:00:00Z');
    await openOk(w, w.C2, 10000);
    // vente faite à 07:50 sur la tablette d'Awa (hors-ligne, pendant son quart), reçue seulement maintenant
    const off = { client_uuid: uuid(), provisional: 'H1-1', offline: true, ts: '2026-10-07T07:50:00Z', lines: [{ product_id: w.minute.id, qty: 1, unit_price_cents: 400 }], payments: cash(400) };
    const r = await w.ok(w.t.api.post('/api/sales/sync', { sales: [off] }, w.C));
    assert.equal(r.results[0].ok, true);
    const sale = await w.ok(w.t.api.get(`/api/sales/${r.results[0].id}`, w.M));
    assert.ok(sale.flags.includes('no_shift'), 'Awa n’a pas de quart ouvert à la réception : signalé');
    const pv = await w.ok(w.t.api.get('/api/closure/preview', w.M));
    assert.equal(pv.sales_count, 1); assert.equal(pv.late_cash_cents, 400);
    assert.equal(pv.cash_expected_cents, 10000, 'les 4 € étaient dans le tiroir d’Awa, pas dans celui de Bao');
  } finally { await w.t.close(); }
});

test('quarts : journal non modifiable, un seul ouvert, réglage « quart obligatoire » à zéro = ancien fonctionnement', async () => {
  const w = await shop({ shifts: true });
  try {
    const db = w.t.ctx.db;
    await openOk(w, w.C, 5000);
    assert.throws(() => db.prepare('UPDATE shifts SET opening_counted_cents = 0').run(), /ne se modifie pas/);
    assert.throws(() => db.prepare('DELETE FROM shifts').run(), /ne se supprime pas/);
    assert.throws(() => db.prepare(`INSERT INTO shifts (number, user_id, user_name, opened_at, day, from_sale_id, from_cash_move_id, opening_counted_cents) VALUES ('Q-9', 1, 'x', 'x', 'x', 0, 0, 0)`).run(), /UNIQUE/, 'deux quarts ouverts en même temps sont impossibles même en SQL');
    await w.ok(close(w, w.C, { counted_cents: 5000, float_out_cents: 5000 }), 201);
    assert.throws(() => db.prepare('UPDATE shifts SET closed_by_name = \'x\'').run(), /ne se modifie pas/, 'un quart fermé ne change plus');
    const list = await w.ok(w.t.api.get('/api/shifts', w.M));
    assert.equal(list.items.length, 1); assert.equal(list.items[0].closure.number, 'Z-0001');
    assert.equal((await w.t.api.get('/api/shifts', w.K)).status, 403);
    // le propriétaire désactive l'obligation : on encaisse sans quart
    await w.ok(w.t.api.put('/api/settings', { require_shift: 0 }, w.O));
    await w.sellOk(w.C2, [{ product_id: w.minute.id, qty: 1 }], cash(400));
    assert.equal((await w.t.api.put('/api/settings', { require_shift: 2 }, w.O)).status, 400);
  } finally { await w.t.close(); }
});
