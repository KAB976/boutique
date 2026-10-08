import React from 'react';

const STEPS = [
  ['1', 'Socle', 'Comptes, droits, journal des actions, réglages, sauvegardes', 'done'],
  ['2', 'Ingrédients, achats, stock', 'Unités, conditionnements, coût moyen, journal de stock, inventaire', 'done'],
  ['3', 'Recettes', 'Fiches, versions, archive, calcul pour N personnes', 'next'],
  ['4', 'Production et coûts', 'Lots, quantité obtenue, coût réel, invendus, pertes', ''],
  ['5', 'Produits, caisse, hors-ligne', 'Catalogue, ticket, annulation, clôture, mode hors-ligne', ''],
  ['6', 'Promotions et fidélité', '2 achetés 1 offert, 5 pour un prix fixe, tampons', ''],
  ['7', 'Clients et fournisseurs', 'Ardoise, bons de commande, réceptions, dettes', ''],
  ['8', 'Traiteur', 'Commandes à date, devis, acompte, liste de courses', ''],
  ['9', 'Gestion', 'Profit réel, statistiques, exports PDF et Excel', ''],
];

export default function Home({ me }) {
  return (
    <div className="stack">
      <section className="card">
        <h1>Bonjour {me.name}</h1>
        <p>Sont en place : comptes et droits, journal des actions, réglages, sauvegardes, et la gestion du stock (ingrédients, réceptions, pertes, inventaire). Les autres écrans de travail (recettes, caisse…) arrivent étape par étape, chacune livrée après votre accord.</p>
      </section>
      <section className="card">
        <h2>Avancement</h2>
        <ol className="steps">
          {STEPS.map(([n, t, d, s]) => (
            <li key={n} className={s}>
              <span className="num">{s === 'done' ? '✓' : n}</span>
              <div><strong>{t}</strong>{s === 'done' && <span className="badge ok">livrée</span>}{s === 'next' && <span className="badge">prochaine</span>}<div className="muted">{d}</div></div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
