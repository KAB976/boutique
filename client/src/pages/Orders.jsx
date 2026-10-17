import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { ErrorBox } from '../ui.jsx';
import { eur } from '../money.js';
import { useBoard, refreshBoard, useAudioReady } from '../board.js';
import { unlockAudio, playSound } from '../alerts.js';
import NotifyCard from './Notify.jsx';

const mins = (iso, now) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
const hhmm = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }); } catch { return ''; } };
const waitText = (m) => (m < 1 ? 'à l’instant' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);

function OrderCard({ o, me, can, tz, now, onAct, busy }) {
  const m = mins(o.created_at, now);
  const late = o.status !== 'ready' && m >= 15;
  const mine = o.user_id === me.id;
  const canCancel = can.cancel_any || (mine && o.status === 'sent' && can.take);
  return (
    <article className={`order-card st-${o.status}${late ? ' late' : ''}${mine ? ' mine' : ''}`} data-testid={`order-${o.id}`}>
      <header>
        <strong className="order-label">{o.label}</strong>
        <span className="order-meta">{hhmm(o.created_at, tz)} · {waitText(m)}</span>
      </header>
      <ul className="order-lines">
        {o.lines.map((l, i) => (
          <li key={i} className={l.kitchen ? '' : 'nokitchen'}>
            <b>{l.qty} ×</b> {l.name}{l.note ? <em> — {l.note}</em> : null}{!l.kitchen && <span className="muted small"> (pas pour la cuisine)</span>}
          </li>
        ))}
      </ul>
      {o.note && <p className="order-note">📝 {o.note}</p>}
      <p className="muted small">
        {o.number} · pris par {o.user_name || '—'}{o.preparing_by && o.status !== 'sent' ? ` · cuisine : ${o.preparing_by}` : ''} · {o.paid ? <span className="pos-amount">payée</span> : <span>à encaisser {eur(o.total_cents)}</span>}
      </p>
      <div className="order-actions">
        {can.kitchen && o.status === 'sent' && <button className="primary" disabled={busy} onClick={() => onAct(o, 'prepare')}>Je prépare</button>}
        {can.kitchen && (o.status === 'sent' || o.status === 'preparing') && <button className={o.status === 'preparing' ? 'primary' : ''} disabled={busy} onClick={() => onAct(o, 'ready')}>✓ Prête</button>}
        {can.kitchen && o.status === 'ready' && <button disabled={busy} onClick={() => onAct(o, 'unready')}>↩ Pas encore prête</button>}
        {can.serve && o.status === 'ready' && <button className="primary big" disabled={busy} onClick={() => onAct(o, 'serve')}>Servie ✓</button>}
        {canCancel && <button className="danger" disabled={busy} onClick={() => onAct(o, 'cancel')}>Annuler</button>}
      </div>
    </article>
  );
}

export default function Orders({ me }) {
  const b = useBoard();
  const ready = useAudioReady();
  const [now, setNow] = useState(Date.now());
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  useEffect(() => { refreshBoard(); }, []);
  const perms = me.permissions;
  const can = useMemo(() => ({ kitchen: perms.includes('orders.kitchen'), take: perms.includes('orders.take'), serve: perms.includes('orders.serve'), cancel_any: perms.includes('orders.cancel_any') }), [perms]);

  const onAct = async (o, action) => {
    setErr(''); setBusy(true);
    try {
      if (action === 'cancel') {
        const reason = window.prompt(`Annuler la commande « ${o.label} » ? Motif (obligatoire) :`);
        if (reason == null) { setBusy(false); return; }
        if (reason.trim().length < 3) { setErr('Le motif est obligatoire (3 lettres au moins).'); setBusy(false); return; }
        await api.post(`/api/orders/${o.id}/cancel`, { reason: reason.trim() });
      } else await api.post(`/api/orders/${o.id}/${action}`);
    } catch (e) { setErr(e.message); }
    setBusy(false); refreshBoard();
  };

  const data = b.data;
  const act = data?.active ?? [];
  const col = (st) => act.filter((o) => o.status === st);
  const cols = can.kitchen
    ? [['sent', 'Nouvelles', col('sent')], ['preparing', 'En préparation', col('preparing')], ['ready', 'Prêtes à servir', col('ready')]]
    : [['ready', 'Prêtes : à aller chercher', col('ready')], ['cook', 'En cuisine', act.filter((o) => o.status === 'sent' || o.status === 'preparing')]];
  const tz = data?.tz;

  return (
    <div className="stack">
      {!ready && <button className="banner off" style={{ width: '100%', textAlign: 'left' }} onClick={() => { unlockAudio(); setTimeout(() => playSound('ready'), 150); }}><span><strong>🔇 Touchez ici pour activer le son</strong> (le navigateur l'exige après chaque ouverture).</span></button>}
      {b.offline && <div className="banner off"><span><strong>Pas de réseau.</strong> Les commandes ne s'actualisent plus : vérifiez la connexion.</span><button onClick={refreshBoard}>Réessayer</button></div>}
      <ErrorBox error={err || b.error} />
      {!data && !b.offline && <p className="muted">Chargement des commandes…</p>}
      {data && act.length === 0 && <section className="card empty-board"><h2>Aucune commande en cours</h2><p className="muted">{can.take ? 'Prenez une commande depuis la Caisse : « Envoyer en cuisine ».' : 'Les nouvelles commandes apparaissent ici toutes seules, avec un son.'}</p></section>}
      {data && (
        <div className={`board cols-${cols.length}`}>
          {cols.map(([k, title, list]) => (
            <section key={k} className={`board-col col-${k}`}>
              <h2>{title} <span className="count">{list.length}</span></h2>
              {list.length === 0 && <p className="muted small">—</p>}
              {list.map((o) => <OrderCard key={o.id} o={o} me={me} can={can} tz={tz} now={now} onAct={onAct} busy={busy} />)}
            </section>
          ))}
        </div>
      )}
      {data && data.recent.length > 0 && (
        <section className="card">
          <h2>Servies récemment</h2>
          <ul className="tobuy">{data.recent.map((o) => <li key={o.id}>{o.label} · {o.lines.map((l) => `${l.qty} × ${l.name}`).join(', ')} <span className="muted small">— servie à {hhmm(o.served_at, tz)}</span></li>)}</ul>
        </section>
      )}
      <NotifyCard compact />
    </div>
  );
}
