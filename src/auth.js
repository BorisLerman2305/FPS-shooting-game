// Cloud-backed user accounts. Talks to the Express server (`server.js`) via
// /api/auth/* and /api/me/* endpoints. The JWT issued by the server is kept
// in localStorage so the player stays logged in across page refreshes.
//
// Public API kept compatible with the previous localStorage version so
// `main.js` doesn't need many changes:
//   - register(username, password) → user object
//   - login(username, password) → user object
//   - logout() → void
//   - getCurrentUser() → user object | null  (synchronous, reads cache)
//   - bumpStat(key, by)             — fire-and-forget API call, also caches locally
//   - setFavoriteWeapon(id)         — same
//   - tryRestoreSession()           — async, validates the cached token at boot
//   - listUsernames()               — admin only (uses /api/admin/users)
//   - wipeAll()                     — clears local cache (does NOT touch server data)

const TOKEN_KEY = 'fps_token_v2';
const USER_CACHE_KEY = 'fps_user_v2';

let cachedUser = null;

function loadCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCachedUser(user) {
  cachedUser = user;
  if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_CACHE_KEY);
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

cachedUser = loadCachedUser();

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = getToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error('אין חיבור לשרת');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = data?.error || `שגיאה (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ─── Public API ──────────────────────────────────────────────────────────
export async function register(username, password) {
  const data = await api('/api/auth/register', { method: 'POST', body: { username, password } });
  setToken(data.token);
  saveCachedUser(data.user);
  return data.user;
}

export async function login(username, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  setToken(data.token);
  saveCachedUser(data.user);
  return data.user;
}

export function logout() {
  setToken(null);
  saveCachedUser(null);
}

// Synchronous read of the cached user. Call `tryRestoreSession()` on app boot
// to validate the token with the server before relying on this.
export function getCurrentUser() {
  return cachedUser;
}

// On boot: if we have a token, validate it with the server. If valid, refresh
// the cached user; if not, clear local state. Returns the (refreshed) user.
export async function tryRestoreSession() {
  if (!getToken()) return null;
  try {
    const data = await api('/api/auth/me', { auth: true });
    saveCachedUser(data.user);
    return data.user;
  } catch {
    setToken(null);
    saveCachedUser(null);
    return null;
  }
}

// Fire-and-forget stat updater. Updates the local cache immediately so the UI
// reflects the change, then sends to the server. If the server call fails we
// keep the optimistic local update (it'll resync on next login).
export function bumpStat(key, by = 1) {
  if (!cachedUser) return;
  if (!cachedUser.stats) cachedUser.stats = {};
  cachedUser.stats[key] = (cachedUser.stats[key] || 0) + by;
  saveCachedUser(cachedUser);
  api('/api/me/stats', { method: 'POST', body: { [key]: by }, auth: true })
    .then(data => { if (data?.user) saveCachedUser(data.user); })
    .catch(() => {});
}

export function setFavoriteWeapon(weaponId) {
  if (!cachedUser) return;
  cachedUser.loadout = { ...(cachedUser.loadout || {}), favoriteWeapon: weaponId };
  saveCachedUser(cachedUser);
  api('/api/me/loadout', { method: 'PATCH', body: { favoriteWeapon: weaponId }, auth: true })
    .catch(() => {});
}

// ─── Admin ───────────────────────────────────────────────────────────────
export async function listAllUsers() {
  const data = await api('/api/admin/users', { auth: true });
  return data.users;
}

export async function disableUser(id)  { return api(`/api/admin/users/${id}/disable`,  { method: 'PATCH', auth: true }); }
export async function enableUser(id)   { return api(`/api/admin/users/${id}/enable`,   { method: 'PATCH', auth: true }); }
export async function promoteUser(id)  { return api(`/api/admin/users/${id}/promote`,  { method: 'PATCH', auth: true }); }
export async function demoteUser(id)   { return api(`/api/admin/users/${id}/demote`,   { method: 'PATCH', auth: true }); }
export async function deleteUser(id)   { return api(`/api/admin/users/${id}`,          { method: 'DELETE', auth: true }); }

// ─── Debug / dev helpers (no longer touch server data) ──────────────────
export function listUsernames() { return cachedUser ? [cachedUser.name] : []; }
export function wipeAll() {
  setToken(null);
  saveCachedUser(null);
}
