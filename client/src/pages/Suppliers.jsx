import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurSigned, parseEuros, toEuroInput, fmtDT, fmtD } from '../money.js';

const PAY = { cash: 'Espèces', card: 'Carte', transfer: 'Virement', other: 'Autre' };
const defaultUnit = (it) => (it.packs?.length ? `pack:${Math.min(it.purchase_depth, it.packs.length - 1)}` : it.units[0]?.code ?? '');
const STATUS_TONE = { draft: '', sent: 'warn', partial: 'warn', received: 'ok', cancelled: '' };

function SupplierForm({ s, onClose, onSaved }) {
  const [f, setF] = useState({ name: s?.name ?? '', phone: s?.phone ?? '', email: s?.email ?? '', notes: s?.notes ?? '', active: s?.active ?? true });
  const { busy, error, run } = useAsync();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title={s ? `Modifier ${s.name}` : 'Nouveau fournisseur'} onClose={onClose}>
      <ErrorBox error={error} />
      <Field label="Nom"><input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={80} /></Field>
      <Field label="Téléphone"><input inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="Email"><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      {s && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Fournisseur actif</label>}
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !f.name.trim()} onClick={() => run(async () => { if (s) await api.put(`/api/suppliers/${s.id}`, f); else await api.post('/api/suppliers', f); onSaved(); onClose(); })}>Enregistrer</button></div>
    </Modal>
  );
}

function SupplierDetail({ id, onClose, onChanged, onEdit }) {
  const [d, setD] = useState(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('transfer');
  const [drawer, setDrawer] = useState(false);
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get(`/api/suppliers/${id}`).then(setD).catch((e) => setError(e.message)), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const pay = () => run(async () => {
    const cents = parseEuros(amount);
    if (!(cents > 0)) throw new Error('Montant invalide.');
    await api.post(`/api/suppliers/${id}/payments`, { amount_cents: cents, method, from_drawer: method === 'cash' && drawer });
    setAmount(''); await load(); onChanged();
  });
  const adjust = () => run(async () => {
    const v = window.prompt('Correction du compte en € (négatif = on vous fait un avoir) :');
    if (v == null) return;
    const cents = parseEuros(v);
    if (!cents) throw new Error('Montant invalide.');
    const note = window.prompt('Raison (obligatoire) :');
    if (!note || !note.trim()) throw new Error('La raison est obligatoire.');
    await api.post(`/api/suppliers/${id}/adjust`, { amount_cents: cents, note }); await load(); onChanged();
  });
  return (
    <Modal title={d ? d.name : 'Fournisseur'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {d && (
        <>
          <p className="muted">{[d.phone, d.email, d.notes].filter(Boolean).join(' · ') || 'Pas de coordonnées.'}</p>
          <div className="kpis"><div className={`kpi ${d.balance_cents > 0 ? 'bad' : ''}`}><strong>{eur(d.balance_cents)}</strong><span>Vous lui devez</span></div></div>
          {d.balance_cents > 0 && (
            <div className="line-card">
              <strong>Enregistrer un paiement</strong>
              <div className="inline" style={{ marginTop: 6 }}>
                <input inputMode="decimal" placeholder={`Montant (max ${eur(d.balance_cents)})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
                <select value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(PAY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <button className="primary" disabled={busy} onClick={pay}>Payer</button>
              </div>
              {method === 'cash' && <label className="check"><input type="checkbox" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} /> Payé avec l'argent du tiroir-caisse</label>}
              <div className="quick"><button onClick={() => setAmount(toEuroInput(d.balance_cents))}>Tout payer</button></div>
            </div>
          )}
          <h3>Compte</h3>
          {d.ledger.length === 0 ? <p className="muted">Aucune opération.</p> : (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>Date</th><th>Opération</th><th>Montant</th></tr></thead><tbody>
              {d.ledger.map((l) => <tr key={l.id}><td>{fmtDT(l.ts)}</td><td>{{ invoice: `Facture ${l.note ?? ''}`, payment: `Paiement (${PAY[l.method] ?? l.method})`, adjust: `Correction : ${l.note ?? ''}` }[l.type]}</td><td className={l.amount_cents > 0 ? 'neg' : 'pos-amount'}>{eurSigned(l.amount_cents)}</td></tr>)}
            </tbody></table></div>
          )}
          <div className="actions"><button onClick={() => onEdit(d)}>Modifier</button><button onClick={adjust} disabled={busy}>Corriger le compte</button></div>
        </>
      )}
    </Modal>
  );
}

function PoForm({ po, suppliers, stock, onClose, onSaved }) {
  const empty = () => ({ ingredient_id: '', qty: '', unit: '', price: '' });
  const [supplier, setSupplier] = useState(po ? String(po.supplier_id) : '');
  const [expected, setExpected] = useState(po?.expected_on ?? '');
  const [note, setNote] = useState(po?.note ?? '');
  const [lines, setLines] = useState(po ? po.lines.map((l) => ({ ingredient_id: String(l.ingredient_id), qty: String(l.qty), unit: l.unit, price: toEuroInput(l.expected_total_cents) })) : [empty()]);
  const { busy, error, run } = useAsync();
  const upd = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const items = stock.items.filter((i) => i.active);
  const byId = (id) => items.find((i) => i.id === Number(id));
  const filled = lines.filter((l) => l.ingredient_id);
  const save = () => run(async () => {
    const payload = {
      supplier_id: Number(supplier), expected_on: expected || null, note,
      lines: filled.map((l) => ({ ingredient_id: Number(l.ingredient_id), qty: l.qty, unit: l.unit, expected_total_cents: l.price.trim() === '' ? null : parseEuros(l.price) })),
    };
    if (po) await api.put(`/api/purchase-orders/${po.id}`, payload); else await api.post('/api/purchase-orders', payload);
    onSaved(); onClose();
  });
  return (
    <Modal title={po ? `Modifier ${po.number}` : 'Nouveau bon de commande'} onClose={onClose} wide>
      <ErrorBox error={error} />
      <div className="grid">
        <Field label="Fournisseur"><select value={supplier} onChange={(e) => setSupplier(e.target.value)} disabled={Boolean(po)}><option value="">— choisir —</option>{suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Livraison prévue le"><input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      </div>
      {lines.map((l, i) => {
        const it = byId(l.ingredient_id);
        return (
          <div className="line-card" key={i}>
            <div className="grid">
              <Field label="Ingrédient"><select value={l.ingredient_id} onChange={(e) => { const x = byId(e.target.value); upd(i, { ingredient_id: e.target.value, unit: x ? defaultUnit(x) : '' }); }}><option value="">— choisir —</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
              <Field label="Quantité commandée"><div className="inline"><input inputMode="decimal" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} /><select value={l.unit} onChange={(e) => upd(i, { unit: e.target.value })} disabled={!it}>{(it?.units ?? []).map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}</select></div></Field>
              <Field label="Prix prévu pour la ligne (€, facultatif)"><input inputMode="decimal" value={l.price} onChange={(e) => upd(i, { price: e.target.value })} /></Field>
            </div>
            {lines.length > 1 && <button className="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Retirer cette ligne</button>}
          </div>
        );
      })}
      <button onClick={() => setLines((ls) => [...ls, empty()])}>+ Ajouter un ingrédient</button>
      <Field label="Note pour le fournisseur"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !supplier || filled.length === 0} onClick={save}>Enregistrer le brouillon</button></div>
    </Modal>
  );
}

function ReceiveForm({ po, onClose, onSaved }) {
  const open = po.lines.filter((l) => l.left > 1e-9);
  const [rows, setRows] = useState(() => Object.fromEntries(po.lines.map((l) => [l.id, { qty: l.left > 1e-9 ? String(Math.round((l.left / l.base) * l.qty * 1000) / 1000) : '', unit: l.unit, price: '', expiry: '', take: l.left > 1e-9 }])));
  const [ref, setRef] = useState('');
  const [invoice, setInvoice] = useState('');
  const { busy, error, run } = useAsync();
  const upd = (id, p) => setRows((r) => ({ ...r, [id]: { ...r[id], ...p } }));
  const save = () => run(async () => {
    const lines = po.lines.filter((l) => rows[l.id].take && rows[l.id].qty !== '').map((l) => ({
      po_line_id: l.id, qty: rows[l.id].qty, unit: rows[l.id].unit,
      ...(rows[l.id].price.trim() !== '' ? { total_cents: parseEuros(rows[l.id].price) } : {}), ...(rows[l.id].expiry ? { expiry: rows[l.id].expiry } : {}),
    }));
    await api.post(`/api/purchase-orders/${po.id}/receive`, { lines, invoice_ref: ref, ...(invoice.trim() !== '' ? { invoice_cents: parseEuros(invoice) } : {}) });
    onSaved(); onClose();
  });
  return (
    <Modal title={`Réception — ${po.number}`} onClose={onClose} wide>
      <p className="muted">Indiquez ce qui est réellement arrivé et le prix payé pour chaque ligne : le stock et le coût moyen sont mis à jour, et la facture s'ajoute au compte du fournisseur.</p>
      <ErrorBox error={error} />
      {open.length === 0 && <Notice tone="ok">Tout a déjà été reçu.</Notice>}
      {po.lines.map((l) => (
        <div className="line-card" key={l.id} style={l.left <= 1e-9 ? { opacity: 0.5 } : undefined}>
          <label className="check"><input type="checkbox" checked={rows[l.id].take} disabled={l.left <= 1e-9} onChange={(e) => upd(l.id, { take: e.target.checked })} /> <strong>{l.name}</strong> — commandé {l.ordered}, déjà reçu {l.receivedText}</label>
          {rows[l.id].take && (
            <div className="grid">
              <Field label="Quantité reçue"><div className="inline"><input inputMode="decimal" value={rows[l.id].qty} onChange={(e) => upd(l.id, { qty: e.target.value })} /><select value={rows[l.id].unit} onChange={(e) => upd(l.id, { unit: e.target.value })}>{l.units.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}</select></div></Field>
              <Field label="Prix payé pour la ligne (€)"><input inputMode="decimal" value={rows[l.id].price} onChange={(e) => upd(l.id, { price: e.target.value })} placeholder={l.expected_total_cents != null ? `prévu ${toEuroInput(l.expected_total_cents)}` : ''} /></Field>
              <Field label="À consommer avant"><input type="date" value={rows[l.id].expiry} onChange={(e) => upd(l.id, { expiry: e.target.value })} /></Field>
            </div>
          )}
        </div>
      ))}
      <div className="grid">
        <Field label="N° de facture"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Total de la facture (€)" hint="Vide = somme des prix des lignes."><input inputMode="decimal" value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
      </div>
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || open.length === 0} onClick={save}>Enregistrer la réception</button></div>
    </Modal>
  );
}

function PoDetail({ id, stock, suppliers, onClose, onChanged }) {
  const [d, setD] = useState(null);
  const [mode, setMode] = useState(null);
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get(`/api/purchase-orders/${id}`).then(setD).catch((e) => setError(e.message)), [id]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const status = (s) => run(async () => { await api.post(`/api/purchase-orders/${id}/status`, { status: s }); await load(); onChanged(); });
  return (
    <Modal title={d ? `${d.number} — ${d.supplier_name}` : 'Bon de commande'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {d && (
        <>
          <p><span className={`badge ${STATUS_TONE[d.status]}`}>{d.status_label}</span> <span className="muted">créé le {fmtDT(d.created_at)} par {d.user_name}{d.expected_on ? ` · livraison prévue le ${fmtD(d.expected_on)}` : ''}</span></p>
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Ingrédient</th><th>Commandé</th><th>Reçu</th><th>Reste</th><th>Prix prévu</th></tr></thead><tbody>
            {d.lines.map((l) => <tr key={l.id}><td>{l.name}</td><td>{l.ordered}</td><td>{l.receivedText}</td><td>{l.left > 1e-9 ? l.leftText : '✓'}</td><td>{l.expected_total_cents != null ? eur(l.expected_total_cents) : '—'}</td></tr>)}
          </tbody></table></div>
          {d.note && <p>Note : {d.note}</p>}
          {d.receipts.length > 0 && <><h3>Réceptions</h3><ul className="tobuy">{d.receipts.map((r) => <li key={r.id}>{fmtDT(r.ts)} — facture {r.invoice_ref || '—'} : <strong>{eur(r.invoice_cents)}</strong> ({r.user_name})</li>)}</ul></>}
          <div className="actions">
            <button onClick={() => window.print()}>🖨 Imprimer / PDF</button>
            {d.status === 'draft' && <button onClick={() => setMode('edit')}>Modifier</button>}
            {d.status === 'draft' && <button onClick={() => status('sent')} disabled={busy}>Marquer comme envoyé</button>}
            {['draft', 'sent'].includes(d.status) && <button className="danger" onClick={() => { if (window.confirm('Annuler ce bon de commande ?')) status('cancelled'); }} disabled={busy}>Annuler le bon</button>}
            {['draft', 'sent', 'partial'].includes(d.status) && <button className="primary" onClick={() => setMode('receive')}>Réceptionner</button>}
          </div>
          {mode === 'edit' && <PoForm po={d} suppliers={suppliers} stock={stock} onClose={() => setMode(null)} onSaved={() => { load(); onChanged(); }} />}
          {mode === 'receive' && <ReceiveForm po={d} onClose={() => setMode(null)} onSaved={() => { load(); onChanged(); }} />}
          {createPortal(
            <div className="print-sheet">
              <h1>Bon de commande {d.number}</h1>
              <p>Fournisseur : <strong>{d.supplier_name}</strong> · {fmtDT(d.created_at)}{d.expected_on ? ` · livraison souhaitée le ${fmtD(d.expected_on)}` : ''}</p>
              <table><tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.name}</td><td>{l.ordered}</td></tr>)}</tbody></table>
              {d.note && <p>{d.note}</p>}
            </div>, document.body)}
        </>
      )}
    </Modal>
  );
}

export default function Suppliers() {
  const [sub, setSub] = useState('orders');
  const [suppliers, setSuppliers] = useState(null);
  const [orders, setOrders] = useState(null);
  const [stock, setStock] = useState(null);
  const [edit, setEdit] = useState(null);
  const [open, setOpen] = useState(null);
  const [openPo, setOpenPo] = useState(null);
  const [newPo, setNewPo] = useState(false);
  const { error, setError } = useAsync();
  const load = useCallback(() => {
    api.get('/api/suppliers').then((r) => setSuppliers(r.items)).catch((e) => setError(e.message));
    api.get('/api/purchase-orders').then(setOrders).catch((e) => setError(e.message));
  }, []); // eslint-disable-line
  useEffect(() => { load(); api.get('/api/stock').then(setStock).catch(() => {}); }, [load]);
  const owed = (suppliers ?? []).reduce((a, s) => a + Math.max(0, s.balance_cents), 0);
  return (
    <div>
      <div className="subtabs">
        <button className={sub === 'orders' ? 'active' : ''} onClick={() => setSub('orders')}>Bons de commande</button>
        <button className={sub === 'suppliers' ? 'active' : ''} onClick={() => setSub('suppliers')}>Fournisseurs et dettes</button>
      </div>
      <ErrorBox error={error} />
      {sub === 'orders' && (
        <section className="card">
          <div className="row-between"><h1>Bons de commande</h1><button className="primary" disabled={!suppliers?.length || !stock} onClick={() => setNewPo(true)}>+ Nouveau bon</button></div>
          {suppliers && suppliers.length === 0 && <Notice tone="info">Créez d'abord un fournisseur (onglet « Fournisseurs et dettes »).</Notice>}
          {orders && orders.items.length === 0 && <p className="muted">Aucun bon de commande.</p>}
          {orders && orders.items.length > 0 && (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>N°</th><th>Fournisseur</th><th>Date</th><th>Lignes</th><th>État</th><th /></tr></thead><tbody>
              {orders.items.map((o) => <tr key={o.id}><td><strong>{o.number}</strong></td><td>{o.supplier_name}</td><td>{fmtDT(o.created_at)}</td><td>{o.lines}</td><td><span className={`badge ${STATUS_TONE[o.status]}`}>{o.status_label}</span></td><td className="right"><button onClick={() => setOpenPo(o.id)}>Ouvrir</button></td></tr>)}
            </tbody></table></div>
          )}
        </section>
      )}
      {sub === 'suppliers' && (
        <section className="card">
          <div className="row-between"><h1>Fournisseurs</h1><button className="primary" onClick={() => setEdit({})}>+ Nouveau fournisseur</button></div>
          {owed > 0 && <Notice tone="warn">Total que vous devez à vos fournisseurs : <strong>{eur(owed)}</strong></Notice>}
          {suppliers && suppliers.length === 0 && <p className="muted">Aucun fournisseur.</p>}
          {suppliers && suppliers.length > 0 && (
            <div className="table-wrap"><table className="responsive"><thead><tr><th>Fournisseur</th><th>Vous lui devez</th><th /></tr></thead><tbody>
              {suppliers.map((s) => <tr key={s.id} className={s.active ? '' : 'off'}><td><strong>{s.name}</strong>{!s.active && <span className="badge">inactif</span>}<div className="muted small">{s.phone}</div></td><td className={s.balance_cents > 0 ? 'neg' : ''}>{s.balance_cents ? eur(s.balance_cents) : '—'}</td><td className="right"><button onClick={() => setOpen(s.id)}>Ouvrir</button></td></tr>)}
            </tbody></table></div>
          )}
        </section>
      )}
      {edit && <SupplierForm s={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={load} />}
      {open && <SupplierDetail id={open} onClose={() => setOpen(null)} onChanged={load} onEdit={(s) => { setOpen(null); setEdit(s); }} />}
      {openPo && stock && suppliers && <PoDetail id={openPo} stock={stock} suppliers={suppliers} onClose={() => setOpenPo(null)} onChanged={load} />}
      {newPo && stock && suppliers && <PoForm suppliers={suppliers} stock={stock} onClose={() => setNewPo(false)} onSaved={load} />}
    </div>
  );
}
