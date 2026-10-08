# Boutique — étape 2 : ingrédients, achats, stock

Gestion de snack / traiteur. Cette livraison contient les **étapes 1 et 2** du plan validé :
socle (comptes, rôles, journal des actions, réglages, sauvegardes) puis ingrédients, réceptions, stock.
Les étapes suivantes (recettes, production, caisse…) ne sont volontairement pas là : chacune sera livrée après votre accord.

## Mise en ligne gratuite (tablette, téléphone, n'importe où)

Voir `METTRE-EN-LIGNE.txt` : `MISE-EN-LIGNE.bat` fait tout (GitHub via `gh`, vérification Supabase, création du service Render par l'API ; client Render testé avec un faux Render, GitHub/Render réels non testés) ; procédure manuelle en secours. Technique : si `SUPABASE_URL` et `SUPABASE_SERVICE_KEY` sont définis, `server/cloud.js` rapatrie la dernière copie de la base au démarrage puis la copie après chaque écriture dans Supabase Storage (copies numérotées, jamais écrasées, garde-fou contre deux serveurs simultanés). Testé avec une imitation de Supabase (8 tests) ; **non testé contre un vrai Supabase** : l'état s'affiche dans l'onglet Sauvegardes.

## Installation sous Windows (prêt à l'emploi)

Voir `LISEZ-MOI.txt` : double-clic sur `1-INSTALLER.bat` une fois, puis icône « Boutique » sur le Bureau (démarrage automatique avec Windows en option).

## Mise à jour depuis l'étape 1

Arrêtez le serveur (Ctrl+C), copiez les fichiers de cette livraison **par-dessus** le dossier `C:\boutique`
(sans toucher au dossier `data`), puis :

```
npm install --omit=dev
npm start
```

Vos comptes, réglages et sauvegardes sont conservés ; la base est mise à niveau automatiquement au démarrage
(une copie de sécurité `avant-mise-a-niveau-v1.db` est faite dans le dossier `data` juste avant). Rechargez la page dans le navigateur.

## Démarrer

Il faut Node.js 22.13 ou plus récent.

```
npm install --omit=dev
npm start
```

Puis ouvrir http://localhost:3000. Au premier lancement, l'écran d'installation demande le nom du commerce,
votre nom et un code PIN : vous devenez propriétaire. Les données sont rangées dans le dossier `data/`
(base `boutique.db`, copies dans `data/sauvegardes/`).

Variables facultatives : `PORT` (3000), `DATA_DIR` (dossier des données), `TRUST_PROXY` (si le serveur est
derrière un relais HTTPS, par exemple `1`).

Pour modifier l'interface : `npm install`, puis `npm run build` (le résultat va dans `dist/`).

## Droits (propriétaire / gérant / caissier / cuisinier)

La matrice complète est dans `server/permissions.js`, c'est la seule référence. Le serveur refuse l'accès,
l'interface ne fait que masquer les boutons. Choix à confirmer : le gérant peut **lire** le journal des actions
(le document disait « tout sauf réglages et comptes »).

## Ce que fait cette étape

- Connexion par nom + code PIN (4 à 8 chiffres, suites simples refusées), PIN haché (scrypt), jamais écrit en clair ni dans le journal.
- 5 erreurs : compte bloqué 60 secondes. Un compte désactivé garde son historique. Le dernier propriétaire ne peut pas être retiré.
- Un compte créé ou réinitialisé reçoit un code provisoire à changer à la première connexion.
- Déconnexion automatique après inactivité (12 h par défaut, réglable).
- Journal des actions : qui, quand, quoi, avant/après. Lecture seule (même en SQL) et chaîné par empreintes : une ligne modifiée ou retirée est détectée par « Vérifier l'intégrité ».
- Réglages : commerce, adresse, logo, monnaie, fuseau horaire (Indian/Mayotte par défaut), TVA et marge par défaut, durée de session, nombre de sauvegardes.
- Sauvegarde automatique chaque jour (jour du fuseau du commerce), manuelle à la demande, téléchargement, import, restauration avec copie de sécurité préalable. Chaque fichier est contrôlé à la création et avant restauration.
- Application installable (PWA) ; la coquille s'ouvre sans réseau. La caisse hors-ligne arrive à l'étape 5.

## Ce que fait l'étape 2

- **Ingrédients** : on les compte en poids, en volume ou à la pièce. Conditionnement en chaîne (ex. lot de 3 paquets > paquet de 4 sachets > sachet de 4 g), niveau d'achat, équivalences en mesures propres à chaque ingrédient (1 tasse de farine ≠ 1 tasse de sucre), densité, poids d'une pièce, rendement, seuil d'alerte, lieu de stockage. Bouton « Pré-remplir avec les repères » (moyennes à vérifier).
- **Une conversion impossible est refusée** avec une explication (ex. passer de cuillères à des grammes sans connaître l'équivalence), jamais un chiffre approximatif.
- **Mesures générales** (Réglages) : cuillère à café, à soupe, tasse, pincée modifiables ; bouton « Ajouter une mesure ».
- **Réception** de marchandises, plusieurs lignes à la fois (tout ou rien), prix total payé, date limite facultative. **Coût moyen pondéré** recalculé à chaque achat.
- **Cuisinier** : reçoit la marchandise sans voir ni saisir de prix ; le gérant complète le prix ensuite (onglet « Prix à compléter »).
- **Pertes** avec motif obligatoire (périmé, cassé, jeté, donné, repas du personnel, autre) ; jamais plus que le stock.
- **Inventaire guidé** : comptage en emballages mélangés, aperçu des écarts, puis validation ; les écarts deviennent des mouvements.
- **Journal de stock** : le stock est toujours la somme des mouvements ; lecture seule (même en SQL). Une erreur se corrige par un nouveau mouvement.
- **Alertes** : stock bas ou vide, lots proche de la date limite, hausse de prix (seuil réglable, 10 % par défaut), prix à compléter.
- Pas d'allergènes (selon votre choix). Le café en capsules est un ingrédient compté à la pièce ; les produits revendus tels quels (canettes, bouteilles) viendront avec les produits (étape 5).

## Hypothèses et limites propres à l'étape 2

- **Dates limites** : le stock consommé est supposé sortir d'abord des lots les plus anciens (premier entré, premier sorti). Si vous prenez un lot récent avant un ancien, l'alerte de péremption peut être inexacte.
- **Prix complété après coup** : il réévalue seulement la part du lot encore en stock ; ce qui a déjà été consommé garde l'ancien coût moyen (approximation assumée, tracée dans le journal).
- **Liste de courses en emballages** : le calcul existe côté serveur (14 g de levure → 4 sachets → 1 paquet) ; l'écran viendra avec les recettes et le traiteur.
- Les repères pré-remplis (1 tasse de farine ≈ 120 g…) sont des moyennes : pesez une fois vos produits.
- Les montants sont en euros ; le coût est calculé par gramme, millilitre ou pièce et affiché par kg, litre ou pièce.

## Tests

`npm test` : 47 tests automatiques. Étape 2 : coût moyen égal au calcul fait à la main, conversion impossible refusée, stock = somme du journal, cuisinier sans aucun prix, journal infalsifiable, migration depuis l'étape 1. Étape 1 : les critères de réception (caissier sans accès au stock,
journal complet et infalsifiable, sauvegarde restaurable) et sur les cas limites (blocage, sessions, import
piégé, redémarrage…). Les parcours d'écran ont été joués dans un navigateur réel.

## Limites connues, dites franchement

- **Les sauvegardes sont sur le même serveur que la base.** Si le serveur disparaît, elles aussi. Téléchargez
  régulièrement une copie ailleurs. Une copie automatique hors serveur dépend de l'hébergement choisi (décision 10).
- **HTTPS** n'est pas fait par l'application : il vient de l'hébergement ou d'un relais devant elle.
- **Un PIN de 4 à 8 chiffres reste faible** si quelqu'un obtient le fichier de base lui-même (le blocage ne protège que les connexions
  par l'application). Protégez l'accès au serveur et aux sauvegardes.
- Le chaînage du journal détecte une falsification ; il ne peut pas empêcher une personne qui a tout le fichier de recalculer toute la chaîne.
  La copie du journal dans les sauvegardes téléchargées aide à comparer.
- Quelqu'un qui connaît un nom peut bloquer son compte une minute en tapant de faux codes.
- Pas encore testé : imprimante de tickets, hébergement réel, utilisation à plusieurs appareils en même temps.
- `node:sqlite` est encore signalé « expérimental » par Node 22 (le message est masqué au démarrage) ; il est stable pour cet usage.
