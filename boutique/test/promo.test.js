import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPromos, isActiveAt, atOf } from '../shared/promo.js';

const at = { day: '2026-10-07', weekday: 3, minutes: 12 * 60 };
const P = (o) => ({ id: 1, name: 'Promo', active: 1, weekdays: '', scope: 'all', starts_on: null, ends_on: null, time_from: null, time_to: null, ...o });
const L = (key, product_id, qty, price, category = 'Cat') => ({ key, product_id, category, qty, price_cents: price });

test('2 achetés 1 offert : le moins cher est offert, par groupes de 3', () => {
  const r = applyPromos([L('a', 1, 7, 400)], [P({ type: 'bogo', scope: 'product', product_id: 1, buy_qty: 2, free_qty: 1 })], at);
  assert.equal(r.total, 800); // 7 articles = 2 groupes de 3 → 2 offerts
  const mixed = applyPromos([L('a', 1, 2, 1000), L('b', 1, 1, 200)], [P({ type: 'bogo', scope: 'product', product_id: 1, buy_qty: 2, free_qty: 1 })], at);
  assert.equal(mixed.discounts.b, 200); // l'article le moins cher est celui qui est offert
  assert.equal(mixed.discounts.a, 0);
  assert.equal(applyPromos([L('a', 1, 2, 400)], [P({ type: 'bogo', scope: 'product', product_id: 1, buy_qty: 2, free_qty: 1 })], at).total, 0); // pas assez
});

test('5 pour un prix fixe : la remise est exacte au centime et répartie sans reste', () => {
  const promo = P({ type: 'bundle', bundle_qty: 5, bundle_price_cents: 1000 });
  const r = applyPromos([L('a', 1, 5, 333)], [promo], at);
  assert.equal(r.total, 5 * 333 - 1000);
  assert.equal(r.discounts.a, 665);
  const two = applyPromos([L('a', 1, 3, 333), L('b', 2, 3, 250)], [promo], at); // 6 articles : un seul lot de 5 (les 5 moins chers)
  assert.equal(two.total, 3 * 250 + 2 * 333 - 1000);
  assert.equal(Object.values(two.discounts).reduce((a, b) => a + b, 0), two.total);
  assert.equal(applyPromos([L('a', 1, 4, 333)], [promo], at).total, 0);
  assert.equal(applyPromos([L('a', 1, 5, 150)], [promo], at).total, 0, 'jamais de « remise » négative quand le lot coûte plus cher');
});

test('pourcentage et montant par article ; plafonnés au prix', () => {
  assert.equal(applyPromos([L('a', 1, 3, 333)], [P({ type: 'percent', percent: 10 })], at).total, 3 * 33);
  const r = applyPromos([L('a', 1, 2, 80)], [P({ type: 'amount', amount_cents: 100 })], at);
  assert.equal(r.total, 160); // jamais plus que le prix de l'article
  assert.equal(applyPromos([L('a', 1, 1, 1000)], [P({ type: 'percent', percent: 100 })], at).total, 1000);
});

test('portée : article, catégorie (sans tenir compte des accents / majuscules), tout', () => {
  const lines = [L('a', 1, 1, 500, 'Boissons'), L('b', 2, 1, 500, 'Desserts')];
  assert.deepEqual(applyPromos(lines, [P({ type: 'percent', percent: 10, scope: 'product', product_id: 2 })], at).discounts, { a: 0, b: 50 });
  assert.deepEqual(applyPromos(lines, [P({ type: 'percent', percent: 10, scope: 'category', category: 'boisSONS' })], at).discounts, { a: 50, b: 0 });
  assert.deepEqual(applyPromos([L('a', 1, 1, 500, 'Crêpes')], [P({ type: 'percent', percent: 10, scope: 'category', category: 'crepes' })], at).discounts, { a: 50 });
  assert.equal(applyPromos(lines, [P({ type: 'percent', percent: 10 })], at).total, 100);
});

test('une unité ne profite que d’une promotion : on retient la meilleure pour le client', () => {
  const r = applyPromos([L('a', 1, 3, 400)], [
    P({ id: 1, name: 'Dix pour cent', type: 'percent', percent: 10 }),
    P({ id: 2, name: '2+1', type: 'bogo', buy_qty: 2, free_qty: 1 }),
  ], at);
  assert.equal(r.total, 400); // 2+1 offre 400 contre 120
  assert.deepEqual(r.applied.map((x) => x.name), ['2+1']);
});

test('calendrier : dates, jours de la semaine, plage horaire (y compris après minuit), promotion éteinte', () => {
  const base = P({ type: 'percent', percent: 10 });
  assert.equal(isActiveAt({ ...base, starts_on: '2026-10-08' }, at), false);
  assert.equal(isActiveAt({ ...base, ends_on: '2026-10-06' }, at), false);
  assert.equal(isActiveAt({ ...base, starts_on: '2026-10-07', ends_on: '2026-10-07' }, at), true);
  assert.equal(isActiveAt({ ...base, weekdays: '1,2' }, at), false);
  assert.equal(isActiveAt({ ...base, weekdays: '3' }, at), true);
  assert.equal(isActiveAt({ ...base, time_from: '11:00', time_to: '14:00' }, at), true);
  assert.equal(isActiveAt({ ...base, time_from: '14:00', time_to: '18:00' }, at), false);
  assert.equal(isActiveAt({ ...base, time_from: '11:00', time_to: '12:00' }, at), false, 'l’heure de fin est exclue');
  assert.equal(isActiveAt({ ...base, time_from: '22:00', time_to: '02:00' }, { ...at, minutes: 60 }), true);
  assert.equal(isActiveAt({ ...base, time_from: '22:00', time_to: '02:00' }, { ...at, minutes: 12 * 60 }), false);
  assert.equal(isActiveAt({ ...base, active: 0 }, at), false);
  assert.equal(applyPromos([L('a', 1, 1, 500)], [{ ...base, active: 0 }], at).total, 0);
});

test('atOf : jour et heure du commerce (Mayotte = UTC+3), pas ceux du serveur', () => {
  const a = atOf(new Date('2026-10-07T22:30:00Z'), 'Indian/Mayotte');
  assert.deepEqual(a, { day: '2026-10-08', weekday: 4, minutes: 60 + 30 });
});

test('propriétés : jamais plus de remise que de montant, jamais négative, somme des lignes = total', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const lines = Array.from({ length: 1 + rnd(4) }, (_, i) => L(`l${i}`, 1 + rnd(3), 1 + rnd(6), 1 + rnd(1500), ['A', 'B'][rnd(2)]));
    const promos = [
      P({ id: 1, type: 'bogo', buy_qty: 1 + rnd(3), free_qty: 1 + rnd(2), scope: 'product', product_id: 1 + rnd(3) }),
      P({ id: 2, type: 'bundle', bundle_qty: 2 + rnd(4), bundle_price_cents: 1 + rnd(3000), scope: 'category', category: 'A' }),
      P({ id: 3, type: 'percent', percent: 1 + rnd(100), scope: 'product', product_id: 1 + rnd(3) }),
      P({ id: 4, type: 'amount', amount_cents: 1 + rnd(500), scope: 'all' }),
    ].filter(() => rnd(3) > 0);
    const r = applyPromos(lines, promos, at);
    let sum = 0;
    for (const l of lines) {
      const d = r.discounts[l.key];
      assert.ok(Number.isInteger(d) && d >= 0 && d <= l.qty * l.price_cents, `remise ${d} hors limites pour ${JSON.stringify(l)}`);
      sum += d;
    }
    assert.equal(sum, r.total);
    assert.equal(r.applied.reduce((a, x) => a + x.discount_cents, 0), r.total);
  }
});
