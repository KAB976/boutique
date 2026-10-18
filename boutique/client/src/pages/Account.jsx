import React, { useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, Notice, PinPad, useAsync } from '../ui.jsx';
import NotifyCard from './Notify.jsx';

export default function Account({ me, forced, onPinChanged }) {
  const [phase, setPhase] = useState('current'); // current | new | confirm
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAsync();

  const reset = () => { setPhase('current'); setCurrent(''); setNext(''); setAgain(''); };
  const submit = () => run(async () => {
    if (phase === 'current') { setPhase('new'); return; }
    if (phase === 'new') { setPhase('confirm'); return; }
    if (again !== next) { setError('Les deux nouveaux codes ne sont pas identiques.'); setNext(''); setAgain(''); setPhase('new'); return; }
    try {
      await api.post('/api/me/pin', { currentPin: current, newPin: next });
    } catch (e) { reset(); throw e; }
    reset(); setDone(true); onPinChanged?.();
  });
  const value = phase === 'current' ? current : phase === 'new' ? next : again;
  const setValue = phase === 'current' ? setCurrent : phase === 'new' ? setNext : setAgain;
  const title = phase === 'current' ? 'Votre code actuel' : phase === 'new' ? 'Choisissez un nouveau code' : 'Confirmez le nouveau code';

  return (
    <div className="stack">
      <section className="card">
        <h1>{me.name}</h1>
        <p className="muted">Rôle : {me.roleLabel}</p>
        {forced && <Notice tone="warn">Votre code est provisoire. Choisissez le vôtre pour continuer.</Notice>}
      </section>
      {!forced && <NotifyCard />}
      {me.canChangePin === false ? (
        <section className="card narrow-card"><h2>Mon code PIN</h2><p className="muted">Votre code est donné par l'administrateur. Pour le changer, demandez-lui.</p></section>
      ) : (
      <section className="card narrow-card">
        <h2>Changer mon code PIN</h2>
        <ErrorBox error={error} />
        {done && <Notice tone="ok">Code changé. Vos autres appareils ont été déconnectés.</Notice>}
        <h3>{title}</h3>
        {phase !== 'current' && <p className="muted">De 4 à 8 chiffres, pas de suite simple (1234) ni de chiffre répété.</p>}
        <PinPad value={value} onChange={(v) => { setDone(false); setValue(v); }} onSubmit={submit} disabled={busy} submitLabel={phase === 'confirm' ? 'Enregistrer' : 'Suivant'} />
        {phase !== 'current' && <button className="link" onClick={reset}>Recommencer</button>}
      </section>
      )}
    </div>
  );
}
