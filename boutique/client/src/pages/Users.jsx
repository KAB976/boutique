import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, Modal, ErrorBox, Notice, useAsync } from '../ui.jsx';

const ROLES = [['owner', 'Propriétaire'], ['manager', 'Gérant'], ['cashier', 'Caissier'], ['cook', 'Cuisinier'], ['waiter', 'Serveur']];
const ROLE_HELP = {
  owner: 'Tout : réglages, comptes, prix d\'achat, sauvegardes.',
  manager: 'Tout sauf réglages et comptes : recettes, stock, achats, promotions, clôtures, statistiques.',
  cashier: 'Caisse, ventes du jour, clôture, écran cuisine. Ne voit ni stock ni coûts.',
  cook: 'Stock, recettes, production, écran cuisine. Ne voit ni prix d\'achat ni caisse.',
};

function UserForm({ user, onClose, onSaved }) {
  const isNew = !user;
  const [name, setName] = useState(user?.name || '');
  const [role, setRole] = useState(user?.role || 'cashier');
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAsync();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (isNew) await api.post('/api/users', { name, role, pin });
      else await api.patch(`/api/users/${user.id}`, { name, role });
      onSaved();
    });
  };
  return (
    <Modal title={isNew ? 'Nouveau compte' : `Modifier ${user.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Nom"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></Field>
        <Field label="Rôle" hint={ROLE_HELP[role]}>
          <select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>
        {isNew && (
          <Field label="Code PIN" hint="4 à 8 chiffres. C'est vous qui le donnez à la personne ; elle ne peut pas le changer.">
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="off" />
          </Field>
        )}
        <div className="actions"><button type="button" onClick={onClose}>Annuler</button><button className="primary" disabled={busy}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

function PinReset({ user, onClose, onSaved }) {
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAsync();
  const submit = (e) => { e.preventDefault(); run(async () => { await api.post(`/api/users/${user.id}/pin`, { pin }); onSaved(); }); };
  return (
    <Modal title={`Nouveau code pour ${user.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <p className="muted">La personne sera déconnectée et devra choisir son propre code à la prochaine connexion. Un blocage éventuel est levé.</p>
        <Field label="Nouveau code PIN"><input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="off" /></Field>
        <div className="actions"><button type="button" onClick={onClose}>Annuler</button><button className="primary" disabled={busy}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export default function Users({ me }) {
  const [list, setList] = useState(null);
  const [modal, setModal] = useState(null);
  const [flash, setFlash] = useState('');
  const { error, setError, run } = useAsync();
  const load = () => api.get('/api/users').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line
  const done = (msg) => { setModal(null); setFlash(msg); load(); };
  const toggle = (u) => run(async () => { await api.patch(`/api/users/${u.id}`, { active: !u.active }); setFlash(u.active ? `${u.name} désactivé.` : `${u.name} réactivé.`); load(); });

  return (
    <div className="stack">
      <section className="card">
        <div className="row-between"><h2>Comptes</h2><button className="primary" onClick={() => setModal({ type: 'edit' })}>+ Nouveau compte</button></div>
        <p className="muted">Un compte désactivé ne peut plus se connecter mais son historique reste intact : on ne supprime jamais un compte.</p>
        <ErrorBox error={error} />
        <Notice tone="ok">{flash}</Notice>
        {!list ? <p className="muted">Chargement…</p> : (
          <div className="table-wrap"><table className="responsive">
            <thead><tr><th>Nom</th><th>Rôle</th><th>État</th><th /></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'off'}>
                  <td><strong>{u.name}</strong>{u.id === me.id && <span className="badge">vous</span>}</td>
                  <td>{u.roleLabel}</td>
                  <td>
                    {!u.active && <span className="badge">désactivé</span>}
                    {u.active && u.locked && <span className="badge warn">bloqué</span>}
                    {u.active && u.mustChangePin && <span className="badge">code provisoire</span>}
                    {u.active && !u.locked && !u.mustChangePin && <span className="badge ok">actif</span>}
                  </td>
                  <td className="right">
                    <button onClick={() => setModal({ type: 'edit', user: u })}>Modifier</button>
                    {u.id !== me.id && u.active && <button onClick={() => setModal({ type: 'pin', user: u })}>Nouveau PIN</button>}
                    {u.id !== me.id && <button onClick={() => toggle(u)}>{u.active ? 'Désactiver' : 'Réactiver'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {modal?.type === 'edit' && <UserForm user={modal.user} onClose={() => setModal(null)} onSaved={() => done('Compte enregistré.')} />}
      {modal?.type === 'pin' && <PinReset user={modal.user} onClose={() => setModal(null)} onSaved={() => done(`Code de ${modal.user.name} réinitialisé.`)} />}
    </div>
  );
}
