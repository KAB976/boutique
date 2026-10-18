import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync, CategorySelect } from '../ui.jsx';
import { eur, eurReal, parseEuros, toEuroInput } from '../money.js';

const KIND_HELP = {
  made: 'Vous le préparez à l\'avance en lots (ex. crêpes, samoussas, gâteaux). La caisse vend ce qui est en stock ; le coût vient de la dernière production.',
  direct: 'Préparé à la commande (ex. sandwich). Chaque vente sort directement les ingrédients du stock selon la recette.',
  resale: 'Acheté et revendu tel quel (ex. bouteille d\'eau, canette). Chaque vente sort une quantité du stock d\'un ingrédient.',
  free: 'Pas de stock ni de coût suivi (ex. service, supplément, divers).',
};

function ProductForm({ product, lists, settings, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    kind: product?.kind ?? 'made', name: product?.name ?? '', category: product?.category ?? '', price: toEuroInput(product?.price_cents), vat_pct: String(product?.vat_pct ?? settings?.vat_default ?? 0),
    recipe_id: product?.recipe_id ? String(product.recipe_id) : '', portions: String(product?.portions ?? 1), ingredient_id: product?.ingredient_id ? String(product.ingredient_id) : '', ingredient_qty: String(product?.ingredient_qty ?? 1),
    active: product?.active ?? true, to_kitchen: product ? product.to_kitchen !== false : true,
  }));

  const { busy, error, run } = useAsync();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const ing = lists.ingredients.find((i) => i.id === Number(f.ingredient_id));
  const price = parseEuros(f.price);
  const suggest = product?.cost != null && settings?.target_margin != null && settings.target_margin < 100
    ? Math.ceil((product.cost / (1 - settings.target_margin / 100)) * (1 + Number(f.vat_pct || 0) / 100) * 20) / 20 : null; // arrondi aux 5 centimes
  const save = () => run(async () => {
    const body = {
      name: f.name, category: f.category, price_cents: price, vat_pct: Number(String(f.vat_pct).replace(',', '.')),
      ...(f.kind === 'made' || f.kind === 'direct' ? { recipe_id: Number(f.recipe_id) || null, portions: Number(String(f.portions).replace(',', '.')) } : {}),
      ...(f.kind === 'resale' ? { ingredient_id: Number(f.ingredient_id) || null, ingredient_qty: Number(String(f.ingredient_qty).replace(',', '.')) } : {}),
      to_kitchen: f.to_kitchen,
      ...(product ? { active: f.active } : { kind: f.kind }),
    };
    if (product) await api.put(`/api/products/${product.id}`, body); else await api.post('/api/products', body);
    onSaved(); onClose();
  });
  return (
    <Modal title={product ? `Modifier ${product.name}` : 'Nouvel article'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!product && (
        <Field label="Type d'article">
          <select value={f.kind} onChange={(e) => { set('kind', e.target.value); setF((x) => ({ ...x, kind: e.target.value, to_kitchen: e.target.value !== 'resale' })); }}>
            {Object.entries(lists.kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      )}
      <p className="muted small">{KIND_HELP[f.kind]}</p>
      <div className="grid">
        <Field label="Nom affiché à la caisse"><input value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={60} autoFocus /></Field>
        <CategorySelect kind="product" value={f.category} onChange={(v) => set('category', v)} hint="Sert à regrouper les boutons de la caisse et les promotions." />
        <Field label="Prix de vente TTC (€)"><input inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="0,00" /></Field>
        <Field label="TVA (%)" hint="0 si vous n'êtes pas assujetti."><input inputMode="decimal" value={f.vat_pct} onChange={(e) => set('vat_pct', e.target.value)} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={f.to_kitchen} onChange={(e) => set('to_kitchen', e.target.checked)} /> Se prépare en cuisine (apparaît sur l'écran « Commandes » de la cuisine)</label>
      {(f.kind === 'made' || f.kind === 'direct') && (
        <div className="grid">
          <Field label="Recette">
            <select value={f.recipe_id} onChange={(e) => set('recipe_id', e.target.value)}>
              <option value="">— choisir —</option>
              {lists.recipes.map((r) => <option key={r.id} value={r.id}>{r.name}{r.archived ? ' (archive)' : ''}</option>)}
            </select>
          </Field>
          <Field label={f.kind === 'made' ? 'Combien d\'articles pour 1 personne de la recette ?' : 'Combien de personnes de la recette par article ?'} hint={f.kind === 'made' ? 'Ex. la recette est « pour 4 personnes » et donne 8 crêpes : 2.' : 'Ex. un sandwich = 1 personne de la recette.'}>
            <input inputMode="decimal" value={f.portions} onChange={(e) => set('portions', e.target.value)} />
          </Field>
        </div>
      )}
      {f.kind === 'resale' && (
        <div className="grid">
          <Field label="Ingrédient du stock vendu">
            <select value={f.ingredient_id} onChange={(e) => set('ingredient_id', e.target.value)}>
              <option value="">— choisir —</option>
              {lists.ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </Field>
          <Field label={`Quantité sortie du stock par article (${ing ? { mass: 'grammes', volume: 'millilitres', count: 'pièces' }[ing.family] : 'unité de base'})`}>
            <input inputMode="decimal" value={f.ingredient_qty} onChange={(e) => set('ingredient_qty', e.target.value)} />
          </Field>
        </div>
      )}
      {product && product.cost != null && (
        <Notice tone="info">
          Coût estimé : <strong>{eurReal(product.cost)}</strong>{product.cost_incomplete && ' (incomplet)'} — source : {product.cost_source}.
          {price != null && <> Marge sur le prix saisi (hors TVA) : <strong>{eurReal(price / 100 - (price * Number(f.vat_pct || 0)) / (100 + Number(f.vat_pct || 0)) / 100 - product.cost)}</strong>.</>}
          {suggest != null && <> Prix conseillé pour {settings.target_margin} % de marge : <strong>{eurReal(suggest)}</strong>.</>}
        </Notice>
      )}
      {product && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> En vente à la caisse</label>}
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy || price == null} onClick={save}>Enregistrer</button></div>
    </Modal>
  );
}

export default function Products({ me }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null); // null | {} | product
  const [settings, setSettings] = useState(null);
  const [showOff, setShowOff] = useState(false);
  const { error, setError } = useAsync();
  const load = useCallback(() => api.get('/api/products?all=1').then(setData).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); api.get('/api/settings').then((r) => setSettings(r.values)).catch(() => {}); }, [load]);
  if (!data) return <section className="card">{error ? <ErrorBox error={error} /> : <p className="muted">Chargement…</p>}</section>;
  const items = data.items.filter((p) => showOff || p.active);
  const lists = { ...data, categories: [...new Set(data.items.map((p) => p.category).filter(Boolean))] };
  return (
    <section className="card">
      <div className="row-between"><h1>Articles en vente</h1><button className="primary" onClick={() => setEdit({})}>+ Nouvel article</button></div>
      <p className="muted">Ce que la caisse vend. Un article peut venir d'une recette (préparé à l'avance ou à la commande), d'un ingrédient revendu tel quel, ou n'avoir aucun stock.</p>
      <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Afficher aussi les articles retirés de la vente</label>
      <ErrorBox error={error} />
      {items.length === 0 ? <p className="muted">Aucun article. Créez le premier avec « + Nouvel article ».</p> : (
        <div className="table-wrap"><table className="responsive">
          <thead><tr><th>Article</th><th>Type</th><th>Prix</th>{data.can.costs && <th>Coût</th>}{data.can.costs && <th>Marge</th>}<th>Stock</th><th /></tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'off'}>
                <td><strong>{p.name}</strong>{!p.active && <span className="badge">retiré</span>}<div className="muted small">{p.category}{p.recipe_name ? ` · recette : ${p.recipe_name}${p.recipe_archived ? ' (archive)' : ''}` : ''}{p.ingredient_name ? ` · ${p.ingredient_name}` : ''}</div></td>
                <td>{p.kindLabel}</td><td className="nowrap">{eur(p.price_cents)}</td>
                {data.can.costs && <td className="nowrap">{p.cost == null ? '—' : eurReal(p.cost)}{p.cost_incomplete && p.cost != null && <span className="badge warn">incomplet</span>}</td>}
                {data.can.costs && <td className={`nowrap ${p.margin_cents != null && p.margin_cents < 0 ? 'neg' : ''}`}>{p.margin_cents == null ? '—' : eur(p.margin_cents)}</td>}
                <td>{p.available == null ? '—' : p.available}</td>
                <td className="right"><button onClick={() => setEdit(p)}>Modifier</button></td>
              </tr>
            ))}
          </tbody></table></div>
      )}
      {edit && <ProductForm product={edit.id ? edit : null} lists={lists} settings={settings} onClose={() => setEdit(null)} onSaved={load} />}
    </section>
  );
}
