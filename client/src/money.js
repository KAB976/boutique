// Montants : le serveur ne parle qu'en centimes entiers. Ces fonctions convertissent pour l'affichage et la saisie.
const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const eur = (cents) => (cents == null ? '—' : `${nf.format(cents / 100)} €`);
export const eurSigned = (cents) => (cents == null ? '—' : `${cents > 0 ? '+' : ''}${nf.format(cents / 100)} €`);
export const eurReal = (x) => (x == null ? '—' : `${nf.format(x)} €`);

/** « 12,5 » ou « 12.50 » → 1250 ; vide ou invalide → null. */
export function parseEuros(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? Math.round(s * 100) : null;
  const t = String(s ?? '').replace(/\s/g, '').replace('€', '').replace(',', '.');
  if (t === '' || !/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export const toEuroInput = (cents) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));

export const METHODS = { cash: 'Espèces', card: 'Carte', voucher: 'Bon / ticket', credit: 'Ardoise', other: 'Autre' };
export const FLAG_TEXT = {
  offline: 'faite hors-ligne', stock_negative: 'stock insuffisant au moment de la vente', cost_unknown: 'coût inconnu', recipe_incomplete: 'recette incomplète',
  product_inactive: 'article retiré de la vente depuis', price_differs: 'prix différent du catalogue', ts_future: 'heure de l’appareil incorrecte', ts_old: 'vente très ancienne',
  over_limit: 'limite d’ardoise dépassée', refund: 'annulation', after_closure: 'annulation après clôture', no_restock: 'marchandise non remise en stock', offline_gap: 'écart de prix hors-ligne absorbé',
};
let CURRENT_TZ;
/** Fuseau du commerce, fixé une fois connecté : les journées se découpent à son heure, pas à celle de l'appareil. */
export const setShopTz = (tz) => { CURRENT_TZ = tz || undefined; };
export const todayLocal = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || CURRENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const monthStart = (tz) => `${todayLocal(tz).slice(0, 8)}01`;
export const fmtTime = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('fr-FR', { timeZone: tz || CURRENT_TZ, hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
export const fmtDT = (iso, tz) => { try { return new Date(iso).toLocaleString('fr-FR', { timeZone: tz || CURRENT_TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
export const fmtD = (day) => { try { return new Date(`${day}T12:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return day; } };
