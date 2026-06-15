// SQLite storage via Node's built-in synchronous driver (no native build step).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'payroll.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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

  CREATE INDEX IF NOT EXISTS idx_invoices_week_emp ON invoices(week_id, employee_id);
  CREATE INDEX IF NOT EXISTS idx_adjustments_week_emp ON adjustments(week_id, employee_id);
`);

// The shop normally has 3 employees; seed placeholders the owner can rename.
const employeeCount = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
if (employeeCount === 0) {
  const ins = db.prepare('INSERT INTO employees (name) VALUES (?)');
  for (const name of ['Сотрудник 1', 'Сотрудник 2', 'Сотрудник 3']) ins.run(name);
}

export const STANDING_LABELS = ['Патент', 'Аванс'];

// Standing deductions exist for every employee in every week, defaulting to 0.
export function ensureStandingAdjustments(weekId, employeeId) {
  const find = db.prepare(
    "SELECT id FROM adjustments WHERE week_id = ? AND employee_id = ? AND type = 'standing' AND label = ?"
  );
  const ins = db.prepare(
    "INSERT INTO adjustments (week_id, employee_id, type, label, sign, amount) VALUES (?, ?, 'standing', ?, '-', 0)"
  );
  for (const label of STANDING_LABELS) {
    if (!find.get(weekId, employeeId, label)) ins.run(weekId, employeeId, label);
  }
}
