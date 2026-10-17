import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurSigned, METHODS, fmtDT, fmtTime, fmtD } from '../money.js';
import { cache } from '../offline.js';

const Row = ({ k, v, strong, cls }) => <tr><td>{strong ? <strong>{k}</strong> : k}</td><td className={`right ${cls || ''}`}>{strong ? <strong>{v}</strong> : v}</td></tr>;

function Sheet({ d, shop, tz }) {
  return createPortal(
    <div className="print-sheet">
      <h1>{shop?.shop_name} — Vérification de caisse {d.number}</h1>
      <p>Quart {d.shift?.number} · {d.shift?.user_name} · {fmtDT(d.ts, tz)}</p>
      <Detail d={d} tz={tz} />
      {d.review && <p>Vérifié par {d.review.reviewer_name} le {fmtDT(d.review.reviewed_at, tz)}{d.review.note ? ` : ${d.review.note}` : ''}</p>}
    </div>, document.body);
}

function Detail({ d, tz }) {
  return (
    <>
      <table><tbody>
        <Row k="Fond de caisse compté à l'ouverture" v={eur(d.float_in_cents)} />
        <Row k="+ Ventes en espèces (nettes)" v={eur(d.cash_sales_cents)} />
        {d.late_cash_cents !== 0 && <Row k="− Ventes sans réseau faites avant l'ouverture (argent resté dans le tiroir précédent)" v={eur(d.late_cash_cents)} />}
        <Row k="± Entrées / sorties d'espèces" v={eurSigned(d.moves.reduce((t, m) => t + m.amount_cents, 0))} />
        <Row k="− Versements en cours de quart" v={eur(d.versed_cents)} />
        <Row k="= Attendu dans le tiroir à la fermeture" v={eur(d.cash_expected_cents)} strong />
        <Row k="Compté par le caissier" v={eur(d.cash_counted_cents)} />
        <Row k="Écart" v={eurSigned(d.variance_cents)} strong cls={d.variance_cents === 0 ? 'pos-amount' : 'neg'} />
        <Row k="Fond de caisse laissé" v={eur(d.float_out_cents)} />
        <Row k="Versé à la fermeture" v={eur(d.closing_deposit_cents)} />
        <Row k="Total versé (versements + fermeture)" v={eur(d.handed_total_cents)} strong />
      </tbody></table>
      <h3>Autres encaissements du quart</h3>
      <table><tbody>
        {Object.entries(d.by_method).filter(([m]) => m !== 'cash').map(([m, v]) => <Row key={m} k={METHODS[m] || m} v={eur(v)} />)}
        <Row k="Chiffre d'affaires net" v={eur(d.sales_cents - d.refunds_cents)} />
      </tbody></table>
      {d.versements.length > 0 && <><h3>Versements</h3><table><tbody>{d.versements.map((v) => <tr key={v.number}><td>Versement {v.number}</td><td>{fmtTime(v.ts, tz)}</td><td className="right">{eur(v.amount_cents)}</td></tr>)}</tbody></table></>}
      {d.moves.length > 0 && <><h3>Entrées et sorties d'espèces</h3><table><tbody>{d.moves.map((m, i) => <tr key={i}><td>{fmtTime(m.ts, tz)}</td><td><strong>{m.category || '—'}</strong><div className="small">{m.reason}{m.user_name ? ` · ${m.user_name}` : ''}</div></td><td className="right">{eurSigned(m.amount_cents)}</td></tr>)}</tbody></table></>}
      {d.shift?.opening_variance_cents ? <p className="neg small">Écart à l'ouverture du quart : {eurSigned(d.shift.opening_variance_cents)}{d.shift.opening_note ? ` — ${d.shift.opening_note}` : ''}</p> : null}
      {d.note && <p>Note du caissier : {d.note}</p>}
    </>
  );
}

function Check({ d, me, tz, shop, onClose, onDone }) {
  const [note, setNote] = useState('');
  const { busy, error, run } = useAsync();
  const mine = d.user_id === me.id && me.role !== 'owner';
  const validate = () => run(async () => { await api.post(`/api/cash-review/${d.id}`, { note }); onDone(); onClose(); });
  return (
    <Modal title={`Caisse ${d.number} · quart ${d.shift?.number ?? ''}`} onClose={onClose}>
      <p>{d.shift?.user_name} · fermée le {fmtDT(d.ts, tz)}{d.shift?.forced ? ` · fermée à sa place par ${d.shift.closed_by_name}` : ''}</p>
      <Detail d={d} tz={tz} />
      <Sheet d={d} shop={shop} tz={tz} />
      {d.review ? (
        <Notice tone="ok">Vérifiée par {d.review.reviewer_name} le {fmtDT(d.review.reviewed_at, tz)}{d.review.note ? ` : ${d.review.note}` : ''}</Notice>
      ) : mine ? <Notice tone="warn">C'est votre propre caisse : elle doit être vérifiée par le propriétaire.</Notice> : (
        <>
          <ErrorBox error={error} />
          <Field label={d.variance_cents === 0 ? 'Remarque (facultatif)' : 'Votre conclusion sur l\'écart (obligatoire)'}><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        </>
      )}
      <div className="actions">
        <button onClick={() => window.print()}>🖨 Imprimer / PDF</button>
        {!d.review && !mine && <button className="primary" disabled={busy || (d.variance_cents !== 0 && note.trim().length < 3)} onClick={validate}>Valider cette caisse</button>}
      </div>
    </Modal>
  );
}

function Live({ live, tz, onChanged }) {
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAsync();
  if (!live) return <section className="card"><h2>Caisse en cours</h2><p className="muted">Aucun quart ouvert pour l'instant.</p></section>;
  const ask = () => run(async () => { await api.post('/api/shift/request-deposit', { note: msg }); setSent(true); setMsg(''); onChanged(); });
  const sh = live.shift;
  return (
    <section className="card">
      <h2>Caisse en cours</h2>
      <p>Quart <strong>{sh.number}</strong> de <strong>{sh.user_name}</strong>, ouvert à {fmtTime(sh.opened_at, tz)}.</p>
      <div className="kpis">
        <div className="kpi"><strong className={live.over ? 'neg' : ''}>{eur(live.expected_now_cents)}</strong><span>espèces attendues dans le tiroir (dont fond {eur(sh.opening_counted_cents)})</span></div>
        <div className="kpi"><strong>{eur(live.cash_sales_cents)}</strong><span>ventes en espèces</span></div>
        <div className="kpi"><strong>{eur(live.card_cents)}</strong><span>ventes par carte</span></div>
        <div className="kpi"><strong>{eur(live.deposits_cents)}</strong><span>déjà versé ({live.deposits.length})</span></div>
      </div>
      {live.over && <Notice tone="warn">Plus de {eur(live.alert_cents)} d'espèces hors fond de caisse : le caissier a été prévenu de verser {eur(live.alert_cents)} et reçoit un rappel toutes les 10 minutes. Vous pouvez aussi le relancer ci-dessous.</Notice>}
      {sh.deposit_requested_at && <p className="muted small">Demande envoyée à {fmtTime(sh.deposit_requested_at, tz)} par {sh.deposit_requested_by} ; pas encore de versement depuis.</p>}
      <ErrorBox error={error} />
      <div className="inline">
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message (facultatif) : ex. versez 100 €" maxLength={120} />
        <button className="primary" disabled={busy} onClick={ask}>Demander un versement</button>
      </div>
      {sent && <p className="muted small">{sh.user_name} voit la demande sur son écran (et sur son téléphone s'il a activé les notifications).</p>}
      {live.deposits.length > 0 && <table><tbody>{live.deposits.map((d) => <tr key={d.number}><td>Versement {d.number}</td><td>{fmtTime(d.ts, tz)}</td><td className="right">{eur(d.amount_cents)}</td></tr>)}</tbody></table>}
    </section>
  );
}

export default function CashCheck({ me }) {
  const [data, setData] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(null);
  const [shop] = useState(() => cache.get('ticket'));
  const tz = cache.get('catalog')?.tz;
  const { error, setError } = useAsync();
  const load = useCallback(() => api.get(`/api/cash-review?${from ? `from=${from}&` : ''}${to ? `to=${to}` : ''}`).then(setData).catch((e) => setError(e.message)), [from, to]); // eslint-disable-line
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);
  if (!data) return <section className="card">{error ? <ErrorBox error={error} /> : <p className="muted">Chargement…</p>}</section>;
  return (
    <div className="stack">
      <Live live={data.live} tz={tz} onChanged={load} />
      <section className="card">
        <div className="row-between"><h2>Vérification des caisses{data.pending_total > 0 ? ` · ${data.pending_total} à vérifier` : ''}</h2>
          <span className="inline"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Du" style={{ width: 'auto' }} /><input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Au" style={{ width: 'auto' }} /></span></div>
        <ErrorBox error={error} />
        {data.days.length === 0 && <p className="muted">Aucune caisse fermée.</p>}
        {data.days.map((day) => (
          <div key={day.day} className="stack-tight" style={{ marginTop: 14 }}>
            <h3>{fmtD(day.day)} {day.totals.pending > 0 ? <span className="badge warn">{day.totals.pending} à vérifier</span> : <span className="badge ok">tout est vérifié</span>}</h3>
            <p className="muted small">Total du jour : ventes {eur(day.totals.sales_cents)} (espèces {eur(day.totals.cash_sales_cents)}, carte {eur(day.totals.card_cents)}) · total versé {eur(day.totals.handed_cents)} · écart cumulé <strong className={day.totals.variance_cents === 0 ? '' : 'neg'}>{eurSigned(day.totals.variance_cents)}</strong></p>
            <div className="table-wrap"><table className="responsive">
              <thead><tr><th>Quart</th><th>Caissier</th><th>Fermé à</th><th>Attendu</th><th>Compté</th><th>Écart</th><th>Versé</th><th /></tr></thead>
              <tbody>{day.items.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.shift?.number ?? d.number}</strong></td><td>{d.shift?.user_name ?? d.user_name}</td><td className="nowrap">{fmtTime(d.ts, tz)}</td>
                  <td>{eur(d.cash_expected_cents)}</td><td>{eur(d.cash_counted_cents)}</td>
                  <td className={d.variance_cents === 0 ? 'pos-amount' : 'neg'}>{eurSigned(d.variance_cents)}</td><td>{eur(d.handed_total_cents)}</td>
                  <td className="right">{d.review ? <button onClick={() => setOpen(d)}>✓ Vérifiée</button> : <button className="primary" onClick={() => setOpen(d)}>Vérifier</button>}</td>
                </tr>))}</tbody>
            </table></div>
          </div>
        ))}
      </section>
      {open && <Check d={open} me={me} tz={tz} shop={shop} onClose={() => setOpen(null)} onDone={load} />}
    </div>
  );
}
