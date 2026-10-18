import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal, Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eurReal, fmtDT } from '../money.js';

const BASE = { mass: 'g', volume: 'ml', count: 'piece' };
const BASE_LABEL = { mass: 'g', volume: 'ml', count: 'pièce(s)' };
const nfmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
const REASONS = { invendu: 'Invendu en fin de journée', perime: 'Périmé', casse: 'Cassé ou tombé', jete: 'Jeté', donne: 'Donné', personnel: 'Repas du personnel', autre: 'Autre (à préciser)' };

function Produce({ me, onDone }) {
  const [recipes, setRecipes] = useState({ active: [], archived: [] });
  const [rid, setRid] = useState('');
  const [servings, setServings] = useState('');
  const [plan, setPlan] = useState(null);
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [showUsed, setShowUsed] = useState(false);
  const [used, setUsed] = useState({});
  const [note, setNote] = useState('');
  const [orders, setOrders] = useState([]);
  const [orderId, setOrderId] = useState('');
  const [result, setResult] = useState(null);
  const [needForce, setNeedForce] = useState(false);
  const { busy, error, setError, run } = useAsync();
  const costs = me.permissions.includes('costs.view');

  useEffect(() => {
    Promise.all([api.get('/api/recipes'), api.get('/api/recipes?archived=1')])
      .then(([a, b]) => setRecipes({ active: a.items, archived: b.items })).catch((e) => setError(e.message));
    api.get('/api/catering?status=confirmed').then((r) => setOrders(r.items)).catch(() => {});
  }, []); // eslint-disable-line

  const all = [...recipes.active, ...recipes.archived];
  const pick = (id) => {
    setRid(id); setPlan(null); setResult(null); setUsed({}); setShowUsed(false); setNeedForce(false);
    const r = all.find((x) => x.id === Number(id));
    setServings(r ? String(r.servings) : '');
  };
  const n = Number(String(servings).replace(',', '.'));
  useEffect(() => {
    if (!rid || !(n > 0)) { setPlan(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/api/production/plan?recipe_id=${rid}&servings=${encodeURIComponent(n)}`).then((p) => {
        if (!alive) return;
        setPlan(p); setError(''); setNeedForce(false);
        setProductId((cur) => (p.products.some((x) => String(x.id) === String(cur)) ? cur : p.products[0] ? String(p.products[0].id) : ''));
        setQty(String(p.defaultQty)); setUsed({});
      }).catch((e) => { if (alive) { setPlan(null); setError(e.message); } });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [rid, n]); // eslint-disable-line

  const prod = plan?.products.find((p) => String(p.id) === String(productId));
  useEffect(() => { if (plan && prod) setQty(String(Math.round(n * (prod.portions ?? 1) * 1000) / 1000)); }, [productId]); // eslint-disable-line

  const submit = (force = false) => run(async () => {
    const usedList = Object.entries(used).filter(([, v]) => v !== '' && v != null).map(([id, v]) => {
      const l = plan.lines.find((x) => x.ingredient_id === Number(id));
      return { ingredient_id: Number(id), qty: v, unit: BASE[l.family] };
    });
    try {
      const r = await api.post('/api/production', {
        recipe_id: Number(rid), servings: n, ...(productId ? { product_id: Number(productId), qty_obtained: qty } : {}), ...(usedList.length ? { used: usedList } : {}), note, ...(orderId ? { order_id: Number(orderId) } : {}), ...(force ? { force: true } : {}),
      });
      setResult(r); setPlan(null); setRid(''); setServings(''); setOrderId(''); onDone();
    } catch (e) { if (e.code === 'insufficient') setNeedForce(Boolean(plan?.canForce)); throw e; }
  });

  const short = plan?.lines.filter((l) => !l.enough) ?? [];
  return (
    <section className="card">
      <h2>Produire</h2>
      <p className="muted">Choisissez la recette (l'archive aussi) et le nombre de personnes. L'application calcule les quantités, sort les ingrédients du stock et enregistre ce que la production a réellement coûté.</p>
      <ErrorBox error={error} />
      <div className="grid">
        <Field label="Recette">
          <select value={rid} onChange={(e) => pick(e.target.value)}>
            <option value="">— choisir —</option>
            <optgroup label="Recettes">{recipes.active.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>
            {recipes.archived.length > 0 && <optgroup label="Archive">{recipes.archived.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>}
          </select>
        </Field>
        <Field label="Pour combien de personnes ?"><input inputMode="decimal" value={servings} onChange={(e) => setServings(e.target.value)} /></Field>
      </div>
      {plan && (
        <>
          {plan.unlinked.length > 0 && <Notice tone="error">Cette recette contient des ingrédients qui ne sont pas dans la liste des ingrédients : <strong>{plan.unlinked.join(', ')}</strong>. Le gérant doit les relier (Recettes → Modifier) avant de produire.</Notice>}
          {short.length > 0 && <Notice tone="warn"><strong>Il manque en stock :</strong> {short.map((l) => `${l.name} (${l.shortText})`).join(' · ')}</Notice>}
          {plan.ready && <Notice tone="ok">Tout est en stock pour {nfmt.format(n)} personne{n > 1 ? 's' : ''}.</Notice>}
          <div className="table-wrap"><table className="responsive">
            <thead><tr><th>Ingrédient</th><th>À sortir du stock</th><th>En stock</th>{showUsed && <th>Quantité réellement utilisée ({'g / ml / pièces'})</th>}</tr></thead>
            <tbody>
              {plan.lines.map((l) => (
                <tr key={l.ingredient_id} className={l.enough ? '' : 'off'}>
                  <td>{l.name}</td><td>{l.plannedText}</td><td className={l.enough ? '' : 'neg'}>{l.stockText}</td>
                  {showUsed && <td><input inputMode="decimal" value={used[l.ingredient_id] ?? ''} placeholder={String(l.planned)} onChange={(e) => setUsed({ ...used, [l.ingredient_id]: e.target.value })} aria-label={`Quantité utilisée de ${l.name} en ${BASE_LABEL[l.family]}`} /></td>}
                </tr>
              ))}
            </tbody></table></div>
          {costs && plan.cost != null && <p>Coût prévu : <strong>{eurReal(plan.cost)}</strong>{plan.cost_incomplete && <span className="muted"> (incomplet : des prix manquent)</span>}</p>}
          <label className="check"><input type="checkbox" checked={showUsed} onChange={(e) => setShowUsed(e.target.checked)} /> J'ai utilisé des quantités différentes de celles prévues</label>
          <div className="grid">
            <Field label="Article obtenu" hint={plan.products.length === 0 ? 'Aucun article « préparé à l’avance » n’est lié à cette recette : la production sera enregistrée sans stock de lots.' : undefined}>
              <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">— aucun (traiteur, usage interne) —</option>
                {plan.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {productId && <Field label="Quantité réellement obtenue" hint="Comptez ce qui est sorti du four : c'est cela qui fixe le coût de chaque article."><input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>}
          </div>
          <div className="grid">
            {orders.length > 0 && <Field label="Pour une commande traiteur (facultatif)" hint="Le coût réel de cette production sera retenu pour la commande."><select value={orderId} onChange={(e) => setOrderId(e.target.value)}><option value="">— non —</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.number} · {o.contact_name} · {o.event_date}</option>)}</select></Field>}
            <Field label="Note (facultatif)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
          </div>
          <div className="actions">
            {needForce && <button className="danger" disabled={busy} onClick={() => submit(true)}>Produire quand même (stock négatif)</button>}
            <button className="primary" disabled={busy || plan.unlinked.length > 0} onClick={() => submit(false)}>{busy ? 'Enregistrement…' : 'Enregistrer la production'}</button>
          </div>
        </>
      )}
      {result && (
        <Modal title={`Production ${result.number} enregistrée`} onClose={() => setResult(null)}>
          <p><strong>{nfmt.format(result.qty_obtained)}</strong> obtenu{result.qty_obtained > 1 ? 's' : ''}.</p>
          {result.cost_total != null && <p>Coût réel : <strong>{eurReal(result.cost_total)}</strong>{result.qty_obtained > 0 && <> · soit <strong>{eurReal(result.unit_cost)}</strong> l'unité</>}</p>}
          {result.incomplete && <Notice tone="warn">Le prix d'au moins un ingrédient est inconnu : le coût réel est sous-estimé. Complétez les prix dans le Stock.</Notice>}
          {result.forced && <Notice tone="warn">Production forcée : certains ingrédients sont passés en stock négatif. Faites un inventaire dès que possible.</Notice>}
          <div className="actions"><button className="primary" onClick={() => setResult(null)}>OK</button></div>
        </Modal>
      )}
    </section>
  );
}

function LossModal({ item, reasons, onClose, onDone }) {
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('invendu');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Invendu / perte — ${item.name}`} onClose={onClose}>
      <p className="muted">En stock : {item.balance}</p>
      <ErrorBox error={error} />
      <Field label="Quantité retirée"><input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></Field>
      <Field label="Motif"><select value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label={reason === 'autre' ? 'Précisez (obligatoire)' : 'Note (facultatif)'}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy} onClick={() => run(async () => { await api.post('/api/batches/loss', { product_id: item.id, qty: Number(qty), reason, note }); onDone(); onClose(); })}>Enregistrer</button></div>
    </Modal>
  );
}

function CountModal({ item, onClose, onDone }) {
  const [counted, setCounted] = useState(String(Math.max(0, item.balance)));
  const { busy, error, run } = useAsync();
  return (
    <Modal title={`Compter — ${item.name}`} onClose={onClose}>
      <p className="muted">L'application pense qu'il en reste {item.balance}. Entrez ce que vous comptez vraiment : l'écart est enregistré.</p>
      <ErrorBox error={error} />
      <Field label="Quantité comptée"><input inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus /></Field>
      <div className="actions"><button onClick={onClose}>Annuler</button><button className="primary" disabled={busy} onClick={() => run(async () => { await api.post('/api/batches/count', { product_id: item.id, counted: Number(counted) }); onDone(); onClose(); })}>Enregistrer</button></div>
    </Modal>
  );
}

function Batches({ me, version, onDone }) {
  const [data, setData] = useState(null);
  const [loss, setLoss] = useState(null);
  const [count, setCount] = useState(null);
  const { error, setError } = useAsync();
  const load = useCallback(() => api.get('/api/batches').then(setData).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); }, [load, version]);
  const costs = me.permissions.includes('costs.view');
  return (
    <section className="card">
      <h2>Articles préparés en stock</h2>
      <p className="muted">Ce qui est prêt à la vente. Le soir, enregistrez les invendus : ils sortent du stock et leur coût compte comme une perte.</p>
      <ErrorBox error={error} />
      {data && data.items.length === 0 && <p className="muted">Aucun article « préparé à l'avance ». Créez-en dans l'onglet Articles.</p>}
      {data && data.items.length > 0 && (
        <div className="table-wrap"><table className="responsive"><thead><tr><th>Article</th><th>En stock</th><th>Dernière production</th>{costs && <th>Coût unitaire</th>}{costs && <th>Valeur</th>}<th /></tr></thead><tbody>
          {data.items.map((b) => (
            <tr key={b.id}><td><strong>{b.name}</strong></td><td className={b.balance < 0 ? 'neg' : ''}>{b.balance}</td><td>{b.last_produced ? fmtDT(b.last_produced) : '—'}</td>
              {costs && <td>{eurReal(b.unit_cost)}</td>}{costs && <td>{eurReal(b.value)}</td>}
              <td className="right"><button onClick={() => setLoss(b)} disabled={b.balance <= 0}>Invendu / perte</button><button onClick={() => setCount(b)}>Compter</button></td></tr>
          ))}</tbody></table></div>
      )}
      {loss && <LossModal item={loss} reasons={data.reasons ?? REASONS} onClose={() => setLoss(null)} onDone={() => { load(); onDone(); }} />}
      {count && <CountModal item={count} onClose={() => setCount(null)} onDone={() => { load(); onDone(); }} />}
    </section>
  );
}

function History({ me, version, onDone }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [reason, setReason] = useState('');
  const { busy, error, setError, run } = useAsync();
  const load = useCallback(() => api.get('/api/productions').then(setData).catch((e) => setError(e.message)), []); // eslint-disable-line
  useEffect(() => { load(); }, [load, version]);
  return (
    <section className="card">
      <h2>Historique des productions</h2>
      <ErrorBox error={error} />
      {data && data.items.length === 0 && <p className="muted">Aucune production.</p>}
      {data && data.items.length > 0 && (
        <div className="table-wrap"><table className="responsive"><thead><tr><th>N°</th><th>Date</th><th>Recette</th><th>Personnes</th><th>Obtenu</th>{data.can.costs && <th>Coût réel</th>}<th>Par</th><th /></tr></thead><tbody>
          {data.items.map((p) => (
            <tr key={p.id} className={p.voided_at ? 'off' : ''}>
              <td><strong>{p.number}</strong>{p.voided_at && <span className="badge warn">annulée</span>}</td><td>{fmtDT(p.ts)}</td><td>{p.recipe_name}{p.product_name ? <div className="muted small">→ {p.product_name}</div> : null}</td>
              <td>{nfmt.format(p.servings)}</td><td>{nfmt.format(p.qty_obtained)}</td>{data.can.costs && <td>{eurReal(p.cost_total)}</td>}<td>{p.user_name}</td>
              <td className="right"><button onClick={() => setOpen(p.id)}>Détail</button>{data.can.void && !p.voided_at && <button onClick={() => { setVoiding(p); setReason(''); }}>Annuler</button>}</td>
            </tr>
          ))}</tbody></table></div>
      )}
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
      {voiding && (
        <Modal title={`Annuler la production ${voiding.number}`} onClose={() => setVoiding(null)}>
          <p className="muted">Les ingrédients sont remis en stock au prix d'origine et les articles obtenus sont retirés. Impossible si une partie est déjà vendue.</p>
          <ErrorBox error={error} />
          <Field label="Motif (obligatoire)"><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
          <div className="actions"><button onClick={() => setVoiding(null)}>Retour</button><button className="danger" disabled={busy || !reason.trim()} onClick={() => run(async () => { await api.post(`/api/productions/${voiding.id}/void`, { reason }); setVoiding(null); load(); onDone(); })}>Annuler la production</button></div>
        </Modal>
      )}
    </section>
  );
}

function Detail({ id, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/api/productions/${id}`).then(setD).catch(() => {}); }, [id]);
  return (
    <Modal title={d ? `Production ${d.number}` : 'Production'} onClose={onClose} wide>
      {d && (
        <>
          <p className="muted">{d.recipe_name} (version {d.recipe_version}) · {nfmt.format(d.servings)} personnes · {fmtDT(d.ts)} · {d.user_name}</p>
          {d.voided_at && <Notice tone="warn">Annulée par {d.voided_by} : {d.void_reason}</Notice>}
          {d.note && <p>Note : {d.note}</p>}
          <div className="table-wrap"><table className="responsive"><thead><tr><th>Ingrédient</th><th>Prévu</th><th>Utilisé</th>{d.lines[0]?.value !== undefined && <th>Valeur</th>}</tr></thead><tbody>
            {d.lines.map((l) => <tr key={l.ingredient_id}><td>{l.name}</td><td>{l.plannedText}</td><td className={l.differs ? 'neg' : ''}>{l.usedText}</td>{l.value !== undefined && <td>{eurReal(l.value)}</td>}</tr>)}
          </tbody></table></div>
          {d.cost_total != null && <p>Coût réel total : <strong>{eurReal(d.cost_total)}</strong>{d.qty_obtained > 0 && <> · {eurReal(d.unit_cost)} l'unité ({nfmt.format(d.qty_obtained)} obtenus)</>}</p>}
        </>
      )}
    </Modal>
  );
}

export default function Kitchen({ me }) {
  const [sub, setSub] = useState('produce');
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  return (
    <div>
      <div className="subtabs">
        <button className={sub === 'produce' ? 'active' : ''} onClick={() => setSub('produce')}>Produire</button>
        <button className={sub === 'batches' ? 'active' : ''} onClick={() => setSub('batches')}>Articles en stock</button>
        <button className={sub === 'history' ? 'active' : ''} onClick={() => setSub('history')}>Historique</button>
      </div>
      {sub === 'produce' && <Produce me={me} onDone={bump} />}
      {sub === 'batches' && <Batches me={me} version={version} onDone={bump} />}
      {sub === 'history' && <History me={me} version={version} onDone={bump} />}
    </div>
  );
}
