/** Unités utilisables pour saisir une quantité d'un ingrédient en cours de création (celles de sa famille, l'autre dimension si connue, et ses conditionnements). */
export const DEFAULT_TH = { mass: 'kg', volume: 'l', count: 'piece' };
/** Unités proposées pour l'alerte : celles de la famille, + l'autre dimension si la densité est connue, + les conditionnements. */
export function usableUnits(f) {
  const own = { mass: [['g', 'g'], ['kg', 'kg']], volume: [['ml', 'ml'], ['l', 'l']], count: [['piece', 'pièce']] }[f.family];
  const hasDensity = Number(String(f.density).replace(',', '.')) > 0;
  const hasPiece = Number(String(f.piece_g).replace(',', '.')) > 0;
  const out = [...own];
  if (hasDensity && f.family === 'mass') out.push(['ml', 'ml'], ['l', 'l']);
  if (hasDensity && f.family === 'volume') out.push(['g', 'g'], ['kg', 'kg']);
  if (hasPiece && f.family !== 'count') out.push(['piece', 'pièce']);
  if (hasPiece && f.family === 'count') out.push(['g', 'g'], ['kg', 'kg']);
  f.packs.forEach((p, i) => { if (p.label.trim()) out.push([`pack:${i}`, p.label.trim()]); });
  return out;
}
