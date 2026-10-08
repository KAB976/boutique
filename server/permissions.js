/**
 * Matrice des droits : la seule référence. Le serveur la fait respecter,
 * l'interface ne fait que l'afficher.
 * Les droits des étapes suivantes sont déjà listés pour que les rôles restent cohérents.
 */
export const ROLES = ['owner', 'manager', 'cashier', 'cook'];
export const ROLE_LABELS = { owner: 'Propriétaire', manager: 'Gérant', cashier: 'Caissier', cook: 'Cuisinier' };

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
};

export const can = (role, perm) => Boolean(PERMISSIONS[perm]?.includes(role));
export const permissionsOf = (role) => Object.keys(PERMISSIONS).filter((p) => can(role, p));
