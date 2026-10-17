import React, { useState } from 'react';
import { api } from '../api.js';
import { Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur, eurSigned, parseEuros, fmtTime, fmtDT } from '../money.js';
import { loadShift, nav } from '../shift.js';

export const PinInput = ({ value, onChange, label = 'Votre code PIN (pour confirmer)' }) => (
  <Field label={label}><input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} placeholder="••••" style={{ maxWidth: 180 }} /></Field>
);

/** Ouverture du quart : on compte le fond laissé par la personne d'avant, avec son propre code. */
function OpenForm({ me, sh }) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAsync();
  const c = parseEuros(counted);
  const expected = sh.expected_float_cents;
  const diff = expected != null && c != null ? c - expected : null;
  const submit = () => run(async () => { await api.post('/api/shifts/open', { counted_cents: c, note, pin }); setPin(''); await loadShift(me); });
  return (
    <section className="card narrow-card">
      <h2>Ouvrir mon quart de caisse</h2>
      <p className="muted">Bonjour {me.name}. Avant de vendre : comptez l'argent qui se trouve dans le tiroir.</p>
      {expected != null
        ? <Notice tone="info">Le quart précédent a laissé <strong>{eur(expected)}</strong> dans le tiroir. Vérifiez que c'est bien le cas.</Notice>
        : <Notice tone="info">Premier quart : comptez le fond de caisse de départ (peut être 0 €).</Notice>}
      <ErrorBox error={error} />
      <Field label="Espèces comptées dans le tiroir (€)"><input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="0,00" autoFocus /></Field>
      {diff != null && <p className={diff === 0 ? 'pos-amount' : 'neg'}>{diff === 0 ? '✓ C’est juste.' : `Écart avec ce qui devait être laissé : ${eurSigned(diff)} (${diff < 0 ? 'il manque' : 'il y a en trop'} ${eur(Math.abs(diff))})`}</p>}
      {diff != null && diff !== 0 && <Field label="Expliquez l'écart (obligatoire)" hint="Il sera écrit dans le journal, au nom du quart précédent."><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>}
      <PinInput value={pin} onChange={setPin} />
      <div className="actions"><button className="primary" disabled={busy || c == null || pin.length < 4 || (diff != null && diff !== 0 && note.trim().length < 3)} onClick={submit}>{busy ? 'Ouverture…' : 'Ouvrir mon quart'}</button></div>
    </section>
  );
}

/** Écran affiché à la place de la caisse quand on n'a pas le droit d'encaisser. */
export function ShiftGate({ me, sh, go }) {
  if (!sh) return <section className="card"><p className="muted">Vérification du quart de caisse… (si ce message reste, le réseau est nécessaire une première fois)</p></section>;
  const other = sh.shift && !sh.mine;
  if (!other && !sh.can_open) return <section className="card"><h2>Aucun quart ouvert</h2><p>Un caissier doit ouvrir son quart avant de pouvoir encaisser.</p></section>;
  if (!other) return <OpenForm me={me} sh={sh} />;
  return (
    <section className="card narrow-card">
      <h2>Le quart de {sh.shift.user_name} est ouvert</h2>
      <p>Ouvert à {fmtTime(sh.shift.opened_at, sh.tz)} ({sh.shift.number}). Il doit être fermé avant que vous puissiez encaisser.</p>
      <p className="muted">{sh.shift.user_name} ferme son quart depuis « Ventes et clôture » → « Fermer mon quart », en comptant le tiroir et en laissant le fond de caisse.</p>
      {sh.can_force_close && <div className="actions"><button onClick={() => { nav.sub = 'closure'; go('sales'); }}>Fermer son quart à sa place (gérant)</button></div>}
    </section>
  );
}

export function ShiftBar({ sh, go }) {
  if (!sh?.shift || !sh.mine) return null;
  const req = sh.shift.deposit_requested_at;
  const due = sh.deposit_due_cents;
  const goClose = () => { nav.sub = 'closure'; go('sales'); };
  return (
    <>
      {due > 0 && (
        <div className="banner off" style={{ marginBottom: 8 }}>
          <span><strong>Il y a trop d'espèces dans le tiroir : versez {eur(due)} à l'administrateur.</strong> Vous pouvez continuer à encaisser.</span>
          <button className="primary" onClick={goClose}>Faire le versement</button>
        </div>
      )}
      {req && !due && (
        <div className="banner off" style={{ marginBottom: 8 }}>
          <span><strong>{sh.shift.deposit_requested_by} vous demande de faire un versement.</strong>{sh.shift.deposit_request_note ? ` ${sh.shift.deposit_request_note}` : ' Retirez des espèces du tiroir et remettez-les.'}</span>
          <button className="primary" onClick={goClose}>Faire un versement</button>
        </div>
      )}
      <div className="banner ok" style={{ marginBottom: 8 }}>
        <span><strong>Quart {sh.shift.number}</strong> ouvert à {fmtTime(sh.shift.opened_at, sh.tz)} · fond de départ {eur(sh.shift.opening_counted_cents)}{sh.shift.opening_variance_cents ? <span className="neg"> (écart d'ouverture {eurSigned(sh.shift.opening_variance_cents)})</span> : null}</span>
        <span className="inline"><button onClick={goClose}>Versement</button><button onClick={goClose}>Fermer mon quart</button></span>
      </div>
    </>
  );
}
export { fmtDT };
