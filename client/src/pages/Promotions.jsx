import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, parseEuros, toEuroInput, fmtD } from '../money.js';

const DAYS = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mer'], ['4', 'Jeu'], ['5', 'Ven'], ['6', 'Sam'], ['0', 'Dim']];

function describe(p) {
  const what = p.scope === 'all' ? 'tous les articles' : p.scope === 'category' ? `catégorie « ${p.category} »` : `« ${p.product_name} »`;
  const rule = { bogo: `${p.buy_qty} acheté${p.buy_qty > 1 ? 's' : ''} = ${p.free_qty} offert${p.free_qty > 1 ? 's' : ''}`, bundle: `${p.bundle_qty} pour ${eur(p.bundle_price_cents)}`, percent: `−${p.percent} %`, amount: `−${eur(p.amount_cents)} par article` }[p.type];
  const when = [
    p.starts_on || p.ends_on ? `${p.starts_on ? `du ${fmtD(p.starts_on)}` : ''}${p.ends_on ? ` au ${fmtD(p.ends_on)}` : ''}` : '',
    p.weekdays ? p.weekdays.split(',').map((d) => DAYS.find((x) => x[0] === d)?.[1]).join(' ') : '', p.time_from ? `${p.time_from}–${p.time_to}` : '',
  ].filter(Boolean).join(' · ');
  return `${rule} sur ${what}${when ? ` — ${when}` : ' — tout le temps'}`;
}

function PromoForm({ promo, lists, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    name: promo?.name ?? '', type: promo?.type ?? 'bogo', scope: promo?.scope ?? 'product', product_id: promo?.product_id ? String(promo.product_id) : '', category: promo?.category ?? '',
    buy_qty: String(promo?.buy_qty ?? 2), free_qty: String(promo?.free_qty ?? 1), bundle_qty: String(promo?.bundle_qty ?? 5), bundle_price: toEuroInput(promo?.bundle_price_cents),
    percent: String(promo?.percent ?? 10), amount: toEuroInput(promo?.amount_cents), starts_on: promo?.starts_on ?? '', ends_on: promo?.ends_on ?? '',
    weekdays: promo?.weekdays ? promo.weekdays.split(',') : [], time_from: promo?.time_from ?? '', time_to: promo?.time_to ?? '', active: promo?.active ?? true,
  }));
  const { busy, error, run } = useAsync();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleDay = (d) => set('weekdays', f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d]);
  const save = () => run(async () => {
    const body = {
      name: f.name, type: f.type, scope: f.scope, starts_on: f.starts_on || null, ends_on: f.ends_on || null, weekdays: f.weekdays.join(','), time_from: f.time_from || null, time_to: f.time_to || null,
      ...(f.scope === 'product' ? { product_id: Number(f.product_id) || null } : {}), ...(f.scope === 'category' ? { category: f.category } : {}),
      ...(f.type === 'bogo' ? { buy_qty: Number(f.buy_qty), free_qty: Number(f.free_qty) } : {}),
      ...(f.type === 'bundle' ? { bundle_qty: Number(f.bundle_qty), bundle_price_cents: parseEuros(f.bundle_price) } : {}),
      ...(f.type === 'percent' ? { percent: Number(String(f.percent).replace(',', '.')) } : {}), ...(f.type === 'amount' ? { amount_cents: parseEuros(f.amount) } : {}),
      ...(promo ? { active: f.active } : {}),
    };
    if (promo) await api.put(`/api/promotions/${promo.id}`, body); else await api.post('/api/promotions', body);
    onSaved(); onClose();
  });
  return (
    <Modal title={promo ? `Modifier « ${promo.name} »` : 'Nouvelle promotion'} onClose={onClose} wide>
      <ErrorBox error={error} />
      <Field label="Nom (apparaît sur le ticket)"><input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={60} autoFocus placeholder="ex. Crêpes 2 achetées 1 offerte" /></Field>
      <div className="grid">
        <Field label="Type"><select value={f.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(lists.types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="S'applique à"><select value={f.scope} onChange={(e) => set('scope', e.target.value)}><option value="product">Un article</option><option value="category">Une catégorie</option><option value="all">Tout le catalogue</option></select></Field>
        {f.scope === 'product' && <Field label="Article"><select value={f.product_id} onChange={(e) => set('product_id', e.target.value)}><option value="">— choisir —</option>{lists.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {f.scope === 'category' && <Field label="Catégorie"><select value={f.category} onChange={(e) => set('category', e.target.value)}><option value="">— choisir —</option>{lists.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>}
      </div>
      {f.type === 'bogo' && <div className="grid"><Field label="Nombre achetés"><input inputMode="numeric" value={f.buy_qty} onChange={(e) => set('buy_qty', e.target.value)} /></Field><Field label="Nombre offerts" hint="Les articles les moins chers du groupe sont ceux offerts."><input inputMode="numeric" value={f.free_qty} onChange={(e) => set('free_qty', e.target.value)} /></Field></div>}
      {f.type === 'bundle' && <div className="grid"><Field label="Nombre d'articles du lot"><input inputMode="numeric" value={f.bundle_qty} onChange={(e) => set('bundle_qty', e.target.value)} /></Field><Field label="Prix du lot (€)" hint="S'applique à chaque lot complet, aux articles les moins chers."><input inputMode="decimal" value={f.bundle_price} onChange={(e) => set('bundle_price', e.target.value)} /></Field></div>}
      {f.type === 'percent' && <Field label="Remise (%)"><input inputMode="decimal" value={f.percent} onChange={(e) => set('percent', e.target.value)} /></Field>}
      {f.type === 'amount' && <Field label="Remise par article (€)"><input inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} /></Field>}
      <h3>Quand ?</h3>
      <div className="grid">
        <Field label="Du (facultatif)"><input type="date" value={f.starts_on} onChange={(e) => set('starts_on', e.target.value)} /></Field>
        <Field label="Au (facultatif)"><input type="date" value={f.ends_on} onChange={(e) => set('ends_on', e.target.value)} /></Field>
        <Field label="De (heure)"><input type="time" value={f.time_from} onChange={(e) => set('time_from', e.target.value)} /></Field>
        <Field label="À (heure)"><input type="time" value={f.time_to} onChange={(e) => set('time_to', e.target.value)} /></Field>
      </div>
      <div className="chips" role="group" aria-label="Jours">{DAYS.map(([d, l]) => <button key={d} className={`chip${f.weekdays.includes(d) ? ' on' : ''}`} onClick={() => toggleDay(d)}>{l}</button>)}</div>
      <p className="muted small">Sans jour choisi, la promotion vaut tous les jours. Un article ne profite que d'une promotion à la fois : la plus avantageuse pour le client.</p>
      {promo && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Promotion active</label>}
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !f.name.trim()} onClick={save}>Enregistrer</button></div>
    </Modal>
  );
}

function Loyalty({ loyalty, onSaved }) {
  const [f, setF] = useState({ enabled: Boolean(loyalty.enabled), spend: toEuroInput(loyalty.spend_cents_per_stamp), needed: String(loyalty.stamps_needed), reward: toEuroInput(loyalty.reward_cents) });
  const { busy, error, run } = useAsync();
  const [saved, setSaved] = useState(false);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setSaved(false); };
  return (
    <section className="card">
      <h2>Carte de fidélité (tampons)</h2>
      <ErrorBox error={error} />
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Programme actif</label>
      <div className="grid">
        <Field label="1 tampon par … € dépensés"><input inputMode="decimal" value={f.spend} onChange={(e) => set('spend', e.target.value)} /></Field>
        <Field label="Tampons pour une récompense"><input inputMode="numeric" value={f.needed} onChange={(e) => set('needed', e.target.value)} /></Field>
        <Field label="Valeur de la récompense (€ de remise)"><input inputMode="decimal" value={f.reward} onChange={(e) => set('reward', e.target.value)} /></Field>
      </div>
      <p className="muted small">Exemple : 1 tampon par 1 €, 10 tampons = 5 € offerts. Les tampons sont attribués aux clients enregistrés choisis à la caisse, et retirés si la vente est annulée.</p>
      <div className="actions">{saved && <span className="pos-amount">Enregistré ✓</span>}<button className="primary" disabled={busy} onClick={() => run(async () => { await api.put('/api/loyalty', { enabled: f.enabled, spend_cents_per_stamp: parseEuros(f.spend), stamps_needed: Number(f.needed), reward_cents: parseEuros(f.reward) }); setSaved(true); onSaved(); })}>Enregistrer</button></div>
    </section>
  );
}

export default function Promotions() {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const { error, setError } = useAsync();
  const load = useCallback(() => api.get('/api/promotions').then(setData).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  if (!data) return <section className="card">{error ? <ErrorBox error={error} /> : <p className="muted">Chargement…</p>}</section>;
  return (
    <div className="stack">
      <section className="card">
        <div className="row-between"><h1>Promotions</h1><button className="primary" onClick={() => setEdit({})}>+ Nouvelle promotion</button></div>
        <ErrorBox error={error} />
        {data.items.length === 0 && <p className="muted">Aucune promotion. Exemples : « 2 achetées, 1 offerte », « 5 pour 10 € », « −20 % de 17 h à 19 h ».</p>}
        {data.items.length > 0 && (
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Promotion</th><th>État</th><th /></tr></thead><tbody>
            {data.items.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'off'}><td><strong>{p.name}</strong><div className="muted small">{describe(p)}</div></td>
                <td>{!p.active ? <span className="badge">désactivée</span> : p.runningNow ? <span className="badge ok">en cours</span> : <span className="badge">hors période</span>}</td>
                <td className="right"><button onClick={() => setEdit(p)}>Modifier</button></td></tr>
            ))}</tbody></table></div>
        )}
      </section>
      <Loyalty key={JSON.stringify(data.loyalty)} loyalty={data.loyalty} onSaved={load} />
      {edit && <PromoForm promo={edit.id ? edit : null} lists={data} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}
