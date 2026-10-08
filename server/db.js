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
