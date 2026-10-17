# Boutique — version 1.1

Gestion de snack / traiteur : **étapes 1 à 9** livrées ensemble — socle (comptes, rôles, journal), ingrédients et stock, recettes, production et coûts, articles et caisse (hors-ligne), promotions et fidélité, clients et fournisseurs, traiteur, gestion (profit réel, exports PDF et Excel). Voir la section « Étapes 4 à 9 » plus bas.

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

## Ce que fait l'étape 3 (recettes)

- **Fiches recettes** : ingrédients avec quantité dans l'unité de votre choix (g, cuillères, tasses, pièces, sacs…), nombre de personnes pour lequel la recette est écrite, temps de préparation et de cuisson, étapes, notes. Une recette ne contient que des ingrédients (pas de sous-recettes).
- **Ingrédients pas encore dans votre liste** : une recette intéressante peut être enregistrée même si vous n'avez pas encore créé tous ses ingrédients (choix « ➕ Pas dans ma liste » : nom, quantité et unité libres). Elle se range directement dans l'archive. Ces lignes sont signalées partout (« pas dans vos ingrédients », « à créer »), comptées comme « coût incomplet », et se calculent pour N personnes comme les autres. Quand l'ingrédient est créé dans Stock, on le choisit dans la liste en modifiant la recette.
- **À l'ouverture d'une recette** (archive ou non) : pour N personnes, un bandeau dit si tout est en stock ou liste ce qu'il faut acheter avant de produire (emballages entiers, ingrédients pas encore créés compris).
- **Versions** : chaque modification du contenu crée une nouvelle version (qui, quand, pourquoi) ; les anciennes restent consultables et ne se modifient jamais. « Revenir à celle-ci » crée une nouvelle version identique, rien n'est effacé. Si deux appareils modifient en même temps, le second est prévenu au lieu d'écraser.
- **Calcul pour N personnes** : quantités proportionnelles, dans l'unité saisie, avec la quantité à sortir du stock quand l'ingrédient a une perte (rendement). Case « comparer au stock » : en stock, à acheter, en emballages entiers. Ce calcul n'écrit rien dans le stock (la production vient à l'étape 4).
- **Coûts** (propriétaire et gérant seulement) : coût moyen pondéré actuel du stock, rendement compris, total et par personne ; un ingrédient sans prix d'achat est signalé (« coût incomplet »). Le cuisinier voit les recettes sans aucun coût.
- **Archive** : une recette archivée sort de la liste de travail mais reste consultable, calculable, modifiable (on la complète au fil du temps), avec ses photos, et restaurable. On peut créer une recette directement dans l'archive.
- **Photos** : 8 par recette, réduites automatiquement sur l'appareil (1280 px, environ 100 à 300 ko). Elles sont stockées à part de la base (un fichier par photo) sur le serveur et dans Supabase : elles ne ralentissent pas la copie de la base.
- **Impression / PDF** : bouton sur la fiche (la signature KAB figure en bas à droite de chaque page). Choisissez « Enregistrer au format PDF » dans la fenêtre d'impression.
- **Signature « KAB »** : en bas à droite de tous les écrans et de toutes les pages imprimées, police Comic Sans MS (Windows, Mac, iPhone) ; sur Android, où cette police n'existe pas, une police voisine (Comic Neue) est fournie avec l'application.

## Hypothèses et limites propres à l'étape 2

- **Dates limites** : le stock consommé est supposé sortir d'abord des lots les plus anciens (premier entré, premier sorti). Si vous prenez un lot récent avant un ancien, l'alerte de péremption peut être inexacte.
- **Prix complété après coup** : il réévalue seulement la part du lot encore en stock ; ce qui a déjà été consommé garde l'ancien coût moyen (approximation assumée, tracée dans le journal).
- **Liste de courses en emballages** : le calcul existe côté serveur (14 g de levure → 4 sachets → 1 paquet) ; l'écran viendra avec les recettes et le traiteur.
- Les repères pré-remplis (1 tasse de farine ≈ 120 g…) sont des moyennes : pesez une fois vos produits.
- Les montants sont en euros ; le coût est calculé par gramme, millilitre ou pièce et affiché par kg, litre ou pièce.

## Tests

`npm test` : 69 tests automatiques. Étape 3 : versions immuables (même en SQL), conflit de version, coûts avec rendement, aucun coût pour le cuisinier, calcul N personnes, photos en ligne et rapatriement, photos d'une autre recette inaccessibles. Étape 2 : coût moyen égal au calcul fait à la main, conversion impossible refusée, stock = somme du journal, cuisinier sans aucun prix, journal infalsifiable, migration depuis l'étape 1. Étape 1 : les critères de réception (caissier sans accès au stock,
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

## Étapes 4 à 9 (version 1.0)

Argent : en **centimes entiers** partout (ventes, paiements, ardoises). Les coûts d'ingrédients sont en euros (décimaux). Numérotation : `V20261008-0001` ventes (par jour), `A…` remboursements, `Z-0001` clôtures, `P-00001` productions, `BC-0001` bons de commande, `T-0001` traiteur.

- **Production** : la recette produit N portions ; coût réel calculé au coût moyen pondéré, stock d'ingrédients décrémenté, lot d'articles préparés créé. Quantités réellement utilisées modifiables ; annulation possible tant que rien n'a été vendu du lot ; pertes/invendus et comptage avec motif.
- **Articles** : *préparé à l'avance* (lot), *à la minute* (consomme les ingrédients de la recette à la vente), *revendu* (ex. canette), *libre* (sans stock). Une vente n'est **jamais bloquée** par le stock : un stock négatif est signalé (`stock_negative`).
- **Caisse** : paiements multiples (espèces avec rendu, carte, ardoise, bon…), ventes idempotentes (`client_uuid`), changement de prix pendant la vente = erreur 409 `price_changed`. **Hors-ligne** : la vente est gardée dans l'appareil (ticket provisoire `H…`), envoyée toute seule au retour du réseau, au prix montré au client ; l'écart éventuel est absorbé par la boutique et signalé (`offline_gap`). Hors-ligne, seule la caisse est disponible.
- **Remboursement** = annulation **totale** d'une vente (pas de remboursement partiel) ; une seule fois par vente ; un caissier ne peut annuler que sa propre vente du jour, avant clôture.
- **Clôture Z** : attendu = fond de caisse + espèces nettes + mouvements de caisse ; un écart exige une note ; le fond du lendemain = fond laissé.
- **Promotions** (moteur commun serveur/client) : 2 achetés = 1 offert (le moins cher du groupe), lot à prix fixe (les unités les moins chères, jamais négatif), pourcentage, montant (par article). Une seule promotion par unité, la plus avantageuse pour le client. Remise manuelle réservée au droit `promotions.manage`. Fidélité : tampons par tranche de dépense, récompense plafonnée au total.
- **Clients / ardoise** : limite de crédit, encaissement de dettes (espèces = mouvement de caisse). **Fournisseurs** : bons de commande, réception (met à jour le stock et le coût moyen), dettes et paiements.
- **Traiteur** : devis → confirmé → préparé → livré (ou annulé), acomptes, liste de courses, lien avec la production.
- **Gestion** : profit réel = marge des ventes (HT − coût) + marge du traiteur livré − dépenses − pertes. Les achats ne comptent pas (ils entrent dans le coût à la vente). Export Excel (`.xlsx`, sans dépendance) et impression PDF.
- Frontières de clôture déterminées par l'identifiant de vente (pas par l'heure).

Tests : `npm test`.

## Mettre à jour une installation en ligne

`MISE-EN-LIGNE.bat` : envoie le programme sur GitHub, puis demande la clé API Render (à coller **dans la fenêtre noire seulement**), relance le déploiement sans toucher aux clés Supabase, attend « live » et **vérifie que la version en ligne est la bonne (1.1.0)**.

## Version 1.1 : commandes envoyées à la cuisine, avec sons et notifications

- **Prendre une commande** (Caisse → « Envoyer en cuisine ») : on choisit une table ou un nom de client (« Table 4 », « Mme Diallo »), une remarque facultative, puis **« Envoyer (payer plus tard) »** ou **« Envoyer et payer maintenant »**. Plusieurs envois pour la même table s'additionnent.
- **Écran « Commandes »** (cuisine et salle, mis à jour toutes les 4 secondes) : colonnes Nouvelles / En préparation / Prêtes à servir. La cuisine touche « Je prépare » puis « ✓ Prête » ; la personne de salle touche « Servie ✓ ». Une carte devient orange après 15 minutes d'attente.
- **Sons** (application ouverte) : nouvelle commande = sonnerie qui se répète toutes les 8 s jusqu'à « Je prépare » ; commande prête = mélodie chez la personne qui l'a prise, répétée toutes les 20 s jusqu'à « Servie ». Le navigateur exige un toucher de l'écran après chaque ouverture (bandeau « Touchez ici pour activer le son »).
- **Notifications du téléphone** (Web Push, standard du navigateur), même écran verrouillé et application fermée : nouvelle commande → comptes cuisine (cuisinier, gérant, propriétaire), sauf l'auteur ; commande prête → **la personne qui a pris la commande** (si elle n'a aucun appareil abonné : tous les comptes de salle) ; commande annulée → cuisine. Chaque appareil s'abonne lui-même : Mon compte → « Activer les notifications ». Les clés (VAPID) sont créées automatiquement et gardées dans la base (table `server_secrets`, jamais envoyées au navigateur). **iPhone/iPad** : l'application doit d'abord être ajoutée à l'écran d'accueil (Safari → Partager).
- **Additions ouvertes** (Caisse → « 📋 Additions ouvertes ») : toutes les commandes non payées d'une même table ; « Encaisser cette addition » remplit le panier ; la vente rattache les commandes (`order_ids`). Une addition ne peut pas être encaissée deux fois (409 `order_paid`), ni si une commande a été annulée entre-temps (409 `order_cancelled`) : dans ces cas rien n'est enregistré.
- **Stock** : une commande ne touche pas au stock ; le stock et le coût sont comptés à l'encaissement, comme avant.
- **Articles « pas pour la cuisine »** (case dans la fiche article ; coché par défaut sauf « revendu tel quel ») : ils figurent sur l'addition mais pas sur l'écran cuisine ; une commande sans aucun article de cuisine est directement « servie » et ne notifie personne.
- **Annulation** : le serveur peut annuler sa propre commande tant que la cuisine n'a pas commencé ; ensuite seulement le gérant / propriétaire, avec un motif (écrit dans le journal). Une commande déjà encaissée se corrige par un remboursement.
- **Limites connues** : envoi de commande et additions nécessitent le réseau (la caisse hors-ligne reste possible pour les ventes directes). Les notifications dépendent du service de notification du téléphone (Google/Apple) et peuvent arriver avec du retard ; le plus fiable reste un téléphone/tablette de cuisine branché, écran allumé, sur l'onglet Commandes (cela évite aussi que le serveur gratuit de Render s'endorme). Un test de notification réel n'a pas pu être fait depuis l'environnement de développement : bouton « Envoyer un test » dans Mon compte.
- Nouveaux droits : `orders.view` (tous), `orders.take` / `orders.serve` (propriétaire, gérant, caissier), `orders.kitchen` (propriétaire, gérant, cuisinier), `orders.cancel_any` (propriétaire, gérant).

## Version 1.2 : quart de caisse et comptes gérés par l'administrateur

- **Quart de caisse** : pour encaisser, il faut avoir ouvert son quart (Caisse → on compte le tiroir et on tape son code). Un seul quart peut être ouvert à la fois. Le caissier qui part ferme son quart (Ventes → « Fermer mon quart »), compte le tiroir, laisse un fond de caisse et tape son code. Le suivant ouvre le sien avec son propre code et vérifie le fond laissé ; en cas d'écart, une explication est obligatoire.
- **Sorties / entrées d'espèces** : un motif (liste) et une note sont obligatoires. Elles sont reprises sur la clôture imprimée.
- **Fermeture forcée** : le patron ou le gérant peut fermer le quart de quelqu'un d'absent (note obligatoire).
- **Ventes hors ligne** : si elles sont rejouées après la fermeture, les espèces sont comptées à part (« espèces tardives »).
- Réglage `Quart de caisse obligatoire` (1 par défaut).
- **Comptes** : le nom et le code PIN de chaque employé sont créés par l'administrateur uniquement, sans code provisoire, et l'employé ne peut pas le changer (réglage `self_pin_change`, 0 par défaut). L'administrateur peut redonner un code à tout moment.

## Version 1.3 : fermeture « à l'aveugle », versements, vérification par l'administrateur

- **Le caissier ne voit aucun total** (ventes, espèces, carte, montant attendu, écart). À la fermeture il compte le tiroir, indique le **fond de caisse laissé** et **l'argent versé** (tout le reste), tape son code. Il n'a pas à expliquer d'écart : il ne le connaît pas.
- **Versements en cours de quart** : quand l'administrateur le demande (ou de lui-même), le caissier retire des espèces et saisit seulement le montant : « Versement 1 », « Versement 2 »… Ils sont enregistrés, datés, numérotés par quart, et déduits de l'attendu.
- **Onglet « Vérif. caisses »** (propriétaire et gérant) : 
  - *Caisse en cours* : espèces attendues dans le tiroir en ce moment, ventes espèces/carte, versements déjà faits, alerte au-delà du seuil (réglage « Seuil d’espèces », 300 € par défaut) et bouton **Demander un versement** (le caissier voit un bandeau, et une notification s'il les a activées).
  - *Par jour* : chaque quart avec attendu, compté, écart, total versé, et le total du jour. **Valider cette caisse** (note obligatoire s'il y a un écart). Une validation ne se modifie plus et est écrite au journal. Un gérant ne valide pas sa propre caisse : le propriétaire le fait.
- Le gérant ou le propriétaire qui ferme un quart voit l'écart et doit l'expliquer (comme avant).
- Les clôtures passées et le détail des ventes par jour ne sont plus accessibles au caissier. Sa liste « Mes ventes » n'affiche plus les montants.
- Comptes : nom et code PIN créés par l'administrateur uniquement (réglage `self_pin_change`, 0 par défaut).
- **Seuil automatique** : quand les espèces du tiroir (hors fond de caisse du départ) dépassent le seuil réglé, le caissier reçoit tout de suite un bandeau et une notification « versez <seuil> € » (sans voir aucun total), puis un rappel toutes les 10 minutes tant qu'il n'a pas versé. La caisse n'est jamais bloquée. Seuil à 0 = désactivé.

## Version 1.4 : commandes depuis chaque téléphone, rôle Serveur, additions et ardoise

- **Commandes depuis n'importe quel téléphone** : onglet « Commandes » → « ＋ Nouvelle commande » (menu, quantités, remarque par article, table ou nom du client). La commande part tout de suite en cuisine (son + notification), sans passer par la caisse et **sans quart ouvert**. Elle reste utilisable depuis la Caisse comme avant.
- **Nouveau rôle « Serveur »** (créé par le propriétaire dans Comptes) : prend et sert les commandes, voit le menu, rien d'autre (ni caisse, ni espèces, ni clients, ni clôtures). Un caissier ou un gérant peut aussi prendre des commandes de son téléphone.
- **Le paiement se fait uniquement à la caisse** : « Additions ouvertes », chercher par numéro de table ou nom du client, voir le total, encaisser.
- **Clients à crédit (ardoise)** : si le nom de l'addition est celui d'un client enregistré (un seul), la caisse montre son ardoise et sa limite, et le sélectionne automatiquement : on peut payer l'addition en espèces/carte ou la mettre sur son ardoise (limite fixée par le gérant). Les règlements se font dans « Clients », avec relevé de compte imprimable.
- Mise à jour d'une base existante : la migration 13 autorise le rôle Serveur sans toucher aux données.
- **Plusieurs additions d'un coup** (v1.4.1) : dans « Additions ouvertes », cochez « Regrouper » sur Table 4, Table 1… puis « Encaisser le tout » : une seule vente. Choisissez le client, puis « 📒 Tout mettre sur l'ardoise du client ». La limite d'ardoise est vérifiée ; si elle est dépassée, rien n'est enregistré et les additions restent ouvertes.
- **Remise spéciale autorisée par le gérant** (v1.4.2) : seul le gérant ou le propriétaire peut accorder une remise libre. Le caissier touche « Remise (accord gérant) », saisit le montant et le motif, et le gérant choisit son nom et tape SON code sur cet appareil. Le code est vérifié tout de suite (5 erreurs = blocage 60 s). La vente enregistre qui a demandé (le caissier), qui a autorisé (le gérant) et le motif ; c'est dans le journal et dans le détail de la vente. Impossible sans réseau.
