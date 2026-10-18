/**
 * Matrice des droits : la seule référence. Le serveur la fait respecter,
 * l'interface ne fait que l'afficher.
 * Les droits des étapes suivantes sont déjà listés pour que les rôles restent cohérents.
 */
export const ROLES = ['owner', 'manager', 'cashier', 'cook', 'waiter'];
export const ROLE_LABELS = { owner: 'Propriétaire', manager: 'Gérant', cashier: 'Caissier', cook: 'Cuisinier', waiter: 'Serveur' };

const ALL = ROLES;
export const PERMISSIONS = {
  // étape 1 : socle
  'account.self':       ALL,
  'settings.read.all':  ALL,
  'settings.read.manage': ['owner', 'manager'],
  'settings.read.owner': ['owner'],
  'settings.edit':      ['owner'],
  'users.manage':       ['owner'],
  'audit.view':         ['owner', 'manager'],
  'backup.manage':      ['owner'],
  // étapes suivantes (déjà fixées par le document d'architecture)
  'pos.sell':           ['owner', 'manager', 'cashier'],
  'sales.view_own':     ['owner', 'manager', 'cashier'],
  'sales.view_all':     ['owner', 'manager'],
  'sales.void_own':     ['owner', 'manager', 'cashier'],
  'sales.void_any':     ['owner', 'manager'],
  'closure.do':         ['owner', 'manager', 'cashier'],
  'kitchen.view':       ALL,
  'stock.view':         ['owner', 'manager', 'cook'],
  'stock.move':         ['owner', 'manager', 'cook'],
  'ingredients.edit':   ['owner', 'manager'],
  'recipes.view':       ['owner', 'manager', 'cook'],
  'recipes.edit':       ['owner', 'manager'],
  'production.do':      ['owner', 'manager', 'cook'],
  'costs.view':         ['owner', 'manager'],
  'purchase_prices.view': ['owner', 'manager'],
  'purchasing.manage':  ['owner', 'manager'],
  'promotions.manage':  ['owner', 'manager'],
  'stats.view':         ['owner', 'manager'],
  // étapes 4 à 9
  'catalog.view':       ALL,
  'products.edit':      ['owner', 'manager'],
  'categories.edit':    ['owner', 'manager'],
  'customers.view':     ['owner', 'manager', 'cashier'],
  'customers.edit':     ['owner', 'manager', 'cashier'],
  'customers.credit':   ['owner', 'manager'],
  'customers.payment':  ['owner', 'manager', 'cashier'],
  'cash.move':          ['owner', 'manager', 'cashier'],
  'catering.view':      ['owner', 'manager', 'cook'],
  'catering.edit':      ['owner', 'manager'],
  'expenses.manage':    ['owner', 'manager'],
  'production.void':    ['owner', 'manager'],
  'sales.sync':         ['owner', 'manager', 'cashier'],
  // version 1.2 : quarts de caisse
  'shift.open':         ['owner', 'manager', 'cashier'],
  'shift.force_close':  ['owner', 'manager'],
  // version 1.3 : le caissier ferme « à l'aveugle », l'administrateur vérifie
  'cash.review':        ['owner', 'manager'],
  'cash.deposit':       ['owner', 'manager', 'cashier'],
  // version 1.1 : commandes envoyées à la cuisine
  'orders.view':        ALL,
  'orders.take':        ['owner', 'manager', 'cashier', 'waiter'],
  'orders.serve':       ['owner', 'manager', 'cashier', 'waiter'],
  'orders.kitchen':     ['owner', 'manager', 'cook'],
  'orders.cancel_any':  ['owner', 'manager'],
};

export const can = (role, perm) => Boolean(PERMISSIONS[perm]?.includes(role));
export const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((p) => can(role, p));
