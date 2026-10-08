import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, Notice, fmtDate, useAsync } from '../ui.jsx';

const LABELS = {
  'setup.done': 'Installation de l\'application',
  'auth.login': 'Connexion',
  'auth.login_failed': 'Code PIN erroné',
  'auth.locked': 'Compte bloqué (trop d\'erreurs)',
  'auth.logout': 'Déconnexion',
  'auth.pin_changed': 'Code PIN changé',
  'user.create': 'Compte créé',
  'user.update': 'Compte modifié',
  'user.deactivate': 'Compte désactivé',
  'user.reactivate': 'Compte réactivé',
  'user.pin_reset': 'Code PIN réinitialisé',
  'settings.update': 'Réglages modifiés',
  'backup.create': 'Sauvegarde créée',
  'backup.download': 'Sauvegarde téléchargée',
  'backup.import': 'Sauvegarde importée',
  'backup.restore': 'Sauvegarde restaurée',
};
const FILTERS = [['', 'Tout'], ['auth.', 'Connexions'], ['user.', 'Comptes'], ['settings.', 'Réglages'], ['backup.', 'Sauvegardes']];
const FIELD = { name: 'nom', role: 'rôle', active: 'actif', shop_name: 'nom du commerce', address: 'adresse', phone: 'téléphone',
  ticket_footer: 'message du ticket', logo: 'logo', currency: 'monnaie', timezone: 'fuseau', vat_default: 'TVA', target_margin: 'marge cible',
  session_hours: 'durée de session', backup_keep: 'sauvegardes gardées' };
const ROLE_FR = { owner: 'propriétaire', manager: 'gérant', cashier: 'caissier', cook: 'cuisinier' };
const show = (v) => (v === true ? 'oui' : v === false ? 'non' : v === '' ? '(vide)' : String(v));

function summary(r) {
  const d = r.detail;
  if (!d) return '';
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v === 'object' && 'from' in v) {
      const f = k === 'role' ? (ROLE_FR[v.from] || v.from) : v.from, t = k === 'role' ? (ROLE_FR[v.to] || v.to) : v.to;
      parts.push(`${FIELD[k] || k} : ${show(f)} → ${show(t)}`);
    }
    else if (k === 'name') parts.push(String(v));
    else if (k === 'role') parts.push(`rôle ${ROLE_FR[v] || v}`);
    else if (k === 'failures') parts.push(`${v} erreur(s)`);
    else if (k === 'seconds') parts.push(`${v} s`);
    else if (k === 'kind') parts.push(String(v));
    else if (k === 'safetyCopy') parts.push(`copie de sécurité ${v}`);
    else if (k === 'owner') parts.push(String(v));
  }
  if (r.entity === 'backup' && r.entity_id) parts.unshift(r.entity_id);
  return parts.join(' · ');
}

export default function Audit() {
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState('');
  const [tz, setTz] = useState('');
  const [check, setCheck] = useState(null);
  const { busy, error, run } = useAsync();

  const load = (reset) => run(async () => {
    const before = !reset && rows.length ? `&beforeId=${rows.at(-1).id}` : '';
    const d = await api.get(`/api/audit?limit=50&action=${encodeURIComponent(filter)}${before}`);
    setRows(reset ? d.rows : [...rows, ...d.rows]); setHasMore(d.hasMore);
  });
  useEffect(() => { api.get('/api/settings').then((s) => setTz(s.values.timezone)).catch(() => {}); }, []);
  useEffect(() => { load(true); }, [filter]); // eslint-disable-line

  return (
    <div className="stack">
      <section className="card">
        <div className="row-between">
          <h2>Journal des actions</h2>
          <button disabled={busy} onClick={() => run(async () => setCheck(await api.get('/api/audit/verify')))}>Vérifier l'intégrité</button>
        </div>
        <p className="muted">Chaque action sensible est écrite ici : qui, quand, quoi. Le journal ne peut ni être modifié ni être effacé depuis l'application.</p>
        {check && (check.ok
          ? <Notice tone="ok">Journal intact : {check.count} lignes vérifiées.</Notice>
          : <Notice tone="warn">Anomalie à la ligne {check.brokenAtId} : {check.reason}</Notice>)}
        <div className="chips">{FILTERS.map(([v, l]) => <button key={v} className={filter === v ? 'chip on' : 'chip'} onClick={() => setFilter(v)}>{l}</button>)}</div>
        <ErrorBox error={error} />
        <div className="table-wrap"><table className="responsive">
          <thead><tr><th>Date</th><th>Qui</th><th>Action</th><th>Détail</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{fmtDate(r.ts, tz)}</td>
                <td>{r.user_name || <span className="muted">système</span>}</td>
                <td>{LABELS[r.action] || r.action}</td>
                <td className="muted">{summary(r)}</td>
              </tr>
            ))}
            {!rows.length && !busy && <tr><td colSpan="4" className="muted">Aucune ligne.</td></tr>}
          </tbody>
        </table></div>
        {hasMore && <div className="actions"><button disabled={busy} onClick={() => load(false)}>Charger la suite</button></div>}
      </section>
    </div>
  );
}
