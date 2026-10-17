import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurSigned, parseEuros, toEuroInput, METHODS, FLAG_TEXT, fmtDT, fmtTime, fmtD, todayLocal } from '../money.js';
import { cache, queue, failed, onQueueChange } from '../offline.js';
import { TicketBody, PrintTicket } from './Ticket.jsx';
import { useShift, loadShift, nav } from '../shift.js';
import { PinInput } from './Shift.jsx';

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
          {s.discount_by_name && <Notice tone="info">Remise spéciale accordée par <strong>{s.discount_by_name}</strong> : {s.discount_reason}.</Notice>}
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
          <thead><tr><th>Ticket</th><th>Heure</th><th>Vendeur</th>{all && <th>Total</th>}<th /></tr></thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id} className={s.refunded ? 'off' : ''}>
                <td><strong>{s.number}</strong> {s.kind === 'refund' && <span className="badge warn">annulation</span>} {s.refunded && <span className="badge">annulée</span>} {s.offline ? <span className="badge">hors-ligne</span> : null} <Flags flags={s.flags} /></td>
                <td className="nowrap">{all ? fmtDT(s.ts, tz) : fmtTime(s.ts, tz)}</td><td>{s.user_name}</td>
                {all && <td className={`nowrap ${s.total_cents < 0 ? 'neg' : ''}`}>{eur(s.total_cents)}</td>}
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
      <p>{fmtDT(z.ts, tz)} · {z.user_name}{z.shift?.closed_by_name && z.shift.closed_by_name !== z.shift.user_name ? ` (fermé par ${z.shift.closed_by_name})` : ''}</p>
      {z.shift && <p>Quart {z.shift.number} : ouvert par {z.shift.user_name} le {fmtDT(z.shift.opened_at, tz)} · fond compté à l'ouverture {eur(z.shift.opening_counted_cents)}{z.shift.opening_variance_cents ? ` (écart d'ouverture ${eurSigned(z.shift.opening_variance_cents)}${z.shift.opening_note ? ` : ${z.shift.opening_note}` : ''})` : ''}</p>}
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
        <tr><td>Fond laissé en caisse pour le quart suivant</td><td>{eur(z.float_out_cents)}</td></tr>
      </tbody></table>
      {z.note && <p>Note : {z.note}</p>}
      {byProduct?.length > 0 && <><h2>Par article</h2><table><tbody>{byProduct.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.qty}</td><td>{eur(p.cents)}</td></tr>)}</tbody></table></>}
      {moves?.length > 0 && <><h2>Mouvements de caisse</h2><table><tbody>{moves.map((m, i) => <tr key={i}><td>{m.category ? `${m.category} — ` : ''}{m.reason}{m.user_name ? ` (${m.user_name})` : ''}</td><td>{eurSigned(m.amount_cents)}</td></tr>)}</tbody></table></>}
    </div>, document.body);
}

function Closure({ me }) {
  const sh = useShift(me);
  const [pin, setPin] = useState('');
  const [pv, setPv] = useState(null);
  const [counted, setCounted] = useState('');
  const [floatOut, setFloatOut] = useState('');
  const [handIn, setHandIn] = useState('');
  const [dep, setDep] = useState({ amount: '', note: '' });
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState(queue().length);
  const [shop] = useState(() => cache.get('ticket'));
  const tz = cache.get('catalog')?.tz;
  const { busy, error, setError, run } = useAsync();
  const [move, setMove] = useState({ sign: -1, amount: '', category: '', reason: '' });
  const load = useCallback(() => api.get('/api/closure/preview').then(setPv).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  useEffect(() => onQueueChange(() => setPending(queue().length)), []);
  const blind = Boolean(pv?.blind);
  const f = floatOut === '' ? 0 : parseEuros(floatOut);
  const h = handIn === '' ? 0 : parseEuros(handIn);
  const c = blind ? (f != null && h != null && (handIn !== '' || floatOut !== '') ? f + h : null) : parseEuros(counted);
  const variance = !blind && pv && c != null ? c - pv.cash_expected_cents : null;
  const submit = () => run(async () => {
    const r = await api.post('/api/closure', { counted_cents: c, float_out_cents: f, note, pin });
    setResult({ ...r, by_product: pv.by_product, moves: pv.cash_moves });
    setCounted(''); setFloatOut(''); setHandIn(''); setNote(''); setPin(''); load(); loadShift(me);
  });
  const addDeposit = () => run(async () => {
    const cents = parseEuros(dep.amount);
    if (!(cents > 0)) throw new Error('Montant invalide.');
    await api.post('/api/shift/deposit', { amount_cents: cents, note: dep.note });
    setDep({ amount: '', note: '' }); load(); loadShift(me);
  });
  const addMove = () => run(async () => {
    const cents = parseEuros(move.amount);
    if (!(cents > 0)) throw new Error('Montant invalide.');
    await api.post('/api/cash-moves', { amount_cents: move.sign * cents, category: move.category, reason: move.reason });
    setMove({ sign: move.sign, amount: '', category: '', reason: '' }); load();
  });
  const required = Boolean(sh?.required);
  const shift = pv?.shift;
  const theirs = Boolean(shift && shift.user_id !== me.id);
  const reasons = (move.sign < 0 ? sh?.out_reasons : sh?.in_reasons) ?? [];
  const resultModal = result && (
        <Modal title={`${result.shift ? `Quart ${result.shift.number} fermé` : 'Clôture enregistrée'} · ${result.number}`} onClose={() => setResult(null)}>
          {result.blind ? (
            <>
              <p>Merci. Vous avez versé <strong>{eur(result.deposit_cents)}</strong> et laissé un fond de caisse de <strong>{eur(result.float_out_cents)}</strong>.</p>
              <p className="muted">L'administrateur va vérifier la caisse.</p>
              <div className="actions"><button className="primary" onClick={() => setResult(null)}>Fermer</button></div>
            </>
          ) : (
            <>
              <p>Écart : <strong className={result.variance_cents === 0 ? 'pos-amount' : 'neg'}>{eurSigned(result.variance_cents)}</strong>. À retirer de la caisse (dépôt) : <strong>{eur(result.deposit_cents)}</strong>. Fond laissé pour le prochain quart : <strong>{eur(result.float_out_cents)}</strong>.</p>
              <PrintZ z={result} shop={shop} tz={tz} byProduct={result.by_product} moves={result.moves} />
              <div className="actions"><button onClick={() => window.print()}>🖨 Imprimer / PDF</button><button className="primary" onClick={() => setResult(null)}>Fermer</button></div>
            </>
          )}
        </Modal>
  );
  if (!pv) return <section className="card">{error ? <ErrorBox error={error} /> : <p className="muted">Chargement…</p>}</section>;
  if (required && !shift) return <div className="stack"><section className="card"><h2>Aucun quart ouvert</h2><p>Il n'y a rien à fermer. Pour commencer à vendre, ouvrez votre quart depuis l'onglet « Caisse ».</p></section>{resultModal}</div>;
  return (
    <div className="stack">
      {pending > 0 && <Notice tone="warn">Cet appareil a encore {pending} vente(s) hors-ligne non envoyée(s). Elles doivent être envoyées avant de fermer le quart (retournez dans « Caisse » : elles partent dès que le réseau revient).</Notice>}
      <section className="card">
        <h2>{shift ? `Fermer le quart ${shift.number}` : 'Clôture de caisse'}</h2>
        {shift && <p className="muted">Quart de <strong>{shift.user_name}</strong>, ouvert à {fmtTime(shift.opened_at, tz)} avec {eur(shift.opening_counted_cents)} dans le tiroir{shift.opening_variance_cents ? <span className="neg"> (écart constaté à l'ouverture : {eurSigned(shift.opening_variance_cents)}{shift.opening_note ? ` — ${shift.opening_note}` : ''})</span> : ''}.</p>}
        {theirs && <Notice tone="warn">Ce quart est celui de {shift.user_name}. En le fermant à sa place, vous devez expliquer pourquoi dans la note ; c'est écrit dans le journal.</Notice>}
        {!shift && <p className="muted">{pv.last ? `Dernière clôture : ${pv.last.number}, le ${fmtDT(pv.last.ts, tz)}.` : 'Aucune clôture pour l\'instant.'}</p>}
        {pv.empty ? <p>Rien à clôturer : aucune vente ni mouvement depuis la dernière clôture.</p> : (
          <>
            {!blind && (<>
            <div className="kpis">
              <div className="kpi"><strong>{pv.sales_count}</strong><span>ventes</span></div>
              <div className="kpi"><strong>{eur(pv.sales_cents - pv.refunds_cents)}</strong><span>chiffre d'affaires net{pv.refunds_count > 0 ? ` (dont ${pv.refunds_count} annulation${pv.refunds_count > 1 ? 's' : ''})` : ''}</span></div>
              {Object.entries(pv.by_method).map(([m, v]) => <div className="kpi" key={m}><strong>{eur(v)}</strong><span>{METHODS[m] || m}</span></div>)}
            </div>
            <table><tbody>
              <tr><td>Fond de caisse compté à l'ouverture</td><td className="right">{eur(pv.float_in_cents)}</td></tr>
              <tr><td>+ Espèces encaissées (ventes − annulations)</td><td className="right">{eur((pv.by_method.cash ?? 0) - (pv.late_cash_cents || 0))}</td></tr>
              {pv.late_cash_cents > 0 && <tr><td className="muted small">(+ {eur(pv.late_cash_cents)} de ventes sans réseau faites avant l'ouverture : l'argent est dans le tiroir du quart précédent)</td><td /></tr>}
              <tr><td>± Mouvements de caisse (dont versements)</td><td className="right">{eurSigned(pv.cash_moves_cents)}</td></tr>
              <tr><td><strong>= Attendu dans le tiroir</strong></td><td className="right"><strong>{eur(pv.cash_expected_cents)}</strong></td></tr>
            </tbody></table></>)}
            {blind && <Notice tone="info">Comptez le tiroir. Laissez le fond de caisse, mettez-le de côté, puis comptez <strong>tout le reste</strong> : c'est ce que vous versez.</Notice>}
            <ErrorBox error={error} />
            {blind ? (
              <div className="grid">
                <Field label="Fond de caisse que vous laissez dans le tiroir (€)" hint="La personne suivante le recomptera."><input inputMode="decimal" value={floatOut} onChange={(e) => setFloatOut(e.target.value)} placeholder="0,00" /></Field>
                <Field label="Argent que vous versez : tout le reste (€)" hint="Après avoir retiré le fond de caisse."><input inputMode="decimal" value={handIn} onChange={(e) => setHandIn(e.target.value)} placeholder="0,00" /></Field>
              </div>
            ) : (
              <div className="grid">
                <Field label="Espèces comptées dans le tiroir (€)"><input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0,00" /></Field>
                <Field label="Fond de caisse que vous laissez (€)" hint="Le reste est retiré de la caisse (dépôt)."><input inputMode="decimal" value={floatOut} onChange={(e) => setFloatOut(e.target.value)} placeholder="0,00" /></Field>
              </div>
            )}
            {variance != null && <p className={variance === 0 ? 'pos-amount' : 'neg'}>{variance === 0 ? 'La caisse est juste.' : `Écart : ${eurSigned(variance)} (${variance < 0 ? 'il manque' : 'il y a en trop'} ${eur(Math.abs(variance))})`}</p>}
            {variance != null && variance !== 0 && <Field label="Expliquez l'écart (obligatoire)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
            {theirs && variance === 0 && <Field label={`Pourquoi fermez-vous le quart de ${shift.user_name} ? (obligatoire)`}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
            {shift && <PinInput value={pin} onChange={setPin} label={theirs ? 'Votre code PIN (celui du gérant qui ferme)' : 'Votre code PIN (pour fermer votre quart)'} />}
            {!blind && f != null && f > 0 && <p className="muted small">Vous laissez <strong>{eur(f)}</strong> dans le tiroir : la personne suivante devra les recompter avec son code avant de vendre.</p>}
            <div className="actions"><button className="primary" disabled={busy || c == null || f == null || h == null || (blind && handIn === '') || (variance != null && variance !== 0 && !note.trim()) || (theirs && note.trim().length < 3) || (shift && pin.length < 4) || (shift && pending > 0)} onClick={submit}>{shift ? 'Fermer le quart' : 'Clôturer la caisse'}</button></div>
          </>
        )}
      </section>
      {resultModal}
      {shift && !theirs && (
        <section className="card">
          <h3>Versement en cours de quart</h3>
          <p className="muted small">Quand il y a beaucoup d'espèces dans le tiroir, remettez-en à l'administrateur : indiquez seulement le montant remis. Vous n'avez pas à calculer autre chose.</p>
          <div className="inline">
            <input inputMode="decimal" placeholder="Montant remis €" value={dep.amount} onChange={(e) => setDep({ ...dep, amount: e.target.value })} />
            <button className="primary" disabled={busy || !dep.amount} onClick={addDeposit}>Faire le versement {(pv.deposits?.length || 0) + 1}</button>
          </div>
          <Field label="Note (facultatif)"><input value={dep.note} onChange={(e) => setDep({ ...dep, note: e.target.value })} maxLength={150} placeholder="Ex. remis à Mina" /></Field>
          {pv.deposits?.length > 0 && <table><tbody>{pv.deposits.map((d) => <tr key={d.number}><td>Versement {d.number}</td><td>{fmtTime(d.ts, tz)}</td><td className="right">{eur(d.amount_cents)}</td></tr>)}</tbody></table>}
        </section>
      )}
      <section className="card">
        <h3>Entrée ou sortie d'espèces du tiroir</h3>
        <p className="muted small">Chaque sortie d'argent (achat, banque, retrait…) doit avoir un motif et une note. Elle apparaît dans la fermeture du quart et dans le journal.</p>
        <ErrorBox error={error} />
        <div className="inline">
          <select value={move.sign} onChange={(e) => setMove({ ...move, sign: Number(e.target.value), category: '' })} style={{ maxWidth: 140 }}><option value={-1}>Sortie −</option><option value={1}>Entrée +</option></select>
          <input inputMode="decimal" placeholder="Montant €" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} />
        </div>
        <Field label="Motif">
          <select value={move.category} onChange={(e) => setMove({ ...move, category: e.target.value })}><option value="">— choisir —</option>{reasons.map((r) => <option key={r}>{r}</option>)}</select>
        </Field>
        <Field label="Note (obligatoire)" hint="Ex. « Pain et lait chez Ali, ticket gardé »."><input value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} maxLength={200} /></Field>
        <div className="actions"><button onClick={addMove} disabled={busy || move.reason.trim().length < 3 || !move.amount || !move.category}>Enregistrer</button></div>
        {pv.cash_moves.length > 0 && <table><tbody>{pv.cash_moves.map((m, i) => <tr key={i}><td>{fmtTime(m.ts, tz)}</td><td><strong>{m.category || '—'}</strong><div className="small">{m.reason}{m.user_name ? ` · ${m.user_name}` : ''}</div></td><td className="right">{eurSigned(m.amount_cents)}</td></tr>)}</tbody></table>}
      </section>
      {!blind && pv.by_product.length > 0 && (
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
        <div className="table-wrap"><table className="responsive"><thead><tr><th>N°</th><th>Quart</th><th>Date</th><th>Ventes</th><th>CA net</th><th>Écart</th><th /></tr></thead><tbody>
          {items.map((z) => (
            <tr key={z.id}><td><strong>{z.number}</strong></td><td>{z.shift ? `${z.shift.number} · ${z.shift.user_name}` : '—'}</td><td>{fmtDT(z.ts, tz)}</td><td>{z.sales_count}</td><td>{eur(z.sales_cents - z.refunds_cents)}</td>
              <td className={z.variance_cents === 0 ? '' : 'neg'}>{eurSigned(z.variance_cents)}</td><td className="right"><button onClick={() => setOpen(z)}>Voir</button></td></tr>
          ))}
        </tbody></table></div>
      )}
      {open && (
        <Modal title={`${open.shift ? `Quart ${open.shift.number} · ` : ''}Clôture ${open.number}`} onClose={() => setOpen(null)}>
          <p>{fmtDT(open.ts, tz)} · fermée par {open.user_name}</p>
          {open.shift && <p className="small">Quart de <strong>{open.shift.user_name}</strong>, ouvert le {fmtDT(open.shift.opened_at, tz)}, fond compté à l'ouverture {eur(open.shift.opening_counted_cents)}{open.shift.opening_variance_cents ? <span className="neg"> (écart d'ouverture {eurSigned(open.shift.opening_variance_cents)}{open.shift.opening_note ? ` — ${open.shift.opening_note}` : ''})</span> : ''}{open.shift.forced ? ` · fermé par ${open.shift.closed_by_name} à sa place` : ''}</p>}
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
  const [sub, setSub] = useState(() => { const v = nav.sub; nav.sub = null; return v || 'history'; });
  const canClose = me.permissions.includes('closure.do');
  return (
    <div>
      <div className="subtabs">
        <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>Ventes</button>
        {canClose && <button className={sub === 'closure' ? 'active' : ''} onClick={() => setSub('closure')}>Fermer mon quart / clôture</button>}
        {me.permissions.includes('cash.review') && <button className={sub === 'past' ? 'active' : ''} onClick={() => setSub('past')}>Clôtures passées</button>}
      </div>
      {sub === 'history' && <History me={me} />}
      {sub === 'closure' && <Closure me={me} />}
      {sub === 'past' && <Closures />}
    </div>
  );
}
