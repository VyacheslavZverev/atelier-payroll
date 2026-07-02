// Photo file storage: local disk by default, Vercel Blob when a
// BLOB_READ_WRITE_TOKEN is present (cloud mode). The photo_ref stored on
// invoices stays a bare "uuid.ext" filename in both modes; blob mode keeps a
// ref -> public URL map in the photos table.
import path from 'node:path';
import fs from 'node:fs';
import { PHOTOS_DIR, get, run } from './db.js';

export const IS_BLOB_STORAGE = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export async function savePhoto(ref, buffer, contentType) {
  if (!IS_BLOB_STORAGE) {
    fs.writeFileSync(path.join(PHOTOS_DIR, ref), buffer);
    return;
  }
  const { put } = await import('@vercel/blob');
  // The ref already contains a UUID, so the public URL is unguessable.
  const { url } = await put(`photos/${ref}`, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
    cacheControlMaxAge: 31536000 // photos are immutable once uploaded
  });
  await run('INSERT OR REPLACE INTO photos (ref, url) VALUES (?, ?)', [ref, url]);
}

// Where a photo lives: { file } in local mode, { url } in blob mode,
// or null when it does not exist.
export async function locatePhoto(ref) {
  if (!IS_BLOB_STORAGE) {
    const file = path.join(PHOTOS_DIR, ref);
    return fs.existsSync(file) ? { file } : null;
  }
  const row = await get('SELECT url FROM photos WHERE ref = ?', [ref]);
  return row ? { url: row.url } : null;
}

export async function deletePhoto(ref) {
  if (!IS_BLOB_STORAGE) {
    try {
      fs.unlinkSync(path.join(PHOTOS_DIR, ref));
    } catch {
      // already gone — fine
    }
    return;
  }
  const row = await get('SELECT url FROM photos WHERE ref = ?', [ref]);
  if (!row) return;
  const { del } = await import('@vercel/blob');
  try {
    await del(row.url);
  } catch {
    // stale mapping — still drop the row below
  }
  await run('DELETE FROM photos WHERE ref = ?', [ref]);
}
