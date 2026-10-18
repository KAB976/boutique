import React, { useState } from 'react';
import { api } from '../api.js';
import { Field, ErrorBox, PinPad, useAsync } from '../ui.jsx';

export default function Setup({ onDone }) {
  const [step, setStep] = useState(1);
  const [shop, setShop] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [confirming, setConfirming] = useState(false);
  const { busy, error, setError, run } = useAsync();

  const next = (e) => {
    e.preventDefault();
    if (!shop.trim() || !name.trim()) { setError('Indiquez le nom du commerce et votre nom.'); return; }
    setError(''); setStep(2);
  };
  const submit = () => run(async () => {
    if (!confirming) { setConfirming(true); setPin2(''); return; }
    if (pin2 !== pin) { setError('Les deux codes ne sont pas identiques. Recommencez.'); setPin(''); setPin2(''); setConfirming(false); return; }
    try {
      const r = await api.post('/api/setup', { shopName: shop.trim(), ownerName: name.trim(), pin });
      onDone(r.token, r.user);
    } catch (e) {
      setPin(''); setPin2(''); setConfirming(false); // le code a été refusé : on recommence le choix
      throw e;
    }
  });

  return (
    <div className="center">
      <div className="card narrow">
        <h1>Bienvenue</h1>
        <p className="muted">Installation : une minute. Vous serez le propriétaire de l'application.</p>
        <ErrorBox error={error} />
        {step === 1 ? (
          <form onSubmit={next}>
            <Field label="Nom de votre commerce"><input value={shop} onChange={(e) => setShop(e.target.value)} maxLength={60} autoFocus /></Field>
            <Field label="Votre nom"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></Field>
            <button className="primary block" type="submit">Continuer</button>
          </form>
        ) : (
          <>
            <h2>{confirming ? 'Confirmez votre code PIN' : 'Choisissez votre code PIN'}</h2>
            <p className="muted">De 4 à 8 chiffres. Évitez 1234 ou 0000. Ce code vous sert à ouvrir l'application.</p>
            <PinPad value={confirming ? pin2 : pin} onChange={confirming ? setPin2 : setPin} onSubmit={submit} disabled={busy} submitLabel={confirming ? 'Terminer' : 'Suivant'} />
          </>
        )}
      </div>
    </div>
  );
}
