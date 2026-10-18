import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';

const KINDS = [
  ['ingredient', 'Ingrédients', 'Rangent les ingrédients du stock (produits laitiers, farines…).'],
  ['recipe', 'Recettes', 'Rangent les recettes (petit déjeuner, plat, dessert…).'],
  ['product', 'Articles de la caisse', 'Regroupent les boutons de la caisse et servent aux promotions par catégorie.'],
];

function RenameModal({ kind, cat, names, onClose, onDone }) {
  const [to, setTo] = useState(cat.name);
  const { busy, error, run } = useAsync();
  const fusion = to.trim() && to.trim().toLowerCase() !== cat.name.toLowerCase() && names.some((n) => n.toLowerCase() === to.trim().toLowerCase());
  const save = (e) => { e.preventDefault(); run(async () => { await api.post('/api/categories/rename', { kind, from: cat.name, to }); onDone(); }); };
  return (
    <Modal title={`Renommer « ${cat.name} »`} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        <Field label="Nouveau nom" hint={cat.count ? `Les ${cat.count} élément${cat.count > 1 ? 's' : ''} qui l'utilisent changent aussi.` : undefined}>
          <input value={to} maxLength={40} onChange={(e) => setTo(e.target.value)} autoFocus required />
        </Field>
        {fusion && <Notice tone="warn">Ce nom existe déjà : les deux catégories seront regroupées en une seule.</Notice>}
        <div className="actions"><button type="button" onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !to.trim()}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

export default function Categories() {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('ingredient');
  const [name, setName] = useState('');
  const [ren, setRen] = useState(null);
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get('/api/categories').then(setData).catch((e) => setError(e.message)), [setError]);
  useEffect(() => { load(); }, [load]);
  const list = data?.[kind] ?? [];
  const info = KINDS.find((k) => k[0] === kind);

  const add = (e) => { e.preventDefault(); run(async () => { await api.post('/api/categories', { kind, name }); setName(''); await load(); }); };
  const del = (c) => { if (!window.confirm(`Supprimer la catégorie « ${c.name} » ?`)) return; run(async () => { await api.post('/api/categories/delete', { kind, name: c.name }); await load(); }); };

  return (
    <section className="card">
      <h2>Catégories</h2>
      <p className="muted">Ajoutez, renommez ou supprimez les catégories proposées dans les menus déroulants.</p>
      <div className="chips">
        {KINDS.map(([k, l]) => <button key={k} className={`chip${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      <p className="muted">{info[2]}</p>
      <ErrorBox error={error} />
      <form className="inline" onSubmit={add}>
        <input aria-label="Nouvelle catégorie" placeholder="Nouvelle catégorie…" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={busy || !name.trim()}>Ajouter</button>
      </form>
      {!data && <p className="muted">Chargement…</p>}
      {data && list.length === 0 && <Notice>Aucune catégorie pour l'instant.</Notice>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th>Catégorie</th><th>Utilisée par</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.name}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.count === 0 ? <span className="muted">rien</span> : `${c.count} élément${c.count > 1 ? 's' : ''}`}</td>
                  <td className="actions-cell">
                    <button onClick={() => setRen(c)}>Renommer</button>
                    <button onClick={() => del(c)} disabled={busy || c.count > 0} title={c.count > 0 ? 'Encore utilisée : renommez-la ou changez les éléments d\'abord.' : ''}>Supprimer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ren && <RenameModal kind={kind} cat={ren} names={list.map((c) => c.name)} onClose={() => setRen(null)} onDone={() => { setRen(null); load(); }} />}
    </section>
  );
}
