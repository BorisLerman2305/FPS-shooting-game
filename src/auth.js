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

function persistCache() {
  if (cachedUser) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(cachedUser));
  else localStorage.removeItem(USER_CACHE_KEY);
}

// Replace the cached user wholesale (login / register / first restore).
// Anyone holding a reference to the OLD cachedUser will see stale data,
// so callers should also re-read getCurrentUser() afterwards.
function setCachedUser(user) {
  cachedUser = user;
  persistCache();
}

// MUTATE the cached user in place from a server response. Preserves the
// object identity so external references (e.g. main.js's session.user)
// stay in sync without needing a refresh round-trip.
function mergeFromServer(serverUser) {
  if (!serverUser) { setCachedUser(null); return; }
  if (!cachedUser) { setCachedUser(serverUser); return; }
  // Top-level scalars / flags
  for (const k of Object.keys(serverUser)) {
    if (k === 'stats' || k === 'loadout') continue;
    cachedUser[k] = serverUser[k];
  }
  // Nested objects we care about — also merged in place
  if (serverUser.stats)   Object.assign(cachedUser.stats   = cachedUser.stats   || {}, serverUser.stats);
  if (serverUser.loadout) Object.assign(cachedUser.loadout = cachedUser.loadout || {}, serverUser.loadout);
  if (serverUser.ownedItems) cachedUser.ownedItems = serverUser.ownedItems.slice();
  persistCache();
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
  setCachedUser(data.user);  // first time → fresh reference is fine
  return data.user;
}

export async function login(username, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  setToken(data.token);
  setCachedUser(data.user);
  return data.user;
}

export function logout() {
  setToken(null);
  setCachedUser(null);
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
    // Use merge — if the boot path runs after the app has already grabbed
    // a reference to getCurrentUser(), we keep it in sync.
    if (cachedUser) mergeFromServer(data.user);
    else setCachedUser(data.user);
    return cachedUser;
  } catch {
    setToken(null);
    setCachedUser(null);
    return null;
  }
}

// Fire-and-forget stat updater. Optimistically bumps the cached value so
// the HUD updates instantly; the server response is merged IN PLACE so
// external references to getCurrentUser() stay live.
export function bumpStat(key, by = 1) {
  if (!cachedUser) return;
  if (!cachedUser.stats) cachedUser.stats = {};
  cachedUser.stats[key] = (cachedUser.stats[key] || 0) + by;
  persistCache();
  api('/api/me/stats', { method: 'POST', body: { [key]: by }, auth: true })
    .then(data => { if (data?.user) mergeFromServer(data.user); })
    .catch(() => {});
}

export function setFavoriteWeapon(weaponId) {
  if (!cachedUser) return;
  cachedUser.loadout = cachedUser.loadout || {};
  const prev = cachedUser.loadout.favoriteWeapon;
  cachedUser.loadout.favoriteWeapon = weaponId;
  persistCache();
  // If the server rejects (e.g. weapon not owned), roll the optimistic update
  // back so the client doesn't lie about a favorite that didn't actually save.
  api('/api/me/loadout', { method: 'PATCH', body: { favoriteWeapon: weaponId }, auth: true })
    .catch((err) => {
      console.warn('[auth] setFavoriteWeapon failed, rolling back:', err.message);
      if (cachedUser) {
        cachedUser.loadout.favoriteWeapon = prev;
        persistCache();
      }
    });
}

// ─── Admin ───────────────────────────────────────────────────────────────
export async function listAllUsers() {
  const data = await api('/api/admin/users', { auth: true });
  return data.users;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────
export async function fetchLeaderboard(sort = 'kills') {
  const data = await api(`/api/leaderboard?sort=${encodeURIComponent(sort)}`);
  return data.players || [];
}

// ─── PvP rating ──────────────────────────────────────────────────────────
export async function reportPvpKill(targetUserId) {
  const data = await api('/api/me/pvp-kill', { method: 'POST', body: { targetId: targetUserId }, auth: true });
  if (data && data.user) mergeFromServer(data.user);
  return data;
}

// ─── Daily challenges ────────────────────────────────────────────────────
export async function fetchDailyChallenges() {
  const data = await api('/api/me/challenges', { auth: true });
  return data.challenges;
}
// Fire-and-forget — bumps any active challenge of that type by `by`
export function bumpChallenge(type, by = 1) {
  api('/api/me/challenges/progress', { method: 'POST', body: { type, by }, auth: true })
    .catch(() => {});
}
export async function claimChallenge(id) {
  const data = await api('/api/me/challenges/claim', { method: 'POST', body: { id }, auth: true });
  if (data && data.user) mergeFromServer(data.user);
  return data;
}

// ─── Achievements ────────────────────────────────────────────────────────
export async function fetchAchievements() {
  const data = await api('/api/me/achievements', { auth: true });
  return data;
}

// ─── Shop ────────────────────────────────────────────────────────────────
export async function buyItem(itemId) {
  const data = await api('/api/me/buy', { method: 'POST', body: { itemId }, auth: true });
  // Merge so the caller's cached reference (e.g. session.user) updates
  if (data && data.user) mergeFromServer(data.user);
  return cachedUser;
}

export async function disableUser(id)  { return api(`/api/admin/users/${id}/disable`,  { method: 'PATCH', auth: true }); }
export async function enableUser(id)   { return api(`/api/admin/users/${id}/enable`,   { method: 'PATCH', auth: true }); }
export async function promoteUser(id)  { return api(`/api/admin/users/${id}/promote`,  { method: 'PATCH', auth: true }); }
export async function demoteUser(id)   { return api(`/api/admin/users/${id}/demote`,   { method: 'PATCH', auth: true }); }
export async function deleteUser(id)   { return api(`/api/admin/users/${id}`,          { method: 'DELETE', auth: true }); }
export async function adminGrantCoins(id, amount) {
  return api(`/api/admin/users/${id}/coins`, { method: 'PATCH', body: { amount }, auth: true });
}

// ─── Debug / dev helpers (no longer touch server data) ──────────────────
export function listUsernames() { return cachedUser ? [cachedUser.name] : []; }
export function wipeAll() {
  setToken(null);
  setCachedUser(null);
}
