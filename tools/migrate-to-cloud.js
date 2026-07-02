// One-time migration of the local database and photos into the cloud services
// used by the Vercel deployment (Turso + Vercel Blob).
//
//   node tools/migrate-to-cloud.js
//
// Requires TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and BLOB_READ_WRITE_TOKEN in
// .env. Reads local data only — data/payroll.db is opened read-only and never
// modified. The TARGET database is wiped and refilled, so the script is safe
// to re-run until the cloud version goes live.
import { ROOT_DIR } from '../server/env.js';
import { SCHEMA_SQL } from '../server/db.js';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client/web';
import path from 'node:path';
import fs from 'node:fs';

const missing = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'BLOB_READ_WRITE_TOKEN'].filter(
  (k) => !process.env[k]
);
if (missing.length > 0) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const DATA_DIR = path.join(ROOT_DIR, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const src = new DatabaseSync(path.join(DATA_DIR, 'payroll.db'), { readOnly: true });
const dst = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Chunked transactional inserts keep each HTTP request to Turso small.
async function insertRows(table, columns, rows) {
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    await dst.batch(
      chunk.map((row) => ({
        sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`,
        args: columns.map((c) => row[c] ?? null)
      })),
      'write'
    );
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

console.log('Creating schema in Turso...');
await dst.executeMultiple(SCHEMA_SQL);

console.log('Clearing target tables...');
await dst.batch(
  ['invoices', 'adjustments', 'weeks', 'employees', 'sessions', 'photos'].map((t) => ({
    sql: `DELETE FROM ${t}`
  })),
  'write'
);

console.log('Copying tables (ids preserved)...');
await insertRows('employees', ['id', 'name', 'status'], src.prepare('SELECT * FROM employees').all());
await insertRows('weeks', ['id', 'label', 'date'], src.prepare('SELECT * FROM weeks').all());
await insertRows(
  'invoices',
  ['id', 'week_id', 'employee_id', 'number', 'amount', 'paid', 'needs_review', 'photo_ref', 'created_at'],
  src.prepare('SELECT * FROM invoices').all()
);
await insertRows(
  'adjustments',
  ['id', 'week_id', 'employee_id', 'type', 'label', 'sign', 'amount', 'date'],
  src.prepare('SELECT * FROM adjustments').all()
);
// sessions are not copied: everyone simply enters the PIN once on the new URL

console.log('Uploading photos to Vercel Blob...');
const { put } = await import('@vercel/blob');
const refs = src
  .prepare('SELECT DISTINCT photo_ref AS ref FROM invoices WHERE photo_ref IS NOT NULL')
  .all();
let uploaded = 0;
for (const { ref } of refs) {
  const file = path.join(PHOTOS_DIR, ref);
  if (!fs.existsSync(file)) {
    console.warn(`  SKIP (file missing): ${ref}`);
    continue;
  }
  const ext = path.extname(ref).slice(1);
  const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const { url } = await put(`photos/${ref}`, fs.readFileSync(file), {
    access: 'public',
    contentType,
    addRandomSuffix: false,
    cacheControlMaxAge: 31536000
  });
  await dst.execute({ sql: 'INSERT OR REPLACE INTO photos (ref, url) VALUES (?, ?)', args: [ref, url] });
  uploaded += 1;
  console.log(`  ${uploaded}/${refs.length} ${ref}`);
}

console.log('\nVerifying row counts (local -> cloud):');
let ok = true;
for (const t of ['employees', 'weeks', 'invoices', 'adjustments']) {
  const a = src.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  const b = Number((await dst.execute(`SELECT COUNT(*) AS c FROM ${t}`)).rows[0].c);
  console.log(`  ${t}: ${a} -> ${b} ${a === b ? 'OK' : 'MISMATCH!'}`);
  if (a !== b) ok = false;
}
const photoCount = Number((await dst.execute('SELECT COUNT(*) AS c FROM photos')).rows[0].c);
console.log(`  photos: ${refs.length} referenced -> ${photoCount} uploaded`);

console.log(ok ? '\nMigration finished successfully.' : '\nMIGRATION HAS MISMATCHES — do not go live.');
process.exit(ok ? 0 : 1);
