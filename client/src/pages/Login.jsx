import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, Notice, PinPad, useAsync } from '../ui.jsx';
import { VersionBadge } from '../version.jsx';

export default function Login({ pub, message, onDone }) {
  const [users, setUsers] = useState(null);
  const [picked, setPicked] = useState(null);
  const [pin, setPin] = useState('');
  const [wait, setWait] = useState(0);
  const { busy, error, setError, run } = useAsync();

  useEffect(() => { api.get('/api/auth/users').then(setUsers).catch((e) => setError(e.message)); }, []); // eslint-disable-line
  useEffect(() => {
    if (wait <= 0) return undefined;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const submit = () => run(async () => {
    try {
      const r = await api.post('/api/auth/login', { userId: picked.id, pin });
      onDone(r.token, r.user);
    } catch (e) {
      setPin('');
      if (e.retryAfter) setWait(e.retryAfter);
      throw e;
    }
  });

  return (
    <div className="center">
      <div className="card narrow">
        <div className="login-head">
          {pub.logo ? <img src={pub.logo} alt="" /> : <span className="logo-fallback big">🍽</span>}
          <h1>{pub.shop_name || 'Boutique'}</h1>
          <VersionBadge server={pub.version} />
        </div>
        <Notice tone="warn">{message}</Notice>
        <ErrorBox error={error} />
        {!picked ? (
          <>
            <h2>Qui êtes-vous ?</h2>
            {!users ? <p className="muted">Chargement…</p> : (
              <div className="tiles">
                {users.map((u) => (
                  <button key={u.id} className="tile" onClick={() => { setPicked(u); setPin(''); setError(''); }}>
                    <strong>{u.name}</strong><span>{u.roleLabel}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <h2>{picked.name}</h2>
            {wait > 0 && <Notice tone="warn">Compte bloqué. Nouvel essai possible dans {wait} s.</Notice>}
            <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={busy || wait > 0} submitLabel="Entrer" />
            <button className="link" onClick={() => { setPicked(null); setPin(''); setError(''); }}>← Changer de personne</button>
          </>
        )}
      </div>
    </div>
  );
}
