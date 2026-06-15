// Format integer rubles with non-breaking thin spaces: 12 500
export function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Downscale a camera photo before upload: cuts upload size and vision tokens
// while keeping handwriting legible. Returns a JPEG data URL.
export async function fileToDataUrl(file, maxDim = 1600) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}
