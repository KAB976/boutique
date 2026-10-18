import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBase, baseOfPack, breakdown, packsProblem, unitOptions, fmtBase, suggestFor } from '../shared/units.js';

const measures = new Map([
  ['cc', { label: 'cuillère à café', ml: 5 }],
  ['cs', { label: 'cuillère à soupe', ml: 15 }],
  ['tasse', { label: 'tasse', ml: 240 }],
]);
const levure = {
  name: 'Levure', family: 'mass', density: null, pieceG: null, equivs: new Map(),
  packs: [{ label: 'lot', contains: 3 }, { label: 'paquet', contains: 4 }, { label: 'sachet', contains: 4 }],
};
const farine = { name: 'Farine', family: 'mass', density: null, pieceG: null, equivs: new Map([['tasse', 120]]), packs: [{ label: 'sac', contains: 25000 }] };
const huile = { name: 'Huile', family: 'volume', density: 0.92, pieceG: null, equivs: new Map(), packs: [{ label: 'bidon', contains: 5000 }] };
const oeuf = { name: 'Œuf', family: 'count', density: null, pieceG: 60, equivs: new Map(), packs: [{ label: 'plateau', contains: 30 }] };
const capsule = { name: 'Capsule café', family: 'count', density: null, pieceG: null, equivs: new Map(), packs: [{ label: 'carton', contains: 10 }, { label: 'boîte', contains: 10 }, { label: 'capsule', contains: 1 }] };

test('chaîne de conditionnement : 1 lot = 3 paquets de 4 sachets de 4 g = 48 g', () => {
  assert.equal(baseOfPack(levure.packs, 0), 48);
  assert.equal(baseOfPack(levure.packs, 1), 16);
  assert.equal(baseOfPack(levure.packs, 2), 4);
  assert.equal(toBase(levure, measures, 2, 'pack:0').base, 96);
  assert.equal(toBase(levure, measures, 1, 'pack:1').base, 16);
  assert.equal(toBase(levure, measures, 3, 'pack:2').base, 12);
  assert.equal(baseOfPack(capsule.packs, 0), 100);
});

test('découpe en emballages entiers', () => {
  assert.deepEqual(breakdown(100, levure.packs), { parts: [{ label: 'lot', n: 2 }, { label: 'sachet', n: 1 }], rest: 0 });
  assert.deepEqual(breakdown(21, levure.packs), { parts: [{ label: 'paquet', n: 1 }, { label: 'sachet', n: 1 }], rest: 1 });
  assert.deepEqual(breakdown(0, levure.packs), { parts: [], rest: 0 });
});

test('mêmes familles : conversions métriques exactes', () => {
  assert.equal(toBase(farine, measures, 2.5, 'kg').base, 2500);
  assert.equal(toBase(farine, measures, 500, 'mg').base, 0.5);
  assert.equal(toBase(huile, measures, 1.5, 'l').base, 1500);
  assert.equal(toBase(huile, measures, 25, 'cl').base, 250);
  assert.equal(toBase(oeuf, measures, 2, 'douzaine').base, 24);
});

test('équivalence par ingrédient : 2,5 tasses de farine = 300 g', () => {
  assert.equal(toBase(farine, measures, 2.5, 'tasse').base, 300);
});

test('densité : cuillère à soupe d\'huile (ml) ; 14 g d\'huile → 15,217391 ml', () => {
  assert.equal(toBase(huile, measures, 1, 'cs').base, 15);
  assert.equal(toBase(huile, measures, 14, 'g').base, 15.217391);
  assert.equal(toBase(huile, measures, 2, 'tasse').base, 480);
});

test('poids d\'une pièce : 300 g d\'œufs = 5 œufs ; 3 œufs en g = 180', () => {
  assert.equal(toBase(oeuf, measures, 300, 'g').base, 5);
  assert.equal(toBase({ ...farine, name: 'X', pieceG: 60 }, measures, 3, 'piece').base, 180);
});

test('CRITÈRE : une conversion impossible est refusée avec une explication', () => {
  const r1 = toBase(farine, measures, 1, 'l');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /Impossible de convertir « l » en g pour « Farine »/);
  const r2 = toBase(levure, measures, 1, 'cc');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /densité/);
  const r3 = toBase({ ...farine, equivs: new Map() }, measures, 1, 'piece');
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /poids d'une pièce/);
  assert.equal(toBase(huile, measures, 1, 'piece').ok, false);
  assert.equal(toBase(capsule, measures, 1, 'g').ok, false);
  assert.equal(toBase(capsule, measures, 1, 'ml').ok, false);
  assert.match(toBase(farine, measures, 1, 'furlong').reason, /Unité inconnue/);
  assert.equal(toBase(farine, measures, -1, 'g').ok, false);
  assert.equal(toBase(farine, measures, NaN, 'g').ok, false);
  assert.equal(toBase(farine, measures, 1, 'pack:7').ok, false);
});

test('une mesure personnalisée ou modifiée change bien la conversion', () => {
  const m2 = new Map(measures);
  m2.set('verre', { label: 'verre', ml: 200 });
  assert.equal(toBase(huile, m2, 1, 'verre').base, 200);
  m2.set('cs', { label: 'cuillère à soupe', ml: 12 });
  assert.equal(toBase(huile, m2, 1, 'cs').base, 12);
});

test('liste des unités proposées : seulement celles qui se convertissent', () => {
  const codes = (ing) => unitOptions(ing, measures).map((u) => u.code);
  assert.deepEqual(codes(capsule), ['pack:0', 'pack:1', 'pack:2', 'piece', 'douzaine']);
  const f = codes(farine);
  assert.ok(f.includes('g') && f.includes('kg') && f.includes('tasse') && f.includes('pack:0'));
  assert.ok(!f.includes('ml') && !f.includes('cc'));
  const h = codes(huile);
  assert.ok(h.includes('ml') && h.includes('l') && h.includes('cs') && h.includes('g') && h.includes('kg'));
  assert.ok(!codes(huile).includes('piece'));
  assert.ok(codes(levure).includes('mg') && codes(levure).includes('pack:2'));
  assert.ok(!codes(huile).includes('mg'), 'mg réservé aux ingrédients au poids');
});

test('chaînes de conditionnement invalides refusées', () => {
  assert.equal(packsProblem(levure.packs), null);
  assert.match(packsProblem([{ label: '', contains: 2 }]), /pas de nom/);
  assert.match(packsProblem([{ label: 'a', contains: 0 }]), /supérieure à zéro/);
  assert.match(packsProblem([{ label: 'a', contains: 2.5 }, { label: 'b', contains: 1 }]), /nombre entier/);
  assert.match(packsProblem([{ label: 'a', contains: 2 }, { label: 'A', contains: 1 }]), /deux fois/);
  assert.match(packsProblem(Array.from({ length: 5 }, (_, i) => ({ label: `n${i}`, contains: 2 }))), /Quatre niveaux/);
  assert.equal(packsProblem([{ label: 'sac', contains: 25000 }]), null, 'le dernier niveau peut être décimal');
  assert.equal(packsProblem([]), null);
});

test('affichage et repères', () => {
  assert.equal(fmtBase(250, 'mass'), '250 g');
  assert.equal(fmtBase(1250, 'mass'), '1,25 kg');
  assert.equal(fmtBase(1500, 'volume'), '1,5 l');
  assert.equal(fmtBase(1, 'count'), '1 pièce');
  assert.equal(fmtBase(12, 'count'), '12 pièces');
  assert.equal(suggestFor('Farine de blé T55').equivs.tasse, 120);
  assert.equal(suggestFor('Huile de tournesol').density, 0.92);
  assert.equal(suggestFor('Capsules café'), null);
});
