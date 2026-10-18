import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync, FAMILY_FR, CategorySelect } from '../ui.jsx';

const BASE_UNIT = { mass: 'g', volume: 'ml', count: 'pièce' };
const DEFAULT_TH = { mass: 'kg', volume: 'l', count: 'piece' };
/** Unités proposées pour l'alerte : celles de la famille, + l'autre dimension si la densité est connue, + les conditionnements. */
function thresholdUnits(f) {
  const own = { mass: [['g', 'g'], ['kg', 'kg']], volume: [['ml', 'ml'], ['l', 'l']], count: [['piece', 'pièce']] }[f.family];
  const hasDensity = Number(String(f.density).replace(',', '.')) > 0;
  const hasPiece = Number(String(f.piece_g).replace(',', '.')) > 0;
  const out = [...own];
  if (hasDensity && f.family === 'mass') out.push(['ml', 'ml'], ['l', 'l']);
  if (hasDensity && f.family === 'volume') out.push(['g', 'g'], ['kg', 'kg']);
  if (hasPiece && f.family !== 'count') out.push(['piece', 'pièce']);
  if (hasPiece && f.family === 'count') out.push(['g', 'g'], ['kg', 'kg']);
  f.packs.forEach((p, i) => { if (p.label.trim()) out.push([`pack:${i}`, p.label.trim()]); });
  return out;
}
/** Seuil enregistré (en unité de base) → quantité + unité lisibles (1500 ml → 1,5 l). */
function thresholdShown(ing) {
  if (ing?.threshold == null) return { qty: '', unit: DEFAULT_TH[ing?.family ?? 'mass'] };
  const t = ing.threshold, fam = ing.family;
  if (fam === 'count') return { qty: toStr(t), unit: 'piece' };
  const big = t >= 1000;
  return { qty: toStr(Math.round((big ? t / 1000 : t) * 1000) / 1000), unit: fam === 'mass' ? (big ? 'kg' : 'g') : (big ? 'l' : 'ml') };
}
const toStr = (x) => (x == null ? '' : String(x).replace('.', ','));

/** Création / modification d'un ingrédient. */
export default function IngredientForm({ ing, measures, onClose, onSaved }) {
  const isNew = !ing;
  const { busy, error, setError, run } = useAsync();
  const [f, setF] = useState(() => ({
    name: ing?.name ?? '', category: ing?.category ?? '', storage: ing?.storage ?? '', notes: ing?.notes ?? '',
    family: ing?.family ?? 'mass', yield_pct: toStr(ing?.yield_pct ?? 100), density: toStr(ing?.density), piece_g: toStr(ing?.piece_g),
    packs: (ing?.packs ?? []).map((p) => ({ label: p.label, contains: toStr(p.contains) })),
    purchase_depth: ing?.purchase_depth ?? 0,
    equivs: (ing?.equivalences ?? []).map((e) => ({ unit: e.unit, base_qty: toStr(e.base_qty) })),
    thQty: thresholdShown(ing).qty, thUnit: thresholdShown(ing).unit, // affiché en kg / l dès que c'est ≥ 1000, pour ne pas confondre g et kg
  }));
  const [tip, setTip] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const base = BASE_UNIT[f.family];

  useEffect(() => { // changement de famille : l'unité du seuil suit
    if (!thresholdUnits(f).some(([c]) => c === f.thUnit)) set('thUnit', DEFAULT_TH[f.family]);
  }, [f.family, f.density, f.piece_g, f.packs.length]); // eslint-disable-line

  const suggest = () => run(async () => {
    const s = await api.get(`/api/ingredients/suggest?name=${encodeURIComponent(f.name)}`);
    if (!s) { setTip('Pas de repère connu pour ce nom : renseignez les mesures vous-même.'); return; }
    setF((x) => ({
      ...x, family: s.family, density: s.density != null ? toStr(s.density) : x.density, piece_g: s.piece_g != null ? toStr(s.piece_g) : x.piece_g,
      equivs: [...x.equivs.filter((e) => !s.equivalences.some((q) => q.unit === e.unit)), ...s.equivalences.map((e) => ({ unit: e.unit, base_qty: toStr(e.base_qty) }))],
    }));
    setTip(`Repère appliqué : ${s.note}. Vérifiez avec votre produit, ce n'est qu'une moyenne.`);
  });

  const setPack = (i, k, v) => set('packs', f.packs.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const addPack = () => f.packs.length < 4 && set('packs', [...f.packs, { label: '', contains: '' }]);
  const delPack = (i) => { set('packs', f.packs.filter((_, j) => j !== i)); if (f.purchase_depth >= f.packs.length - 1) set('purchase_depth', 0); };
  const setEq = (i, k, v) => set('equivs', f.equivs.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const free = measures.filter((m) => !f.equivs.some((e) => e.unit === m.code));

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const body = {
        name: f.name, category: f.category, storage: f.storage, notes: f.notes, family: f.family,
        yield_pct: f.yield_pct, density: f.density === '' ? null : f.density, piece_g: f.piece_g === '' ? null : f.piece_g,
        packs: f.packs.map((p) => ({ label: p.label, contains: p.contains })), purchase_depth: f.packs.length ? Number(f.purchase_depth) : 0,
        equivalences: f.equivs.map((q) => ({ unit: q.unit, base_qty: q.base_qty })),
        threshold: f.thQty === '' ? null : { qty: f.thQty, unit: f.thUnit },
      };
      const r = isNew ? await api.post('/api/ingredients', body) : await api.patch(`/api/ingredients/${ing.id}`, body);
      onSaved(r);
    });
  };

  const levelText = (i) => {
    const next = f.packs[i + 1];
    return next ? `contient … « ${next.label || 'niveau suivant'} »` : `contient … ${base === 'pièce' ? 'pièces' : base}`;
  };

  return (
    <Modal title={isNew ? 'Nouvel ingrédient' : `Modifier ${ing.name}`} onClose={onClose} wide>
      <form onSubmit={save}>
        <ErrorBox error={error} />
        <div className="grid">
          <Field label="Nom"><input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={60} required /></Field>
          <Field label="Comment on le compte" hint={!isNew && ing.stock !== 0 ? 'Ne peut plus changer une fois qu\'il y a eu du stock.' : 'Poids pour la farine, volume pour l\'huile, pièces pour les œufs ou les capsules.'}>
            <select value={f.family} onChange={(e) => set('family', e.target.value)}>
              {Object.entries(FAMILY_FR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
        {isNew && f.name.trim().length > 2 && <p><button type="button" className="link" onClick={suggest} disabled={busy}>Pré-remplir avec les repères</button></p>}
        <Notice tone="info">{tip}</Notice>

        <h3>Conditionnement d'achat <span className="muted">(facultatif)</span></h3>
        <p className="muted">Du plus gros au plus petit. Exemple pour la levure : « lot » contient 3 « paquet », « paquet » contient 4 « sachet », « sachet » contient 4 g. Les niveaux s'emboîtent, donc deux formats différents (boîte 400 g ou boîte 1 kg) ne vont pas ensemble : gardez le format le plus courant ici, et saisissez l'autre directement en g ou kg à la réception.</p>
        {f.packs.map((p, i) => (
          <div className="pack-row" key={i}>
            <input aria-label={`Nom du niveau ${i + 1}`} placeholder="ex. paquet" value={p.label} onChange={(e) => setPack(i, 'label', e.target.value)} maxLength={30} />
            <span className="muted">{levelText(i)}</span>
            <input aria-label={`Quantité du niveau ${i + 1}`} inputMode="decimal" placeholder="4" value={p.contains} onChange={(e) => setPack(i, 'contains', e.target.value)} />
            <button type="button" className="icon" aria-label="Retirer ce niveau" onClick={() => delPack(i)}>✕</button>
          </div>
        ))}
        {f.packs.length < 4 && <button type="button" onClick={addPack}>+ Ajouter un niveau</button>}
        {f.packs.length > 0 && (
          <Field label="Je l'achète en" hint="Sert à arrondir la liste de courses en vrais emballages.">
            <select value={f.purchase_depth} onChange={(e) => set('purchase_depth', Number(e.target.value))}>
              {f.packs.map((p, i) => <option key={i} value={i}>{p.label || `niveau ${i + 1}`}</option>)}
            </select>
          </Field>
        )}

        <h3>Équivalences en mesures</h3>
        <p className="muted">Pour utiliser des cuillères ou des tasses dans les recettes : combien de {base === 'pièce' ? 'pièces' : base} dans une mesure.</p>
        {f.equivs.map((q, i) => (
          <div className="pack-row" key={q.unit}>
            <span>1 {measures.find((m) => m.code === q.unit)?.label ?? q.unit} =</span>
            <input aria-label="Quantité" inputMode="decimal" value={q.base_qty} onChange={(e) => setEq(i, 'base_qty', e.target.value)} />
            <span className="muted">{base === 'pièce' ? 'pièces' : base}</span>
            <button type="button" className="icon" aria-label="Retirer" onClick={() => set('equivs', f.equivs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        {free.length > 0 && (
          <select aria-label="Ajouter une mesure" value="" onChange={(e) => e.target.value && set('equivs', [...f.equivs, { unit: e.target.value, base_qty: '' }])}>
            <option value="">+ Ajouter une mesure (cuillère, tasse…)</option>
            {free.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
          </select>
        )}

        <div className="grid">
          {f.family === 'mass' && <Field label="Densité (g pour 1 ml)" hint="Seulement si vous passez du poids au volume (miel, huile…)."><input inputMode="decimal" value={f.density} onChange={(e) => set('density', e.target.value)} /></Field>}
          {f.family === 'volume' && <Field label="Densité (g pour 1 ml)" hint="Seulement si vous passez du volume au poids."><input inputMode="decimal" value={f.density} onChange={(e) => set('density', e.target.value)} /></Field>}
          {f.family !== 'count' && <Field label="Poids d'une pièce (g)" hint="Seulement si vous comptez aussi à la pièce."><input inputMode="decimal" value={f.piece_g} onChange={(e) => set('piece_g', e.target.value)} /></Field>}
          {f.family === 'count' && <Field label="Poids d'une pièce (g)" hint="Pour passer des pièces au poids."><input inputMode="decimal" value={f.piece_g} onChange={(e) => set('piece_g', e.target.value)} /></Field>}
          <Field label="Rendement (%)" hint="Part utilisable après épluchage ou parage. 100 = rien à perdre."><input inputMode="decimal" value={f.yield_pct} onChange={(e) => set('yield_pct', e.target.value)} /></Field>
          <Field label="Alerte « stock bas » en dessous de" hint="Laisser vide pour ne pas être alerté. Choisissez l'unité à droite (kg, g, l, ml…).">
            <div className="inline"><input inputMode="decimal" value={f.thQty} onChange={(e) => set('thQty', e.target.value)} />
              <select aria-label="Unité du seuil" value={f.thUnit} onChange={(e) => set('thUnit', e.target.value)}>{thresholdUnits(f).map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select></div>
          </Field>
          <CategorySelect kind="ingredient" value={f.category} onChange={(v) => set('category', v)} />
          <Field label="Lieu de stockage"><input value={f.storage} onChange={(e) => set('storage', e.target.value)} maxLength={40} /></Field>
        </div>
        <Field label="Notes"><input value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={500} /></Field>
        <div className="actions sticky"><button type="button" onClick={onClose}>Annuler</button><button className="primary" disabled={busy}>Enregistrer</button></div>
      </form>
    </Modal>
  );
}
