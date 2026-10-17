// Moteur de promotions : fonction pure, utilisée par le serveur ET par l'écran de caisse (mode hors-ligne compris),
// pour que le total affiché soit exactement le total enregistré. Tous les montants sont en centimes entiers.

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Distribution au plus grand reste (somme exacte). */
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length || sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** La promotion est-elle valable à ce moment ? at = { day:'AAAA-MM-JJ', weekday:0-6 (0 = dimanche), minutes:0-1439 } */
export function isActiveAt(p, at) {
  if (!p.active) return false;
  if (p.starts_on && at.day < p.starts_on) return false;
  if (p.ends_on && at.day > p.ends_on) return false;
  if (p.weekdays && p.weekdays !== '' && !String(p.weekdays).split(',').map((x) => x.trim()).includes(String(at.weekday))) return false;
  if (p.time_from && p.time_to) {
    const a = toMin(p.time_from), b = toMin(p.time_to);
    if (a <= b ? !(at.minutes >= a && at.minutes < b) : !(at.minutes >= a || at.minutes < b)) return false; // b < a : après minuit
  }
  return true;
}

const eligible = (p, u) => (p.scope === 'all' ? true : p.scope === 'product' ? u.product_id === p.product_id : norm(u.category) === norm(p.category));

function evaluate(p, units) {
  const el = units.filter((u) => !u.used && eligible(p, u));
  const alloc = new Map();
  let used = [];
  if (p.type === 'bogo') {
    const buy = p.buy_qty, free = p.free_qty, g = buy + free;
    const n = Math.floor(el.length / g);
    if (!n) return null;
    const group = [...el].sort((a, b) => b.price - a.price || a.i - b.i).slice(0, n * g);
    const freeUnits = [...group].sort((a, b) => a.price - b.price || b.i - a.i).slice(0, n * free);
    for (const u of freeUnits) alloc.set(u.i, u.price);
    used = group;
  } else if (p.type === 'bundle') {
    const q = p.bundle_qty;
    const k = Math.floor(el.length / q);
    if (!k) return null;
    const chosen = [...el].sort((a, b) => a.price - b.price || a.i - b.i).slice(0, k * q); // les moins chers : prudent pour le commerce
    const d = chosen.reduce((s, u) => s + u.price, 0) - k * p.bundle_price_cents;
    if (d <= 0) return null;
    const parts = allocate(d, chosen.map((u) => u.price));
    chosen.forEach((u, j) => alloc.set(u.i, parts[j]));
    used = chosen;
  } else if (p.type === 'percent') {
    for (const u of el) alloc.set(u.i, Math.round((u.price * p.percent) / 100));
    used = el;
  } else if (p.type === 'amount') {
    for (const u of el) alloc.set(u.i, Math.min(u.price, p.amount_cents));
    used = el;
  } else return null;
  const total = [...alloc.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return { total, alloc, used };
}

/**
 * lines : [{ key, product_id, category, qty (entier), price_cents }]
 * Retourne { discounts: { [key]: cents }, labels: { [key]: [noms] }, applied: [{ promo_id, name, discount_cents }], total }
 * Une unité ne profite que d'une seule promotion : on retient à chaque tour celle qui fait le plus gagner au client.
 */
export function applyPromos(lines, promos, at) {
  const units = [];
  for (const l of lines) for (let j = 0; j < l.qty; j++) units.push({ i: units.length, key: l.key, product_id: l.product_id, category: l.category, price: l.price_cents, used: false });
  const discounts = Object.fromEntries(lines.map((l) => [l.key, 0]));
  const labels = Object.fromEntries(lines.map((l) => [l.key, []]));
  const applied = [];
  let pool = promos.filter((p) => isActiveAt(p, at));
  for (;;) {
    let best = null;
    for (const p of pool) {
      const r = evaluate(p, units);
      if (r && (!best || r.total > best.r.total || (r.total === best.r.total && p.id < best.p.id))) best = { p, r };
    }
    if (!best) break;
    for (const u of best.r.used) u.used = true;
    for (const [i, d] of best.r.alloc) {
      const u = units[i];
      discounts[u.key] += d;
      if (!labels[u.key].includes(best.p.name)) labels[u.key].push(best.p.name);
    }
    applied.push({ promo_id: best.p.id, name: best.p.name, discount_cents: best.r.total });
    pool = pool.filter((p) => p !== best.p);
  }
  return { discounts, labels, applied, total: applied.reduce((s, a) => s + a.discount_cents, 0) };
}

/** Décomposition d'une date/heure ISO dans un fuseau, pour isActiveAt. */
export function atOf(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: wd, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
