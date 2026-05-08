// Local user accounts persisted in localStorage. Passwords are hashed with
// SHA-256 + a per-user random salt — strong enough to keep curious eyes out
// of the browser dev tools, NOT a substitute for a real auth backend.

const STORAGE_KEY = 'fps_users_v1';

function loadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { users: {}, currentUser: null };
    const data = JSON.parse(raw);
    return {
      users: data.users || {},
      currentUser: data.currentUser || null,
    };
  } catch {
    return { users: {}, currentUser: null };
  }
}

function saveStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

const toHex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

async function hashPassword(password, saltHex) {
  const buf = new TextEncoder().encode(saltHex + ':' + password);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return toHex(new Uint8Array(digest));
}

function newSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function defaultUserRecord(salt, passwordHash) {
  return {
    salt,
    passwordHash,
    createdAt: Date.now(),
    stats: { kills: 0, victories: 0, deaths: 0, gamesPlayed: 0 },
    loadout: { favoriteWeapon: 'pistol' },
  };
}

export function listUsernames() {
  return Object.keys(loadStorage().users);
}

export async function register(username, password) {
  username = (username || '').trim();
  if (username.length < 2) throw new Error('שם משתמש חייב להיות לפחות 2 תווים');
  if (username.length > 20) throw new Error('שם משתמש ארוך מדי');
  if (!password || password.length < 4) throw new Error('סיסמה חייבת להיות לפחות 4 תווים');
  const data = loadStorage();
  if (data.users[username]) throw new Error('שם המשתמש כבר תפוס');
  const salt = newSalt();
  const passwordHash = await hashPassword(password, salt);
  data.users[username] = defaultUserRecord(salt, passwordHash);
  data.currentUser = username;
  saveStorage(data);
  return getCurrentUser();
}

export async function login(username, password) {
  username = (username || '').trim();
  const data = loadStorage();
  const user = data.users[username];
  if (!user) throw new Error('שם משתמש לא קיים');
  const hash = await hashPassword(password, user.salt);
  if (hash !== user.passwordHash) throw new Error('סיסמה שגויה');
  data.currentUser = username;
  saveStorage(data);
  return getCurrentUser();
}

export function logout() {
  const data = loadStorage();
  data.currentUser = null;
  saveStorage(data);
}

export function getCurrentUser() {
  const data = loadStorage();
  if (!data.currentUser) return null;
  const user = data.users[data.currentUser];
  if (!user) return null;
  return {
    name: data.currentUser,
    createdAt: user.createdAt,
    stats: { ...user.stats },
    loadout: { ...user.loadout },
  };
}

// Increment a numeric stat for the current user.
export function bumpStat(key, by = 1) {
  const data = loadStorage();
  if (!data.currentUser) return;
  const u = data.users[data.currentUser];
  if (!u) return;
  u.stats[key] = (u.stats[key] || 0) + by;
  saveStorage(data);
}

export function setFavoriteWeapon(weaponId) {
  const data = loadStorage();
  if (!data.currentUser) return;
  const u = data.users[data.currentUser];
  if (!u) return;
  u.loadout.favoriteWeapon = weaponId;
  saveStorage(data);
}

// Dev helper: wipe all stored users (e.g. `__fps.auth.wipeAll()` in DevTools)
export function wipeAll() {
  localStorage.removeItem(STORAGE_KEY);
}
