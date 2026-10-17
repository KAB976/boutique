import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Migrations : chaque entrée n'est appliquée qu'une fois, dans l'ordre.
 * On n'édite jamais une migration déjà livrée : on en ajoute une nouvelle.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'socle',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','cook')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_pin INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pin IN (0,1)),
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_active_name ON users (lower(name)) WHERE active = 1;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_action ON audit (action);
CREATE INDEX audit_user ON audit (user_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'Le journal des actions est en lecture seule'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'Le journal des actions est en lecture seule'); END;
`,
  },
  {
    version: 2,
    name: 'ingredients-stock',
    sql: `
CREATE TABLE measures (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  ml REAL NOT NULL CHECK (ml > 0),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX measures_label ON measures (lower(label)) WHERE active = 1;
INSERT INTO measures (code, label, ml, builtin, created_at, updated_at) VALUES
  ('cc', 'cuillère à café', 5, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cs', 'cuillère à soupe', 15, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('tasse', 'tasse', 240, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('pincee', 'pincée', 0.3, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL CHECK (family IN ('mass','volume','count')),
  yield_pct REAL NOT NULL DEFAULT 100 CHECK (yield_pct > 0 AND yield_pct <= 100),
  density REAL CHECK (density IS NULL OR density > 0),
  piece_g REAL CHECK (piece_g IS NULL OR piece_g > 0),
  threshold REAL CHECK (threshold IS NULL OR threshold >= 0),
  purchase_depth INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ingredients_active_name ON ingredients (lower(name)) WHERE active = 1;
CREATE TABLE pack_levels (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  depth INTEGER NOT NULL,
  label TEXT NOT NULL,
  contains REAL NOT NULL CHECK (contains > 0),
  PRIMARY KEY (ingredient_id, depth)
);
CREATE TABLE ingredient_equivs (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  unit TEXT NOT NULL,
  base_qty REAL NOT NULL CHECK (base_qty > 0),
  PRIMARY KEY (ingredient_id, unit)
);
CREATE TABLE inventories (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  note TEXT,
  lines INTEGER NOT NULL,
  variance_value REAL NOT NULL DEFAULT 0
);
CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  type TEXT NOT NULL CHECK (type IN ('receipt','production','sale','loss','inventory','void','price_fix')),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  value REAL NOT NULL DEFAULT 0,
  stock_after REAL NOT NULL,
  avg_after REAL NOT NULL,
  expiry TEXT,
  price_pending INTEGER NOT NULL DEFAULT 0 CHECK (price_pending IN (0,1)),
  fixes_move_id INTEGER REFERENCES stock_moves(id),
  inventory_id INTEGER REFERENCES inventories(id),
  reason TEXT,
  ref TEXT,
  note TEXT,
  entered TEXT,
  user_id INTEGER,
  user_name TEXT
);
CREATE INDEX stock_moves_ing ON stock_moves (ingredient_id, id);
CREATE INDEX stock_moves_type ON stock_moves (type);
CREATE UNIQUE INDEX stock_moves_one_fix ON stock_moves (fixes_move_id) WHERE fixes_move_id IS NOT NULL;
CREATE TRIGGER stock_moves_no_update BEFORE UPDATE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'Le journal de stock est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves
BEGIN SELECT RAISE(ABORT, 'Le journal de stock est en lecture seule : on corrige par une nouvelle ligne'); END;
`,
  },
  {
    version: 3,
    name: 'recettes',
    sql: `
CREATE TABLE recipes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  archived_at TEXT,
  current_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX recipes_active_name ON recipes (lower(name)) WHERE archived = 0;
CREATE TABLE recipe_versions (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  version INTEGER NOT NULL,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  servings REAL NOT NULL CHECK (servings > 0),
  prep_min INTEGER,
  cook_min INTEGER,
  steps TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  change_note TEXT NOT NULL DEFAULT '',
  UNIQUE (recipe_id, version)
);
CREATE TABLE recipe_lines (
  version_id INTEGER NOT NULL REFERENCES recipe_versions(id),
  pos INTEGER NOT NULL,
  ingredient_id INTEGER REFERENCES ingredients(id),
  label TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL DEFAULT '',
  base REAL,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, pos),
  CHECK ((ingredient_id IS NOT NULL AND base IS NOT NULL AND base > 0) OR (ingredient_id IS NULL AND base IS NULL AND label <> ''))
);
CREATE INDEX recipe_lines_ing ON recipe_lines (ingredient_id);
CREATE TABLE recipe_photos (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  user_name TEXT
);
CREATE INDEX recipe_photos_recipe ON recipe_photos (recipe_id, pos, id);
CREATE TRIGGER recipe_versions_no_update BEFORE UPDATE ON recipe_versions
BEGIN SELECT RAISE(ABORT, 'Une version de recette ne se modifie pas : on en crée une nouvelle'); END;
CREATE TRIGGER recipe_versions_no_delete BEFORE DELETE ON recipe_versions
BEGIN SELECT RAISE(ABORT, 'Une version de recette ne se supprime pas'); END;
CREATE TRIGGER recipe_lines_no_update BEFORE UPDATE ON recipe_lines
BEGIN SELECT RAISE(ABORT, 'Une version de recette ne se modifie pas : on en crée une nouvelle'); END;
CREATE TRIGGER recipe_lines_no_delete BEFORE DELETE ON recipe_lines
BEGIN SELECT RAISE(ABORT, 'Une version de recette ne se supprime pas'); END;
`,
  },
  {
    version: 4,
    name: 'produits-production',
    sql: `
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('made','direct','resale','free')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  vat_pct REAL NOT NULL DEFAULT 0 CHECK (vat_pct >= 0 AND vat_pct <= 100),
  recipe_id INTEGER REFERENCES recipes(id),
  portions REAL CHECK (portions IS NULL OR portions > 0),
  ingredient_id INTEGER REFERENCES ingredients(id),
  ingredient_qty REAL CHECK (ingredient_qty IS NULL OR ingredient_qty > 0),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind NOT IN ('made','direct') OR recipe_id IS NOT NULL),
  CHECK (kind <> 'resale' OR (ingredient_id IS NOT NULL AND ingredient_qty IS NOT NULL))
);
CREATE INDEX products_recipe ON products (recipe_id);
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE productions (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id),
  recipe_version INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  order_id INTEGER,
  servings REAL NOT NULL CHECK (servings > 0),
  qty_obtained REAL NOT NULL CHECK (qty_obtained >= 0),
  cost_total REAL NOT NULL,
  unit_cost REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);
CREATE INDEX productions_day ON productions (day);
CREATE INDEX productions_product ON productions (product_id, id);
CREATE TABLE production_lines (
  production_id INTEGER NOT NULL REFERENCES productions(id),
  pos INTEGER NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  planned_base REAL NOT NULL,
  used_base REAL NOT NULL CHECK (used_base >= 0),
  value REAL NOT NULL,
  move_id INTEGER REFERENCES stock_moves(id),
  PRIMARY KEY (production_id, pos)
);
CREATE TABLE batch_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  production_id INTEGER REFERENCES productions(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL CHECK (type IN ('produce','sale','void','loss','adjust')),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  reason TEXT,
  ref TEXT,
  note TEXT,
  user_id INTEGER,
  user_name TEXT
);
CREATE INDEX batch_moves_product ON batch_moves (product_id, id);
CREATE INDEX batch_moves_prod ON batch_moves (production_id);
CREATE INDEX batch_moves_ref ON batch_moves (ref);
CREATE TRIGGER batch_moves_no_update BEFORE UPDATE ON batch_moves
BEGIN SELECT RAISE(ABORT, 'Le journal des produits finis est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER batch_moves_no_delete BEFORE DELETE ON batch_moves
BEGIN SELECT RAISE(ABORT, 'Le journal des produits finis est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER production_lines_no_update BEFORE UPDATE ON production_lines
BEGIN SELECT RAISE(ABORT, 'Une production enregistrée ne se modifie pas'); END;
CREATE TRIGGER production_lines_no_delete BEFORE DELETE ON production_lines
BEGIN SELECT RAISE(ABORT, 'Une production enregistrée ne se modifie pas'); END;

CREATE TRIGGER productions_no_delete BEFORE DELETE ON productions
BEGIN SELECT RAISE(ABORT, 'Une production ne se supprime pas : on l''annule'); END;
CREATE TRIGGER productions_only_void BEFORE UPDATE ON productions
WHEN NEW.id <> OLD.id OR NEW.number <> OLD.number OR NEW.ts <> OLD.ts OR NEW.recipe_id <> OLD.recipe_id OR NEW.servings <> OLD.servings
  OR NEW.qty_obtained <> OLD.qty_obtained OR NEW.cost_total <> OLD.cost_total OR NEW.unit_cost <> OLD.unit_cost OR OLD.voided_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Une production ne se modifie pas : on l''annule'); END;
`,
  },

  {
    version: 5,
    name: 'ventes-caisse',
    sql: `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  credit_limit_cents INTEGER CHECK (credit_limit_cents IS NULL OR credit_limit_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE cash_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  reason TEXT NOT NULL,
  ref TEXT,
  user_id INTEGER,
  user_name TEXT
);
CREATE TRIGGER cash_moves_no_update BEFORE UPDATE ON cash_moves
BEGIN SELECT RAISE(ABORT, 'Les mouvements de caisse sont en lecture seule'); END;
CREATE TRIGGER cash_moves_no_delete BEFORE DELETE ON cash_moves
BEGIN SELECT RAISE(ABORT, 'Les mouvements de caisse sont en lecture seule'); END;

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('sale','refund')),
  client_uuid TEXT UNIQUE,
  provisional TEXT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  received_at TEXT NOT NULL,
  offline INTEGER NOT NULL DEFAULT 0 CHECK (offline IN (0,1)),
  user_id INTEGER,
  user_name TEXT,
  customer_id INTEGER REFERENCES customers(id),
  refund_of INTEGER REFERENCES sales(id),
  void_reason TEXT,
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  change_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '[]',
  CHECK ((kind = 'refund') = (refund_of IS NOT NULL))
);
CREATE UNIQUE INDEX sales_one_refund ON sales (refund_of) WHERE refund_of IS NOT NULL;
CREATE INDEX sales_day ON sales (day);
CREATE INDEX sales_customer ON sales (customer_id);
CREATE TABLE sale_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  pos INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  vat_pct REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  promo_label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sale_lines_sale ON sale_lines (sale_id);
CREATE INDEX sale_lines_product ON sale_lines (product_id);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL CHECK (method IN ('cash','card','voucher','credit','other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  ref TEXT
);
CREATE INDEX payments_sale ON payments (sale_id);
CREATE TABLE customer_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sale','refund','payment','adjust')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  sale_id INTEGER REFERENCES sales(id),
  method TEXT,
  note TEXT,
  user_id INTEGER,
  user_name TEXT
);
CREATE INDEX customer_ledger_c ON customer_ledger (customer_id, id);
CREATE TABLE closures (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  to_sale_id INTEGER NOT NULL,
  to_cash_move_id INTEGER NOT NULL,
  sales_count INTEGER NOT NULL,
  refunds_count INTEGER NOT NULL,
  sales_cents INTEGER NOT NULL,
  refunds_cents INTEGER NOT NULL,
  by_method TEXT NOT NULL,
  float_in_cents INTEGER NOT NULL,
  cash_expected_cents INTEGER NOT NULL,
  cash_counted_cents INTEGER NOT NULL,
  variance_cents INTEGER NOT NULL,
  float_out_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TRIGGER sales_no_update BEFORE UPDATE ON sales
BEGIN SELECT RAISE(ABORT, 'Une vente ne se modifie pas : on lannule par un avoir'); END;
CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'Une vente ne se modifie pas : on lannule par un avoir'); END;
CREATE TRIGGER sale_lines_no_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'Une vente ne se modifie pas : on lannule par un avoir'); END;
CREATE TRIGGER sale_lines_no_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'Une vente ne se modifie pas : on lannule par un avoir'); END;
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'Un paiement ne se modifie pas'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'Un paiement ne se modifie pas'); END;
CREATE TRIGGER customer_ledger_no_update BEFORE UPDATE ON customer_ledger
BEGIN SELECT RAISE(ABORT, 'Le compte client est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER customer_ledger_no_delete BEFORE DELETE ON customer_ledger
BEGIN SELECT RAISE(ABORT, 'Le compte client est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER closures_no_update BEFORE UPDATE ON closures
BEGIN SELECT RAISE(ABORT, 'Une clôture ne se modifie pas'); END;
CREATE TRIGGER closures_no_delete BEFORE DELETE ON closures
BEGIN SELECT RAISE(ABORT, 'Une clôture ne se modifie pas'); END;

`,
  },

  {
    version: 6,
    name: 'promotions-fidelite',
    sql: `
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bogo','bundle','percent','amount')),
  scope TEXT NOT NULL CHECK (scope IN ('product','category','all')),
  product_id INTEGER REFERENCES products(id),
  category TEXT NOT NULL DEFAULT '',
  buy_qty INTEGER,
  free_qty INTEGER,
  bundle_qty INTEGER,
  bundle_price_cents INTEGER,
  percent REAL,
  amount_cents INTEGER,
  starts_on TEXT,
  ends_on TEXT,
  weekdays TEXT NOT NULL DEFAULT '',
  time_from TEXT,
  time_to TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (scope <> 'product' OR product_id IS NOT NULL),
  CHECK (scope <> 'category' OR category <> '')
);
CREATE TABLE loyalty_program (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  spend_cents_per_stamp INTEGER NOT NULL DEFAULT 500 CHECK (spend_cents_per_stamp > 0),
  stamps_needed INTEGER NOT NULL DEFAULT 10 CHECK (stamps_needed > 0),
  reward_cents INTEGER NOT NULL DEFAULT 500 CHECK (reward_cents > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO loyalty_program (id, enabled, updated_at) VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE loyalty_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  ts TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  sale_id INTEGER REFERENCES sales(id),
  reason TEXT NOT NULL,
  user_name TEXT
);
CREATE INDEX loyalty_moves_c ON loyalty_moves (customer_id, id);
CREATE TRIGGER loyalty_moves_no_update BEFORE UPDATE ON loyalty_moves
BEGIN SELECT RAISE(ABORT, 'Les tampons de fidélité sont en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER loyalty_moves_no_delete BEFORE DELETE ON loyalty_moves
BEGIN SELECT RAISE(ABORT, 'Les tampons de fidélité sont en lecture seule : on corrige par une nouvelle ligne'); END;

`,
  },

  {
    version: 7,
    name: 'fournisseurs',
    sql: `
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL CHECK (status IN ('draft','sent','partial','received','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expected_on TEXT,
  note TEXT NOT NULL DEFAULT '',
  user_name TEXT
);
CREATE TABLE po_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  pos INTEGER NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL,
  base REAL NOT NULL CHECK (base > 0),
  expected_total_cents INTEGER CHECK (expected_total_cents IS NULL OR expected_total_cents >= 0),
  UNIQUE (po_id, pos)
);
CREATE TABLE po_receipts (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  ts TEXT NOT NULL,
  user_name TEXT,
  invoice_ref TEXT NOT NULL DEFAULT '',
  invoice_cents INTEGER NOT NULL CHECK (invoice_cents >= 0),
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE po_receipt_lines (
  receipt_id INTEGER NOT NULL REFERENCES po_receipts(id),
  po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  base REAL NOT NULL CHECK (base > 0),
  total_cents INTEGER CHECK (total_cents IS NULL OR total_cents >= 0),
  move_id INTEGER REFERENCES stock_moves(id),
  PRIMARY KEY (receipt_id, po_line_id)
);
CREATE TABLE supplier_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('invoice','payment','adjust')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  receipt_id INTEGER REFERENCES po_receipts(id),
  method TEXT,
  note TEXT,
  user_name TEXT
);
CREATE INDEX supplier_ledger_s ON supplier_ledger (supplier_id, id);
CREATE TRIGGER supplier_ledger_no_update BEFORE UPDATE ON supplier_ledger
BEGIN SELECT RAISE(ABORT, 'Le compte fournisseur est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER supplier_ledger_no_delete BEFORE DELETE ON supplier_ledger
BEGIN SELECT RAISE(ABORT, 'Le compte fournisseur est en lecture seule : on corrige par une nouvelle ligne'); END;
CREATE TRIGGER po_receipts_no_update BEFORE UPDATE ON po_receipts
BEGIN SELECT RAISE(ABORT, 'Une réception ne se modifie pas'); END;
CREATE TRIGGER po_receipts_no_delete BEFORE DELETE ON po_receipts
BEGIN SELECT RAISE(ABORT, 'Une réception ne se modifie pas'); END;
CREATE TRIGGER po_receipt_lines_no_update BEFORE UPDATE ON po_receipt_lines
BEGIN SELECT RAISE(ABORT, 'Une réception ne se modifie pas'); END;
CREATE TRIGGER po_receipt_lines_no_delete BEFORE DELETE ON po_receipt_lines
BEGIN SELECT RAISE(ABORT, 'Une réception ne se modifie pas'); END;

`,
  },

  {
    version: 8,
    name: 'traiteur',
    sql: `
CREATE TABLE catering_orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('quote','confirmed','prepared','delivered','cancelled')),
  customer_id INTEGER REFERENCES customers(id),
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,
  event_time TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  guests INTEGER CHECK (guests IS NULL OR guests > 0),
  note TEXT NOT NULL DEFAULT '',
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0,
  est_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_name TEXT,
  cancelled_reason TEXT
);
CREATE INDEX catering_date ON catering_orders (event_date);
CREATE TABLE catering_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES catering_orders(id),
  pos INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recipe','product','free')),
  recipe_id INTEGER REFERENCES recipes(id),
  product_id INTEGER REFERENCES products(id),
  label TEXT NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  total_cents INTEGER NOT NULL,
  est_cost REAL NOT NULL DEFAULT 0,
  UNIQUE (order_id, pos),
  CHECK (kind <> 'recipe' OR recipe_id IS NOT NULL),
  CHECK (kind <> 'product' OR product_id IS NOT NULL)
);
CREATE TABLE catering_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES catering_orders(id),
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','balance','refund')),
  method TEXT NOT NULL CHECK (method IN ('cash','card','voucher','transfer','other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  user_name TEXT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX catering_payments_o ON catering_payments (order_id);
CREATE TRIGGER catering_payments_no_update BEFORE UPDATE ON catering_payments
BEGIN SELECT RAISE(ABORT, 'Un paiement ne se modifie pas : un remboursement est une nouvelle ligne'); END;
CREATE TRIGGER catering_payments_no_delete BEFORE DELETE ON catering_payments
BEGIN SELECT RAISE(ABORT, 'Un paiement ne se modifie pas : un remboursement est une nouvelle ligne'); END;

`,
  },

  {
    version: 9,
    name: 'depenses',
    sql: `
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  user_name TEXT,
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX expenses_day ON expenses (day);
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'Une dépense ne se supprime pas : on l''annule'); END;
CREATE TRIGGER expenses_only_void BEFORE UPDATE ON expenses
WHEN NEW.id <> OLD.id OR NEW.ts <> OLD.ts OR NEW.day <> OLD.day OR NEW.category <> OLD.category OR NEW.label <> OLD.label OR NEW.amount_cents <> OLD.amount_cents OR OLD.voided_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Une dépense ne se modifie pas : on l''annule'); END;
`,
  },
  {
    version: 10,
    name: 'commandes-cuisine',
    sql: `
ALTER TABLE products ADD COLUMN to_kitchen INTEGER NOT NULL DEFAULT 1 CHECK (to_kitchen IN (0,1));
UPDATE products SET to_kitchen = 0 WHERE kind = 'resale';
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_uuid TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('sent','preparing','ready','served','cancelled')),
  day TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  created_at TEXT NOT NULL,
  preparing_at TEXT,
  preparing_by TEXT,
  ready_at TEXT,
  ready_by TEXT,
  served_at TEXT,
  served_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  sale_id INTEGER REFERENCES sales(id)
);
CREATE INDEX orders_status ON orders (status, created_at);
CREATE INDEX orders_label ON orders (label);
CREATE INDEX orders_sale ON orders (sale_id);
CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  pos INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  kitchen INTEGER NOT NULL CHECK (kitchen IN (0,1)),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX order_lines_order ON order_lines (order_id);
CREATE TRIGGER order_lines_frozen BEFORE UPDATE ON order_lines
BEGIN SELECT RAISE(ABORT, 'Une ligne de commande ne se modifie pas : annulez la commande et refaites-en une'); END;
CREATE TRIGGER order_lines_no_delete BEFORE DELETE ON order_lines
BEGIN SELECT RAISE(ABORT, 'Une ligne de commande ne se supprime pas'); END;
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'Une commande ne se supprime pas : on l''annule'); END;
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT
);
CREATE INDEX push_user ON push_subscriptions (user_id);
CREATE TABLE server_secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1).version;

export function migrate(db, now = () => new Date()) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
  if (current > LATEST_VERSION) {
    throw new Error(
      `La base est en version ${current}, plus récente que ce programme (${LATEST_VERSION}). Mettez le programme à jour.`,
    );
  }
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version, m.name, now().toISOString());
    });
  }
}

export function openDb(file, now) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
  // Mise à niveau d'une base existante : copie de sécurité d'abord (fichier à côté de la base).
  const hasVersions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  const current = hasVersions ? db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_version').get().v : 0;
  if (current > 0 && current < LATEST_VERSION && file !== ':memory:') {
    const copy = path.join(path.dirname(file), `avant-mise-a-niveau-v${current}.db`);
    if (!fs.existsSync(copy)) db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  }
  migrate(db, now);
  return db;
}

const depth = new WeakMap();
/** Transaction : tout réussit ou rien n'est écrit. Les appels imbriqués rejoignent la transaction en cours. */
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* déjà annulée */ }
    throw e;
  } finally {
    depth.set(db, 0);
  }
}
