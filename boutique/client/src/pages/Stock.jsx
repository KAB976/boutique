import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Modal, ErrorBox, Notice, useAsync, money, perUnit, fmtDay } from '../ui.jsx';
import IngredientForm from './IngredientForm.jsx';
import { Receive, Loss, Inventory, Journal, Alerts, Pending } from './StockOps.jsx';

function Detail({ id, can, measures, onClose, onEdit, onChanged }) {
  const [d, setD] = useState(null);
  const { error, setError, run, busy } = useAsync();
  const load = useCallback(() => api.get(`/api/ingredients/${id}`).then(setD).catch((e) => setError(e.message)), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const toggle = () => run(async () => { await api.patch(`/api/ingredients/${id}`, { active: !d.active }); await load(); onChanged(); });
  return (
    <Modal title={d ? d.name : 'Ingrédient'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {d && (
        <>
          <p><strong>{d.stockText}</strong>{d.breakdownText && <span className="muted"> — {d.breakdownText}</span>}{!d.active && <span className="badge">archivé</span>}</p>
          <div className="tiles">
            {can.costs && <div className="tile card"><strong>{perUnit(d.avg_cost || null, d.family)}</strong><span>Coût moyen</span></div>}
            {can.costs && <div className="tile card"><strong>{money(d.value)}</strong><span>Valeur du stock</span></div>}
            {can.prices && <div className="tile card"><strong>{perUnit(d.last_price, d.family)}</strong><span>Dernier prix d'achat</span></div>}
          </div>
          <h3>Lots en stock</h3>
          {d.lots.length === 0 ? <p className="muted">Aucun lot.</p> : (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>Reçu le</th><th>Reste</th><th>À consommer avant</th></tr></thead>
              <tbody>{d.lots.map((l) => <tr key={l.moveId}><td>{fmtDay(l.ts)}</td><td>{l.remainingText}</td><td>{l.expiry ? fmtDay(l.expiry) : <span className="muted">non daté</span>}</td></tr>)}</tbody></table></div>
          )}
          {can.prices && d.priceHistory?.length > 0 && (
            <>
              <h3>Évolution du prix d'achat</h3>
              <div className="table-wrap"><table className="responsive"><thead><tr><th>Date</th><th>Prix</th></tr></thead>
                <tbody>{d.priceHistory.map((p) => <tr key={p.id}><td>{fmtDay(p.ts)}</td><td>{perUnit(p.unit_cost, d.family)}</td></tr>)}</tbody></table></div>
            </>
          )}
          {(d.category || d.storage || d.notes) && <p className="muted">{[d.category, d.storage, d.notes].filter(Boolean).join(' · ')}</p>}
          <div className="actions">
            {can.edit && <button onClick={() => onEdit(d)}>Modifier</button>}
            {can.edit && <button onClick={toggle} disabled={busy}>{d.active ? 'Archiver' : 'Restaurer'}</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

function List({ data, measures, reload }) {
  const { items, can } = data;
  const [q, setQ] = useState('');
  const [flt, setFlt] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null); // null | 'new' | ingrédient
  const [all, setAll] = useState(null);
  useEffect(() => { if (showArchived) api.get('/api/stock?archived=1').then((d) => setAll(d.items)).catch(() => setAll(null)); }, [showArchived, items]);
  const rows = useMemo(() => (showArchived && all ? all : items).filter((i) => {
    if (q && !i.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
    if (flt === 'low') return i.low;
    if (flt === 'exp') return i.nextExpiry && i.nextExpiry.daysLeft <= data.expiryDays;
    return true;
  }), [items, all, q, flt, showArchived, data.expiryDays]);
  return (
    <section className="card">
      <div className="row-between">
        <h2>Ingrédients ({rows.length})</h2>
        {can.edit && <button className="primary" onClick={() => setEdit('new')}>+ Nouvel ingrédient</button>}
      </div>
      <input type="search" aria-label="Rechercher" placeholder="Rechercher un ingrédient…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        {[['all', 'Tous'], ['low', 'Stock bas'], ['exp', 'À consommer vite']].map(([k, l]) => <button key={k} className={`chip${flt === k ? ' on' : ''}`} onClick={() => setFlt(k)}>{l}</button>)}
        {can.edit && <button className={`chip${showArchived ? ' on' : ''}`} onClick={() => setShowArchived(!showArchived)}>Archivés</button>}
      </div>
      {items.length === 0 && <Notice>Aucun ingrédient pour l'instant.{can.edit ? ' Commencez par « Nouvel ingrédient ».' : ''}</Notice>}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th>Ingrédient</th><th>Stock</th>{can.costs && <th>Valeur</th>}<th>Alertes</th><th /></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'off'}>
                  <td><strong>{i.name}</strong>{i.category && <div className="muted">{i.category}</div>}</td>
                  <td>{i.stockText}{i.breakdownText && <div className="muted">{i.breakdownText}</div>}</td>
                  {can.costs && <td className="nowrap">{money(i.value)}</td>}
                  <td>
                    {i.empty ? <span className="badge warn">vide</span> : i.low ? <span className="badge warn">stock bas</span> : null}
                    {i.nextExpiry && i.nextExpiry.daysLeft <= data.expiryDays && <span className="badge warn">{i.nextExpiry.daysLeft < 0 ? 'périmé' : i.nextExpiry.daysLeft === 0 ? 'périme aujourd\'hui' : `périme dans ${i.nextExpiry.daysLeft} j`}</span>}
                    {!i.active && <span className="badge">archivé</span>}
                  </td>
                  <td className="right"><button onClick={() => setOpen(i.id)}>Détail</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <Detail id={open} can={can} measures={measures} usedCategories={items.map((i) => i.category)} onClose={() => setOpen(null)} onEdit={(d) => { setOpen(null); setEdit(d); }} onChanged={reload} />}
      {edit && <IngredientForm ing={edit === 'new' ? null : edit} measures={measures} usedCategories={items.map((i) => i.category)} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </section>
  );
}

const VIEWS = [
  ['list', 'Ingrédients'], ['receive', 'Réception'], ['loss', 'Perte'], ['inventory', 'Inventaire'], ['alerts', 'Alertes'], ['pending', 'Prix à compléter'], ['journal', 'Journal'],
];

export default function Stock() {
  const [data, setData] = useState(null);
  const [measures, setMeasures] = useState([]);
  const [alertsData, setAlertsData] = useState(null);
  const [view, setView] = useState('list');
  const [err, setErr] = useState('');
  const reload = useCallback(async () => {
    try {
      const [d, m, a] = await Promise.all([api.get('/api/stock'), api.get('/api/measures'), api.get('/api/stock/alerts')]);
      setData(d); setMeasures(m); setAlertsData(a); setErr('');
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  if (!data) return <div className="card"><ErrorBox error={err} /><p className="muted">Chargement…</p></div>;
  const { can, counts } = data;
  const views = VIEWS.filter(([k]) => {
    if (['receive', 'loss', 'inventory'].includes(k)) return can.move;
    if (k === 'pending') return can.price;
    return true;
  });
  const badge = { alerts: (counts.low || 0) + (alertsData?.expiring?.length || 0) + (counts.priceRises || 0), pending: counts.pricePending || 0 };
  const props = { data, measures, reload, alerts: alertsData };
  return (
    <div className="stack">
      <ErrorBox error={err} />
      <div className="chips" role="tablist" aria-label="Stock">
        {views.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} className={`chip${view === k ? ' on' : ''}`} onClick={() => setView(k)}>
            {l}{badge[k] > 0 && <span className="count">{badge[k]}</span>}
          </button>
        ))}
      </div>
      {view === 'list' && <List {...props} />}
      {view === 'receive' && <Receive {...props} onDone={() => { reload(); }} />}
      {view === 'loss' && <Loss {...props} onDone={reload} />}
      {view === 'inventory' && <Inventory {...props} onDone={reload} />}
      {view === 'alerts' && <Alerts {...props} />}
      {view === 'pending' && <Pending {...props} onDone={reload} />}
      {view === 'journal' && <Journal {...props} />}
    </div>
  );
}
