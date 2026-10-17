import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync, money, fmtDate } from '../ui.jsx';

const BASE_UNIT = { mass: 'g', volume: 'ml', count: 'piece' };
const defaultUnit = (it) => (it.units.find((u) => u.code === BASE_UNIT[it.family])?.code ?? it.units[0]?.code ?? '');
const nfmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
const confirmAsk = (msg) => window.confirm(msg);

// ---------------------------------------------------------------- photos
const blobCache = new Map();
function PhotoImg({ recipeId, photoId, alt = '', className, onClick }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, made = null;
    const key = `${recipeId}/${photoId}`;
    const get = blobCache.get(key) || api.download(`/api/recipes/${recipeId}/photos/${photoId}`);
    blobCache.set(key, get);
    Promise.resolve(get).then((b) => { if (!alive) return; made = URL.createObjectURL(b); setUrl(made); })
      .catch(() => { blobCache.delete(key); if (alive) setFailed(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [recipeId, photoId]);
  if (failed) return <span className={`ph ${className || ''}`} title="Photo indisponible pour l'instant">⚠</span>;
  if (!url) return <span className={`ph ${className || ''}`}>…</span>;
  return <img src={url} alt={alt} className={className} onClick={onClick} />;
}

/** Réduit la photo sur l'appareil (1280 px, JPEG) avant l'envoi : rapide en 4G et légère dans le stockage gratuit. */
async function shrink(file) {
  let src = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!src) {
    src = await new Promise((resolve, reject) => {
      const img = new Image(); const u = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('Image illisible : choisissez une photo JPEG ou PNG.')); };
      img.src = u;
    });
  }
  let side = 1280;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const k = Math.min(1, side / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.68, 0.5]) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= 450_000) return blob;
    }
    side = Math.round(side * 0.7);
  }
  throw new Error('Photo trop lourde même réduite. Essayez une autre photo.');
}

function Viewer({ recipe, canEdit, start, onClose, onChanged }) {
  const [i, setI] = useState(start);
  const photos = recipe.photos;
  const p = photos[Math.min(i, photos.length - 1)];
  const [cap, setCap] = useState(p?.caption ?? '');
  const { busy, error, run } = useAsync();
  useEffect(() => { setCap(p?.caption ?? ''); }, [p?.id]); // eslint-disable-line
  if (!p) return null;
  const go = (d) => setI((x) => (x + d + photos.length) % photos.length);
  return (
    <Modal title={`Photo ${Math.min(i, photos.length - 1) + 1} / ${photos.length}`} onClose={onClose} wide>
      <ErrorBox error={error} />
      <div className="viewer"><PhotoImg recipeId={recipe.id} photoId={p.id} alt={p.caption || recipe.name} /></div>
      {photos.length > 1 && <div className="actions" style={{ justifyContent: 'center' }}><button onClick={() => go(-1)}>◀ Précédente</button><button onClick={() => go(1)}>Suivante ▶</button></div>}
      {canEdit ? (
        <div className="inline"><input aria-label="Légende" placeholder="Légende (facultatif)" maxLength={80} value={cap} onChange={(e) => setCap(e.target.value)} />
          <button disabled={busy || cap === p.caption} onClick={() => run(async () => { await api.patch(`/api/recipes/${recipe.id}/photos/${p.id}`, { caption: cap }); onChanged(); })}>Enregistrer</button></div>
      ) : p.caption && <p className="muted">{p.caption}</p>}
      {canEdit && (
        <div className="actions"><button className="danger" disabled={busy} onClick={() => confirmAsk('Supprimer cette photo ?') && run(async () => {
          await api.delete(`/api/recipes/${recipe.id}/photos/${p.id}`); await onChanged(); if (photos.length <= 1) onClose(); else setI(0);
        })}>Supprimer cette photo</button></div>
      )}
    </Modal>
  );
}

function Photos({ recipe, maxPhotos, onChanged }) {
  const canEdit = recipe.can.edit;
  const [view, setView] = useState(null);
  const input = useRef(null);
  const { busy, error, setError, run } = useAsync();
  const add = (files) => run(async () => {
    for (const f of files) {
      if (recipe.photos.length >= maxPhotos) { setError(`Maximum ${maxPhotos} photos par recette.`); break; }
      const blob = await shrink(f);
      await api.upload(`/api/recipes/${recipe.id}/photos`, blob);
      await onChanged();
    }
  });
  return (
    <section>
      <div className="row-between"><h3>Photos ({recipe.photos.length}/{maxPhotos})</h3>
        {canEdit && recipe.photos.length < maxPhotos && (
          <>
            <button disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Envoi…' : '+ Ajouter des photos'}</button>
            <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) add(fs); }} />
          </>
        )}
      </div>
      <ErrorBox error={error} />
      {recipe.photos.length === 0 ? <p className="muted">Aucune photo{canEdit ? ' : ajoutez-en depuis l\'appareil photo ou la galerie.' : '.'}</p> : (
        <div className="thumbs">
          {recipe.photos.map((p, i) => <PhotoImg key={p.id} recipeId={recipe.id} photoId={p.id} alt={p.caption || recipe.name} className="thumb" onClick={() => setView(i)} />)}
        </div>
      )}
      {view != null && <Viewer recipe={recipe} canEdit={canEdit} start={view} onClose={() => setView(null)} onChanged={onChanged} />}
    </section>
  );
}

// ---------------------------------------------------------------- feuille imprimable
function PrintSheet({ d, sc, n, shopping }) {
  const lines = sc?.lines ?? [];
  return createPortal(
    <div className="print-sheet">
      <h1>{d.name}</h1>
      <p>{[d.category, `Pour ${nfmt.format(n)} personne${n > 1 ? 's' : ''}`, d.prep_min != null && `Préparation ${d.prep_min} min`, d.cook_min != null && `Cuisson ${d.cook_min} min`].filter(Boolean).join(' · ')}</p>
      {d.photos[0] && <PhotoImg recipeId={d.id} photoId={d.photos[0].id} className="print-photo" />}
      <h2>Ingrédients</h2>
      <table><tbody>
        {lines.map((l, i) => (
          <tr key={i}><td><strong>{l.entered}</strong></td><td>{l.name}{l.note ? ` — ${l.note}` : ''}{l.hasLoss ? ` (à sortir : ${l.grossText})` : ''}</td></tr>
        ))}
      </tbody></table>
      {shopping && (
        <>
          <h2>À acheter</h2>
          {lines.filter((l) => !l.shop.enough).length === 0 ? <p>Tout est en stock.</p> : (
            <ul>{lines.filter((l) => !l.shop.enough).map((l, i) => <li key={i}>{l.name} : {l.shop.packs ? `${l.shop.packs} ${l.shop.packLabel} (${l.shop.toBuyText})` : l.shop.toBuyText}</li>)}</ul>
          )}
        </>
      )}
      {d.steps && <><h2>Préparation</h2><p className="pre">{d.steps}</p></>}
      {d.notes && <><h2>Notes</h2><p className="pre">{d.notes}</p></>}
      <p className="muted small">Version {d.version} — imprimé le {new Date().toLocaleDateString('fr-FR')}</p>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- fiche
function Detail({ id, maxPhotos, onClose, onEdit, onChanged, onOpen }) {
  const [d, setD] = useState(null);
  const [version, setVersion] = useState(null);
  const [n, setN] = useState('');
  const [sc, setSc] = useState(null);
  const [shopping, setShopping] = useState(true);
  const { busy, error, setError, run } = useAsync();

  const load = useCallback(async (v = version) => {
    try {
      const r = await api.get(`/api/recipes/${id}${v ? `?version=${v}` : ''}`);
      setD(r); setError('');
      return r;
    } catch (e) { setError(e.message); return null; }
  }, [id, version]); // eslint-disable-line
  useEffect(() => { load().then((r) => { if (r) setN((cur) => (cur === '' || version ? String(r.servings) : cur)); }); }, [load]); // eslint-disable-line

  const nNum = Number(String(n).replace(',', '.'));
  useEffect(() => {
    if (!d || !(nNum > 0)) { setSc(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/api/recipes/${id}/scale?servings=${encodeURIComponent(nNum)}&version=${d.version}`).then((r) => { if (alive) { setSc(r); setError(''); } }).catch((e) => { if (alive) setError(e.message); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [id, d?.version, d?.currentVersion, nNum, d?.updated_at]); // eslint-disable-line

  const act = (fn, after) => run(async () => { await fn(); await onChanged(); if (after) after(); else await load(); });
  if (!d) return <Modal title="Recette" onClose={onClose} wide><ErrorBox error={error} />{!error && <p className="muted">Chargement…</p>}</Modal>;

  const can = d.can;
  const rows = sc?.lines ?? d.lines.map((l) => ({ ...l, shop: null, grossText: null }));
  const unpriced = can.costs ? d.lines.filter((l) => !l.priced) : [];
  const toBuy = sc ? sc.lines.filter((l) => !l.shop.enough) : [];
  const hasUnlinked = d.lines.some((l) => l.unlinked);
  const step = (x) => setN(String(Math.max(0.5, Math.round((nNum + x) * 100) / 100)));
  return (
    <Modal title={d.name} onClose={onClose} wide>
      <ErrorBox error={error} />
      {d.archived && <Notice tone="warn">Recette dans l'archive : elle n'apparaît pas dans la liste de travail, mais vous pouvez l'ouvrir, la calculer, la compléter, lui ajouter des photos ou la restaurer.</Notice>}
      {!d.isCurrent && <Notice tone="warn">Vous consultez l'ancienne version {d.version} (enregistrée le {fmtDate(d.version_ts)}). La version en cours est la {d.currentVersion}.
        <button className="link" onClick={() => setVersion(null)}>Revenir à la version en cours</button></Notice>}
      <p className="muted">{[d.category, `Écrite pour ${nfmt.format(d.servings)} personne${d.servings > 1 ? 's' : ''}`, d.prep_min != null && `préparation ${d.prep_min} min`, d.cook_min != null && `cuisson ${d.cook_min} min`, `version ${d.version}`].filter(Boolean).join(' · ')}</p>

      <Photos recipe={d} maxPhotos={maxPhotos} onChanged={async () => { await onChanged(); await load(); }} />

      <section className="card calc">
        <h3>Calculer pour combien de personnes ?</h3>
        <div className="inline">
          <button aria-label="Moins" onClick={() => step(-1)} disabled={!(nNum > 1)}>−</button>
          <input inputMode="decimal" aria-label="Nombre de personnes" value={n} onChange={(e) => setN(e.target.value)} />
          <button aria-label="Plus" onClick={() => step(1)}>+</button>
        </div>
        <div className="chips">
          {[d.servings, d.servings * 2, 10, 20, 50, 100].filter((v, i, a) => a.indexOf(v) === i).map((v) => <button key={v} className={`chip${nNum === v ? ' on' : ''}`} onClick={() => setN(String(v))}>{nfmt.format(v)}{v === d.servings ? ' (recette)' : ''}</button>)}
        </div>
        {!(nNum > 0) && <Notice tone="warn">Indiquez un nombre de personnes supérieur à zéro.</Notice>}
        {sc && (toBuy.length === 0
          ? <Notice tone="ok">✅ Tout est en stock pour {nfmt.format(sc.servings)} personne{sc.servings > 1 ? 's' : ''} : vous pouvez produire.</Notice>
          : (
            <Notice tone="warn">
              <strong>⚠ Il vous manque {toBuy.length} ingrédient{toBuy.length > 1 ? 's' : ''} pour {nfmt.format(sc.servings)} personne{sc.servings > 1 ? 's' : ''}. À acheter avant de produire :</strong>
              <ul className="tobuy">{toBuy.map((l, i) => (
                <li key={i}><strong>{l.name}</strong> : {l.shop.packs ? `${l.shop.packs} ${l.shop.packLabel} (${l.shop.toBuyText})` : l.shop.toBuyText}{l.unlinked && <span className="muted"> — pas encore dans vos ingrédients</span>}</li>
              ))}</ul>
              {hasUnlinked && can.edit && <div>Pour que le stock et le coût comptent aussi les ingrédients « pas encore dans vos ingrédients », créez-les dans l'onglet Stock, puis choisissez-les en modifiant la recette.</div>}
            </Notice>
          ))}
        <label className="check"><input type="checkbox" checked={shopping} onChange={(e) => setShopping(e.target.checked)} /> Afficher, ingrédient par ingrédient, ce qu'il y a en stock</label>
        <div className="table-wrap">
          <table className="responsive">
            <thead><tr><th>Quantité</th><th>Ingrédient</th>{rows.some((l) => l.hasLoss) && <th>À sortir du stock</th>}{shopping && <><th>En stock</th><th>À acheter</th></>}</tr></thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={i} className={l.active === false ? 'off' : ''}>
                  <td className="nowrap"><strong>{l.entered}</strong></td>
                  <td>{l.name}{l.note && <span className="muted"> — {l.note}</span>}{l.active === false && <span className="badge">archivé</span>}{l.unlinked && <span className="badge warn">pas dans vos ingrédients</span>}</td>
                  {rows.some((x) => x.hasLoss) && <td>{l.hasLoss ? <>{l.grossText ?? l.baseText}<div className="muted">perte {Math.round(100 - l.yieldPct)} %</div></> : <span className="muted">—</span>}</td>}
                  {shopping && (l.shop ? (
                    <>
                      <td>{l.shop.inStockText}</td>
                      <td>{l.shop.enough ? <span className="badge ok">suffisant</span> : <strong>{l.shop.packs ? `${l.shop.packs} ${l.shop.packLabel}` : l.shop.toBuyText}{l.shop.packs ? <span className="muted"> ({l.shop.toBuyText})</span> : null}</strong>}</td>
                    </>
                  ) : <><td /><td /></>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {can.costs && sc && (
          <div className="tiles">
            <div className="tile card"><strong>{money(sc.cost_total)}</strong><span>Coût pour {nfmt.format(sc.servings)} pers.</span></div>
            <div className="tile card"><strong>{money(sc.cost_per_serving)}</strong><span>Coût par personne</span></div>
          </div>
        )}
        {can.costs && unpriced.length > 0 && <Notice tone="warn">Coût incomplet : pas encore de prix d'achat (ou ingrédient pas encore créé) pour {unpriced.map((l) => l.name).join(', ')}. Les prix se saisissent à la réception dans Stock.</Notice>}
        {can.costs && d.lines.some((l) => l.priced) && (
          <details><summary>Détail des coûts (pour {nfmt.format(d.servings)} personnes)</summary>
            <table><tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td className="right">{l.priced ? money(l.cost) : <span className="muted">{l.unlinked ? 'non chiffré' : 'prix manquant'}</span>}</td></tr>)}</tbody></table>
          </details>
        )}
        <div className="actions"><button onClick={() => window.print()} disabled={!sc}>🖨 Imprimer / enregistrer en PDF</button></div>
      </section>

      {d.steps && <section><h3>Préparation</h3><p className="pre">{d.steps}</p></section>}
      {d.notes && <section><h3>Notes</h3><p className="pre">{d.notes}</p></section>}

      <details className="versions"><summary>Historique des versions ({d.versions.length})</summary>
        <div className="table-wrap"><table className="responsive"><thead><tr><th>Version</th><th>Date</th><th>Par</th><th>Modification</th><th /></tr></thead>
          <tbody>{d.versions.map((v) => (
            <tr key={v.version} className={v.version === d.version ? 'current' : ''}>
              <td><strong>{v.version}</strong>{v.version === d.currentVersion && <span className="badge ok">en cours</span>}</td>
              <td className="nowrap">{fmtDate(v.ts)}</td><td>{v.user_name}</td><td>{v.change_note || <span className="muted">—</span>}</td>
              <td className="right">
                {v.version !== d.version && <button onClick={() => setVersion(v.version === d.currentVersion ? null : v.version)}>Voir</button>}
                {can.edit && v.version !== d.currentVersion && <button disabled={busy} onClick={() => confirmAsk(`Revenir à la version ${v.version} ? Une nouvelle version identique sera créée ; rien n'est effacé.`) && act(async () => { await api.post(`/api/recipes/${id}/versions/${v.version}/restore`, {}); setVersion(null); })}>Revenir à celle-ci</button>}
              </td>
            </tr>))}</tbody></table></div>
      </details>

      {can.edit && (
        <div className="actions">
          <button onClick={() => onEdit(d)} disabled={!d.isCurrent} title={d.isCurrent ? '' : 'Revenez d\'abord à la version en cours'}>Modifier</button>
          <button disabled={busy} onClick={() => act(async () => { const r = await api.post(`/api/recipes/${id}/duplicate`, {}); onOpen(r.id); }, () => {})}>Dupliquer</button>
          {d.archived
            ? <button className="primary" disabled={busy} onClick={() => act(() => api.post(`/api/recipes/${id}/unarchive`, {}))}>Restaurer</button>
            : <button disabled={busy} onClick={() => confirmAsk('Archiver cette recette ? Elle disparaît de la liste de travail mais reste consultable (photos comprises) et restaurable.') && act(() => api.post(`/api/recipes/${id}/archive`, {}), onClose)}>Archiver</button>}
        </div>
      )}
      <PrintSheet d={d} sc={sc} n={nNum > 0 ? nNum : d.servings} shopping={shopping} />
    </Modal>
  );
}

// ---------------------------------------------------------------- éditeur
const emptyLine = () => ({ mode: 'list', ingredient_id: '', label: '', qty: '', unit: '', note: '' });
const FREE_UNITS = ['g', 'kg', 'ml', 'cl', 'l', 'cuillère à soupe', 'cuillère à café', 'tasse', 'pincée', 'pièce', 'gousse', 'botte', 'feuille', 'tranche', 'verre', 'boîte', 'sachet'];
function Editor({ recipe, categories, defaultArchived = false, onClose, onSaved }) {
  const [items, setItems] = useState(null);
  const [f, setF] = useState(() => (recipe ? {
    name: recipe.name, category: recipe.category, servings: String(recipe.servings), prep_min: recipe.prep_min ?? '', cook_min: recipe.cook_min ?? '',
    steps: recipe.steps, notes: recipe.notes, change_note: '',
    lines: recipe.lines.map((l) => (l.unlinked
      ? { mode: 'free', ingredient_id: '', label: l.label, qty: String(l.qty), unit: l.unit, note: l.note }
      : { mode: 'list', ingredient_id: String(l.ingredient_id), label: '', qty: String(l.qty), unit: l.unit, note: l.note })),
  } : { name: '', category: '', servings: '4', prep_min: '', cook_min: '', steps: '', notes: '', change_note: '', archived: defaultArchived, lines: [emptyLine()] }));
  const { busy, error, setError, run } = useAsync();
  useEffect(() => { api.get('/api/stock').then((s) => setItems(s.items.filter((i) => i.active))).catch((e) => setError(e.message)); }, []); // eslint-disable-line
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const upd = (i, patch) => setF((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const move = (i, d) => setF((x) => { const a = [...x.lines]; const j = i + d; if (j < 0 || j >= a.length) return x; [a[i], a[j]] = [a[j], a[i]]; return { ...x, lines: a }; });
  const byId = (id) => items?.find((i) => i.id === Number(id));
  const pick = (i, id) => {
    if (id === '__free') { upd(i, { mode: 'free', ingredient_id: '', unit: '' }); return; }
    const it = byId(id); upd(i, { ingredient_id: id, unit: it ? defaultUnit(it) : '' });
  };
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const lines = f.lines.filter((l) => (l.mode === 'free' ? l.label.trim() || l.qty !== '' : l.ingredient_id || l.qty !== '')).map((l) => (l.mode === 'free'
        ? { label: l.label, qty: l.qty, unit: l.unit, note: l.note }
        : { ingredient_id: Number(l.ingredient_id), qty: l.qty, unit: l.unit, note: l.note }));
      const body = { ...f, lines, prep_min: f.prep_min === '' ? null : f.prep_min, cook_min: f.cook_min === '' ? null : f.cook_min };
      if (recipe) { const r = await api.put(`/api/recipes/${recipe.id}`, { ...body, based_on_version: recipe.version }); onSaved(recipe.id, r, null); }
      else { const r = await api.post('/api/recipes', body); onSaved(r.id, null, f.archived); }
    });
  };
  return (
    <Modal title={recipe ? `Modifier « ${recipe.name} »` : 'Nouvelle recette'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="grid">
          <Field label="Nom de la recette"><input value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} required /></Field>
          <Field label="Catégorie" hint="Entrée, plat, dessert…"><input list="rec-cats" value={f.category} maxLength={40} onChange={(e) => set('category', e.target.value)} /><datalist id="rec-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Écrite pour combien de personnes ?" hint="Les quantités ci-dessous correspondent à ce nombre."><input inputMode="decimal" value={f.servings} onChange={(e) => set('servings', e.target.value)} required /></Field>
          <Field label="Préparation (minutes)"><input inputMode="numeric" value={f.prep_min} onChange={(e) => set('prep_min', e.target.value)} /></Field>
          <Field label="Cuisson (minutes)"><input inputMode="numeric" value={f.cook_min} onChange={(e) => set('cook_min', e.target.value)} /></Field>
        </div>
        <h3>Ingrédients</h3>
        <p className="muted">Quantités nettes, prêtes à l'emploi. Si l'ingrédient a une perte (épluchage…), le stock en sortira davantage : c'est calculé à partir du rendement de sa fiche.</p>
        {!items ? <p className="muted">Chargement des ingrédients…</p> : f.lines.map((l, i) => {
          const it = byId(l.ingredient_id);
          const missing = l.mode === 'list' && l.ingredient_id && !it ? recipe?.lines.find((x) => String(x.ingredient_id) === String(l.ingredient_id)) : null;
          return (
            <div className={`line-card${l.mode === 'free' ? ' free' : ''}`} key={i}>
              {l.mode === 'free' ? (
                <>
                  <div className="grid">
                    <Field label="Nom de l'ingrédient (pas encore dans ma liste)"><input value={l.label} maxLength={80} onChange={(e) => upd(i, { label: e.target.value })} /></Field>
                    <Field label="Quantité">
                      <div className="inline">
                        <input inputMode="decimal" aria-label="Quantité" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
                        <input list="rec-units" aria-label="Unité" placeholder="unité" value={l.unit} maxLength={30} onChange={(e) => upd(i, { unit: e.target.value })} />
                      </div>
                    </Field>
                    <Field label="Remarque" hint="Facultatif"><input value={l.note} maxLength={120} onChange={(e) => upd(i, { note: e.target.value })} /></Field>
                  </div>
                  <p className="muted small">La recette peut être rangée et calculée ainsi. Le stock et le coût ne comptent cet ingrédient qu'une fois créé dans Stock et choisi dans la liste.</p>
                  <button type="button" className="link" onClick={() => upd(i, { mode: 'list' })}>Choisir plutôt dans ma liste d'ingrédients</button>
                </>
              ) : (
                <div className="grid">
                  <Field label="Ingrédient">
                    <select value={l.ingredient_id} onChange={(e) => pick(i, e.target.value)}>
                      <option value="">— choisir —</option>
                      {missing && <option value={l.ingredient_id}>{missing.name} (archivé)</option>}
                      {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      <option value="__free">➕ Pas dans ma liste (écrire son nom)…</option>
                    </select>
                  </Field>
                  <Field label="Quantité">
                    <div className="inline">
                      <input inputMode="decimal" aria-label="Quantité" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} />
                      <select aria-label="Unité" value={l.unit} onChange={(e) => upd(i, { unit: e.target.value })} disabled={!it && !missing}>
                        {(it?.units ?? []).map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}
                        {!it && l.unit && <option value={l.unit}>{l.unit}</option>}
                      </select>
                    </div>
                  </Field>
                  <Field label="Remarque" hint="Facultatif : « émincé », « tiède »…"><input value={l.note} maxLength={120} onChange={(e) => upd(i, { note: e.target.value })} /></Field>
                </div>
              )}
              <div className="actions">
                <button type="button" className="icon" aria-label="Monter" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="icon" aria-label="Descendre" onClick={() => move(i, 1)} disabled={i === f.lines.length - 1}>↓</button>
                <button type="button" onClick={() => setF((x) => ({ ...x, lines: x.lines.length > 1 ? x.lines.filter((_, j) => j !== i) : [emptyLine()] }))}>Retirer</button>
              </div>
            </div>
          );
        })}
        <button type="button" onClick={() => setF((x) => ({ ...x, lines: [...x.lines, emptyLine()] }))}>+ Ajouter un ingrédient</button>
        <datalist id="rec-units">{FREE_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        {items && items.length === 0 && <Notice>Votre liste d'ingrédients est vide : utilisez « ➕ Pas dans ma liste » pour écrire les ingrédients, vous les créerez dans Stock plus tard.</Notice>}
        <Field label="Étapes de préparation"><textarea rows={7} value={f.steps} maxLength={8000} onChange={(e) => set('steps', e.target.value)} /></Field>
        <Field label="Notes"><textarea rows={3} value={f.notes} maxLength={2000} onChange={(e) => set('notes', e.target.value)} /></Field>
        {!recipe && <label className="check"><input type="checkbox" checked={f.archived} onChange={(e) => set('archived', e.target.checked)} /> Ranger directement dans l'archive (recette à essayer plus tard)</label>}
        {recipe && <Field label="Qu'est-ce qui change ?" hint="Facultatif, gardé dans l'historique des versions."><input value={f.change_note} maxLength={200} onChange={(e) => set('change_note', e.target.value)} /></Field>}
        <div className="actions sticky"><button type="button" onClick={onClose}>Annuler</button><button className="primary" disabled={busy || !items}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- liste
export default function Recipes() {
  const [data, setData] = useState(null);
  const [archive, setArchive] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [edit, setEdit] = useState(null); // null | 'new' | fiche
  const [err, setErr] = useState('');
  const reload = useCallback(async () => {
    try { setData(await api.get(`/api/recipes?archived=${archive ? 1 : 0}`)); setErr(''); } catch (e) { setErr(e.message); }
  }, [archive]);
  useEffect(() => { reload(); }, [reload]);
  if (!data) return <div className="card"><ErrorBox error={err} /><p className="muted">Chargement…</p></div>;
  const key = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const rows = data.items.filter((r) => !q || key(`${r.name} ${r.category}`).includes(key(q.trim())));
  return (
    <div className="stack">
      <ErrorBox error={err} />
      <section className="card">
        <div className="row-between">
          <h2>Recettes</h2>
          {data.can.edit && <button className="primary" onClick={() => setEdit('new')}>+ Nouvelle recette</button>}
        </div>
        <div className="chips" role="tablist" aria-label="Recettes">
          <button role="tab" aria-selected={!archive} className={`chip${!archive ? ' on' : ''}`} onClick={() => setArchive(false)}>En cours ({data.counts.active})</button>
          <button role="tab" aria-selected={archive} className={`chip${archive ? ' on' : ''}`} onClick={() => setArchive(true)}>Archive ({data.counts.archived})</button>
        </div>
        <input type="search" aria-label="Rechercher" placeholder="Rechercher une recette ou une catégorie…" value={q} onChange={(e) => setQ(e.target.value)} />
        {rows.length === 0 && <Notice>{archive ? 'Aucune recette archivée.' : data.counts.active === 0 ? `Aucune recette pour l'instant.${data.can.edit ? ' Commencez par « Nouvelle recette ».' : ''}` : 'Aucun résultat.'}</Notice>}
        <div className="recipe-grid">
          {rows.map((r) => (
            <button key={r.id} className="recipe-card" onClick={() => setOpen(r.id)}>
              <div className="cover">{r.cover ? <PhotoImg recipeId={r.id} photoId={r.cover} alt="" /> : <span className="ph">🍽</span>}</div>
              <div className="body">
                <strong>{r.name}</strong>
                {r.category && <div className="muted">{r.category}</div>}
                <div className="meta">{nfmt.format(r.servings)} pers. · {r.lines} ingrédient{r.lines > 1 ? 's' : ''} · v{r.version}{r.photoCount > 0 && ` · 📷 ${r.photoCount}`}</div>
                {r.unlinked > 0 && <div className="meta"><span className="badge warn">{r.unlinked} ingrédient{r.unlinked > 1 ? 's' : ''} à créer</span></div>}
                {data.can.costs && <div className="meta">{money(r.cost_per_serving)} / pers.{r.cost_incomplete && <span className="badge warn">incomplet</span>}</div>}
              </div>
            </button>
          ))}
        </div>
      </section>
      {open && <Detail id={open} maxPhotos={data.maxPhotos} onClose={() => setOpen(null)} onChanged={reload} onOpen={(id) => setOpen(id)} onEdit={(d) => { setOpen(null); setEdit(d); }} />}
      {edit && <Editor recipe={edit === 'new' ? null : edit} categories={data.categories} defaultArchived={archive} onClose={() => setEdit(null)} onSaved={(id, r, arch) => { setEdit(null); if (arch != null && arch !== archive) setArchive(arch); else reload(); setOpen(id); }} />}
    </div>
  );
}
