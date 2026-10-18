import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { applyPromos, atOf } from '../../../shared/promo.js';
import { eur, parseEuros, toEuroInput, METHODS } from '../money.js';
import { cache, newId, nextProvisional, enqueue, queue, failed, syncNow, onQueueChange, dismissFailed } from '../offline.js';
import { TicketBody, PrintTicket } from './Ticket.jsx';
import { useShift, loadShift } from '../shift.js';
import { ShiftGate, ShiftBar, PinInput } from './Shift.jsx';

/** Remise spéciale demandée par un caissier : le gérant ou le propriétaire l'autorise en tapant SON code sur cet appareil. */
function ApproveDiscount({ onClose, onOk }) {
  const [users, setUsers] = useState([]);
  const [approver, setApprover] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAsync();
  useEffect(() => { api.get('/api/auth/users').then((u) => { const m = u.filter((x) => x.role === 'owner' || x.role === 'manager'); setUsers(m); if (m.length === 1) setApprover(String(m[0].id)); }).catch(() => {}); }, []);
  const cents = parseEuros(amount);
  const submit = () => run(async () => {
    if (!(cents > 0)) throw new Error('Montant de la remise invalide.');
    const r = await api.post('/api/discount/check', { user_id: Number(approver), pin });
    onOk({ cents, reason: reason.trim(), approval: { user_id: Number(approver), pin }, by: r.name });
  });
  return (
    <Modal title="Remise spéciale : accord du gérant" onClose={onClose}>
      <p className="muted small">Seul le gérant ou le propriétaire peut accorder une remise. Il tape son code ici pour l'autoriser.</p>
      <ErrorBox error={error} />
      <Field label="Montant de la remise (€)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" autoFocus /></Field>
      <Field label="Motif (obligatoire)"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Ex. client fidèle" /></Field>
      <Field label="Qui autorise ?"><select value={approver} onChange={(e) => setApprover(e.target.value)}><option value="">— choisir —</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.roleLabel})</option>)}</select></Field>
      {approver && <PinInput value={pin} onChange={setPin} label="Code PIN de cette personne" />}
      <div className="actions"><button onClick={onClose} disabled={busy}>Annuler</button><button className="primary" disabled={busy || !approver || pin.length < 4 || reason.trim().length < 3 || !(cents > 0)} onClick={submit}>Autoriser la remise</button></div>
    </Modal>
  );
}

/** Reste à payer / rendu pour une liste de paiements (même règle que le serveur). */
export function payState(total, payments) {
  const nonCash = payments.filter((p) => p.method !== 'cash').reduce((a, p) => a + p.amount_cents, 0);
  const tendered = payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount_cents, 0);
  const remainingAfterNonCash = total - nonCash;
  return {
    nonCash, tendered, over: nonCash > total,
    due: Math.max(0, remainingAfterNonCash - tendered), // encore à saisir
    change: Math.max(0, tendered - Math.max(0, remainingAfterNonCash)),
    ok: nonCash <= total && tendered >= remainingAfterNonCash,
  };
}

function useQueueInfo() {
  const [info, setInfo] = useState({ q: queue().length, f: failed().length });
  useEffect(() => onQueueChange(() => setInfo({ q: queue().length, f: failed().length })), []);
  return info;
}

function PayModal({ total, customer, canCredit, onClose, onPay, busy, error }) {
  const [pays, setPays] = useState([]);
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const st = payState(total, pays);
  const remaining = Math.max(0, total - st.nonCash - st.tendered);
  const add = (m, cents) => {
    if (!(cents > 0)) return;
    setPays((p) => [...p, { method: m, amount_cents: cents }]); setAmount('');
  };
  const methods = Object.entries(METHODS).filter(([k]) => k !== 'credit' || (canCredit && customer));
  const typed = parseEuros(amount);
  const quick = useMemo(() => {
    const r = remaining; const set = new Set([r]);
    for (const step of [500, 1000, 2000, 5000]) { const v = Math.ceil(r / step) * step; if (v > r) set.add(v); }
    for (const v of [500, 1000, 2000, 5000]) if (v >= r) set.add(v);
    return [...set].filter((v) => v > 0).sort((a, b) => a - b).slice(0, 5);
  }, [remaining]);
  return (
    <Modal title="Encaisser" onClose={onClose}>
      <div className="pay-summary">
        <div><span className="muted">À payer</span><strong>{eur(total)}</strong></div>
        <div><span className="muted">Saisi</span><strong>{eur(st.nonCash + st.tendered)}</strong></div>
        <div><span className="muted">{st.change > 0 ? 'À rendre' : 'Reste'}</span><strong className={st.change > 0 ? 'pos-amount' : ''}>{eur(st.change > 0 ? st.change : remaining)}</strong></div>
      </div>
      <ErrorBox error={error} />
      {st.over && <Notice tone="error">Les paiements autres qu'espèces dépassent le total.</Notice>}
      {pays.length > 0 && (
        <ul className="tobuy">{pays.map((p, i) => <li key={i}>{METHODS[p.method]} : <strong>{eur(p.amount_cents)}</strong> <button className="link" onClick={() => setPays((x) => x.filter((_, j) => j !== i))}>retirer</button></li>)}</ul>
      )}
      <div className="chips" role="group" aria-label="Moyen de paiement">
        {methods.map(([k, v]) => <button key={k} className={`chip${method === k ? ' on' : ''}`} onClick={() => setMethod(k)}>{v}</button>)}
      </div>
      {remaining > 0 && (
        <>
          {method === 'cash' && (
            <div className="quick" aria-label="Billets remis">{quick.map((v) => <button key={v} onClick={() => add('cash', v)}>{v === remaining ? 'Exact' : eur(v)}</button>)}</div>
          )}
          <div className="inline">
            <input inputMode="decimal" placeholder={`Montant (${eur(remaining)})`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant" />
            <button onClick={() => add(method, typed ?? remaining)} disabled={amount !== '' && typed == null}>Ajouter</button>
          </div>
          {method !== 'cash' && <div className="quick"><button className="primary" onClick={() => add(method, remaining)}>{METHODS[method]} : {eur(remaining)}</button></div>}
          {canCredit && customer && method !== 'credit' && <div className="quick"><button onClick={() => add('credit', remaining)}>📒 Tout mettre sur l'ardoise du client : {eur(remaining)}</button></div>}
        </>
      )}
      {st.change > 0 && <div className="change-due">Rendre {eur(st.change)}</div>}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Retour</button>
        <button className="primary" disabled={!st.ok || busy || (total > 0 && pays.length === 0)} onClick={() => onPay(pays)}>{busy ? 'Enregistrement…' : 'Valider la vente'}</button>
      </div>
    </Modal>
  );
}


/** Envoyer le panier en cuisine : étiquette (table ou client), puis payer à la fin ou tout de suite. */
function SendModal({ lines, onClose, onSend, busy, error }) {
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [tabs, setTabs] = useState([]);
  useEffect(() => { api.get('/api/orders/tabs').then((r) => setTabs(r.tabs)).catch(() => {}); }, []);
  const tables = Array.from({ length: 10 }, (_, i) => `Table ${i + 1}`);
  const open = tabs.map((t) => t.label);
  const ok = label.trim().length > 0;
  return (
    <Modal title="Envoyer en cuisine" onClose={onClose}>
      <ErrorBox error={error} />
      <ul className="tobuy">{lines.map((l) => <li key={l.product_id}>{l.qty} × {l.p.name}{l.p.to_kitchen === false ? <span className="muted small"> (pas pour la cuisine)</span> : null}</li>)}</ul>
      <Field label="Table ou nom du client">
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Ex. Table 4 ou Mme Diallo" autoFocus />
      </Field>
      {open.length > 0 && <div><span className="muted small">Additions ouvertes (pour ajouter à la même table) :</span><div className="chips">{open.map((t) => <button key={t} className={`chip${label === t ? ' on' : ''}`} onClick={() => setLabel(t)}>{t}</button>)}</div></div>}
      <div><span className="muted small">Tables :</span><div className="chips">{tables.map((t) => <button key={t} className={`chip${label === t ? ' on' : ''}`} onClick={() => setLabel(t)}>{t.replace('Table ', '')}</button>)}</div></div>
      <Field label="Remarque pour la cuisine (facultatif)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ex. sans sucre, allergie…" /></Field>
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Retour</button>
        <button disabled={!ok || busy} onClick={() => onSend(label.trim(), note.trim(), false)}>{busy ? 'Envoi…' : 'Envoyer (payer plus tard)'}</button>
        <button className="primary" disabled={!ok || busy} onClick={() => onSend(label.trim(), note.trim(), true)}>Envoyer et payer maintenant</button>
      </div>
    </Modal>
  );
}

/** Additions ouvertes : tout ce qui a été commandé et pas encore payé, par table / client. */
function TabsModal({ onClose, onPick }) {
  const [tabs, setTabs] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/api/orders/tabs').then((r) => setTabs(r.tabs)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState([]);
  const SL = { sent: 'envoyée', preparing: 'en préparation', ready: 'prête', served: 'servie' };
  const shown = tabs?.filter((t) => !q.trim() || t.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal title="Additions ouvertes" onClose={onClose} wide>
      <ErrorBox error={err} />
      {tabs?.length > 0 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher une table ou un client (ex. 4, Diallo)" aria-label="Chercher une addition" autoFocus />}
      {tabs === null && !err && <p className="muted">Chargement…</p>}
      {tabs?.length > 0 && shown.length === 0 && <p className="muted">Aucune addition ne correspond.</p>}
      {tabs?.length === 0 && <p className="muted">Aucune addition en attente. Les commandes envoyées en cuisine sans paiement apparaissent ici jusqu'à leur règlement.</p>}
      {shown?.map((t) => (
        <div key={t.key} className="tab-line card">
          <div className="row-between"><strong>{t.label}</strong><strong>{eur(t.total_cents)}</strong></div>
          <p className="small">{t.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')}</p>
          <p className="muted small">{t.order_ids.length} commande{t.order_ids.length > 1 ? 's' : ''} · {t.statuses.map((x) => SL[x]).join(', ')}</p>
          {t.customer && <p className="small">👤 Client enregistré : <strong>{t.customer.name}</strong> · ardoise actuelle <strong className={t.customer.balance_cents > 0 ? 'neg' : ''}>{eur(t.customer.balance_cents)}</strong>{t.customer.credit_limit_cents != null ? ` (limite ${eur(t.customer.credit_limit_cents)})` : ' (pas d\'ardoise autorisée)'}</p>}
          <div className="actions">
            <label className="check"><input type="checkbox" checked={sel.includes(t.key)} onChange={(e) => setSel((x) => (e.target.checked ? [...x, t.key] : x.filter((k) => k !== t.key)))} /> Regrouper</label>
            <button className="primary" onClick={() => onPick([t])}>Encaisser cette addition</button>
          </div>
        </div>
      ))}
      {sel.length > 1 && (() => { const chosen = (tabs || []).filter((t) => sel.includes(t.key)); return (
        <div className="banner ok"><span><strong>{chosen.length} additions regroupées</strong> ({chosen.map((t) => t.label).join(' + ')}) : {eur(chosen.reduce((a, t) => a + t.total_cents, 0))}</span><button className="primary" onClick={() => onPick(chosen)}>Encaisser le tout</button></div>
      ); })()}
      <div className="actions"><button onClick={load}>Actualiser</button><button onClick={onClose}>Fermer</button></div>
    </Modal>
  );
}

function PendingModal({ onClose }) {
  const [f, setF] = useState(failed());
  useEffect(() => onQueueChange(() => setF(failed())), []);
  return (
    <Modal title="Ventes à revoir" onClose={onClose} wide>
      <p className="muted">Ces ventes faites sans réseau n'ont pas pu être enregistrées par le serveur. Notez-les, puis retirez-les de la liste. Le gérant peut les ressaisir.</p>
      {f.length === 0 ? <p>Aucune.</p> : (
        <div className="table-wrap"><table className="responsive"><thead><tr><th>Ticket</th><th>Contenu</th><th>Raison</th><th /></tr></thead><tbody>
          {f.map((s) => (
            <tr key={s.client_uuid}>
              <td>{s.provisional}<div className="muted small">{new Date(s.ts).toLocaleString('fr-FR')}</div></td>
              <td>{s.summary || '—'}</td><td className="neg">{s.error}</td>
              <td className="right"><button onClick={() => dismissFailed(s.client_uuid)}>Retirer</button></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </Modal>
  );
}

export default function Pos({ me, go }) {
  const sh = useShift(me);
  const [cat, setCat] = useState(() => cache.get('catalog'));
  const [offline, setOffline] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState([]); // [{ product_id, qty }]
  const [customerId, setCustomerId] = useState('');
  const [cdetail, setCdetail] = useState(null);
  const [redeem, setRedeem] = useState(false);
  const [discount, setDiscount] = useState(null); // { cents, reason }
  const [showPay, setShowPay] = useState(false);
  const [done, setDone] = useState(null); // { sale, provisional, change, queued }
  const [shop, setShop] = useState(() => cache.get('ticket'));
  const [showPending, setShowPending] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [attached, setAttached] = useState(null); // { ids, label } : commandes déjà envoyées en cuisine, réglées par cette vente
  const [showSend, setShowSend] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [showTabs, setShowTabs] = useState(false);
  const [sentMsg, setSentMsg] = useState('');
  const sendUuid = useRef(newId());
  const uuidRef = useRef(newId());
  const { busy, error, setError, run } = useAsync();
  const canOrder = me.permissions.includes('orders.take');
  const qinfo = useQueueInfo();

  const load = useCallback(async () => {
    try {
      const c = await api.get('/api/catalog');
      cache.set('catalog', c); setCat(c); setOffline(false); setLoadErr('');
      api.get('/api/ticket-info').then((t) => { cache.set('ticket', t); setShop(t); }).catch(() => {});
    } catch (e) {
      if (e.code === 'network') { setOffline(true); if (!cache.get('catalog')) setLoadErr('Pas de réseau et aucun catalogue en mémoire : connectez-vous une première fois avec du réseau.'); }
      else setLoadErr(e.message);
    }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5 * 60_000); return () => clearInterval(t); }, [load]);

  const sync = useCallback(async () => {
    const r = await syncNow();
    if (!r) return;
    if (r.network) { setOffline(true); return; }
    if (r.error) { setSyncMsg(r.error); return; }
    setOffline(false);
    setSyncMsg(`${r.sent} vente${r.sent > 1 ? 's' : ''} envoyée${r.sent > 1 ? 's' : ''}${r.failed ? `, ${r.failed} à revoir` : ''}.`);
    load();
  }, [load]);
  useEffect(() => {
    sync();
    const t = setInterval(sync, 20_000);
    window.addEventListener('online', sync);
    return () => { clearInterval(t); window.removeEventListener('online', sync); };
  }, [sync]);

  useEffect(() => {
    setRedeem(false); setCdetail(null);
    if (customerId && !offline) api.get(`/api/customers/${customerId}`).then(setCdetail).catch(() => {});
  }, [customerId, offline]);

  const products = cat?.products ?? [];
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const shown = products.filter((p) => !category || p.category === category);

  const lines = cart.map((l) => ({ ...l, p: byId.get(l.product_id) })).filter((l) => l.p);
  const calc = useMemo(() => {
    const subtotal = lines.reduce((a, l) => a + l.qty * l.p.price_cents, 0);
    const promo = cat ? applyPromos(lines.map((l) => ({ key: String(l.product_id), product_id: l.product_id, category: l.p.category, qty: l.qty, price_cents: l.p.price_cents })), cat.promotions, atOf(new Date(), cat.tz)) : { discounts: {}, labels: {}, total: 0, applied: [] };
    const afterPromo = subtotal - promo.total;
    const lo = cat?.loyalty;
    const canRedeem = Boolean(lo?.enabled && cdetail && cdetail.stamps >= lo.stamps_needed && afterPromo > 0);
    const reward = redeem && canRedeem ? Math.min(lo.reward_cents, afterPromo) : 0;
    const manual = discount ? Math.min(discount.cents, afterPromo - reward) : 0;
    return { subtotal, promo, afterPromo, canRedeem, reward, manual, total: afterPromo - reward - manual };
  }, [lines, cat, cdetail, redeem, discount]);

  const count = cart.reduce((a, l) => a + l.qty, 0);
  const add = (p) => setCart((c) => (c.some((l) => l.product_id === p.id) ? c.map((l) => (l.product_id === p.id ? { ...l, qty: Math.min(999, l.qty + 1) } : l)) : [...c, { product_id: p.id, qty: 1 }]));
  const setQty = (id, q) => setCart((c) => (q <= 0 ? c.filter((l) => l.product_id !== id) : c.map((l) => (l.product_id === id ? { ...l, qty: Math.min(999, q) } : l))));
  const reset = () => { setAttached(null); setCart([]); setCustomerId(''); setCdetail(null); setRedeem(false); setDiscount(null); setShowPay(false); uuidRef.current = newId(); setError(''); };


  const sendToKitchen = (label, note, payNow) => run(async () => {
    const r = await api.post('/api/orders', { client_uuid: sendUuid.current, label, note, lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty })) });
    sendUuid.current = newId();
    setShowSend(false);
    if (payNow) { setAttached({ ids: [r.order.id], label }); setShowPay(true); setSentMsg(`« ${label} » est envoyée en cuisine. Encaissez maintenant.`); }
    else { setSentMsg(`✓ « ${label} » envoyée en cuisine (${r.order.number}). L'addition reste ouverte.`); reset(); }
  });
  const pickTab = (list) => {
    if (cart.length && !window.confirm('Remplacer le panier en cours par cette addition ?')) return;
    const merged = new Map(); const missing = [];
    for (const t of list) for (const l of t.lines) {
      if (!byId.has(l.product_id)) { missing.push(l.name); continue; }
      merged.set(l.product_id, (merged.get(l.product_id) || 0) + l.qty);
    }
    if (missing.length) window.alert(`Ces articles ne sont plus en vente et ne seront pas dans le panier : ${[...new Set(missing)].join(', ')}. Vérifiez le total avant d'encaisser.`);
    setCart([...merged].map(([product_id, qty]) => ({ product_id, qty })));
    const custs = [...new Set(list.map((t) => t.customer?.id).filter(Boolean))];
    setAttached({ ids: list.flatMap((t) => t.order_ids), label: list.map((t) => t.label).join(' + ') });
    setCustomerId(custs.length === 1 && cat?.customers?.some((c) => c.id === custs[0]) ? String(custs[0]) : '');
    setDiscount(null); setRedeem(false); setShowTabs(false); setError('');
  };

  const askDiscount = () => {
    const v = window.prompt('Montant de la remise en € :');
    if (v == null) return;
    const cents = parseEuros(v);
    if (!(cents > 0)) { window.alert('Montant invalide.'); return; }
    const reason = window.prompt('Motif de la remise (obligatoire) :');
    if (!reason || !reason.trim()) { window.alert('Le motif est obligatoire.'); return; }
    setDiscount({ cents, reason: reason.trim() });
  };

  const pay = (payments) => run(async () => {
    const payload = {
      client_uuid: uuidRef.current,
      lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price_cents: l.p.price_cents })),
      payments,
      ...(attached ? { order_ids: attached.ids } : {}),
      ...(customerId ? { customer_id: Number(customerId) } : {}),
      ...(calc.reward > 0 ? { redeem_loyalty: true } : {}),
      ...(calc.manual > 0 ? { discount_cents: calc.manual, discount_reason: discount.reason, ...(discount.approval ? { discount_approval: discount.approval } : {}) } : {}),
    };
    try {
      const r = await api.post('/api/sales', payload);
      setDone({ sale: r.sale, change: r.sale.change_cents });
      reset(); setShowPay(false); load();
    } catch (e) {
      if (e.code === 'price_changed') { await load(); throw new Error(`${e.message} Le catalogue est à jour : vérifiez le panier.`); }
      if (e.code === 'no_shift' || e.code === 'shift_other') { await loadShift(me); throw e; }
      if (e.code === 'bad_pin' || e.code === 'locked' || e.code === 'approver_required') { setDiscount(null); throw new Error(`${e.message} La remise a été retirée : refaites-la autoriser.`); }
      if (e.code === 'order_paid' || e.code === 'order_cancelled') throw new Error(`${e.message} Touchez « Vider » puis rouvrez les additions.`);
      if (e.code !== 'network') throw e;
      if (attached) throw new Error('Pas de réseau : l’addition d’une table ne peut pas être encaissée hors-ligne. Réessayez quand le réseau revient.');
      // pas de réseau : on garde la vente, elle partira dès que possible
      const provisional = nextProvisional();
      const st = payState(calc.total, payments);
      const ts = new Date().toISOString();
      const summary = lines.map((l) => `${l.qty} × ${l.p.name}`).join(', ');
      enqueue({ ...payload, offline: true, provisional, ts, expected_total_cents: calc.total, summary });
      const sale = {
        kind: 'sale', ts, user_name: me.name, total_cents: calc.total, change_cents: st.change, customer: cdetail ? { name: cdetail.name } : null,
        lines: lines.map((l) => ({ qty: l.qty, name: l.p.name, gross_cents: l.qty * l.p.price_cents, discount_cents: calc.promo.discounts[String(l.product_id)] || 0, promo_label: (calc.promo.labels[String(l.product_id)] || []).join(', '), total_cents: l.qty * l.p.price_cents - (calc.promo.discounts[String(l.product_id)] || 0), vat_pct: l.p.vat_pct })),
        payments: payments.map((p) => (p.method === 'cash' ? { method: 'cash', amount_cents: Math.min(p.amount_cents, Math.max(0, calc.total - st.nonCash)) } : p)),
      };
      setOffline(true);
      setDone({ sale, provisional, change: st.change, queued: true });
      reset(); setShowPay(false);
    }
  });

  const needShift = Boolean(sh?.required) && !sh?.mine;
  if (sh === null || needShift) return <ShiftGate me={me} sh={sh} go={go} />;
  if (!cat) return <section className="card">{loadErr ? <ErrorBox error={loadErr} /> : <p className="muted">Chargement de la caisse…</p>}</section>;

  const cartPanel = (
    <section className="card pos-cart">
      <div className="row-between"><h2>Panier {count > 0 && <span className="count">{count}</span>}</h2>{cart.length > 0 && <button className="link" onClick={reset}>Vider</button>}</div>
      {attached && <div className="banner ok" style={{ margin: '4px 0' }}><span>Addition « <strong>{attached.label}</strong> » : déjà envoyée en cuisine, il ne reste qu'à encaisser.</span></div>}
      {lines.length === 0 && <p className="muted">Touchez un article pour l'ajouter.</p>}
      {lines.map((l) => {
        const d = calc.promo.discounts[String(l.product_id)] || 0;
        return (
          <div className="cart-line" key={l.product_id}>
            <div><strong>{l.p.name}</strong><div className="muted small">{eur(l.p.price_cents)} l'unité</div></div>
            <div className="qty">
              <button onClick={() => setQty(l.product_id, l.qty - 1)} aria-label={`Retirer un ${l.p.name}`}>−</button><span>{l.qty}</span><button onClick={() => setQty(l.product_id, l.qty + 1)} aria-label={`Ajouter un ${l.p.name}`}>+</button>
            </div>
            {d > 0 && <div className="promo">🎁 {(calc.promo.labels[String(l.product_id)] || []).join(', ')} : −{eur(d)}</div>}
          </div>
        );
      })}
      {lines.length > 0 && (
        <>
          <div className="field">
            <span className="label">Client (facultatif)</span>
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={offline && cat.customers.length === 0}>
              <option value="">— aucun —</option>
              {cat.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {cdetail && cat.loyalty?.enabled && (
            <p className="small">Tampons : <strong>{cdetail.stamps}</strong> / {cat.loyalty.stamps_needed}
              {calc.canRedeem && <label className="check"><input type="checkbox" checked={redeem} onChange={(e) => setRedeem(e.target.checked)} /> Utiliser la récompense (−{eur(Math.min(cat.loyalty.reward_cents, calc.afterPromo))})</label>}
            </p>
          )}
          {cdetail && cdetail.balance_cents > 0 && <p className="small neg">Ardoise en cours : {eur(cdetail.balance_cents)}</p>}
          <div className="row-between small"><span>Sous-total</span><span>{eur(calc.subtotal)}</span></div>
          {calc.promo.total > 0 && <div className="row-between small pos-amount"><span>Promotions</span><span>−{eur(calc.promo.total)}</span></div>}
          {calc.reward > 0 && <div className="row-between small pos-amount"><span>Fidélité</span><span>−{eur(calc.reward)}</span></div>}
          {calc.manual > 0 && <div className="row-between small pos-amount"><span>Remise ({discount.reason}{discount.by ? ` · accordée par ${discount.by}` : ''})</span><span>−{eur(calc.manual)}</span></div>}
          <div className="cart-total"><span>Total</span><span>{eur(calc.total)}</span></div>
          <div className="actions" style={{ justifyContent: 'stretch' }}>
            {!offline && <button onClick={discount ? () => setDiscount(null) : cat.canDiscount ? askDiscount : () => setShowApprove(true)}>{discount ? 'Retirer la remise' : cat.canDiscount ? 'Remise' : 'Remise (accord gérant)'}</button>}
            <button className="primary" style={{ flex: 1, minHeight: 56, fontSize: '1.15rem' }} onClick={() => setShowPay(true)}>Encaisser {eur(calc.total)}</button>
          </div>
          {canOrder && !attached && <button style={{ width: '100%', minHeight: 48, marginTop: 8 }} disabled={offline} onClick={() => { setError(''); setShowSend(true); }}>🍽 Envoyer en cuisine{offline ? ' (réseau nécessaire)' : ''}</button>}
        </>
      )}
    </section>
  );

  return (
    <div>
      <ShiftBar sh={sh} go={go} />
      {offline && <div className="banner off"><span><strong>Hors-ligne.</strong> Vous pouvez continuer à vendre : les ventes seront envoyées dès que le réseau revient.</span><button onClick={() => { load(); sync(); }}>Réessayer</button></div>}
      {qinfo.q > 0 && <div className="banner off"><span><strong>{qinfo.q}</strong> vente{qinfo.q > 1 ? 's' : ''} en attente d'envoi.</span><button onClick={sync}>Envoyer maintenant</button></div>}
      {qinfo.f > 0 && <div className="banner err"><span><strong>{qinfo.f}</strong> vente{qinfo.f > 1 ? 's' : ''} hors-ligne refusée{qinfo.f > 1 ? 's' : ''} par le serveur.</span><button onClick={() => setShowPending(true)}>Voir</button></div>}
      {syncMsg && qinfo.q === 0 && <div className="banner ok"><span>{syncMsg}</span><button className="link" onClick={() => setSyncMsg('')}>OK</button></div>}
      {loadErr && <ErrorBox error={loadErr} />}
      {sentMsg && <div className="banner ok"><span>{sentMsg}</span><button className="link" onClick={() => setSentMsg('')}>OK</button></div>}
      <div className="pos">
        <section className="card">
          <div className="chips" role="group" aria-label="Catégories">
            <button className={`chip${category === '' ? ' on' : ''}`} onClick={() => setCategory('')}>Tout</button>
            {cat.categories.map((c) => <button key={c} className={`chip${category === c ? ' on' : ''}`} onClick={() => setCategory(c)}>{c}</button>)}
            {canOrder && <button className="chip tabs-btn" disabled={offline} onClick={() => setShowTabs(true)}>📋 Additions ouvertes</button>}
          </div>
          {products.length === 0 && <p className="muted">Aucun article en vente. Créez-les dans l'onglet « Articles ».</p>}
          <div className="pos-tiles">
            {shown.map((p) => {
              const inCart = cart.find((l) => l.product_id === p.id)?.qty;
              const stockCls = p.available == null ? '' : p.available <= 0 ? 'out' : p.available <= 3 ? 'low' : '';
              return (
                <button key={p.id} className="pos-tile" onClick={() => add(p)}>
                  <strong>{p.name}{inCart ? <span className="qty-badge">{inCart}</span> : null}</strong>
                  <span><span className="price">{eur(p.price_cents)}</span>{p.available != null && <span className={`stock ${stockCls}`}> · {p.available <= 0 ? 'épuisé' : `reste ${p.available}`}</span>}</span>
                </button>
              );
            })}
          </div>
        </section>
        <div>{cartPanel}</div>
      </div>
      {count > 0 && (
        <div className="pos-bar">
          <span className="total">{count} article{count > 1 ? 's' : ''} · {eur(calc.total)}</span>
          <button className="primary" onClick={() => setShowPay(true)}>Encaisser</button>
        </div>
      )}
      {showPay && <PayModal total={calc.total} customer={customerId} canCredit={cat.canCredit} onClose={() => { setShowPay(false); setError(''); }} onPay={pay} busy={busy} error={error} />}
      {showApprove && <ApproveDiscount onClose={() => setShowApprove(false)} onOk={(d) => { setDiscount(d); setShowApprove(false); }} />}
      {showSend && <SendModal lines={lines} onClose={() => { setShowSend(false); setError(''); }} onSend={sendToKitchen} busy={busy} error={error} />}
      {showTabs && <TabsModal onClose={() => setShowTabs(false)} onPick={pickTab} />}
      {showPending && <PendingModal onClose={() => setShowPending(false)} />}
      {done && (
        <Modal title={done.queued ? 'Vente enregistrée (hors-ligne)' : 'Vente enregistrée'} onClose={() => setDone(null)}>
          {done.change > 0 && <div className="change-due">Rendre {eur(done.change)}</div>}
          {done.queued && <Notice tone="warn">Pas de réseau : la vente est gardée dans cet appareil et partira automatiquement. Ticket provisoire {done.provisional}.</Notice>}
          <TicketBody sale={done.sale} shop={shop} tz={cat.tz} provisional={done.provisional} />
          <PrintTicket sale={done.sale} shop={shop} tz={cat.tz} provisional={done.provisional} />
          <div className="actions"><button onClick={() => window.print()}>🖨 Imprimer le ticket</button><button className="primary" onClick={() => setDone(null)}>Nouvelle vente</button></div>
        </Modal>
      )}
    </div>
  );
}
