import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurSigned, parseEuros, toEuroInput, fmtDT } from '../money.js';

const PAY = { cash: 'Espèces', card: 'Carte', transfer: 'Virement', other: 'Autre' };

function CustomerForm({ c, can, onClose, onSaved }) {
  const [f, setF] = useState({ name: c?.name ?? '', phone: c?.phone ?? '', notes: c?.notes ?? '', limit: toEuroInput(c?.credit_limit_cents), active: c?.active ?? true });
  const { busy, error, run } = useAsync();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = () => run(async () => {
    const body = { name: f.name, phone: f.phone, notes: f.notes };
    if (c) {
      body.active = f.active;
      if (can.credit) body.credit_limit_cents = f.limit.trim() === '' ? null : parseEuros(f.limit);
      await api.put(`/api/customers/${c.id}`, body);
    } else await api.post('/api/customers', body);
    onSaved(); onClose();
  });
  return (
    <Modal title={c ? `Modifier ${c.name}` : 'Nouveau client'} onClose={onClose}>
      <ErrorBox error={error} />
      <Field label="Nom"><input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} autoFocus /></Field>
      <Field label="Téléphone"><input inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} maxLength={30} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={500} /></Field>
      {c && can.credit && <Field label="Limite d'ardoise (€)" hint="Vide = pas d'ardoise autorisée pour ce client."><input inputMode="decimal" value={f.limit} onChange={(e) => set('limit', e.target.value)} placeholder="ex. 50,00" /></Field>}
      {c && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Client actif</label>}
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !f.name.trim()} onClick={save}>Enregistrer</button></div>
    </Modal>
  );
}

function Detail({ id, can, loyalty, tz, onClose, onChanged, onEdit }) {
  const [d, setD] = useState(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get(`/api/customers/${id}`).then(setD).catch((e) => setError(e.message)), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const pay = () => run(async () => {
    const cents = parseEuros(amount);
    if (!(cents > 0)) throw new Error('Montant invalide.');
    await api.post(`/api/customers/${id}/payments`, { amount_cents: cents, method });
    setAmount(''); await load(); onChanged();
  });
  const adjust = () => run(async () => {
    const v = window.prompt('Correction de l\'ardoise en € (négatif = on lui retire une dette) :');
    if (v == null) return;
    const cents = parseEuros(v);
    if (!cents) throw new Error('Montant invalide.');
    const note = window.prompt('Raison (obligatoire) :');
    if (!note || !note.trim()) throw new Error('La raison est obligatoire.');
    await api.post(`/api/customers/${id}/adjust`, { amount_cents: cents, note });
    await load(); onChanged();
  });
  const stamps = () => run(async () => {
    const v = window.prompt('Nombre de tampons à ajouter (négatif pour retirer) :');
    if (v == null) return;
    const note = window.prompt('Raison (obligatoire) :');
    if (!note || !note.trim()) throw new Error('La raison est obligatoire.');
    await api.post(`/api/customers/${id}/stamps`, { delta: Number(v), note });
    await load(); onChanged();
  });
  return (
    <Modal title={d ? d.name : 'Client'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {d && (
        <>
          <p className="muted">{[d.phone, d.notes].filter(Boolean).join(' · ') || 'Pas de coordonnées.'}</p>
          <div className="kpis">
            <div className={`kpi ${d.balance_cents > 0 ? 'bad' : ''}`}><strong>{eur(d.balance_cents)}</strong><span>Ardoise à régler{d.credit_limit_cents != null ? ` (limite ${eur(d.credit_limit_cents)})` : ' (pas d\'ardoise autorisée)'}</span></div>
            {loyalty?.enabled && <div className="kpi"><strong>{d.stamps}</strong><span>tampons (récompense à {loyalty.stamps_needed})</span></div>}
          </div>
          {can.payment && d.balance_cents > 0 && (
            <div className="line-card">
              <strong>Encaisser un règlement</strong>
              <div className="inline" style={{ marginTop: 6 }}>
                <input inputMode="decimal" placeholder={`Montant (max ${eur(d.balance_cents)})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
                <select value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(PAY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <button className="primary" disabled={busy} onClick={pay}>Encaisser</button>
              </div>
              <div className="quick"><button onClick={() => setAmount(toEuroInput(d.balance_cents))}>Tout solder</button></div>
              {method === 'cash' && <p className="muted small">Les espèces entrent dans la caisse du jour.</p>}
            </div>
          )}
          <h3>Compte</h3>
          {d.ledger.length === 0 ? <p className="muted">Aucune opération.</p> : (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>Date</th><th>Opération</th><th>Montant</th></tr></thead><tbody>
              {d.ledger.map((l) => <tr key={l.id}><td>{fmtDT(l.ts, tz)}</td><td>{{ sale: `Vente ${l.sale_number ?? ''}`, refund: `Annulation ${l.note ?? ''}`, payment: `Règlement (${PAY[l.method] ?? l.method})`, adjust: `Correction : ${l.note ?? ''}` }[l.type]}</td><td className={l.amount_cents > 0 ? 'neg' : 'pos-amount'}>{eurSigned(l.amount_cents)}</td></tr>)}
            </tbody></table></div>
          )}
          {loyalty?.enabled && d.stamps_log.length > 0 && (
            <details><summary>Historique des tampons</summary>
              <table><tbody>{d.stamps_log.map((m) => <tr key={m.id}><td>{fmtDT(m.ts, tz)}</td><td>{m.reason}</td><td>{m.delta > 0 ? `+${m.delta}` : m.delta}</td></tr>)}</tbody></table></details>
          )}
          <div className="actions">
            {can.edit && <button onClick={() => onEdit(d)}>Modifier</button>}
            {can.credit && <button onClick={adjust} disabled={busy}>Corriger l'ardoise</button>}
            {can.credit && loyalty?.enabled && <button onClick={stamps} disabled={busy}>Ajuster les tampons</button>}
          </div>
        </>
      )}
    </Modal>
  );
}

export default function Customers() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [owing, setOwing] = useState(false);
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null);
  const { error, setError } = useAsync();
  const tz = (() => { try { return JSON.parse(localStorage.getItem('boutique.catalog'))?.tz; } catch { return undefined; } })();
  const load = useCallback(() => api.get(`/api/customers?q=${encodeURIComponent(q)}${owing ? '&owing=1' : ''}`).then(setData).catch((e) => setError(e.message)), [q, owing]); // eslint-disable-line
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  const total = data ? data.items.reduce((a, c) => a + Math.max(0, c.balance_cents), 0) : 0;
  return (
    <section className="card">
      <div className="row-between"><h1>Clients</h1>{data?.can.edit && <button className="primary" onClick={() => setEdit({})}>+ Nouveau client</button>}</div>
      <ErrorBox error={error} />
      <div className="inline"><input placeholder="Chercher un nom ou un téléphone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <label className="check"><input type="checkbox" checked={owing} onChange={(e) => setOwing(e.target.checked)} /> Seulement ceux qui doivent de l'argent</label>
      {data && owing && <Notice tone="info">Total des ardoises à encaisser : <strong>{eur(total)}</strong></Notice>}
      {data && data.items.length === 0 && <p className="muted">Aucun client.</p>}
      {data && data.items.length > 0 && (
        <div className="table-wrap"><table className="responsive"><thead><tr><th>Client</th><th>Ardoise</th>{data.loyalty?.enabled && <th>Tampons</th>}<th /></tr></thead><tbody>
          {data.items.map((c) => (
            <tr key={c.id} className={c.active ? '' : 'off'}>
              <td><strong>{c.name}</strong>{!c.active && <span className="badge">inactif</span>}<div className="muted small">{c.phone}</div></td>
              <td className={c.balance_cents > 0 ? 'neg' : ''}>{c.balance_cents ? eur(c.balance_cents) : '—'}</td>
              {data.loyalty?.enabled && <td>{c.stamps}</td>}
              <td className="right"><button onClick={() => setOpen(c.id)}>Ouvrir</button></td>
            </tr>
          ))}</tbody></table></div>
      )}
      {open && data && <Detail id={open} can={data.can} loyalty={data.loyalty} tz={tz} onClose={() => setOpen(null)} onChanged={load} onEdit={(c) => { setOpen(null); setEdit(c); }} />}
      {edit && data && <CustomerForm c={edit.id ? edit : null} can={data.can} onClose={() => setEdit(null)} onSaved={load} />}
    </section>
  );
}
