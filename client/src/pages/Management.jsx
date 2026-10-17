import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurReal, eurSigned, parseEuros, fmtD, fmtDT, todayLocal, monthStart, METHODS } from '../money.js';
import { cache } from '../offline.js';
const neg = (txt, v) => (Number(v) > 0 ? '−' + txt : txt);

const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const presets = (tz) => {
  const t = todayLocal(tz);
  const ms = monthStart(tz);
  const prevEnd = addDays(ms, -1);
  return [
    ['Aujourd\'hui', t, t], ['Hier', addDays(t, -1), addDays(t, -1)], ['7 jours', addDays(t, -6), t], ['Ce mois', ms, t],
    ['Mois dernier', `${prevEnd.slice(0, 8)}01`, prevEnd], ['Cette année', `${t.slice(0, 4)}-01-01`, t],
  ];
};

function Bars({ rows, label, value, fmt = eur }) {
  const max = Math.max(1, ...rows.map(value));
  return (
    <div className="bars">{rows.map((r, i) => (
      <div className="bar-row" key={i}><span>{label(r)}</span><div><div className="bar" style={{ width: `${(value(r) / max) * 100}%` }} /></div><span className="rtl-right">{fmt(value(r))}</span></div>
    ))}</div>
  );
}

function Dashboard({ tz, shop }) {
  const [from, setFrom] = useState(monthStart(tz));
  const [to, setTo] = useState(todayLocal(tz));
  const [r, setR] = useState(null);
  const { error, setError } = useAsync();
  useEffect(() => { setR(null); api.get(`/api/reports?from=${from}&to=${to}`).then((x) => { setR(x); setError(''); }).catch((e) => setError(e.message)); }, [from, to]); // eslint-disable-line
  const download = async () => {
    try {
      const blob = await api.download(`/api/reports/export.xlsx?from=${from}&to=${to}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `rapport-${from}-${to}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { setError(e.message); }
  };
  const s = r?.sales;
  return (
    <div className="stack">
      <section className="card">
        <h1>Gestion</h1>
        <div className="chips">{presets(tz).map(([l, a, b]) => <button key={l} className={`chip${from === a && to === b ? ' on' : ''}`} onClick={() => { setFrom(a); setTo(b); }}>{l}</button>)}</div>
        <div className="grid"><Field label="Du"><input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field><Field label="Au"><input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field></div>
        <ErrorBox error={error} />
      </section>
      {r && (
        <>
          <section className="card">
            <h2>Résultat réel de la période</h2>
            <div className="kpis">
              <div className={`kpi ${r.profit >= 0 ? 'good' : 'bad'}`}><strong>{eurReal(r.profit)}</strong><span>Résultat réel (marge − charges − pertes)</span></div>
              <div className="kpi"><strong>{eur(s.revenue_cents)}</strong><span>Chiffre d'affaires caisse TTC ({s.count} vente{s.count > 1 ? 's' : ''}{s.refunds ? `, ${s.refunds} annulation${s.refunds > 1 ? 's' : ''}` : ''})</span></div>
              <div className="kpi"><strong>{eurReal(s.margin)}</strong><span>Marge sur ventes (HT){s.margin_pct != null ? ` · ${s.margin_pct} %` : ''}</span></div>
              <div className="kpi"><strong>{eur(s.average_cents)}</strong><span>Panier moyen</span></div>
              <div className="kpi"><strong>{eur(r.catering.revenue_cents)}</strong><span>Traiteur livré ({r.catering.count}) · marge {eurReal(r.catering.margin)}</span></div>
              <div className="kpi bad"><strong>{neg(eur(r.expenses.total_cents), r.expenses.total_cents)}</strong><span>Dépenses</span></div>
              <div className="kpi bad"><strong>{neg(eurReal(r.losses.value), r.losses.value)}</strong><span>Pertes et écarts de stock</span></div>
            </div>
            <p className="muted small">Calcul : marge des ventes (prix HT − coût réel des ingrédients) + marge du traiteur livré − dépenses − pertes. Les achats d'ingrédients ne comptent pas ici : ils entrent dans le coût quand l'article est vendu.</p>
            <div className="actions"><button onClick={() => window.print()}>🖨 Imprimer / PDF</button><button className="primary" onClick={download}>⬇ Exporter en Excel</button></div>
          </section>
          {r.products.length > 0 && (
            <section className="card"><h2>Articles</h2>
              <div className="table-wrap"><table className="responsive"><thead><tr><th>Article</th><th>Vendus</th><th>CA TTC</th><th>Coût</th><th>Marge</th></tr></thead><tbody>
                {r.products.map((p) => <tr key={`${p.product_id}-${p.name}`}><td>{p.name}</td><td>{p.qty}</td><td>{eur(p.cents)}</td><td>{eurReal(p.cost)}</td><td className={p.margin < 0 ? 'neg' : ''}>{eurReal(p.margin)}</td></tr>)}
              </tbody></table></div></section>
          )}
          {r.by_day.length > 1 && <section className="card"><h2>Par jour</h2><Bars rows={r.by_day} label={(d) => fmtD(d.day)} value={(d) => d.cents} /></section>}
          {r.by_hour.length > 0 && <section className="card"><h2>Par heure de la journée</h2><Bars rows={r.by_hour} label={(h) => `${h.hour} h`} value={(h) => h.cents} /></section>}
          {s.count > 0 && <section className="card"><h2>Par jour de la semaine</h2><Bars rows={r.by_weekday.filter((w) => w.count)} label={(w) => w.name} value={(w) => w.cents} /></section>}
          <section className="card">
            <h2>Détails</h2>
            <div className="grid">
              <div><h3>Encaissements</h3><table><tbody>{r.by_method.map((m) => <tr key={m.method}><td>{METHODS[m.method] || m.method}</td><td className="right">{eur(m.cents)}</td></tr>)}</tbody></table></div>
              <div><h3>Vendeurs</h3><table><tbody>{r.by_user.map((u) => <tr key={u.name}><td>{u.name}{u.refunds ? <span className="muted small"> ({u.refunds} annul.)</span> : ''}</td><td className="right">{eur(u.cents)}</td></tr>)}</tbody></table></div>
              <div><h3>Dépenses</h3><table><tbody>{r.expenses.by_category.map((c) => <tr key={c.category}><td>{c.category}</td><td className="right">{eur(c.cents)}</td></tr>)}</tbody></table></div>
            </div>
            <p>Remises accordées : {eur(s.discount_cents)} · TVA collectée : {eur(s.vat_cents)} · Production : {r.production.count} fois, {eurReal(r.production.cost)} d'ingrédients · Achats : {eurReal(r.purchases)}</p>
          </section>
          {r.losses.items.length > 0 && (
            <section className="card"><h2>Pertes et écarts</h2>
              <div className="table-wrap"><table className="responsive"><thead><tr><th>Jour</th><th>Quoi</th><th>Nature</th><th>Motif</th><th>Valeur</th></tr></thead><tbody>
                {r.losses.items.map((l, i) => <tr key={i}><td>{fmtD(l.day)}</td><td>{l.what}</td><td>{l.kind}</td><td>{l.reason}</td><td className={l.value < 0 ? 'pos-amount' : 'neg'}>{eurReal(l.value)}</td></tr>)}
              </tbody></table></div></section>
          )}
          <section className="card">
            <h2>Situation à ce jour</h2>
            <div className="kpis">
              <div className="kpi"><strong>{eurReal(r.now.stock_value)}</strong><span>Valeur du stock d'ingrédients</span></div>
              <div className="kpi"><strong>{eurReal(r.now.batch_value)}</strong><span>Valeur des articles préparés en stock</span></div>
              <div className="kpi"><strong>{eur(r.now.customers_total_cents)}</strong><span>Ardoises à encaisser</span></div>
              <div className="kpi"><strong>{eur(r.now.suppliers_total_cents)}</strong><span>Dettes fournisseurs</span></div>
            </div>
            {r.now.customers.length > 0 && <><h3>Clients qui doivent</h3><table><tbody>{r.now.customers.map((c) => <tr key={c.id}><td>{c.name}</td><td className="right">{eur(c.balance_cents)}</td></tr>)}</tbody></table></>}
            {r.now.suppliers.length > 0 && <><h3>Fournisseurs à payer</h3><table><tbody>{r.now.suppliers.map((c) => <tr key={c.id}><td>{c.name}</td><td className="right">{eur(c.balance_cents)}</td></tr>)}</tbody></table></>}
          </section>
          {createPortal(
            <div className="print-sheet">
              <h1>{shop?.shop_name} — Rapport du {fmtD(from)} au {fmtD(to)}</h1>
              <table><tbody>
                <tr><td>Chiffre d'affaires TTC ({s.count} ventes)</td><td>{eur(s.revenue_cents)}</td></tr><tr><td>dont TVA</td><td>{eur(s.vat_cents)}</td></tr>
                <tr><td>Coût des articles vendus</td><td>{eurReal(s.cost)}</td></tr><tr><td>Marge sur ventes (HT)</td><td>{eurReal(s.margin)}</td></tr>
                <tr><td>Traiteur livré</td><td>{eur(r.catering.revenue_cents)} (marge {eurReal(r.catering.margin)})</td></tr>
                <tr><td>Dépenses</td><td>{neg(eur(r.expenses.total_cents), r.expenses.total_cents)}</td></tr><tr><td>Pertes et écarts</td><td>{neg(eurReal(r.losses.value), r.losses.value)}</td></tr>
                <tr><td><strong>RÉSULTAT RÉEL</strong></td><td><strong>{eurReal(r.profit)}</strong></td></tr>
              </tbody></table>
              <h2>Articles</h2>
              <table><tbody>{r.products.map((p) => <tr key={`${p.product_id}-${p.name}`}><td>{p.name}</td><td>{p.qty}</td><td>{eur(p.cents)}</td><td>{eurReal(p.margin)}</td></tr>)}</tbody></table>
              <h2>Dépenses</h2>
              <table><tbody>{r.expenses.by_category.map((c) => <tr key={c.category}><td>{c.category}</td><td>{eur(c.cents)}</td></tr>)}</tbody></table>
            </div>, document.body)}
        </>
      )}
    </div>
  );
}

function Expenses({ tz }) {
  const [from, setFrom] = useState(monthStart(tz));
  const [to, setTo] = useState(todayLocal(tz));
  const [data, setData] = useState(null);
  const [f, setF] = useState({ category: '', label: '', amount: '', drawer: false });
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get(`/api/expenses?from=${from}&to=${to}`).then(setData).catch((e) => setError(e.message)), [from, to]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const add = () => run(async () => {
    const cents = parseEuros(f.amount);
    if (!(cents > 0)) throw new Error('Montant invalide.');
    await api.post('/api/expenses', { category: f.category, label: f.label, amount_cents: cents, from_drawer: f.drawer });
    setF({ category: f.category, label: '', amount: '', drawer: false }); await load();
  });
  const total = (data?.items ?? []).filter((x) => !x.voided_at).reduce((a, x) => a + x.amount_cents, 0);
  return (
    <div className="stack">
      <section className="card">
        <h2>Nouvelle dépense</h2>
        <ErrorBox error={error} />
        <div className="grid">
          <Field label="Catégorie"><input list="expcats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /><datalist id="expcats">{(data?.categories ?? []).map((c) => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Libellé"><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="ex. Loyer d'octobre" /></Field>
          <Field label="Montant (€)"><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={f.drawer} onChange={(e) => setF({ ...f, drawer: e.target.checked })} /> Payé avec l'argent du tiroir-caisse</label>
        <div className="actions"><button className="primary" disabled={busy || !f.category.trim() || !f.label.trim() || !f.amount} onClick={add}>Enregistrer la dépense</button></div>
      </section>
      <section className="card">
        <h2>Dépenses</h2>
        <div className="grid"><Field label="Du"><input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field><Field label="Au"><input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field></div>
        {data && <p>Total de la période : <strong>{eur(total)}</strong></p>}
        {data && data.items.length === 0 && <p className="muted">Aucune dépense.</p>}
        {data && data.items.length > 0 && (
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Jour</th><th>Catégorie</th><th>Libellé</th><th>Montant</th><th /></tr></thead><tbody>
            {data.items.map((x) => (
              <tr key={x.id} className={x.voided_at ? 'off' : ''}><td>{fmtD(x.day)}</td><td>{x.category}</td><td>{x.label}{x.voided_at && <span className="badge warn">annulée : {x.void_reason}</span>}</td><td>{eur(x.amount_cents)}</td>
                <td className="right">{!x.voided_at && <button onClick={() => { const r = window.prompt('Motif de l\'annulation :'); if (r && r.trim()) run(async () => { await api.post(`/api/expenses/${x.id}/void`, { reason: r.trim() }); await load(); }); }}>Annuler</button>}</td></tr>
            ))}</tbody></table></div>
        )}
      </section>
    </div>
  );
}

export default function Management({ me }) {
  const [sub, setSub] = useState('stats');
  const tz = cache.get('catalog')?.tz;
  const [shop, setShop] = useState(() => cache.get('ticket'));
  useEffect(() => { api.get('/api/ticket-info').then((t) => { cache.set('ticket', t); setShop(t); }).catch(() => {}); }, []);
  return (
    <div>
      <div className="subtabs">
        {me.permissions.includes('stats.view') && <button className={sub === 'stats' ? 'active' : ''} onClick={() => setSub('stats')}>Statistiques</button>}
        {me.permissions.includes('expenses.manage') && <button className={sub === 'expenses' ? 'active' : ''} onClick={() => setSub('expenses')}>Dépenses</button>}
      </div>
      {sub === 'stats' && <Dashboard tz={tz} shop={shop} />}
      {sub === 'expenses' && <Expenses tz={tz} />}
    </div>
  );
}
