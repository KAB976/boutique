import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurReal, eurSigned, parseEuros, toEuroInput, fmtDT, fmtD, todayLocal } from '../money.js';
import { cache } from '../offline.js';

const PAY_KIND = { deposit: 'Acompte', balance: 'Solde', refund: 'Remboursement' };
const PAY_METHOD = { cash: 'Espèces', card: 'Carte', voucher: 'Bon', transfer: 'Virement', other: 'Autre' };
const TONE = { quote: '', confirmed: 'warn', prepared: 'warn', delivered: 'ok', cancelled: '' };
const nfmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });

function OrderForm({ order, onClose, onSaved }) {
  const [lists, setLists] = useState({ recipes: [], products: [], customers: [] });
  const [f, setF] = useState(() => ({
    contact_name: order?.contact_name ?? '', contact_phone: order?.contact_phone ?? '', event_date: order?.event_date ?? '', event_time: order?.event_time ?? '', place: order?.place ?? '',
    guests: order?.guests != null ? String(order.guests) : '', note: order?.note ?? '', customer_id: order?.customer_id ? String(order.customer_id) : '', discount: toEuroInput(order?.discount_cents ?? 0),
  }));
  const [lines, setLines] = useState(() => (order ? order.lines.map((l) => ({ kind: l.kind, recipe_id: l.recipe_id ? String(l.recipe_id) : '', product_id: l.product_id ? String(l.product_id) : '', label: l.kind === 'free' ? l.label : '', qty: String(l.qty), price: toEuroInput(l.unit_price_cents) })) : [{ kind: 'recipe', recipe_id: '', product_id: '', label: '', qty: '', price: '' }]));
  const { busy, error, run } = useAsync();
  useEffect(() => {
    Promise.all([api.get('/api/recipes'), api.get('/api/recipes?archived=1'), api.get('/api/products'), api.get('/api/customers').catch(() => ({ items: [] }))])
      .then(([a, b, p, c]) => setLists({ recipes: [...a.items, ...b.items], products: p.items, customers: c.items }));
  }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const upd = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const total = lines.reduce((a, l) => a + Math.round((Number(String(l.qty).replace(',', '.')) || 0) * (parseEuros(l.price) || 0)), 0);
  const disc = parseEuros(f.discount || '0') || 0;
  const save = () => run(async () => {
    const payload = {
      contact_name: f.contact_name, contact_phone: f.contact_phone, event_date: f.event_date, event_time: f.event_time, place: f.place, note: f.note,
      guests: f.guests === '' ? null : Number(f.guests), customer_id: f.customer_id ? Number(f.customer_id) : null, discount_cents: disc,
      lines: lines.filter((l) => (l.kind === 'recipe' && l.recipe_id) || (l.kind === 'product' && l.product_id) || (l.kind === 'free' && l.label.trim())).map((l) => ({
        kind: l.kind, qty: l.qty, unit_price_cents: parseEuros(l.price) ?? 0,
        ...(l.kind === 'recipe' ? { recipe_id: Number(l.recipe_id) } : {}), ...(l.kind === 'product' ? { product_id: Number(l.product_id) } : {}), ...(l.kind === 'free' ? { label: l.label } : {}),
      })),
    };
    if (order) await api.put(`/api/catering/${order.id}`, payload); else await api.post('/api/catering', payload);
    onSaved(); onClose();
  });
  return (
    <Modal title={order ? `Modifier ${order.number}` : 'Nouvelle commande / devis'} onClose={onClose} wide>
      <ErrorBox error={error} />
      <div className="grid">
        <Field label="Nom du contact"><input value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} autoFocus /></Field>
        <Field label="Téléphone"><input inputMode="tel" value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} /></Field>
        <Field label="Date de l'événement"><input type="date" value={f.event_date} onChange={(e) => set('event_date', e.target.value)} /></Field>
        <Field label="Heure"><input type="time" value={f.event_time} onChange={(e) => set('event_time', e.target.value)} /></Field>
        <Field label="Lieu"><input value={f.place} onChange={(e) => set('place', e.target.value)} /></Field>
        <Field label="Nombre d'invités"><input inputMode="numeric" value={f.guests} onChange={(e) => set('guests', e.target.value)} /></Field>
        {lists.customers.length > 0 && <Field label="Client enregistré (facultatif)"><select value={f.customer_id} onChange={(e) => set('customer_id', e.target.value)}><option value="">— aucun —</option>{lists.customers.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      </div>
      <h3>Ce qui est commandé</h3>
      {lines.map((l, i) => (
        <div className="line-card" key={i}>
          <div className="grid">
            <Field label="Type"><select value={l.kind} onChange={(e) => upd(i, { kind: e.target.value, recipe_id: '', product_id: '', label: '' })}><option value="recipe">Une recette (au prix par personne)</option><option value="product">Un article de la caisse</option><option value="free">Ligne libre (location, service…)</option></select></Field>
            {l.kind === 'recipe' && <Field label="Recette"><select value={l.recipe_id} onChange={(e) => upd(i, { recipe_id: e.target.value })}><option value="">— choisir —</option>{lists.recipes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.archived ? ' (archive)' : ''}</option>)}</select></Field>}
            {l.kind === 'product' && <Field label="Article"><select value={l.product_id} onChange={(e) => { const p = lists.products.find((x) => x.id === Number(e.target.value)); upd(i, { product_id: e.target.value, price: p ? toEuroInput(p.price_cents) : l.price }); }}><option value="">— choisir —</option>{lists.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
            {l.kind === 'free' && <Field label="Libellé"><input value={l.label} onChange={(e) => upd(i, { label: e.target.value })} /></Field>}
            <Field label={l.kind === 'recipe' ? 'Nombre de personnes' : 'Quantité'}><input inputMode="decimal" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} /></Field>
            <Field label={l.kind === 'recipe' ? 'Prix par personne (€)' : 'Prix unitaire (€)'}><input inputMode="decimal" value={l.price} onChange={(e) => upd(i, { price: e.target.value })} /></Field>
          </div>
          {lines.length > 1 && <button className="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Retirer la ligne</button>}
        </div>
      ))}
      <button onClick={() => setLines((ls) => [...ls, { kind: 'recipe', recipe_id: '', product_id: '', label: '', qty: '', price: '' }])}>+ Ajouter une ligne</button>
      <div className="grid">
        <Field label="Remise (€)"><input inputMode="decimal" value={f.discount} onChange={(e) => set('discount', e.target.value)} /></Field>
        <Field label="Note"><input value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
      </div>
      <p className="cart-total"><span>Total TTC</span><span>{eur(Math.max(0, total - disc))}</span></p>
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !f.contact_name.trim() || !f.event_date} onClick={save}>Enregistrer</button></div>
    </Modal>
  );
}

function PayForm({ order, onClose, onSaved }) {
  const [kind, setKind] = useState(order.paid_cents > 0 && order.balance_cents > 0 ? 'balance' : order.paid_cents === 0 ? 'deposit' : 'refund');
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Modal title="Encaissement traiteur" onClose={onClose}>
      <ErrorBox error={error} />
      <p className="muted">Total {eur(order.total_cents)} · déjà encaissé {eur(order.paid_cents)} · reste {eur(order.balance_cents)}</p>
      <Field label="Nature"><select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(PAY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Moyen"><select value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(PAY_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="Montant (€)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
      <div className="quick">
        {kind !== 'refund' && order.balance_cents > 0 && <button onClick={() => setAmount(toEuroInput(order.balance_cents))}>Tout le reste</button>}
        {kind === 'deposit' && <button onClick={() => setAmount(toEuroInput(Math.round(order.total_cents * 0.3)))}>30 %</button>}
        {kind === 'refund' && order.paid_cents > 0 && <button onClick={() => setAmount(toEuroInput(order.paid_cents))}>Tout rembourser</button>}
      </div>
      {method === 'cash' && <p className="muted small">Les espèces {kind === 'refund' ? 'sortent de' : 'entrent dans'} la caisse du jour.</p>}
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !(parseEuros(amount) > 0)} onClick={() => run(async () => { await api.post(`/api/catering/${order.id}/payments`, { kind, method, amount_cents: parseEuros(amount) }); onSaved(); onClose(); })}>Enregistrer</button></div>
    </Modal>
  );
}

function OrderDetail({ id, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [mode, setMode] = useState(null);
  const [shop] = useState(() => cache.get('ticket'));
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get(`/api/catering/${id}`).then(setD).catch((e) => setError(e.message)), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const status = (s, reason) => run(async () => { await api.post(`/api/catering/${id}/status`, { status: s, reason }); await load(); onChanged(); });
  const money = d?.can.money;
  const margin = d && money ? d.total_cents / 100 - d.est_cost : null;
  return (
    <Modal title={d ? `${d.number} — ${d.contact_name}` : 'Commande'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {d && (
        <>
          <p><span className={`badge ${TONE[d.status]}`}>{d.status_label}</span> <strong>{fmtD(d.event_date)}{d.event_time ? ` à ${d.event_time}` : ''}</strong>{d.place ? ` · ${d.place}` : ''}{d.guests ? ` · ${d.guests} invités` : ''}</p>
          <p className="muted">{[d.contact_phone, d.customer?.name && `client : ${d.customer.name}`, d.note].filter(Boolean).join(' · ')}</p>
          {d.cancelled_reason && <Notice tone="warn">Annulée : {d.cancelled_reason}</Notice>}
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Désignation</th><th>Quantité</th>{money && <th>Prix</th>}{money && <th>Total</th>}</tr></thead><tbody>
            {d.lines.map((l) => <tr key={l.id}><td>{l.label}{l.kind === 'recipe' ? <span className="muted small"> (recette)</span> : ''}</td><td>{nfmt.format(l.qty)}</td>{money && <td>{eur(l.unit_price_cents)}</td>}{money && <td>{eur(l.total_cents)}</td>}</tr>)}
          </tbody></table></div>
          {money && (
            <>
              {d.discount_cents > 0 && <p>Remise : −{eur(d.discount_cents)}</p>}
              <div className="kpis">
                <div className="kpi"><strong>{eur(d.total_cents)}</strong><span>Total TTC</span></div>
                <div className="kpi"><strong>{eur(d.paid_cents)}</strong><span>Encaissé</span></div>
                <div className={`kpi ${d.balance_cents > 0 ? 'bad' : 'good'}`}><strong>{eur(d.balance_cents)}</strong><span>Reste à payer</span></div>
                <div className={`kpi ${margin < 0 ? 'bad' : ''}`}><strong>{eurReal(margin)}</strong><span>Marge estimée (coût estimé {eurReal(d.est_cost)})</span></div>
              </div>
              {d.payments.length > 0 && <table><tbody>{d.payments.map((p) => <tr key={p.id}><td>{fmtDT(p.ts)}</td><td>{PAY_KIND[p.kind]} ({PAY_METHOD[p.method]})</td><td className={p.amount_cents < 0 ? 'neg right' : 'pos-amount right'}>{eurSigned(p.amount_cents)}</td></tr>)}</tbody></table>}
            </>
          )}
          {d.productions.length > 0 && <p className="small muted">Productions liées : {d.productions.map((p) => `${p.number}${p.voided_at ? ' (annulée)' : ''}`).join(', ')}</p>}
          <div className="actions">
            <button onClick={() => window.print()}>🖨 {money ? 'Devis / fiche' : 'Fiche de préparation'}</button>
            {d.can.edit && ['quote', 'confirmed'].includes(d.status) && <button onClick={() => setMode('edit')}>Modifier</button>}
            {d.can.edit && d.status !== 'cancelled' && <button onClick={() => setMode('pay')}>Encaisser / rembourser</button>}
            {d.can.edit && d.status === 'quote' && <button className="primary" disabled={busy} onClick={() => status('confirmed')}>Confirmer la commande</button>}
            {d.can.edit && d.status === 'confirmed' && <button className="primary" disabled={busy} onClick={() => status('prepared')}>Marquer comme préparée</button>}
            {d.can.edit && d.status === 'prepared' && <button className="primary" disabled={busy} onClick={() => { if (d.balance_cents > 0 && !window.confirm(`Il reste ${eur(d.balance_cents)} à encaisser. Marquer quand même comme livrée ?`)) return; status('delivered'); }}>Marquer comme livrée</button>}
            {d.can.edit && !['delivered', 'cancelled'].includes(d.status) && <button className="danger" disabled={busy} onClick={() => { const r = window.prompt('Motif de l\'annulation :'); if (r && r.trim()) status('cancelled', r.trim()); }}>Annuler</button>}
          </div>
          {mode === 'edit' && <OrderForm order={d} onClose={() => setMode(null)} onSaved={() => { load(); onChanged(); }} />}
          {mode === 'pay' && <PayForm order={d} onClose={() => setMode(null)} onSaved={() => { load(); onChanged(); }} />}
          {createPortal(
            <div className="print-sheet">
              <h1>{shop?.shop_name} — {money ? (d.status === 'quote' ? 'Devis' : 'Commande') : 'Fiche de préparation'} {d.number}</h1>
              <p><strong>{d.contact_name}</strong> {d.contact_phone}</p>
              <p>Événement : <strong>{fmtD(d.event_date)}{d.event_time ? ` à ${d.event_time}` : ''}</strong>{d.place ? ` — ${d.place}` : ''}{d.guests ? ` — ${d.guests} invités` : ''}</p>
              <table><tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.label}</td><td>{nfmt.format(l.qty)}</td>{money && <td>{eur(l.unit_price_cents)}</td>}{money && <td>{eur(l.total_cents)}</td>}</tr>)}</tbody></table>
              {money && <><h2>Total TTC : {eur(d.total_cents)}</h2>{d.paid_cents > 0 && <p>Acompte / encaissé : {eur(d.paid_cents)} — Reste à payer : <strong>{eur(d.balance_cents)}</strong></p>}</>}
              {d.note && <p>{d.note}</p>}
              {money && d.status === 'quote' && <p><em>Devis valable 15 jours. Merci de confirmer par un acompte.</em></p>}
            </div>, document.body)}
        </>
      )}
    </Modal>
  );
}

function Shopping({ tz }) {
  const [from, setFrom] = useState(todayLocal(tz));
  const [to, setTo] = useState(() => { const d = new Date(`${todayLocal(tz)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); });
  const [data, setData] = useState(null);
  const { error, setError } = useAsync();
  useEffect(() => { api.get(`/api/catering/shopping?from=${from}&to=${to}`).then((r) => { setData(r); setError(''); }).catch((e) => setError(e.message)); }, [from, to]); // eslint-disable-line
  return (
    <section className="card">
      <h2>Liste de courses des commandes</h2>
      <p className="muted">Tous les ingrédients nécessaires aux commandes confirmées de la période, moins ce qui est déjà en stock, en emballages entiers.</p>
      <div className="grid"><Field label="Du"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Au"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      <ErrorBox error={error} />
      {data && (
        <>
          <p>{data.orders.length === 0 ? 'Aucune commande confirmée sur cette période.' : `Commandes : ${data.orders.map((o) => `${o.number} (${fmtD(o.event_date)})`).join(', ')}`}</p>
          {data.items.length > 0 && (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>Ingrédient</th><th>Besoin</th><th>En stock</th><th>À acheter</th></tr></thead><tbody>
              {data.items.map((i) => <tr key={i.ingredient_id} className={i.missing > 0 ? '' : 'off'}><td>{i.name}</td><td>{i.needText}</td><td>{i.stockText}</td><td>{i.missing > 0 ? <strong>{i.packs ? `${i.packs} ${i.packLabel}${i.packs > 1 ? 's' : ''} (${i.toBuyText})` : i.toBuyText}</strong> : '✓ suffisant'}</td></tr>)}
            </tbody></table></div>
          )}
          {data.free.length > 0 && <><h3>Ingrédients non reliés au stock (à prévoir à la main)</h3><ul className="tobuy">{data.free.map((x, i) => <li key={i}>{x.label} — {x.text} <span className="muted">({x.order})</span></li>)}</ul></>}
          {data.items.length > 0 && <div className="actions"><button onClick={() => window.print()}>🖨 Imprimer / PDF</button></div>}
          {createPortal(
            <div className="print-sheet"><h1>Liste de courses — commandes du {fmtD(from)} au {fmtD(to)}</h1>
              <table><tbody>{data.items.filter((i) => i.missing > 0).map((i) => <tr key={i.ingredient_id}><td>☐ {i.name}</td><td>{i.packs ? `${i.packs} ${i.packLabel} (${i.toBuyText})` : i.toBuyText}</td></tr>)}</tbody></table>
              {data.free.length > 0 && <><h2>À prévoir (non reliés au stock)</h2><ul>{data.free.map((x, i) => <li key={i}>{x.label} — {x.text}</li>)}</ul></>}
            </div>, document.body)}
        </>
      )}
    </section>
  );
}

export default function Catering() {
  const [sub, setSub] = useState('orders');
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('open');
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(false);
  const { error, setError } = useAsync();
  const tz = cache.get('catalog')?.tz;
  const load = useCallback(() => api.get('/api/catering').then(setData).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const items = (data?.items ?? []).filter((o) => filter === 'all' || (filter === 'open' ? ['quote', 'confirmed', 'prepared'].includes(o.status) : o.status === filter));
  const sorted = [...items].sort((a, b) => (filter === 'open' ? (a.event_date + a.event_time < b.event_date + b.event_time ? -1 : 1) : 0));
  return (
    <div>
      <div className="subtabs">
        <button className={sub === 'orders' ? 'active' : ''} onClick={() => setSub('orders')}>Commandes</button>
        <button className={sub === 'shopping' ? 'active' : ''} onClick={() => setSub('shopping')}>Liste de courses</button>
      </div>
      {sub === 'shopping' && <Shopping tz={tz} />}
      {sub === 'orders' && (
        <section className="card">
          <div className="row-between"><h1>Traiteur</h1>{data?.can.edit && <button className="primary" onClick={() => setEdit(true)}>+ Nouvelle commande / devis</button>}</div>
          <div className="chips">{[['open', 'À venir'], ['delivered', 'Livrées'], ['cancelled', 'Annulées'], ['all', 'Toutes']].map(([k, v]) => <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{v}</button>)}</div>
          <ErrorBox error={error} />
          {data && sorted.length === 0 && <p className="muted">Aucune commande.</p>}
          {data && sorted.length > 0 && (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>Date</th><th>N°</th><th>Contact</th>{data.can.money && <th>Total</th>}{data.can.money && <th>Reste</th>}<th>État</th><th /></tr></thead><tbody>
              {sorted.map((o) => (
                <tr key={o.id}><td className="nowrap"><strong>{fmtD(o.event_date)}</strong>{o.event_time ? <div className="muted small">{o.event_time}</div> : null}</td><td>{o.number}</td><td>{o.contact_name}{o.guests ? <div className="muted small">{o.guests} invités</div> : null}</td>
                  {data.can.money && <td>{eur(o.total_cents)}</td>}{data.can.money && <td className={o.total_cents - o.paid_cents > 0 && o.status !== 'cancelled' ? 'neg' : ''}>{o.status === 'cancelled' ? '—' : eur(o.total_cents - o.paid_cents)}</td>}
                  <td><span className={`badge ${TONE[o.status]}`}>{o.status_label}</span></td><td className="right"><button onClick={() => setOpen(o.id)}>Ouvrir</button></td></tr>
              ))}</tbody></table></div>
          )}
        </section>
      )}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
      {edit && <OrderForm onClose={() => setEdit(false)} onSaved={load} />}
    </div>
  );
}
