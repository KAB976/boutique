/**
 * Unités et conversions — module partagé serveur / interface.
 *
 * Principe : aucune conversion « silencieuse ». Si le passage d'une unité à une autre n'est pas
 * possible avec ce que l'on sait de l'ingrédient, on renvoie { ok:false, reason } avec une
 * explication en français, jamais un nombre approximatif.
 *
 * Un ingrédient a une famille (mass | volume | count) et donc une unité de base (g | ml | pièce).
 * Tout le stock et tous les coûts sont calculés dans cette unité de base.
 */

export const FAMILIES = ['mass', 'volume', 'count'];
export const BASE = {
  mass: { code: 'g', label: 'g', long: 'grammes' },
  volume: { code: 'ml', label: 'ml', long: 'millilitres' },
  count: { code: 'piece', label: 'pièce', long: 'pièces' },
};
export const FAMILY_LABELS = { mass: 'Poids (g)', volume: 'Volume (ml)', count: 'À la pièce' };

/** Unités métriques fixes : dimension et facteur vers l'unité de la dimension (g, ml, pièce). */
export const METRIC = {
  mg: { label: 'mg', dim: 'mass', f: 0.001 },
  g: { label: 'g', dim: 'mass', f: 1 },
  kg: { label: 'kg', dim: 'mass', f: 1000 },
  ml: { label: 'ml', dim: 'vol', f: 1 },
  cl: { label: 'cl', dim: 'vol', f: 10 },
  dl: { label: 'dl', dim: 'vol', f: 100 },
  l: { label: 'l', dim: 'vol', f: 1000 },
  piece: { label: 'pièce', dim: 'count', f: 1 },
  douzaine: { label: 'douzaine', dim: 'count', f: 12 },
};

export const round6 = (x) => Math.round(x * 1e6) / 1e6;
const famDim = (family) => (family === 'volume' ? 'vol' : family);

/** Quantité de base contenue dans 1 unité du niveau `depth` de la chaîne de conditionnement. */
export function baseOfPack(packs, depth) {
  let p = 1;
  for (let i = depth; i < packs.length; i++) p *= packs[i].contains;
  return p;
}

/** Vérifie une chaîne de conditionnement ; retourne un message d'erreur ou null. */
export function packsProblem(packs) {
  if (!Array.isArray(packs)) return 'Conditionnements invalides.';
  if (packs.length > 4) return 'Quatre niveaux de conditionnement au maximum.';
  const seen = new Set();
  for (const [i, p] of packs.entries()) {
    const label = typeof p?.label === 'string' ? p.label.trim() : '';
    if (!label) return `Le niveau ${i + 1} du conditionnement n'a pas de nom.`;
    if (label.length > 30) return `Le nom « ${label.slice(0, 12)}… » est trop long (30 caractères au maximum).`;
    if (seen.has(label.toLowerCase())) return `Le nom « ${label} » est utilisé deux fois dans le conditionnement.`;
    seen.add(label.toLowerCase());
    if (typeof p.contains !== 'number' || !Number.isFinite(p.contains) || p.contains <= 0) {
      return `« ${label} » doit contenir une quantité supérieure à zéro.`;
    }
    if (i < packs.length - 1 && !Number.isInteger(p.contains)) {
      return `« ${label} » doit contenir un nombre entier de « ${packs[i + 1].label || 'niveau suivant'} ».`;
    }
  }
  return null;
}

/** Découpe une quantité de base en emballages entiers : [{label, n}] + reste en base. */
export function breakdown(baseQty, packs) {
  const parts = [];
  let rem = round6(baseQty);
  for (let i = 0; i < packs.length; i++) {
    const per = baseOfPack(packs, i);
    const n = Math.floor(rem / per + 1e-9);
    if (n > 0) parts.push({ label: packs[i].label, n });
    rem = round6(rem - n * per);
  }
  return { parts, rest: rem < 1e-9 ? 0 : rem };
}

/**
 * Convertit (qty, unit) vers l'unité de base de l'ingrédient.
 *
 * ing : { name, family, density (g/ml) | null, pieceG (g par pièce) | null,
 *         packs: [{label, contains}], equivs: Map<unité, quantité de base pour 1 unité> }
 * measures : Map<code, { label, ml }>
 * Codes d'unité : métriques (g, kg, ml, l, piece…), mesures (cc, cs, tasse… ou personnalisées),
 *                 « pack:N » (niveau N de la chaîne de conditionnement).
 */
export function toBase(ing, measures, qty, unit) {
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return { ok: false, reason: 'La quantité doit être un nombre.' };
  if (qty < 0) return { ok: false, reason: 'La quantité ne peut pas être négative.' };
  const packs = ing.packs || [];

  if (typeof unit === 'string' && unit.startsWith('pack:')) {
    const d = Number(unit.slice(5));
    if (!Number.isInteger(d) || d < 0 || d >= packs.length) return { ok: false, reason: `Conditionnement inconnu pour « ${ing.name} ».` };
    return { ok: true, base: round6(qty * baseOfPack(packs, d)) };
  }
  if (ing.equivs?.has(unit)) return { ok: true, base: round6(qty * ing.equivs.get(unit)) };

  let dim, amt, unitLabel;
  if (METRIC[unit]) { dim = METRIC[unit].dim; amt = qty * METRIC[unit].f; unitLabel = METRIC[unit].label; }
  else if (measures?.has(unit)) { dim = 'vol'; amt = qty * measures.get(unit).ml; unitLabel = measures.get(unit).label; }
  else return { ok: false, reason: `Unité inconnue : « ${unit} ».` };

  const target = famDim(ing.family);
  if (dim === target) return { ok: true, base: round6(amt) };

  const baseLabel = BASE[ing.family].label;
  const missingDensity = `Impossible de convertir « ${unitLabel} » en ${baseLabel} pour « ${ing.name} » : indiquez sa densité (poids de 1 ml) ou ce que pèse une ${unitLabel} de ${ing.name}.`;
  const missingPiece = `Impossible de convertir « ${unitLabel} » en ${baseLabel} pour « ${ing.name} » : indiquez le poids d'une pièce.`;

  // passage par le poids en grammes
  let grams;
  if (dim === 'mass') grams = amt;
  else if (dim === 'vol') { if (!ing.density) return { ok: false, reason: missingDensity }; grams = amt * ing.density; }
  else { if (!ing.pieceG) return { ok: false, reason: missingPiece }; grams = amt * ing.pieceG; }

  if (target === 'mass') return { ok: true, base: round6(grams) };
  if (target === 'vol') { if (!ing.density) return { ok: false, reason: missingDensity }; return { ok: true, base: round6(grams / ing.density) }; }
  if (!ing.pieceG) return { ok: false, reason: missingPiece };
  return { ok: true, base: round6(grams / ing.pieceG) };
}

/** Liste des unités utilisables pour cet ingrédient (celles dont la conversion est possible). */
export function unitOptions(ing, measures) {
  const out = [];
  const packs = ing.packs || [];
  packs.forEach((p, i) => out.push({ code: `pack:${i}`, label: p.label, kind: 'pack' }));
  for (const [code, m] of Object.entries(METRIC)) {
    if (code === 'mg' && ing.family !== 'mass') continue;
    if (toBase(ing, measures, 1, code).ok) out.push({ code, label: m.label, kind: 'metric' });
  }
  for (const [code, m] of measures || []) {
    if (toBase(ing, measures, 1, code).ok) out.push({ code, label: m.label, kind: 'measure' });
  }
  return out;
}

/** Libellé court d'une quantité de base, en français. */
export function fmtBase(q, family) {
  const n = (x, d = 3) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(round6(x));
  if (family === 'mass') return Math.abs(q) >= 1000 ? `${n(q / 1000)} kg` : `${n(q, 2)} g`;
  if (family === 'volume') return Math.abs(q) >= 1000 ? `${n(q / 1000)} l` : `${n(q, 2)} ml`;
  return `${n(q, 2)} ${Math.abs(q) > 1 ? 'pièces' : 'pièce'}`;
}

export const fmtMoney = (x, cur = '€', d = 2) => `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(x)} ${cur}`;

/**
 * Repères courants, proposés (jamais appliqués sans que la personne les voie).
 * Valeurs indicatives, à vérifier en pesant son propre produit.
 */
export const SUGGESTIONS = [
  { match: /farine/i, family: 'mass', equivs: { tasse: 120 }, note: '1 tasse ≈ 120 g' },
  { match: /sucre/i, family: 'mass', equivs: { tasse: 200 }, note: '1 tasse ≈ 200 g' },
  { match: /\bsel\b/i, family: 'mass', equivs: { cc: 6 }, note: '1 c. à café ≈ 6 g' },
  { match: /\briz\b/i, family: 'mass', equivs: { tasse: 190 }, note: '1 tasse ≈ 190 g' },
  { match: /beurre/i, family: 'mass', equivs: { cs: 14 }, note: '1 c. à soupe ≈ 14 g' },
  { match: /huile/i, family: 'volume', density: 0.92, note: 'densité ≈ 0,92' },
  { match: /\blait\b/i, family: 'volume', density: 1.03, note: 'densité ≈ 1,03' },
  { match: /\beau\b/i, family: 'volume', density: 1, note: 'densité 1' },
  { match: /\boeufs?\b|\bœufs?\b/i, family: 'count', pieceG: 60, note: '1 œuf ≈ 60 g' },
];
export const suggestFor = (name) => SUGGESTIONS.find((s) => s.match.test(name)) || null;
