import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Field, ErrorBox, Notice, useAsync } from '../ui.jsx';
import { eur } from '../money.js';

const PHRASE = 'REMETTRE A ZERO';
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

/** Fin de la période de test : remise à zéro des ventes, de la caisse et des soldes clients (propriétaire seulement). */
export default function Reset() {
  const [pv, setPv] = useState(null);
  const [expenses, setExpenses] = useState(true);
  const [catering, setCatering] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [pin, setPin] = useState('');
  const [done, setDone] = useState(null);
  const { busy, error, setError, run } = useAsync();
  useEffect(() => { api.get('/api/reset/preview').then(setPv).catch((e) => setError(e.message)); }, [setError]);

  const ready = norm(phrase) === PHRASE && pin.length >= 4;
  const go = (e) => {
    e.preventDefault();
    if (!window.confirm('Dernière question : effacer définitivement les ventes, la caisse et les soldes clients ?')) return;
    run(async () => { const r = await api.post('/api/reset', { pin, phrase, expenses, catering }); setDone(r); });
  };

  if (done) {
    return (
      <section className="card">
        <h2>✓ Remise à zéro faite</h2>
        <Notice tone="info">Les ventes, la caisse et les soldes clients sont à zéro. Vous pouvez commencer l'activité : le premier quart de caisse sera le n° 1.</Notice>
        <p className="muted">Une copie de sécurité d'avant la remise à zéro a été gardée (« {done.backup} »). Elle se trouve dans Administration › Sauvegardes.</p>
        <button className="primary" onClick={() => { window.location.href = '/'; }}>Retourner à l'accueil</button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Remise à zéro (fin de la période de test)</h2>
      <p className="muted">À faire une seule fois, juste avant de commencer l'activité réelle. Une copie de sécurité est faite automatiquement avant d'effacer.</p>
      <ErrorBox error={error} />
      {!pv && !error && <p className="muted">Chargement…</p>}
      {pv && (
        <>
          <div className="alert warn">
            <strong>Sera effacé définitivement :</strong>
            <ul>
              <li>{plural(pv.sales, 'vente', 'ventes')} (chiffre d'affaires : {eur(pv.sales_cents)}) et tous les chiffres qui en dépendent</li>
              <li>{plural(pv.shifts, 'quart de caisse', 'quarts de caisse')}, {plural(pv.closures, 'clôture', 'clôtures')} et {plural(pv.cash_moves, 'mouvement de caisse', 'mouvements de caisse')} (versements compris)</li>
              <li>Les soldes et ardoises des clients ({plural(pv.customers_with_balance, 'client doit', 'clients doivent')} {eur(pv.balances_cents)}) et les tampons de fidélité</li>
              <li>{plural(pv.orders, 'commande envoyée en cuisine', 'commandes envoyées en cuisine')}</li>
            </ul>
          </div>
          <div className="alert info">
            <strong>Sera conservé :</strong> vos {plural(pv.kept.ingredients, 'ingrédient', 'ingrédients')} et leur stock, {plural(pv.kept.recipes, 'recette', 'recettes')} (dont {plural(pv.kept.recipes_archived, 'archivée', 'archivées')}), {plural(pv.kept.products, 'article', 'articles')}, les catégories, les fournisseurs, les promotions, {plural(pv.customers, 'fiche client', 'fiches clients')} (noms, téléphones, plafonds), {plural(pv.kept.users, 'compte du personnel', 'comptes du personnel')}, les réglages et le journal.
          </div>
          <h3>En option</h3>
          <label className="check"><input type="checkbox" checked={expenses} onChange={(e) => setExpenses(e.target.checked)} /> Effacer aussi les dépenses saisies ({pv.expenses})</label>
          <label className="check"><input type="checkbox" checked={catering} onChange={(e) => setCatering(e.target.checked)} /> Effacer aussi les commandes traiteur et leurs acomptes ({pv.catering_orders})</label>
          <Notice tone="warn">Le stock n'est pas modifié. Si vos essais ont fait baisser des quantités, refaites un inventaire (Cuisine et stock › Stock › Inventaire).</Notice>
          <form onSubmit={go}>
            <Field label={`Pour confirmer, écrivez : ${PHRASE}`}>
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" placeholder={PHRASE} />
            </Field>
            <Field label="Votre code PIN">
              <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))} />
            </Field>
            <button className="danger" disabled={!ready || busy}>Tout remettre à zéro</button>
          </form>
        </>
      )}
    </section>
  );
}
