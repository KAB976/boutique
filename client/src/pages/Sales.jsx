import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurSigned, parseEuros, toEuroInput, METHODS, FLAG_TEXT, fmtDT, fmtTime, fmtD, todayLocal } from '../money.js';
import { cache, queue, failed, onQueueChange } from '../offline.js';
import { TicketBody, PrintTicket } from './Ticket.jsx';

const Flags = ({ flags }) => (flags || []).filter((f) => FLAG_TEXT[f] && !['refund', 'offline'].includes(f)).map((f) => <span key={f} className="badge warn" title={FLAG_TEXT[f]}>{FLAG_TEXT[f]}</span>);

function SaleDetail({ id, tz, can, onClose, onChanged }) {
  const [s, setS] = useState(null);
  const [shop, setShop] = useState(() => cache.get('ticket'));
  const [refunding, setRefunding] = useState(false);
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get(`/api/sales/${id}`).then(setS).catch((e) => setError(e.message)), [id]); // eslint-disable-line
  useEffect(() => { load(); api.get('/api/ticket-info').then((t) => { cache.set('ticket', t); setShop(t); }).catch(() => {}); }, [load]);
  const refund = () => run(async () => { await api.post(`/api/sales/${id}/refund`, { reason, restock }); setRefunding(false); await load(); onChanged(); });
  return (
    <Modal title={s ? `${s.kind === 'refund' ? 'Annulation' : 'Vente'} ${s.number}` : 'Vente'} onClose={onClose}>
      <ErrorBox error={error} />
      {s && (
        <>
          {s.refunded_by && <Notice tone="warn">Cette vente a été annulée ({s.refunded_by.number}) : {s.refunded_by.void_reason}.</Notice>}
          {s.kind === 'refund' && <Notice tone="warn">Motif : {s.void_reason}</Notice>}
          <p className="small"><Flags flags={s.flags} />{s.offline ? <span className="badge">hors-ligne{s.provisional ? ` (${s.provisional})` : ''}</span> : null}</p>
          <TicketBody sale={s} shop={shop} tz={tz} />
          <PrintTicket sale={s} shop={shop} tz={tz} />
          {can.costs && s.cost != null && <p className="small muted">Coût des articles : {eur(Math.round(s.cost * 100))} · marge {eur(s.total_cents - s.vat_cents - Math.round(s.cost * 100))} (hors TVA)</p>}
          {refunding ? (
            <>
              <Field label="Motif de l'annulation (obligatoire)"><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
              <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Remettre la marchandise en stock (décochez si elle est jetée)</label>
              <div className="actions"><button onClick={() => setRefunding(false)}>Retour</button><button className="danger" disabled={busy || !reason.trim()} onClick={refund}>Annuler cette vente</button></div>
            </>
          ) : (
            <div className="actions">
              <button onClick={() => window.print()}>🖨 Imprimer</button>
              {s.kind === 'sale' && !s.refunded_by && <button className="danger" onClick={() => setRefunding(true)}>Annuler la vente…</button>}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function History({ me }) {
  const [day, setDay] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const { error, setError } = useAsync();
  const [cat] = useState(() => cache.get('catalog'));
  const load = useCallback(() => api.get(`/api/sales?limit=100${day ? `&day=${day}` : ''}`).then(setData).catch((e) => setError(e.message)), [day]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const all = data?.scope === 'all';
  const tz = cat?.tz;
  return (
    <section className="card">
      <div className="row-between"><h2>{all ? 'Ventes' : 'Mes ventes depuis la dernière clôture'}</h2>
        {all && <input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} aria-label="Jour" />}</div>
      <ErrorBox error={error} />
      {data && data.items.length === 0 && <p className="muted">Aucune vente.</p>}
      {data && data.items.length > 0 && (
        <div className="table-wrap"><table className="responsive">
          <thead><tr><th>Ticket</th><th>Heure</th><th>Vendeur</th><th>Total</th><th /></tr></thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id} className={s.refunded ? 'off' : ''}>
                <td><strong>{s.number}</strong> {s.kind === 'refund' && <span className="badge warn">annulation</span>} {s.refunded && <span className="badge">annulée</span>} {s.offline ? <span className="badge">hors-ligne</span> : null} <Flags flags={s.flags} /></td>
                <td className="nowrap">{all ? fmtDT(s.ts, tz) : fmtTime(s.ts, tz)}</td><td>{s.user_name}</td>
                <td className={`nowrap ${s.total_cents < 0 ? 'neg' : ''}`}>{eur(s.total_cents)}</td>
                <td className="right"><button onClick={() => setOpen(s.id)}>Détail</button></td>
              </tr>
            ))}
          </tbody></table></div>
      )}
      {open && <SaleDetail id={open} tz={tz} can={{ costs: me.permissions.includes('costs.view') }} onClose={() => setOpen(null)} onChanged={load} />}
    </section>
  );
}

function PrintZ({ z, shop, tz, byProduct, moves }) {
  return createPortal(
    <div className="print-sheet">
      <h1>{shop?.shop_name} — Clôture de caisse {z.number}</h1>
      <p>{fmtDT(z.ts, tz)} · {z.user_name}</p>
      <h2>Ventes</h2>
      <table><tbody>
        <tr><td>Nombre de ventes</td><td>{z.sales_count}</td></tr>
        <tr><td>Chiffre d'affaires</td><td>{eur(z.sales_cents)}</td></tr>
        <tr><td>Annulations ({z.refunds_count})</td><td>−{eur(z.refunds_cents)}</td></tr>
        {Object.entries(z.by_method || {}).map(([m, v]) => <tr key={m}><td>Encaissé : {METHODS[m] || m}</td><td>{eur(v)}</td></tr>)}
      </tbody></table>
      <h2>Espèces</h2>
      <table><tbody>
        <tr><td>Fond de caisse au départ</td><td>{eur(z.float_in_cents)}</td></tr>
        <tr><td>Attendu en caisse</td><td>{eur(z.cash_expected_cents)}</td></tr>
        <tr><td>Compté</td><td>{eur(z.cash_counted_cents)}</td></tr>
        <tr><td><strong>Écart</strong></td><td><strong>{eurSigned(z.variance_cents)}</strong></td></tr>
        <tr><td>Fond laissé en caisse</td><td>{eur(z.float_out_cents)}</td></tr>
      </tbody></table>
      {z.note && <p>Note : {z.note}</p>}
      {byProduct?.length > 0 && <><h2>Par article</h2><table><tbody>{byProduct.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.qty}</td><td>{eur(p.cents)}</td></tr>)}</tbody></table></>}
      {moves?.length > 0 && <><h2>Mouvements de caisse</h2><table><tbody>{moves.map((m, i) => <tr key={i}><td>{m.reason}</td><td>{eurSigned(m.amount_cents)}</td></tr>)}</tbody></table></>}
    </div>, document.body);
}

function Closure({ me }) {
  const [pv, setPv] = useState(null);
  const [counted, setCounted] = useState('');
  const [floatOut, setFloatOut] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState(queue().length);
  const [shop] = useState(() => cache.get('ticket'));
  const tz = cache.get('catalog')?.tz;
  const { busy, error, setError, run } = useAsync();
  const [move, setMove] = useState({ sign: 1, amount: '', reason: '' });
  const load = useCallback(() => api.get('/api/closure/preview').then(setPv).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => onQueueChange(() => setPending(queue().length)), []);
  const c = parseEuros(counted), f = floatOut === '' ? 0 : parseEuros(floatOut);
  const variance = pv && c != null ? c - pv.cash_expected_cents : null;
  const submit = () => run(async () => {
    const r = await api.post('/api/closure', { counted_cents: c, float_out_cents: f, note });
    setResult({ ...r, by_product: pv.by_product, moves: pv.cash_moves });
    setCounted(''); setFloatOut(''); setNote(''); load();
  });
  const addMove = () => run(async () => {
    const cents = parseEuros(move.amount);
    if (!(cents > 0)) throw new Error('Montant invalide.');
    await api.post('/api/cash-moves', { amount_cents: move.sign * cents, reason: move.reason });
    setMove({ sign: 1, amount: '', reason: '' }); load();
  });
  if (!pv) return <section className="card">{error ? <ErrorBox error={error} /> : <p className="muted">Chargement…</p>}</section>;
  return (
    <div className="stack">
      {pending > 0 && <Notice tone="warn">Cet appareil a encore {pending} vente(s) hors-ligne non envoyée(s). Attendez qu'elles soient envoyées avant de clôturer, sinon elles tomberont dans la clôture suivante.</Notice>}
      <section className="card">
        <h2>Clôture de caisse</h2>
        <p className="muted">{pv.last ? `Dernière clôture : ${pv.last.number}, le ${fmtDT(pv.last.ts, tz)}.` : 'Aucune clôture pour l\'instant.'}</p>
        {pv.empty ? <p>Rien à clôturer : aucune vente ni mouvement depuis la dernière clôture.</p> : (
          <>
            <div className="kpis">
              <div className="kpi"><strong>{pv.sales_count}</strong><span>ventes</span></div>
              <div className="kpi"><strong>{eur(pv.sales_cents - pv.refunds_cents)}</strong><span>chiffre d'affaires net{pv.refunds_count > 0 ? ` (dont ${pv.refunds_count} annulation${pv.refunds_count > 1 ? 's' : ''})` : ''}</span></div>
              {Object.entries(pv.by_method).map(([m, v]) => <div className="kpi" key={m}><strong>{eur(v)}</strong><span>{METHODS[m] || m}</span></div>)}
            </div>
            <table><tbody>
              <tr><td>Fond de caisse au départ</td><td className="right">{eur(pv.float_in_cents)}</td></tr>
              <tr><td>+ Espèces encaissées (ventes − annulations)</td><td className="right">{eur(pv.by_method.cash ?? 0)}</td></tr>
              <tr><td>± Mouvements de caisse</td><td className="right">{eurSigned(pv.cash_moves_cents)}</td></tr>
              <tr><td><strong>= Attendu dans le tiroir</strong></td><td className="right"><strong>{eur(pv.cash_expected_cents)}</strong></td></tr>
            </tbody></table>
            <ErrorBox error={error} />
            <div className="grid">
              <Field label="Espèces comptées dans le tiroir (€)"><input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0,00" /></Field>
              <Field label="Fond de caisse que vous laissez (€)" hint="Le reste est retiré de la caisse (dépôt)."><input inputMode="decimal" value={floatOut} onChange={(e) => setFloatOut(e.target.value)} placeholder="0,00" /></Field>
            </div>
            {variance != null && <p className={variance === 0 ? 'pos-amount' : 'neg'}>{variance === 0 ? 'La caisse est juste.' : `Écart : ${eurSigned(variance)} (${variance < 0 ? 'il manque' : 'il y a en trop'} ${eur(Math.abs(variance))})`}</p>}
            {variance != null && variance !== 0 && <Field label="Expliquez l'écart (obligatoire)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
            <div className="actions"><button className="primary" disabled={busy || c == null || f == null || (variance !== 0 && !note.trim())} onClick={submit}>Clôturer la caisse</button></div>
          </>
        )}
      </section>
      {result && (
        <Modal title={`Clôture ${result.number} enregistrée`} onClose={() => setResult(null)}>
          <p>Écart : <strong className={result.variance_cents === 0 ? 'pos-amount' : 'neg'}>{eurSigned(result.variance_cents)}</strong>. À retirer de la caisse (dépôt) : <strong>{eur(result.deposit_cents)}</strong>.</p>
          <PrintZ z={result} shop={shop} tz={tz} byProduct={result.by_product} moves={result.moves} />
          <div className="actions"><button onClick={() => window.print()}>🖨 Imprimer / PDF</button><button className="primary" onClick={() => setResult(null)}>Fermer</button></div>
        </Modal>
      )}
      <section className="card">
        <h3>Mouvement de caisse</h3>
        <p className="muted small">Fond de caisse ajouté, achat payé en espèces, retrait… Chaque mouvement a un motif.</p>
        <div className="inline">
          <select value={move.sign} onChange={(e) => setMove({ ...move, sign: Number(e.target.value) })} style={{ maxWidth: 130 }}><option value={1}>Entrée +</option><option value={-1}>Sortie −</option></select>
          <input inputMode="decimal" placeholder="Montant €" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} />
        </div>
        <Field label="Motif"><input value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} /></Field>
        <div className="actions"><button onClick={addMove} disabled={busy || !move.reason.trim() || !move.amount}>Enregistrer</button></div>
        {pv.cash_moves.length > 0 && <table><tbody>{pv.cash_moves.map((m, i) => <tr key={i}><td>{fmtTime(m.ts, tz)}</td><td>{m.reason}</td><td className="right">{eurSigned(m.amount_cents)}</td></tr>)}</tbody></table>}
      </section>
      {pv.by_product.length > 0 && (
        <section className="card"><h3>Par article depuis la dernière clôture</h3>
          <table><tbody>{pv.by_product.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.qty}</td><td className="right">{eur(p.cents)}</td></tr>)}</tbody></table></section>
      )}
    </div>
  );
}

function Closures() {
  const [items, setItems] = useState(null);
  const [open, setOpen] = useState(null);
  const tz = cache.get('catalog')?.tz;
  const [shop] = useState(() => cache.get('ticket'));
  useEffect(() => { api.get('/api/closures').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  if (!items) return null;
  return (
    <section className="card">
      <h2>Clôtures passées</h2>
      {items.length === 0 ? <p className="muted">Aucune.</p> : (
        <div className="table-wrap"><table className="responsive"><thead><tr><th>N°</th><th>Date</th><th>Ventes</th><th>CA net</th><th>Écart</th><th /></tr></thead><tbody>
          {items.map((z) => (
            <tr key={z.id}><td><strong>{z.number}</strong></td><td>{fmtDT(z.ts, tz)}</td><td>{z.sales_count}</td><td>{eur(z.sales_cents - z.refunds_cents)}</td>
              <td className={z.variance_cents === 0 ? '' : 'neg'}>{eurSigned(z.variance_cents)}</td><td className="right"><button onClick={() => setOpen(z)}>Voir</button></td></tr>
          ))}
        </tbody></table></div>
      )}
      {open && (
        <Modal title={`Clôture ${open.number}`} onClose={() => setOpen(null)}>
          <p>{fmtDT(open.ts, tz)} · {open.user_name}</p>
          <table><tbody>
            <tr><td>Ventes</td><td className="right">{open.sales_count}</td></tr><tr><td>Chiffre d'affaires</td><td className="right">{eur(open.sales_cents)}</td></tr><tr><td>Annulations</td><td className="right">−{eur(open.refunds_cents)}</td></tr>
            {Object.entries(open.by_method).map(([m, v]) => <tr key={m}><td>{METHODS[m] || m}</td><td className="right">{eur(v)}</td></tr>)}
            <tr><td>Attendu</td><td className="right">{eur(open.cash_expected_cents)}</td></tr><tr><td>Compté</td><td className="right">{eur(open.cash_counted_cents)}</td></tr>
            <tr><td><strong>Écart</strong></td><td className="right"><strong>{eurSigned(open.variance_cents)}</strong></td></tr><tr><td>Fond laissé</td><td className="right">{eur(open.float_out_cents)}</td></tr>
          </tbody></table>
          {open.note && <p>Note : {open.note}</p>}
          <PrintZ z={open} shop={shop} tz={tz} />
          <div className="actions"><button onClick={() => window.print()}>🖨 Imprimer / PDF</button></div>
        </Modal>
      )}
    </section>
  );
}

export default function Sales({ me }) {
  const [sub, setSub] = useState('history');
  const canClose = me.permissions.includes('closure.do');
  return (
    <div>
      <div className="subtabs">
        <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>Ventes</button>
        {canClose && <button className={sub === 'closure' ? 'active' : ''} onClick={() => setSub('closure')}>Clôture de caisse</button>}
        {canClose && <button className={sub === 'past' ? 'active' : ''} onClick={() => setSub('past')}>Clôtures passées</button>}
      </div>
      {sub === 'history' && <History me={me} />}
      {sub === 'closure' && <Closure me={me} />}
      {sub === 'past' && <Closures />}
    </div>
  );
}
