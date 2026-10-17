import React from 'react';

const SHORTCUTS = [
  ['pos', '🛒 Caisse', 'Vendre, encaisser, imprimer le ticket (marche sans réseau)', 'pos.sell'],
  ['orders', '🍽 Commandes', 'Commandes envoyées en cuisine, « prête », à servir', 'orders.view'],
  ['sales', '🧾 Ventes et clôture', 'Ventes du jour, annulation, clôture de caisse', 'sales.view_own'],
  ['kitchen', '👩‍🍳 Cuisine', 'Produire, articles prêts, invendus et pertes', 'production.do'],
  ['recipes', '📖 Recettes', 'Fiches, photos, archive, calcul pour N personnes', 'recipes.view'],
  ['stock', '📦 Stock', 'Ingrédients, réceptions, pertes, inventaire', 'stock.view'],
  ['products', '🏷 Articles', 'Ce qui est en vente et à quel prix', 'products.edit'],
  ['catering', '🎉 Traiteur', 'Commandes, devis, acomptes, liste de courses', 'catering.view'],
  ['customers', '👥 Clients', 'Ardoises, règlements, tampons de fidélité', 'customers.view'],
  ['suppliers', '🚚 Fournisseurs', 'Bons de commande, réceptions, dettes', 'purchasing.manage'],
  ['promotions', '🎁 Promotions', '2 achetés 1 offert, lots, fidélité', 'promotions.manage'],
  ['management', '📊 Gestion', 'Résultat réel, statistiques, dépenses, export Excel', 'stats.view'],
];

export default function Home({ me, go }) {
  const mine = SHORTCUTS.filter((s) => me.permissions.includes(s[3]));
  return (
    <div className="stack">
      <section className="card">
        <h1>Bonjour {me.name}</h1>
        <p className="muted">Choisissez ce que vous voulez faire.</p>
        <div className="tiles">
          {mine.map(([id, t, d]) => (
            <button key={id} className="tile card" onClick={() => go(id)}><strong>{t}</strong><span>{d}</span></button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>À savoir</h2>
        <ul className="tobuy">
          <li>Tout ce qui touche à l'argent et au stock est écrit dans un journal qu'on ne peut ni modifier ni effacer : une erreur se corrige par une annulation, jamais en effaçant.</li>
          <li>Les montants des ventes sont calculés au centime ; le prix de revient vient du coût réel des ingrédients achetés.</li>
          <li>Commandes : on les envoie en cuisine depuis la Caisse (« Envoyer en cuisine »), la cuisine sonne, puis la personne qui a pris la commande est prévenue quand elle est prête. L'addition se règle à la fin du repas ou tout de suite.</li>
          <li>Sans réseau, la caisse continue : les ventes sont gardées dans l'appareil et envoyées toutes seules au retour du réseau.</li>
        </ul>
      </section>
    </div>
  );
}
