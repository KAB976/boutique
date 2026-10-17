import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, useAsync } from '../ui.jsx';
import { eur } from '../money.js';
import { cache, newId } from '../offline.js';
import { refreshBoard } from '../board.js';

/**
 * Prise de commande depuis n'importe quel téléphone (serveur, caissier, gérant) :
 * la commande part directement en cuisine, sans passer par la caisse et sans quart ouvert.
 * L'encaissement reste à la caisse (« Additions ouvertes »).
 */
export default function OrderTake({ onClose, onSent }) {
  const [cat, setCat] = useState(() => cache.get('catalog'));
  const [loadErr, setLoadErr] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState([]); // { product_id, qty, note }
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [tabs, setTabs] = useState([]);
  const [step, setStep] = useState('items'); // items | send
  const uuid = useRef(newId());
  const { busy, error, setError, run } = useAsync();

  const load = useCallback(() => {
    api.get('/api/catalog').then((c) => { cache.set('catalog', c); setCat(c); setLoadErr(''); })
      .catch((e) => setLoadErr(e.code === 'network' && cache.get('catalog') ? '' : e.message));
    api.get('/api/orders/tabs').then((r) => setTabs(r.tabs)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const products = cat?.products ?? [];
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const shown = products.filter((p) => !category || p.category === category);
  const lines = cart.map((l) => ({ ...l, p: byId.get(l.product_id) })).filter((l) => l.p);
  const count = cart.reduce((a, l) => a + l.qty, 0);
  const total = lines.reduce((a, l) => a + l.qty * l.p.price_cents, 0);
  const add = (p) => setCart((c) => (c.some((l) => l.product_id === p.id) ? c.map((l) => (l.product_id === p.id ? { ...l, qty: Math.min(99, l.qty + 1) } : l)) : [...c, { product_id: p.id, qty: 1, note: '' }]));
  const setQty = (id, q) => setCart((c) => (q <= 0 ? c.filter((l) => l.product_id !== id) : c.map((l) => (l.product_id === id ? { ...l, qty: Math.min(99, q) } : l))));
  const setLineNote = (id, v) => setCart((c) => c.map((l) => (l.product_id === id ? { ...l, note: v } : l)));
  const tables = Array.from({ length: 10 }, (_, i) => `Table ${i + 1}`);

  const send = () => run(async () => {
    if (!label.trim()) throw new Error('Indiquez la table ou le nom du client.');
    let r;
    try {
      r = await api.post('/api/orders', { client_uuid: uuid.current, label: label.trim(), note: note.trim(), lines: lines.map((l) => ({ product_id: l.product_id, qty: l.qty, note: l.note.trim() })) });
    } catch (e) {
      if (e.code === 'network') throw new Error('Pas de réseau : la commande n\'est PAS partie. Réessayez dès que le réseau revient (ne la refaites pas à la main).');
      throw e;
    }
    uuid.current = newId();
    refreshBoard();
    onSent(`✓ « ${label.trim()} » envoyée (${r.order.number}).`);
    onClose();
  });

  return (
    <Modal title={step === 'items' ? 'Nouvelle commande' : 'Envoyer en cuisine'} onClose={onClose} wide>
      <ErrorBox error={loadErr || error} />
      {!cat && !loadErr && <p className="muted">Chargement du menu…</p>}
      {cat && step === 'items' && (
        <>
          <div className="chips" role="group" aria-label="Catégories">
            <button className={`chip${category === '' ? ' on' : ''}`} onClick={() => setCategory('')}>Tout</button>
            {cat.categories.map((c) => <button key={c} className={`chip${category === c ? ' on' : ''}`} onClick={() => setCategory(c)}>{c}</button>)}
          </div>
          <div className="pos-tiles">
            {shown.map((p) => {
              const inCart = cart.find((l) => l.product_id === p.id)?.qty;
              const out = p.available != null && p.available <= 0;
              return (
                <button key={p.id} className="pos-tile" onClick={() => add(p)} aria-label={`Ajouter ${p.name}`}>
                  <strong>{p.name}{inCart ? <span className="qty-badge">{inCart}</span> : null}</strong>
                  <span><span className="price">{eur(p.price_cents)}</span>{out && <span className="stock out"> · épuisé ?</span>}</span>
                </button>
              );
            })}
          </div>
          {lines.length > 0 && (
            <div className="card" style={{ marginTop: 10 }}>
              {lines.map((l) => (
                <div className="cart-line" key={l.product_id}>
                  <div><strong>{l.p.name}</strong>
                    <input value={l.note} onChange={(e) => setLineNote(l.product_id, e.target.value)} maxLength={120} placeholder="Remarque (ex. sans sucre)" aria-label={`Remarque ${l.p.name}`} style={{ marginTop: 4 }} />
                  </div>
                  <div className="qty"><button onClick={() => setQty(l.product_id, l.qty - 1)} aria-label={`Retirer un ${l.p.name}`}>−</button><span>{l.qty}</span><button onClick={() => setQty(l.product_id, l.qty + 1)} aria-label={`Ajouter un ${l.p.name}`}>+</button></div>
                </div>
              ))}
            </div>
          )}
          <div className="actions">
            <button onClick={onClose}>Annuler</button>
            <button className="primary" disabled={count === 0} onClick={() => { setError(''); setStep('send'); }}>Suivant : {count} article{count > 1 ? 's' : ''} · {eur(total)}</button>
          </div>
        </>
      )}
      {cat && step === 'send' && (
        <>
          <ul className="tobuy">{lines.map((l) => <li key={l.product_id}>{l.qty} × {l.p.name}{l.note ? <em> — {l.note}</em> : null}{l.p.to_kitchen === false ? <span className="muted small"> (pas pour la cuisine)</span> : null}</li>)}</ul>
          <Field label="Table ou nom du client">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Ex. Table 4 ou Mme Diallo" autoFocus />
          </Field>
          {tabs.length > 0 && <div><span className="muted small">Additions ouvertes (pour ajouter à la même table) :</span><div className="chips">{tabs.map((t) => <button key={t.key} className={`chip${label === t.label ? ' on' : ''}`} onClick={() => setLabel(t.label)}>{t.label}</button>)}</div></div>}
          <div><span className="muted small">Tables :</span><div className="chips">{tables.map((t) => <button key={t} className={`chip${label === t ? ' on' : ''}`} onClick={() => setLabel(t)}>{t.replace('Table ', '')}</button>)}</div></div>
          <Field label="Remarque pour la cuisine (facultatif)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Ex. allergie aux arachides" /></Field>
          <p className="muted small">Le paiement se fait à la caisse : donnez la table ou le nom du client.</p>
          <div className="actions">
            <button onClick={() => setStep('items')} disabled={busy}>Retour</button>
            <button className="primary" disabled={busy || !label.trim()} onClick={send}>{busy ? 'Envoi…' : 'Envoyer en cuisine'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}
