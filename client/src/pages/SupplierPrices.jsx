import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, parseEuros, toEuroInput, fmtD } from '../money.js';
import { toBase } from '../../../shared/units.js';
import { usableUnits } from '../unitsUi.js';

const PER = { mass: 'kg', volume: 'l', count: 'pièce' };
const SCALE = { mass: 1000, volume: 1000, count: 1 };
const num = (s) => Number(String(s ?? '').replace(',', '.'));
const unitLabel = (units, code) => units.find(([c]) => c === code)?.[1] ?? code;
export const eur2 = (cents) => `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} €`;

/** Un ingrédient « en forme » pour le calcul partagé (même règles que le serveur). */
function ingLike(f) {
  return {
    name: f.name || 'cet ingrédient', family: f.family, density: num(f.density) > 0 ? num(f.density) : null, pieceG: num(f.piece_g) > 0 ? num(f.piece_g) : null,
    packs: f.packs.map((p) => ({ label: p.label, contains: num(p.contains) })), equivs: new Map(),
  };
}
/** Prix ramené au kg / litre / pièce, ou null si on ne sait pas calculer encore. */
export function perUnitCents(f, row) {
  const cents = parseEuros(row.price);
  const q = num(row.qty);
  if (!(cents >= 0) || !(q > 0) || row.price.trim() === '') return null;
  const r = toBase(ingLike(f), new Map(), q, row.unit);
  return r.ok && r.base > 0 ? (cents / r.base) * SCALE[f.family] : null;
}

/** Contrôle avant d'enregistrer ; retourne un message ou null. */
export function validatePriceRows(rows, f) {
  const seen = new Set();
  for (const r of rows) {
    if (!r.supplier_id && r.price.trim() === '') continue; // ligne vide : ignorée
    if (!r.supplier_id) return 'Prix par fournisseur : choisissez le fournisseur de chaque ligne.';
    if (seen.has(r.supplier_id)) return 'Prix par fournisseur : un fournisseur ne peut apparaître qu\'une fois.';
    seen.add(r.supplier_id);
    if (r.price.trim() === '' || !(parseEuros(r.price) >= 0)) return 'Prix par fournisseur : indiquez un prix valide (ex. 12,50).';
    if (!(num(r.qty) > 0)) return 'Prix par fournisseur : indiquez la quantité vendue pour ce prix (ex. 5 kg).';
    if (perUnitCents(f, r) == null) return 'Prix par fournisseur : cette unité n\'est pas utilisable pour cet ingrédient (complétez la densité ou le conditionnement).';
  }
  return null;
}
export const savePriceRows = (ingId, rows) => api.put(`/api/ingredients/${ingId}/prices`, {
  prices: rows.filter((r) => r.supplier_id).map((r) => ({ supplier_id: Number(r.supplier_id), price_cents: parseEuros(r.price), qty: num(r.qty), unit: r.unit, note: r.note ?? '' })),
});
export const rowsFromServer = (items) => items.map((x) => ({ supplier_id: String(x.supplier_id), price: toEuroInput(x.price_cents), qty: String(x.qty).replace('.', ','), unit: x.unit, note: x.note ?? '' }));

/** Tableau « fournisseur / prix / pour quelle quantité » avec le prix au kg (ou litre, pièce) calculé en direct. */
export function PricesEditor({ f, rows, setRows, available }) {
  const [suppliers, setSuppliers] = useState(null);
  useEffect(() => { api.get('/api/suppliers').then((r) => { setSuppliers(r.items.filter((s) => s.active)); available?.(true); }).catch(() => { setSuppliers(false); available?.(false); }); }, []); // eslint-disable-line
  const units = usableUnits(f);
  const defUnit = units.find(([c]) => c === (f.family === 'count' ? 'piece' : PER[f.family] === 'l' ? 'l' : 'kg'))?.[0] ?? units[0][0];
  const upd = (i, p) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const per = rows.map((r) => perUnitCents(f, r));
  const best = Math.min(...per.filter((x, i) => x != null && rows[i].supplier_id));
  if (suppliers === false) return null; // pas le droit : la section n'apparaît pas
  return (
    <>
      <h3>Prix par fournisseur <span className="muted">(facultatif)</span></h3>
      <p className="muted">Notez ce que chaque fournisseur vous demande et pour quelle quantité (ex. « Metro : 12,50 € pour 5 kg »). Le prix au {PER[f.family]} est calculé pour comparer.</p>
      {suppliers && suppliers.length === 0 && <Notice tone="info">Créez d'abord vos fournisseurs (Clients et achats › Fournisseurs).</Notice>}
      {rows.map((r, i) => (
        <div className="price-row" key={i}>
          <select aria-label={`Fournisseur ${i + 1}`} value={r.supplier_id} onChange={(e) => upd(i, { supplier_id: e.target.value })}>
            <option value="">— Fournisseur —</option>
            {(suppliers || []).map((s) => <option key={s.id} value={s.id} disabled={rows.some((x, j) => j !== i && x.supplier_id === String(s.id))}>{s.name}</option>)}
          </select>
          <input aria-label={`Prix ${i + 1} (€)`} inputMode="decimal" placeholder="Prix €" value={r.price} onChange={(e) => upd(i, { price: e.target.value })} />
          <span className="muted">pour</span>
          <input aria-label={`Quantité ${i + 1}`} inputMode="decimal" placeholder="Qté" value={r.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
          <select aria-label={`Unité ${i + 1}`} value={r.unit} onChange={(e) => upd(i, { unit: e.target.value })}>{units.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select>
          <strong className={per[i] != null && per[i] === best && r.supplier_id && rows.filter((x) => x.supplier_id).length > 1 ? 'ok' : ''} aria-label={`Prix au ${PER[f.family]} ${i + 1}`}>{per[i] != null ? `= ${eur2(per[i])} / ${PER[f.family]}` : ''}</strong>
          <button type="button" className="icon" aria-label="Retirer ce prix" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, { supplier_id: '', price: '', qty: '1', unit: defUnit, note: '' }])} disabled={!suppliers?.length || rows.length >= (suppliers?.length ?? 0)}>+ Ajouter un fournisseur</button>
    </>
  );
}

/** Fenêtre autonome : ne modifie que les prix d'un ingrédient (depuis la page de comparaison). */
function PricesModal({ ingId, onClose, onSaved }) {
  const [ing, setIng] = useState(null);
  const [rows, setRows] = useState(null);
  const { busy, error, setError, run } = useAsync();
  useEffect(() => {
    Promise.all([api.get(`/api/ingredients/${ingId}`), api.get(`/api/ingredients/${ingId}/prices`)]).then(([i, p]) => {
      setIng({ name: i.name, family: i.family, density: i.density ?? '', piece_g: i.piece_g ?? '', packs: (i.packs ?? []).map((q) => ({ label: q.label, contains: q.contains })) });
      setRows(rowsFromServer(p.items));
    }).catch((e) => setError(e.message));
  }, [ingId, setError]);
  const save = () => run(async () => {
    const msg = validatePriceRows(rows, ing); if (msg) throw new Error(msg);
    await savePriceRows(ingId, rows); onSaved(); onClose();
  });
  return (
    <Modal title={ing ? `Prix de ${ing.name}` : 'Prix'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {ing && rows && <PricesEditor f={ing} rows={rows} setRows={setRows} />}
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !rows} onClick={save}>Enregistrer les prix</button></div>
    </Modal>
  );
}

/** Page « Comparer les prix » : pour chaque ingrédient, les fournisseurs du moins cher au plus cher. */
export default function PriceCompare({ canEdit = true }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [all, setAll] = useState(null);
  const { error, setError } = useAsync();
  const load = useCallback(() => {
    api.get('/api/prices/compare').then(setData).catch((e) => setError(e.message));
    api.get('/api/stock').then((s) => setAll(s.items.filter((i) => i.active))).catch(() => {});
  }, []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const rows = useMemo(() => (data?.items ?? []).filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);
  const without = (all ?? []).filter((i) => !(data?.items ?? []).some((x) => x.ingredient_id === i.id));
  return (
    <section className="card">
      <div className="row-between"><h1>Comparer les prix</h1></div>
      <p className="muted">Pour chaque ingrédient, le prix de chaque fournisseur ramené au kg, au litre ou à la pièce : achetez là où c'est le moins cher.</p>
      <ErrorBox error={error} />
      <input aria-label="Rechercher un ingrédient" placeholder="Rechercher un ingrédient…" value={q} onChange={(e) => setQ(e.target.value)} />
      {data && data.items.length === 0 && <Notice tone="info">Aucun prix enregistré. Ajoutez-en depuis la fiche d'un ingrédient (Cuisine et stock › Stock › Modifier › Prix par fournisseur), ou avec « Ajouter des prix » ci-dessous.</Notice>}
      {rows.map((x) => (
        <div className="line-card" key={x.ingredient_id}>
          <div className="row-between">
            <div><strong>{x.name}</strong> {x.category && <span className="muted small">· {x.category}</span>}
              {x.last_paid_cents != null && <div className="muted small">Dernier prix payé à la réception : {eur2(x.last_paid_cents)} / {x.per_label}</div>}</div>
            {canEdit && <button onClick={() => setEdit(x.ingredient_id)}>Modifier les prix</button>}
          </div>
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Fournisseur</th><th>Prix demandé</th><th>Au {x.per_label}</th><th /></tr></thead><tbody>
            {x.items.map((it) => (
              <tr key={it.supplier_id} className={it.supplier_active ? '' : 'off'}>
                <td><strong>{it.supplier_name}</strong>{!it.supplier_active && <span className="badge">inactif</span>}<div className="muted small">à jour le {fmtD(String(it.updated_at).slice(0, 10))}</div></td>
                <td>{eur(it.price_cents)} <span className="muted">pour {String(it.qty).replace('.', ',')} {it.unit_label || it.unit}</span></td>
                <td><strong>{eur2(it.per_cents)}</strong> / {it.per_label}</td>
                <td>{it.cheapest ? <span className="badge ok">Moins cher</span> : it.over_pct > 0 ? <span className="badge warn">+ {String(it.over_pct).replace('.', ',')} %</span> : null}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      ))}
      {canEdit && without.length > 0 && (
        <p><select aria-label="Ajouter des prix" value="" onChange={(e) => e.target.value && setEdit(Number(e.target.value))}>
          <option value="">+ Ajouter des prix pour un ingrédient…</option>
          {without.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select></p>
      )}
      {edit && <PricesModal ingId={edit} onClose={() => setEdit(null)} onSaved={load} />}
    </section>
  );
}
