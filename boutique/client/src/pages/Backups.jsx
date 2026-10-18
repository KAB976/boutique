import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Field, Modal, ErrorBox, Notice, fmtDate, fmtSize, useAsync } from '../ui.jsx';

function RestoreModal({ item, onClose, onDone }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAsync();
  const go = (e) => {
    e.preventDefault();
    run(async () => { const r = await api.post(`/api/backups/${item.name}/restore`, { confirm: text }); onDone(r); });
  };
  return (
    <Modal title="Restaurer cette sauvegarde ?" onClose={onClose}>
      <form onSubmit={go}>
        <ErrorBox error={error} />
        <Notice tone="warn">Tout ce qui a été fait après le <strong>{fmtDate(item.createdAt)}</strong> sera perdu. Une copie de l'état actuel est faite juste avant, pour pouvoir revenir en arrière. Tout le monde sera déconnecté.</Notice>
        <Field label="Pour confirmer, tapez RESTAURER"><input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" /></Field>
        <div className="actions"><button type="button" onClick={onClose}>Annuler</button><button className="danger" disabled={busy || text !== 'RESTAURER'}>Restaurer</button></div>
      </form>
    </Modal>
  );
}

function CloudCard() {
  const [st, setSt] = useState(null);
  const [, tick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => api.get('/api/cloud/status').then((d) => live && setSt(d)).catch(() => {});
    load();
    const t = setInterval(() => { load(); tick((n) => n + 1); }, 8000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!st?.enabled) return null;
  const ago = st.lastOkAt ? Math.max(0, Math.round((Date.now() - new Date(st.lastOkAt).getTime()) / 1000)) : null;
  const agoText = ago == null ? 'pas encore' : ago < 60 ? `il y a ${ago} s` : ago < 3600 ? `il y a ${Math.round(ago / 60)} min` : `il y a ${Math.round(ago / 3600)} h`;
  return (
    <section className="card">
      <h2>Copie en ligne (Supabase)</h2>
      {st.conflict || st.lastError
        ? <Notice tone="error">{st.lastError}</Notice>
        : st.pending
          ? <Notice tone="info">Envoi en cours… votre dernière modification part dans quelques secondes.</Notice>
          : <Notice tone="ok">Tout est à jour. Dernière copie {agoText}.</Notice>}
      <p className="muted">Chaque modification est copiée automatiquement. Si le serveur redémarre, tout est retrouvé. Une copie par jour est gardée 30 jours.</p>
    </section>
  );
}

export default function Backups({ onRelogin }) {
  const [data, setData] = useState(null);
  const [tz, setTz] = useState('');
  const [flash, setFlash] = useState('');
  const [restore, setRestore] = useState(null);
  const file = useRef(null);
  const { busy, error, setError, run } = useAsync();

  const load = () => api.get('/api/backups').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); api.get('/api/settings').then((s) => setTz(s.values.timezone)).catch(() => {}); }, []); // eslint-disable-line

  const create = () => run(async () => { const b = await api.post('/api/backups', {}); setFlash(`Sauvegarde créée : ${b.name}`); load(); });
  const download = (b) => run(async () => {
    const blob = await api.download(`/api/backups/${b.name}/download`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = b.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    load();
  });
  const upload = (e) => run(async () => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const b = await api.upload('/api/backups/import', f);
    setFlash(`Fichier importé : ${b.name}. Il n'est pas encore appliqué : choisissez « Restaurer » pour l'utiliser.`); load();
  });

  return (
    <div className="stack">
      <CloudCard />
      <section className="card">
        <div className="row-between">
          <h2>Sauvegardes</h2>
          <div className="actions">
            <input ref={file} type="file" accept=".db" hidden onChange={upload} />
            <button disabled={busy} onClick={() => file.current?.click()}>Importer un fichier</button>
            <button className="primary" disabled={busy} onClick={create}>Sauvegarder maintenant</button>
          </div>
        </div>
        <p className="muted">Une sauvegarde automatique est faite chaque jour{data ? ` (les ${data.keepAuto} dernières sont gardées)` : ''}. Chaque fichier est vérifié dès sa création.</p>
        <Notice tone="warn">Ces copies sont rangées sur le même serveur : si le serveur est perdu, elles le sont aussi. Téléchargez régulièrement une copie et gardez-la ailleurs (clé USB, autre appareil, messagerie).</Notice>
        <ErrorBox error={error} />
        <Notice tone="ok">{flash}</Notice>
        {!data ? <p className="muted">Chargement…</p> : (
          <div className="table-wrap"><table className="responsive">
            <thead><tr><th>Date</th><th>Type</th><th>Taille</th><th /></tr></thead>
            <tbody>
              {data.items.map((b) => (
                <tr key={b.name}>
                  <td className="nowrap">{fmtDate(b.createdAt, tz)}</td>
                  <td>{b.kindLabel}</td>
                  <td>{fmtSize(b.size)}</td>
                  <td className="right"><button onClick={() => download(b)} disabled={busy}>Télécharger</button><button onClick={() => setRestore(b)}>Restaurer</button></td>
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan="4" className="muted">Aucune sauvegarde pour l'instant.</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
      {restore && <RestoreModal item={restore} onClose={() => setRestore(null)} onDone={() => { setRestore(null); onRelogin('Sauvegarde restaurée. Reconnectez-vous.'); }} />}
    </div>
  );
}
