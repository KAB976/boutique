import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Field, ErrorBox, Notice, useAsync, Modal } from '../ui.jsx';

const GROUPS = [
  ['Votre commerce (figure sur le ticket)', ['shop_name', 'address', 'phone', 'ticket_footer', 'logo']],
  ['Monnaie et heure', ['currency', 'timezone']],
  ['Calculs par défaut', ['vat_default', 'target_margin']],
  ['Stock et achats', ['price_alert_pct', 'expiry_alert_days']],
  ['Sécurité et sauvegardes', ['session_hours', 'backup_keep']],
];
const HINTS = {
  vat_default: 'Pourra être précisée par produit (étape 5).',
  target_margin: 'Part du prix de vente qui reste après le coût. 50 % : le coût vaut la moitié du prix.',
  timezone: 'Sert à découper les journées (clôture, sauvegardes).',
  session_hours: 'Une personne inactive est déconnectée au bout de ce délai.',
  price_alert_pct: 'Une alerte apparaît quand un ingrédient coûte au moins ce pourcentage de plus qu\'à l\'achat précédent.',
  expiry_alert_days: 'Nombre de jours avant la date limite à partir duquel un lot est signalé (0 = le jour même).',
  backup_keep: 'Nombre de sauvegardes automatiques gardées (une par jour). Les manuelles ne sont jamais supprimées.',
};

/** Réduit une image à 256 px de large maximum et la renvoie en PNG (data URL). */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 256 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}

function MeasureModal({ m, onClose, onSaved }) {
  const [label, setLabel] = useState(m?.label ?? '');
  const [ml, setMl] = useState(m ? String(m.ml).replace('.', ',') : '');
  const { busy, error, run } = useAsync();
  const save = (e) => { e.preventDefault(); run(async () => { const body = { label, ml: ml.replace(',', '.') }; if (m) await api.patch(`/api/measures/${m.code}`, body); else await api.post('/api/measures', body); onSaved(); }); };
  return (
    <Modal title={m ? `Modifier « ${m.label} »` : 'Ajouter une mesure'} onClose={onClose}>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        <Field label="Nom"><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={30} required placeholder="ex. louche" /></Field>
        <Field label="Contenance (ml)" hint="Volume d'une mesure rase. Pour chaque ingrédient, vous indiquerez ensuite combien de grammes cela représente.">
          <input inputMode="decimal" value={ml} onChange={(e) => setMl(e.target.value)} required />
        </Field>
        <div className="actions"><button type="button" onClick={onClose}>Annuler</button><button className="primary" disabled={busy}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}

function Measures() {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null); // null | 'new' | mesure
  const { error, setError, run } = useAsync();
  const load = () => api.get('/api/measures?all=1').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line
  const toggle = (m) => run(async () => { await api.patch(`/api/measures/${m.code}`, { active: !m.active }); await load(); });
  return (
    <section className="card">
      <div className="row-between"><h2>Mesures générales</h2><button type="button" onClick={() => setEdit('new')}>+ Ajouter une mesure</button></div>
      <p className="muted">Cuillères, tasses… utilisables dans les recettes. L'équivalent en grammes se règle ingrédient par ingrédient (1 tasse de farine ≠ 1 tasse de sucre).</p>
      <ErrorBox error={error} />
      {list && (
        <div className="table-wrap"><table className="responsive"><thead><tr><th>Mesure</th><th>Contenance</th><th /></tr></thead>
          <tbody>{list.map((m) => (
            <tr key={m.code} className={m.active ? '' : 'off'}>
              <td>{m.label}{m.builtin && <span className="badge">de base</span>}{!m.active && <span className="badge">retirée</span>}</td>
              <td>{String(m.ml).replace('.', ',')} ml</td>
              <td className="right"><button type="button" onClick={() => setEdit(m)}>Modifier</button>{!m.builtin && <button type="button" onClick={() => toggle(m)}>{m.active ? 'Retirer' : 'Rétablir'}</button>}</td>
            </tr>))}</tbody></table></div>
      )}
      {edit && <MeasureModal m={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </section>
  );
}

export default function Settings({ onPublicChange }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [saved, setSaved] = useState('');
  const { busy, error, setError, run } = useAsync();
  const file = useRef(null);

  const load = () => api.get('/api/settings').then((d) => { setData(d); setForm(d.values); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line

  if (!data) return <div className="card"><ErrorBox error={error} /><p className="muted">Chargement…</p></div>;
  const dirty = Object.keys(form).filter((k) => JSON.stringify(form[k]) !== JSON.stringify(data.values[k]));
  const set = (k, v) => { setSaved(''); setForm((f) => ({ ...f, [k]: v })); };

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const patch = Object.fromEntries(dirty.map((k) => [k, form[k]]));
      const r = await api.put('/api/settings', patch);
      setData((d) => ({ ...d, values: r.values })); setForm(r.values);
      setSaved(Object.keys(r.changes).length ? 'Réglages enregistrés.' : 'Rien à changer.');
      onPublicChange?.();
    });
  };
  const pickLogo = (e) => run(async () => {
    const f = e.target.files?.[0];
    if (!f) return;
    set('logo', await shrink(f));
  });

  return (
    <div className="stack">
    <form id="settings-form" className="stack" onSubmit={save}>
      <ErrorBox error={error} />
      {saved && <Notice tone="ok">{saved}</Notice>}
      {GROUPS.map(([title, keys]) => (
        <section className="card" key={title}>
          <h2>{title}</h2>
          <div className="grid">
            {keys.filter((k) => k in data.meta).map((k) => (
              k === 'logo' ? (
                <Field key={k} label={data.meta[k].label} hint="Image PNG, JPEG ou WebP (réduite automatiquement).">
                  <div className="logo-row">
                    {form.logo ? <img className="logo-preview" src={form.logo} alt="Logo actuel" /> : <span className="muted">Aucun logo</span>}
                    <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={pickLogo} hidden />
                    <button type="button" onClick={() => file.current?.click()}>Choisir une image</button>
                    {form.logo && <button type="button" onClick={() => set('logo', '')}>Retirer</button>}
                  </div>
                </Field>
              ) : (
                <Field key={k} label={data.meta[k].label} hint={HINTS[k]}>
                  <input
                    value={form[k] ?? ''}
                    inputMode={typeof data.values[k] === 'number' ? 'decimal' : 'text'}
                    onChange={(e) => set(k, e.target.value)}
                  />
                </Field>
              )
            ))}
          </div>
        </section>
      ))}
    </form>
    <Measures />
    <div className="actions sticky"><button form="settings-form" className="primary" disabled={busy || !dirty.length}>{dirty.length ? `Enregistrer (${dirty.length})` : 'Enregistrer'}</button></div>
    </div>
  );
}
