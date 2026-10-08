import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Field, ErrorBox, Notice, useAsync, money, perUnit, fmtDay, fmtDate, TYPE_FR } from '../ui.jsx';

const defaultUnit = (it) => (it.packs?.length ? `pack:${Math.min(it.purchase_depth, it.packs.length - 1)}` : it.units[0]?.code ?? '');
const UnitSelect = ({ item, value, onChange, label = 'Unité' }) => (
  <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={!item}>
    {(item?.units ?? []).map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
  </select>
);
const active = (items) => items.filter((i) => i.active);

// ---------------------------------------------------------------- réception
const emptyLine = () => ({ ingredient_id: '', qty: '', unit: '', total_price: '', expiry: '' });

export function Receive({ data, onDone }) {
  const items = active(data.items);
  const byId = (id) => items.find((i) => i.id === Number(id));
  const [lines, setLines] = useState([emptyLine()]);
  const [ref, setRef] = useState('');
  const [result, setResult] = useState(null);
  const { busy, error, run } = useAsync();
  const upd = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i, id) => { const it = byId(id); upd(i, { ingredient_id: id, unit: it ? defaultUnit(it) : '' }); };
  const filled = lines.filter((l) => l.ingredient_id || l.qty);
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const payload = filled.map((l) => ({
        ingredient_id: Number(l.ingredient_id), qty: l.qty, unit: l.unit,
        ...(data.can.price && l.total_price !== '' ? { total_price: l.total_price } : {}), ...(l.expiry ? { expiry: l.expiry } : {}),
      }));
      const r = await api.post('/api/stock/receipts', { lines: payload, ref: ref || undefined });
      setResult(r); setLines([emptyLine()]); setRef(''); onDone();
    });
  };
  return (
    <section className="card">
      <h2>Réception de marchandises</h2>
      <p className="muted">Ce que vous venez d'acheter ou de recevoir. {data.can.price ? 'Le prix total payé pour la ligne met à jour le coût moyen.' : 'Vous n\'avez pas à saisir les prix : le gérant les complétera.'}</p>
      <ErrorBox error={error} />
      {result && (
        <Notice tone="ok">
          Réception enregistrée ({result.lines.length} ligne{result.lines.length > 1 ? 's' : ''}).
          {result.lines.map((l) => <div key={l.moveId}>{l.ingredient} : +{l.entered} → stock {l.stockText}{l.priceRise && <strong> ⚠ prix en hausse de {Math.round(l.priceRise.pct)} %</strong>}{l.pricePending && ' (prix à compléter)'}</div>)}
        </Notice>
      )}
      <form onSubmit={submit}>
        {lines.map((l, i) => {
          const it = byId(l.ingredient_id);
          return (
            <div className="line-card" key={i}>
              <div className="grid">
                <Field label="Ingrédient">
                  <select value={l.ingredient_id} onChange={(e) => pick(i, e.target.value)}>
                    <option value="">— choisir —</option>
                    {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </Field>
                <Field label="Quantité reçue">
                  <div className="inline"><input inputMode="decimal" aria-label="Quantité" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
                    <UnitSelect item={it} value={l.unit} onChange={(u) => upd(i, { unit: u })} /></div>
                </Field>
                {data.can.price && <Field label="Prix total payé (€)"><input inputMode="decimal" value={l.total_price} onChange={(e) => upd(i, { total_price: e.target.value })} /></Field>}
                <Field label="À consommer avant" hint="Facultatif."><input type="date" value={l.expiry} onChange={(e) => upd(i, { expiry: e.target.value })} /></Field>
              </div>
              {lines.length > 1 && <button type="button" className="link" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Retirer cette ligne</button>}
            </div>
          );
        })}
        <button type="button" onClick={() => setLines([...lines, emptyLine()])}>+ Ajouter une ligne</button>
        <Field label="Référence" hint="Facultatif : fournisseur, n° de facture…"><input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} /></Field>
        <div className="actions sticky"><button className="primary" disabled={busy || !filled.length}>Enregistrer la réception</button></div>
      </form>
    </section>
  );
}

// -------------------------------------------------------------------- perte
export function Loss({ data, onDone }) {
  const items = active(data.items);
  const [f, setF] = useState({ ingredient_id: '', qty: '', unit: '', reason: '', note: '' });
  const [done, setDone] = useState('');
  const { busy, error, run } = useAsync();
  const it = items.find((i) => i.id === Number(f.ingredient_id));
  const set = (patch) => { setDone(''); setF((x) => ({ ...x, ...patch })); };
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/api/stock/losses', { ...f, ingredient_id: Number(f.ingredient_id) });
      setDone(`Perte enregistrée : ${r.ingredient}, il reste ${r.stockText}${r.value != null ? ` (perte valorisée ${money(r.value)})` : ''}.`);
      setF({ ingredient_id: '', qty: '', unit: '', reason: '', note: '' }); onDone();
    });
  };
  return (
    <section className="card narrow-wide">
      <h2>Déclarer une perte</h2>
      <p className="muted">Périmé, cassé, jeté, donné… Le stock diminue et le motif est conservé.</p>
      <ErrorBox error={error} /><Notice tone="ok">{done}</Notice>
      <form onSubmit={submit}>
        <Field label="Ingrédient">
          <select value={f.ingredient_id} onChange={(e) => set({ ingredient_id: e.target.value, unit: items.find((i) => i.id === Number(e.target.value))?.units[0]?.code ?? '' })}>
            <option value="">— choisir —</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.stockText})</option>)}
          </select>
        </Field>
        <Field label="Quantité perdue"><div className="inline"><input inputMode="decimal" value={f.qty} onChange={(e) => set({ qty: e.target.value })} /><UnitSelect item={it} value={f.unit} onChange={(unit) => set({ unit })} /></div></Field>
        <Field label="Motif">
          <select value={f.reason} onChange={(e) => set({ reason: e.target.value })}>
            <option value="">— choisir —</option>{Object.entries(data.lossReasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Précision" hint={f.reason === 'autre' ? 'Obligatoire pour « autre ».' : 'Facultatif.'}><input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={200} /></Field>
        <div className="actions"><button className="primary" disabled={busy || !f.ingredient_id || !f.qty || !f.reason}>Enregistrer la perte</button></div>
      </form>
    </section>
  );
}

// --------------------------------------------------------------- inventaire
export function Inventory({ data, onDone }) {
  const items = active(data.items);
  const [counts, setCounts] = useState({}); // id -> [{qty, unit}]
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState(null);
  const { busy, error, run } = useAsync();
  const partsOf = (it) => counts[it.id] ?? [{ qty: '', unit: it.units[0]?.code ?? '' }];
  const setParts = (it, parts) => { setPreview(null); setDone(null); setCounts((c) => ({ ...c, [it.id]: parts })); };
  const payload = useMemo(() => items.map((it) => ({ ingredient_id: it.id, parts: (counts[it.id] ?? []).filter((p) => p.qty !== '').map((p) => ({ qty: p.qty, unit: p.unit })) })).filter((c) => c.parts.length), [counts, items]);
  const visible = items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const doPreview = () => run(async () => setPreview(await api.post('/api/stock/inventory/preview', { counts: payload })));
  const commit = () => run(async () => { const r = await api.post('/api/stock/inventory', { counts: payload, note: note || undefined }); setDone(r); setPreview(null); setCounts({}); setNote(''); onDone(); });
  return (
    <section className="card">
      <h2>Inventaire guidé</h2>
      <p className="muted">Comptez ce qu'il y a réellement et saisissez-le (vous pouvez mélanger : 2 paquets + 3 sachets). Les ingrédients laissés vides ne sont pas touchés.</p>
      <ErrorBox error={error} />
      {done && <Notice tone="ok">Inventaire enregistré : {done.lines.filter((l) => l.delta !== 0).length} écart(s) corrigé(s) sur {done.lines.length} ingrédient(s) compté(s).</Notice>}
      {!preview ? (
        <>
          <input type="search" aria-label="Rechercher" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
          {visible.map((it) => (
            <div className="line-card" key={it.id}>
              <strong>{it.name}</strong> <span className="muted">— attendu : {it.stockText}</span>
              {partsOf(it).map((p, i) => (
                <div className="inline" key={i}>
                  <input aria-label={`Quantité comptée pour ${it.name}`} inputMode="decimal" value={p.qty} onChange={(e) => setParts(it, partsOf(it).map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                  <UnitSelect item={it} value={p.unit} onChange={(u) => setParts(it, partsOf(it).map((x, j) => (j === i ? { ...x, unit: u } : x)))} />
                </div>
              ))}
              <button type="button" className="link" onClick={() => setParts(it, [...partsOf(it), { qty: '', unit: it.units[0]?.code ?? '' }])}>+ autre unité</button>
            </div>
          ))}
          <div className="actions sticky"><button className="primary" disabled={busy || !payload.length} onClick={doPreview}>Voir les écarts ({payload.length})</button></div>
        </>
      ) : (
        <>
          <h3>Écarts constatés</h3>
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Ingrédient</th><th>Attendu</th><th>Compté</th><th>Écart</th>{data.can.costs && <th>Valeur</th>}</tr></thead>
            <tbody>{preview.lines.map((l) => <tr key={l.ingredient_id}><td>{l.name}</td><td>{l.theoreticalText}</td><td>{l.countedText}</td><td><span className={`badge ${l.delta === 0 ? 'ok' : 'warn'}`}>{l.deltaText}</span></td>{data.can.costs && <td>{money(l.value)}</td>}</tr>)}</tbody></table></div>
          {data.can.costs && <p>Écart total valorisé : <strong>{money(preview.variance)}</strong></p>}
          <Field label="Remarque" hint="Facultatif."><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
          <div className="actions"><button onClick={() => setPreview(null)}>Modifier le comptage</button><button className="primary" disabled={busy} onClick={commit}>Valider l'inventaire</button></div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ journal
export function Journal({ data }) {
  const [type, setType] = useState('');
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const { busy, error, run } = useAsync();
  const load = (reset) => run(async () => {
    const before = reset || !rows.length ? '' : `&beforeId=${rows[rows.length - 1].id}`;
    const r = await api.get(`/api/stock/moves?limit=50${type ? `&type=${type}` : ''}${before}`);
    setRows(reset ? r.rows : [...rows, ...r.rows]); setMore(r.hasMore);
  });
  useEffect(() => { load(true); }, [type]); // eslint-disable-line
  const sign = (q) => (q > 0 ? '+' : q < 0 ? '−' : '');
  return (
    <section className="card">
      <h2>Journal des mouvements</h2>
      <p className="muted">Chaque entrée et sortie de stock. Rien ne s'efface : une erreur se corrige par un nouveau mouvement.</p>
      <div className="chips">{[['', 'Tout'], ['receipt', 'Réceptions'], ['loss', 'Pertes'], ['inventory', 'Inventaires']].map(([k, l]) => <button key={k} className={`chip${type === k ? ' on' : ''}`} onClick={() => setType(k)}>{l}</button>)}</div>
      <ErrorBox error={error} />
      <div className="table-wrap"><table className="responsive"><thead><tr><th>Date</th><th>Mouvement</th><th>Ingrédient</th><th>Quantité</th><th>Stock après</th><th>Par</th></tr></thead>
        <tbody>{rows.map((m) => (
          <tr key={m.id}>
            <td className="nowrap">{fmtDate(m.ts).slice(0, 16)}</td>
            <td>{TYPE_FR[m.type] || m.type}{m.reasonText && <div className="muted">{m.reasonText}</div>}{m.price_pending && <span className="badge warn">prix à compléter</span>}{m.expiry && <div className="muted">avant le {fmtDay(m.expiry)}</div>}{m.note && <div className="muted">{m.note}</div>}</td>
            <td>{m.ingredient}</td>
            <td className="nowrap">{sign(m.qty)}{m.entered || Math.abs(m.qty)}{data.can.costs && m.value != null && <div className="muted">{money(m.value)}</div>}</td>
            <td className="nowrap">{m.stock_after}</td><td>{m.user_name}</td>
          </tr>))}</tbody></table></div>
      {rows.length === 0 && !busy && <p className="muted">Aucun mouvement.</p>}
      {more && <div className="actions"><button onClick={() => load(false)} disabled={busy}>Voir plus ancien</button></div>}
    </section>
  );
}

// ------------------------------------------------------------------ alertes
export function Alerts({ data, alerts }) {
  if (!alerts) return null;
  const none = !alerts.low.length && !alerts.expiring.length && !(alerts.priceRises?.length) && !alerts.pricePending;
  return (
    <section className="card">
      <h2>Alertes</h2>
      {none && <Notice tone="ok">Rien à signaler.</Notice>}
      {alerts.low.length > 0 && (<><h3>Stock bas</h3><ul>{alerts.low.map((l) => <li key={l.id}><strong>{l.name}</strong> — {l.empty ? 'vide' : `reste ${data.items.find((i) => i.id === l.id)?.stockText ?? ''}`}</li>)}</ul></>)}
      {alerts.expiring.length > 0 && (<><h3>À consommer vite</h3><ul>{alerts.expiring.map((l, i) => <li key={i}><strong>{l.name}</strong> — {l.daysLeft < 0 ? `périmé depuis ${-l.daysLeft} j` : l.daysLeft === 0 ? 'périme aujourd\'hui' : `dans ${l.daysLeft} j`} ({fmtDay(l.expiry)})</li>)}</ul></>)}
      {alerts.priceRises?.length > 0 && (<><h3>Prix en hausse</h3><ul>{alerts.priceRises.map((p) => <li key={p.id}><strong>{p.name}</strong> : {perUnit(p.from, p.family)} → {perUnit(p.to, p.family)} (+{Math.round(p.pct)} %)</li>)}</ul></>)}
      {alerts.pricePending > 0 && <p><strong>{alerts.pricePending}</strong> réception(s) attendent leur prix (onglet « Prix à compléter »).</p>}
    </section>
  );
}

// ------------------------------------------------------------ prix à compléter
export function Pending({ onDone }) {
  const [rows, setRows] = useState(null);
  const [price, setPrice] = useState({});
  const { busy, error, run } = useAsync();
  const load = () => api.get('/api/stock/pending-prices').then(setRows);
  useEffect(() => { load().catch(() => setRows([])); }, []);
  const save = (r) => run(async () => { await api.post('/api/stock/price-fix', { move_id: r.id, total_price: price[r.id] }); await load(); onDone(); });
  if (!rows) return <div className="card muted">Chargement…</div>;
  return (
    <section className="card">
      <h2>Prix à compléter</h2>
      <p className="muted">Réceptions faites sans prix. Saisissez le prix total payé pour mettre le coût moyen à jour.</p>
      <ErrorBox error={error} />
      {rows.length === 0 && <Notice tone="ok">Tous les prix sont renseignés.</Notice>}
      {rows.map((r) => (
        <div className="line-card" key={r.id}>
          <strong>{r.name}</strong> <span className="muted">— {r.entered}, reçu le {fmtDay(r.ts)} par {r.user_name}</span>
          <div className="inline"><input inputMode="decimal" aria-label={`Prix total pour ${r.name}`} placeholder="Prix total (€)" value={price[r.id] ?? ''} onChange={(e) => setPrice({ ...price, [r.id]: e.target.value })} />
            <button className="primary" disabled={busy || !price[r.id]} onClick={() => save(r)}>Enregistrer</button></div>
        </div>
      ))}
    </section>
  );
}
