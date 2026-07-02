import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, PHOTOS_DIR, ROOT_DIR, ensureStandingAdjustments } from './db.js';
import { readInvoicesFromImage, isVisionConfigured } from './vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Externally-set variables (e.g. PORT injected by a process manager) must win
// over .env values, so capture them before loading the file.
const externalPort = process.env.PORT;
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  // .env is optional; environment variables may be set externally
}
// An empty `ANTHROPIC_API_KEY=` line would still occupy its slot in the SDK's
// credential precedence and shadow OAuth-profile auth — drop empty values.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) {
  if (process.env[key] === '') delete process.env[key];
}

const PORT = Number(externalPort || process.env.PORT || 3000);
const PIN = process.env.APP_PIN || '1234';
const SHOP_NAME = process.env.SHOP_NAME || 'Ателье';

const app = express();
app.use(express.json({ limit: '20mb' }));

// The production server runs with a hidden console, so errors also go to a
// file the developer can read: data/server.log.
function logError(...args) {
  console.error(...args);
  const line = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'server.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // logging must never break a request
  }
}

// ---------------------------------------------------------------- auth

function getRequestToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (typeof req.query.t === 'string') return req.query.t; // for <img> photo URLs
  return null;
}

function isValidToken(token) {
  if (!token) return false;
  return Boolean(db.prepare('SELECT token FROM sessions WHERE token = ?').get(token));
}

app.post('/api/login', async (req, res) => {
  // Tiny delay makes brute-forcing the PIN impractical for a hobby attacker.
  await new Promise((r) => setTimeout(r, 350));
  const { pin } = req.body || {};
  if (typeof pin !== 'string' || pin !== PIN) {
    return res.status(401).json({ error: 'Неверный PIN-код' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
  res.json({ token, shop_name: SHOP_NAME, vision_ready: isVisionConfigured() });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  if (!isValidToken(getRequestToken(req))) {
    return res.status(401).json({ error: 'Требуется вход' });
  }
  next();
});

// ---------------------------------------------------------------- config

app.get('/api/config', (req, res) => {
  res.json({ shop_name: SHOP_NAME, vision_ready: isVisionConfigured() });
});

// ---------------------------------------------------------------- employees

app.get('/api/employees', (req, res) => {
  const rows = db.prepare('SELECT * FROM employees ORDER BY status, id').all();
  res.json(rows);
});

app.post('/api/employees', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Введите имя' });
  const r = db.prepare('INSERT INTO employees (name) VALUES (?)').run(name);
  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(r.lastInsertRowid));
});

app.patch('/api/employees/:id', (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Введите имя' });
  db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(name, id);
  res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
});

// Removing an employee always archives; past weeks must stay intact.
app.post('/api/employees/:id/archive', (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE employees SET status = 'archived' WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.post('/api/employees/:id/restore', (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE employees SET status = 'active' WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- weeks

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

app.get('/api/weeks', (req, res) => {
  res.json(db.prepare('SELECT * FROM weeks ORDER BY id DESC').all());
});

app.post('/api/weeks', (req, res) => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const label = String(req.body?.label || '').trim() || `Неделя ${isoWeekNumber(now)}`;
  const r = db.prepare('INSERT INTO weeks (label, date) VALUES (?, ?)').run(label, date);
  res.json(db.prepare('SELECT * FROM weeks WHERE id = ?').get(r.lastInsertRowid));
});

// Deletes a week with everything in it (the client double-confirms first).
// Photo files are removed only when no other week references them.
app.delete('/api/weeks/:id', (req, res) => {
  const id = Number(req.params.id);
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(id);
  if (!week) return res.status(404).json({ error: 'Не найдено' });

  const refs = db
    .prepare('SELECT DISTINCT photo_ref FROM invoices WHERE week_id = ? AND photo_ref IS NOT NULL')
    .all(id);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM invoices WHERE week_id = ?').run(id);
    db.prepare('DELETE FROM adjustments WHERE week_id = ?').run(id);
    db.prepare('DELETE FROM weeks WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const stillUsed = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE photo_ref = ?');
  for (const { photo_ref } of refs) {
    if (stillUsed.get(photo_ref).c === 0) {
      try {
        fs.unlinkSync(path.join(PHOTOS_DIR, photo_ref));
      } catch {
        // already gone — fine
      }
    }
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- calculation

function calcForEmployee(weekId, employeeId) {
  const invoices = db
    .prepare('SELECT * FROM invoices WHERE week_id = ? AND employee_id = ? ORDER BY id')
    .all(weekId, employeeId);
  const adjustments = db
    .prepare("SELECT * FROM adjustments WHERE week_id = ? AND employee_id = ? ORDER BY type DESC, id")
    .all(weekId, employeeId);

  const sum = invoices.reduce((acc, i) => acc + (i.paid ? i.amount : 0), 0);
  const half = Math.round(sum / 2);
  const deductions = adjustments.filter((a) => a.sign === '-').reduce((acc, a) => acc + a.amount, 0);
  const bonuses = adjustments.filter((a) => a.sign === '+').reduce((acc, a) => acc + a.amount, 0);
  const payout = half - deductions + bonuses;
  return { invoices, adjustments, sum, half, deductions, bonuses, payout };
}

// Monthly analytics: sum of each employee's "50%" across every week whose date
// falls in the given calendar month (YYYY-MM). Includes archived employees who
// worked that month. View-only — for the owner.
app.get('/api/months/:ym/analytics', (req, res) => {
  const ym = String(req.params.ym);
  if (!/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ error: 'Некорректный месяц' });

  const weeks = db.prepare("SELECT * FROM weeks WHERE substr(date, 1, 7) = ? ORDER BY id").all(ym);
  const employees = db.prepare('SELECT * FROM employees ORDER BY id').all();

  const result = [];
  for (const e of employees) {
    let totalHalf = 0;
    const perWeek = [];
    for (const w of weeks) {
      const { invoices, half } = calcForEmployee(w.id, e.id);
      if (invoices.length === 0) continue; // employee didn't work this week
      perWeek.push({ week_id: w.id, label: w.label, half });
      totalHalf += half;
    }
    if (perWeek.length > 0) {
      result.push({ id: e.id, name: e.name, status: e.status, total_half: totalHalf, weeks: perWeek });
    }
  }

  res.json({
    month: ym,
    weeks: weeks.map((w) => ({ id: w.id, label: w.label, date: w.date })),
    employees: result
  });
});

// Everything the per-employee calculation screen needs, in one call.
app.get('/api/weeks/:weekId/employee/:employeeId', (req, res) => {
  const weekId = Number(req.params.weekId);
  const employeeId = Number(req.params.employeeId);
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  if (!week || !employee) return res.status(404).json({ error: 'Не найдено' });
  ensureStandingAdjustments(weekId, employeeId);
  res.json({ week, employee, ...calcForEmployee(weekId, employeeId) });
});

// Home screen: per-employee totals for the week + cross-employee checks.
app.get('/api/weeks/:weekId/overview', (req, res) => {
  const weekId = Number(req.params.weekId);
  const week = db.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId);
  if (!week) return res.status(404).json({ error: 'Не найдено' });

  const employees = db.prepare("SELECT * FROM employees WHERE status = 'active' ORDER BY id").all();
  const perEmployee = employees.map((e) => {
    const { invoices, sum, half, payout } = calcForEmployee(weekId, e.id);
    return {
      id: e.id,
      name: e.name,
      invoice_count: invoices.length,
      needs_review_count: invoices.filter((i) => i.needs_review).length,
      unpaid_count: invoices.filter((i) => !i.paid).length,
      sum,
      half,
      payout
    };
  });

  const totalInvoices = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE week_id = ?').get(weekId).c;
  res.json({ week, employees: perEmployee, total_invoices: totalInvoices, checks: weekChecks(weekId) });
});

// Weekly checks run across ALL employees (shared invoice-number pool).
function weekChecks(weekId) {
  const rows = db
    .prepare(
      `SELECT i.id, i.number, i.amount, i.paid, e.name AS employee_name
       FROM invoices i JOIN employees e ON e.id = i.employee_id
       WHERE i.week_id = ? ORDER BY i.number`
    )
    .all(weekId);

  const byNumber = new Map();
  for (const r of rows) {
    if (r.number === null) continue;
    if (!byNumber.has(r.number)) byNumber.set(r.number, []);
    byNumber.get(r.number).push(r);
  }

  // A given invoice number is unique across the whole shop, so the same number
  // appearing for two employees in one week means someone mis-entered it.
  const duplicates = [...byNumber.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([number, list]) => ({
      number,
      entries: list.map((r) => ({ employee_name: r.employee_name, amount: r.amount }))
    }));

  const unpaid = rows
    .filter((r) => !r.paid)
    .map((r) => ({ employee_name: r.employee_name, number: r.number, amount: r.amount }));

  return { duplicates, unpaid };
}

app.get('/api/weeks/:weekId/checks', (req, res) => {
  res.json(weekChecks(Number(req.params.weekId)));
});

// ---------------------------------------------------------------- invoices

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

app.post('/api/invoices', (req, res) => {
  const { week_id, employee_id, number, amount, paid, needs_review, photo_ref } = req.body || {};
  if (!week_id || !employee_id) return res.status(400).json({ error: 'Нет недели или сотрудника' });
  const r = db
    .prepare(
      `INSERT INTO invoices (week_id, employee_id, number, amount, paid, needs_review, photo_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(week_id),
      Number(employee_id),
      intOrNull(number),
      intOrNull(amount) ?? 0,
      paid ? 1 : 0,
      needs_review ? 1 : 0,
      photo_ref || null
    );
  res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(r.lastInsertRowid));
});

app.patch('/api/invoices/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Не найдено' });
  const b = req.body || {};
  const number = 'number' in b ? intOrNull(b.number) : cur.number;
  const amount = 'amount' in b ? intOrNull(b.amount) ?? 0 : cur.amount;
  const paid = 'paid' in b ? (b.paid ? 1 : 0) : cur.paid;
  const needs_review = 'needs_review' in b ? (b.needs_review ? 1 : 0) : cur.needs_review;
  db.prepare('UPDATE invoices SET number = ?, amount = ?, paid = ?, needs_review = ? WHERE id = ?').run(
    number,
    amount,
    paid,
    needs_review,
    id
  );
  res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
});

app.delete('/api/invoices/:id', (req, res) => {
  db.prepare('DELETE FROM invoices WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Delete several invoices in one request (the review screen's "select" mode).
// Removes photo files that no invoice references anymore.
app.post('/api/invoices/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.json({ ok: true, deleted: 0 });
  const placeholders = ids.map(() => '?').join(',');
  const refs = db
    .prepare(`SELECT DISTINCT photo_ref FROM invoices WHERE id IN (${placeholders}) AND photo_ref IS NOT NULL`)
    .all(...ids);
  const info = db.prepare(`DELETE FROM invoices WHERE id IN (${placeholders})`).run(...ids);
  const stillUsed = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE photo_ref = ?');
  for (const { photo_ref } of refs) {
    if (stillUsed.get(photo_ref).c === 0) {
      try {
        fs.unlinkSync(path.join(PHOTOS_DIR, photo_ref));
      } catch {
        // already gone — fine
      }
    }
  }
  res.json({ ok: true, deleted: info.changes });
});

// ---------------------------------------------------------------- adjustments

app.post('/api/adjustments', (req, res) => {
  const { week_id, employee_id, label, sign, amount } = req.body || {};
  if (!week_id || !employee_id) return res.status(400).json({ error: 'Нет недели или сотрудника' });
  const labelText = String(label || '').trim();
  if (!labelText) return res.status(400).json({ error: 'Введите название' });
  const date = new Date().toISOString().slice(0, 10);
  const r = db
    .prepare(
      `INSERT INTO adjustments (week_id, employee_id, type, label, sign, amount, date)
       VALUES (?, ?, 'custom', ?, ?, ?, ?)`
    )
    .run(
      Number(week_id),
      Number(employee_id),
      labelText,
      sign === '+' ? '+' : '-',
      intOrNull(amount) ?? 0,
      date
    );
  res.json(db.prepare('SELECT * FROM adjustments WHERE id = ?').get(r.lastInsertRowid));
});

app.patch('/api/adjustments/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Не найдено' });
  const b = req.body || {};
  const amount = 'amount' in b ? intOrNull(b.amount) ?? 0 : cur.amount;
  const label = 'label' in b && cur.type === 'custom' ? String(b.label).trim() || cur.label : cur.label;
  const sign = 'sign' in b && cur.type === 'custom' ? (b.sign === '+' ? '+' : '-') : cur.sign;
  db.prepare('UPDATE adjustments SET amount = ?, label = ?, sign = ? WHERE id = ?').run(amount, label, sign, id);
  res.json(db.prepare('SELECT * FROM adjustments WHERE id = ?').get(id));
});

app.delete('/api/adjustments/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(Number(req.params.id));
  if (cur && cur.type === 'standing') {
    return res.status(400).json({ error: 'Постоянные корректировки нельзя удалить' });
  }
  db.prepare("DELETE FROM adjustments WHERE id = ? AND type = 'custom'").run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- photo scan

app.post('/api/scan', async (req, res) => {
  const { week_id, employee_id, image } = req.body || {};
  if (!week_id || !employee_id) return res.status(400).json({ error: 'Нет недели или сотрудника' });
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(String(image || ''));
  if (!m) return res.status(400).json({ error: 'Некорректное изображение' });
  const [, mediaType, base64Data] = m;

  // Keep the original photo regardless of recognition outcome.
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const photoRef = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(PHOTOS_DIR, photoRef), Buffer.from(base64Data, 'base64'));

  const insert = db.prepare(
    `INSERT INTO invoices (week_id, employee_id, number, amount, paid, needs_review, photo_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const getById = db.prepare('SELECT * FROM invoices WHERE id = ?');

  try {
    const rows = await readInvoicesFromImage(base64Data, mediaType);
    const created = rows.map((r) => {
      const ins = insert.run(
        Number(week_id),
        Number(employee_id),
        r.number,
        r.amount,
        r.paid_stamp ? 1 : 0,
        r.needs_review ? 1 : 0,
        photoRef
      );
      return getById.get(ins.lastInsertRowid);
    });
    if (created.length === 0) {
      // Nothing recognized: keep the photo visible as one empty row to fill in.
      const ins = insert.run(Number(week_id), Number(employee_id), null, 0, 0, 1, photoRef);
      created.push(getById.get(ins.lastInsertRowid));
      return res.json({ ok: false, error: 'На фото не найдено накладных — проверьте строку вручную', invoices: created });
    }
    res.json({ ok: true, invoices: created });
  } catch (e) {
    logError('scan failed:', e);
    // Never drop data: surface the photo as a manual-entry row.
    const ins = insert.run(Number(week_id), Number(employee_id), null, 0, 0, 1, photoRef);
    const row = getById.get(ins.lastInsertRowid);
    const msg = String(e.message || '');
    let message;
    if (e.code === 'NO_KEY') {
      message = 'Доступ к API не настроен (ключ в .env) — заполните строку вручную';
    } else if (msg.includes('error 402') || /credit/i.test(msg)) {
      message = 'Закончились кредиты OpenRouter — пополните баланс на openrouter.ai. Строку можно заполнить вручную';
    } else {
      message = 'Не удалось распознать фото — заполните строку вручную';
    }
    res.json({ ok: false, error: message, invoices: [row] });
  }
});

app.get('/api/photos/:ref', (req, res) => {
  const ref = path.basename(String(req.params.ref)); // prevent path traversal
  const file = path.join(PHOTOS_DIR, ref);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// ---------------------------------------------------------------- static frontend

const DIST = path.join(ROOT_DIR, 'client', 'dist');
app.use(express.static(DIST));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Payroll app listening on http://localhost:${PORT}`);
  if (!isVisionConfigured()) {
    console.warn(
      'WARNING: no Anthropic credentials found (ANTHROPIC_API_KEY in .env, ANTHROPIC_AUTH_TOKEN, or an "ant auth login" profile) — photo recognition is disabled (manual entry still works).'
    );
  }
});
