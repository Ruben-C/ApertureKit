import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'branding'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'attachments'), { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Each entry runs once, in order. Append new migrations; never edit old ones.
const migrations = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','editor','admin')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE categories (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#2A4BC7',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE forms (
    id           INTEGER PRIMARY KEY,
    category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    slug         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    fields       TEXT NOT NULL DEFAULT '[]',
    confirmation TEXT NOT NULL DEFAULT '',
    published    INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE requests (
    id            INTEGER PRIMARY KEY,
    form_id       INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','done','declined')),
    answers       TEXT NOT NULL,
    form_snapshot TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX requests_user ON requests(user_id, created_at DESC);
  CREATE INDEX requests_status ON requests(status, created_at DESC);
  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE attachments (
    id            INTEGER PRIMARY KEY,
    request_id    INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    field_id      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL
  );
  `,
  // External sign-in methods (OIDC, SAML, LDAP) and which user each remote
  // identity belongs to. Accounts that only sign in this way keep an empty
  // password_hash, which never verifies.
  `
  CREATE TABLE auth_providers (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL CHECK (type IN ('oidc','saml','ldap')),
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    config     TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE identities (
    id          INTEGER PRIMARY KEY,
    provider_id INTEGER NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT NOT NULL,
    last_login  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider_id, subject)
  );
  CREATE INDEX identities_user ON identities(user_id);
  `,
];

db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
let version = db.prepare('SELECT version FROM schema_version').get()?.version ?? 0;
if (version === 0) db.prepare('INSERT INTO schema_version VALUES (0)').run();
for (let i = version; i < migrations.length; i++) {
  db.exec('BEGIN');
  db.exec(migrations[i]);
  db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
  db.exec('COMMIT');
}

export function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
