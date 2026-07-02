// Database layer with two modes behind one small async API (get/all/run/batch):
//   - local (default): SQLite file via Node's built-in driver — the PC setup
//   - cloud: Turso (hosted libSQL) when TURSO_DATABASE_URL is set — Vercel
// The cloud client is the pure-JS "web" build, so no native binary is needed
// in the serverless bundle.
import { ROOT_DIR } from './env.js';
import path from 'node:path';
import fs from 'node:fs';

export { ROOT_DIR };
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

export const IS_CLOUD_DB = Boolean(process.env.TURSO_DATABASE_URL);

// The photos table exists only for blob storage (ref -> public URL map);
// in local mode it simply stays empty.
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS employees (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived'))
  );

  CREATE TABLE IF NOT EXISTS weeks (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    date  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    week_id      INTEGER NOT NULL REFERENCES weeks(id),
    employee_id  INTEGER NOT NULL REFERENCES employees(id),
    number       INTEGER,
    amount       INTEGER NOT NULL DEFAULT 0,
    paid         INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    photo_ref    TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    week_id     INTEGER NOT NULL REFERENCES weeks(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    type        TEXT NOT NULL CHECK (type IN ('standing', 'custom')),
    label       TEXT NOT NULL,
    sign        TEXT NOT NULL DEFAULT '-' CHECK (sign IN ('+', '-')),
    amount      INTEGER NOT NULL DEFAULT 0,
    date        TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    ref TEXT PRIMARY KEY,
    url TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_invoices_week_emp ON invoices(week_id, employee_id);
  CREATE INDEX IF NOT EXISTS idx_adjustments_week_emp ON adjustments(week_id, employee_id);
`;

// get(sql, args)  -> first row or undefined
// all(sql, args)  -> array of rows (plain objects)
// run(sql, args)  -> { lastInsertRowid, changes }
// batch([{sql, args}, ...]) -> all statements in one transaction
export let get, all, run, batch;

if (IS_CLOUD_DB) {
  const { createClient } = await import('@libsql/client/web');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  // libSQL rows are array-like objects; spread them into plain objects so
  // res.json() and object spread behave exactly like the local driver.
  const plain = (row) => (row === undefined ? undefined : { ...row });

  get = async (sql, args = []) => plain((await client.execute({ sql, args })).rows[0]);
  all = async (sql, args = []) => (await client.execute({ sql, args })).rows.map(plain);
  run = async (sql, args = []) => {
    const r = await client.execute({ sql, args });
    return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected };
  };
  batch = async (stmts) => {
    await client.batch(stmts.map((s) => ({ sql: s.sql, args: s.args ?? [] })), 'write');
  };

  await client.executeMultiple(SCHEMA_SQL);
} else {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'payroll.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  get = async (sql, args = []) => db.prepare(sql).get(...args);
  all = async (sql, args = []) => db.prepare(sql).all(...args);
  run = async (sql, args = []) => {
    const r = db.prepare(sql).run(...args);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  };
  batch = async (stmts) => {
    db.exec('BEGIN');
    try {
      for (const s of stmts) db.prepare(s.sql).run(...(s.args ?? []));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // The shop normally has 3 employees; seed placeholders the owner can rename.
  // Local-only: the cloud database is populated by the migration script.
  const employeeCount = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
  if (employeeCount === 0) {
    const ins = db.prepare('INSERT INTO employees (name) VALUES (?)');
    for (const name of ['Сотрудник 1', 'Сотрудник 2', 'Сотрудник 3']) ins.run(name);
  }
}

export const STANDING_LABELS = ['Патент', 'Аванс'];

// Standing deductions exist for every employee in every week, defaulting to 0.
export async function ensureStandingAdjustments(weekId, employeeId) {
  const existing = await all(
    "SELECT label FROM adjustments WHERE week_id = ? AND employee_id = ? AND type = 'standing'",
    [weekId, employeeId]
  );
  const have = new Set(existing.map((r) => r.label));
  for (const label of STANDING_LABELS) {
    if (!have.has(label)) {
      await run(
        "INSERT INTO adjustments (week_id, employee_id, type, label, sign, amount) VALUES (?, ?, 'standing', ?, '-', 0)",
        [weekId, employeeId, label]
      );
    }
  }
}
