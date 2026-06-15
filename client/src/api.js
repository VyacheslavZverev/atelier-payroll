const TOKEN_KEY = 'payroll_token';
const LAST_ACTIVE_KEY = 'payroll_last_active';

// Re-ask for the PIN once the app has sat unused longer than this. Normal
// weekly work keeps refreshing the timer, so she is not nagged mid-session.
export const LOCK_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Record that the app was just used, to push the inactivity lock forward.
export function markActive() {
  localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
}

// Unlocked = there is a token AND it was used recently enough.
export function isUnlocked() {
  if (!getToken()) return false;
  const last = Number(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
  return Date.now() - last <= LOCK_AFTER_MS;
}

export class AuthError extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  if (res.status === 401) {
    setToken(null);
    throw new AuthError('Требуется вход');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  markActive(); // any successful server interaction counts as activity
  return data;
}

export function photoUrl(ref) {
  return `/api/photos/${encodeURIComponent(ref)}?t=${encodeURIComponent(getToken() || '')}`;
}
