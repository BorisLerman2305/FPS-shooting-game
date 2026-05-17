// Express server: serves the built static client + a small REST API.
//
// In production (Railway), this single process handles BOTH the game's HTML/JS
// (out of dist/) and the /api/* endpoints. In dev we run Vite alongside it on
// a different port and proxy /api requests.

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrate, pool,
  findUserByUsername, findUserById, userCount,
  createUser, touchLastLogin, updateLoadout, bumpStats, buyItem,
  listAllUsers, setUserDisabled, deleteUser, setUserAdmin,
  publicUser, leaderboard, applyPvpKill,
  setDailyChallenges, getDailyChallenges, adminAddCoins, updateSkin,
} from './db.js';

// ─── Shop catalog (server-authoritative — client cannot fake costs) ──────
// Mirrored on the client (src/shop.js) so both sides agree on what exists.
const SHOP_ITEMS = {
  rpg:           { kind: 'weapon', cost: 100 },
  tommyGun:      { kind: 'weapon', cost: 250 },
  lightsaber:    { kind: 'weapon', cost: 500 },
  crossbow:      { kind: 'weapon', cost: 150 },
  minigun:       { kind: 'weapon', cost: 400 },
  hpBoost:       { kind: 'perk',   cost: 200 },
  staminaBoost:  { kind: 'perk',   cost: 150 },
  grenadeMax:    { kind: 'perk',   cost: 100 },
  // Weapon attachments — cheap-ish, one-time buy, auto-active in every match
  scopeRifle:    { kind: 'attach', cost: 80  },
  bigMagRifle:   { kind: 'attach', cost: 60  },
  bigMagPistol:  { kind: 'attach', cost: 40  },
  fastReload:    { kind: 'attach', cost: 120 },
  extraPellets:  { kind: 'attach', cost: 80  },
  sharpSword:    { kind: 'attach', cost: 70  },
  // Cosmetic skins — change the look of the player's avatar only
  skinNinja:     { kind: 'skin',   cost: 80  },
  skinRobot:     { kind: 'skin',   cost: 120 },
  skinAstronaut: { kind: 'skin',   cost: 150 },
  skinWizard:    { kind: 'skin',   cost: 200 },
};

// Skin shop IDs → the active 'skin' value stored on the user row. 'classic'
// is the free default and isn't in SHOP_ITEMS.
const SKIN_IDS = new Set(['classic', 'skinNinja', 'skinRobot', 'skinAstronaut', 'skinWizard']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me-in-prod';
const JWT_EXPIRES_IN = '30d';

if (JWT_SECRET === 'dev-only-secret-change-me-in-prod' && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  JWT_SECRET is using the dev default in production! Set a real secret in env vars.');
}

const app = express();
app.use(express.json({ limit: '32kb' }));

// ─── Auth helpers ────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, name: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authMiddleware(required = true) {
  return async (req, res, next) => {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/);
    if (!match) {
      if (required) return res.status(401).json({ error: 'לא מחובר' });
      req.user = null;
      return next();
    }
    try {
      const decoded = jwt.verify(match[1], JWT_SECRET);
      const row = await findUserById(decoded.id);
      if (!row) return res.status(401).json({ error: 'משתמש לא קיים' });
      if (row.is_disabled) return res.status(403).json({ error: 'החשבון הושבת' });
      req.user = row;
      next();
    } catch {
      if (required) return res.status(401).json({ error: 'טוקן לא תקף' });
      req.user = null;
      next();
    }
  };
}

function adminOnly(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'נדרש Admin' });
  next();
}

// ─── Auth routes ─────────────────────────────────────────────────────────
function validateCreds(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'שם משתמש וסיסמה חייבים להיות טקסט';
  }
  username = username.trim();
  if (username.length < 2) return 'שם משתמש קצר מדי (מינימום 2 תווים)';
  if (username.length > 20) return 'שם משתמש ארוך מדי';
  if (!/^[A-Za-zא-ת0-9_\- ]+$/.test(username)) return 'שם משתמש מכיל תווים לא חוקיים';
  if (password.length < 4) return 'סיסמה חייבת להיות לפחות 4 תווים';
  if (password.length > 100) return 'סיסמה ארוכה מדי';
  return null;
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const err = validateCreds(username, password);
    if (err) return res.status(400).json({ error: err });

    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'שם המשתמש כבר תפוס' });

    const passwordHash = await bcrypt.hash(password, 10);
    // First registered user becomes the admin (bootstrap mechanism)
    const isAdmin = (await userCount()) === 0;
    const row = await createUser({ username, passwordHash, isAdmin });
    const token = signToken(row);
    res.json({ token, user: publicUser(row) });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    if (!username || !password) return res.status(400).json({ error: 'חסרים שם משתמש או סיסמה' });
    const row = await findUserByUsername(username);
    if (!row) return res.status(401).json({ error: 'שם משתמש לא קיים' });
    if (row.is_disabled) return res.status(403).json({ error: 'החשבון הושבת ע"י מנהל' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'סיסמה שגויה' });
    await touchLastLogin(row.id);
    const token = signToken(row);
    res.json({ token, user: publicUser(row) });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.get('/api/auth/me', authMiddleware(true), async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ─── User-facing endpoints (logged-in user updates their own data) ──────
app.patch('/api/me/loadout', authMiddleware(true), async (req, res) => {
  // Accept ANY combination of { favoriteWeapon?, skin? } in one call.
  // We validate each field independently and only update what was passed in.
  let touched = false;
  if (req.body.favoriteWeapon !== undefined) {
    const fav = (req.body.favoriteWeapon || '').trim();
    // Base weapons everyone has access to. Shop weapons require ownership.
    const baseWeapons = ['pistol', 'rifle', 'sniper', 'shotgun', 'sword', 'flamethrower'];
    const shopWeapons = ['rpg', 'tommyGun', 'lightsaber', 'crossbow', 'minigun'];
    if (![...baseWeapons, ...shopWeapons].includes(fav)) {
      return res.status(400).json({ error: 'נשק לא חוקי' });
    }
    if (shopWeapons.includes(fav) && !(req.user.owned_items || []).includes(fav)) {
      return res.status(403).json({ error: 'הנשק לא ברשותך' });
    }
    await updateLoadout(req.user.id, fav);
    touched = true;
  }
  if (req.body.skin !== undefined) {
    const skin = (req.body.skin || '').trim();
    if (!SKIN_IDS.has(skin)) {
      return res.status(400).json({ error: 'סקין לא חוקי' });
    }
    // 'classic' is free for everyone; paid skins must be owned
    if (skin !== 'classic' && !(req.user.owned_items || []).includes(skin)) {
      return res.status(403).json({ error: 'הסקין לא ברשותך' });
    }
    await updateSkin(req.user.id, skin);
    touched = true;
  }
  if (!touched) return res.status(400).json({ error: 'לא נשלח שינוי' });
  res.json({ ok: true });
});

app.post('/api/me/stats', authMiddleware(true), async (req, res) => {
  // Accept partial deltas: { kills, victories, deaths, gamesPlayed, coins }
  const deltas = {};
  for (const key of ['kills', 'victories', 'deaths', 'gamesPlayed', 'coins']) {
    const v = req.body[key];
    if (v == null) continue;
    // Coins reward is small (max 5 per BOSS) — cap at 200 per call to be safe
    if (!Number.isFinite(v) || v < 0 || v > 200) {
      return res.status(400).json({ error: `ערך לא חוקי עבור ${key}` });
    }
    deltas[key] = Math.floor(v);
  }
  await bumpStats(req.user.id, deltas);
  const row = await findUserById(req.user.id);
  res.json({ user: publicUser(row) });
});

// ─── Leaderboard ─────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  const sort = ['kills', 'victories', 'coins', 'pvp_elo'].includes(req.query.sort)
    ? req.query.sort : 'kills';
  try {
    const rows = await leaderboard(sort, 50);
    res.json({ sort, players: rows.map(r => ({
      id: r.id, name: r.username, isAdmin: r.is_admin,
      kills: r.kills, victories: r.victories, deaths: r.deaths,
      gamesPlayed: r.games_played, coins: r.coins, pvpElo: r.pvp_elo,
    })) });
  } catch (e) {
    console.error('[leaderboard]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── PvP rating ──────────────────────────────────────────────────────────
app.post('/api/me/pvp-kill', authMiddleware(true), async (req, res) => {
  const targetId = parseInt(req.body && req.body.targetId, 10);
  if (!Number.isFinite(targetId) || targetId === req.user.id) {
    return res.status(400).json({ error: 'יעד לא חוקי' });
  }
  try {
    const result = await applyPvpKill(req.user.id, targetId);
    if (!result) return res.status(404).json({ error: 'יעד לא נמצא' });
    const row = await findUserById(req.user.id);
    res.json({ ...result, user: publicUser(row) });
  } catch (e) {
    console.error('[pvp-kill]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── Daily challenges ────────────────────────────────────────────────────
// Pool of templates — random 3 are rolled per user per day. type names
// match the client-side bumpDailyChallenge() calls.
const CHALLENGE_TEMPLATES = [
  { type: 'kill_bots',       target:  20, reward: 30, label: 'הרוג 20 בוטים' },
  { type: 'kill_bots',       target:  50, reward: 80, label: 'הרוג 50 בוטים' },
  { type: 'kill_boss',       target:   1, reward: 40, label: 'הרוג 1 BOSS' },
  { type: 'kill_boss',       target:   3, reward: 120,label: 'הרוג 3 BOSSים' },
  { type: 'win_games',       target:   3, reward: 60, label: 'נצח ב-3 משחקים' },
  { type: 'kill_sniper',     target:   5, reward: 35, label: 'הרוג 5 צלפים' },
  { type: 'kill_kamikaze',   target:   5, reward: 35, label: 'הרוג 5 קמיקזות' },
  { type: 'kill_healer',     target:   3, reward: 35, label: 'הרוג 3 רופאים' },
  { type: 'earn_coins',      target: 100, reward: 40, label: 'הרווח 100 מטבעות' },
  { type: 'play_games',      target:   5, reward: 25, label: 'שחק 5 משחקים' },
  { type: 'kill_with_sword', target:  10, reward: 50, label: 'הרוג 10 עם חרב' },
  { type: 'kill_with_rpg',   target:   8, reward: 60, label: 'הרוג 8 עם RPG' },
];

function todayKey() {
  // Day key in the server's UTC date — coarse but consistent
  return new Date().toISOString().slice(0, 10);
}
function rollDailyChallenges() {
  // Pick 3 distinct templates
  const pool = [...CHALLENGE_TEMPLATES];
  const picked = [];
  while (picked.length < 3 && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    const [tpl] = pool.splice(i, 1);
    picked.push({
      id: Math.random().toString(36).slice(2, 9),
      type: tpl.type, target: tpl.target, reward: tpl.reward, label: tpl.label,
      progress: 0, claimed: false,
    });
  }
  return { date: todayKey(), list: picked };
}

// Returns today's challenges; rolls a new set if the stored ones are stale.
async function ensureTodayChallenges(userId) {
  const stored = await getDailyChallenges(userId);
  if (stored && stored.date === todayKey() && Array.isArray(stored.list) && stored.list.length === 3) {
    return stored;
  }
  const fresh = rollDailyChallenges();
  await setDailyChallenges(userId, fresh);
  return fresh;
}

app.get('/api/me/challenges', authMiddleware(true), async (req, res) => {
  try {
    const challenges = await ensureTodayChallenges(req.user.id);
    res.json({ challenges });
  } catch (e) {
    console.error('[challenges]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/me/challenges/progress', authMiddleware(true), async (req, res) => {
  const type = String(req.body && req.body.type || '');
  const by = Math.max(1, Math.min(100, Math.floor(Number(req.body && req.body.by) || 1)));
  try {
    const challenges = await ensureTodayChallenges(req.user.id);
    let touched = false;
    for (const c of challenges.list) {
      if (c.type !== type || c.claimed) continue;
      if (c.progress >= c.target) continue;
      c.progress = Math.min(c.target, c.progress + by);
      touched = true;
    }
    if (touched) await setDailyChallenges(req.user.id, challenges);
    res.json({ challenges });
  } catch (e) {
    console.error('[challenges/progress]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

app.post('/api/me/challenges/claim', authMiddleware(true), async (req, res) => {
  const id = String(req.body && req.body.id || '');
  try {
    const challenges = await ensureTodayChallenges(req.user.id);
    const c = challenges.list.find(x => x.id === id);
    if (!c) return res.status(404).json({ error: 'משימה לא נמצאה' });
    if (c.claimed) return res.status(409).json({ error: 'כבר הוחלפה' });
    if (c.progress < c.target) return res.status(409).json({ error: 'המשימה לא הושלמה' });
    c.claimed = true;
    await setDailyChallenges(req.user.id, challenges);
    // Grant the reward as coins on the user record
    await bumpStats(req.user.id, { coins: c.reward });
    const row = await findUserById(req.user.id);
    res.json({ user: publicUser(row), challenges, reward: c.reward });
  } catch (e) {
    console.error('[challenges/claim]', e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
});

// ─── Achievements (derived from stats — no DB writes needed) ─────────────
// Each achievement: { id, name, description, check(user) → bool, reward }
const ACHIEVEMENTS = [
  { id: 'first_blood',  name: 'דם ראשון',     description: 'הרוג בוט אחד',                check: u => u.kills >= 1 },
  { id: 'killer_25',    name: 'מתחיל',         description: 'הרוג 25 בוטים',              check: u => u.kills >= 25 },
  { id: 'killer_100',   name: 'מקצוען',        description: 'הרוג 100 בוטים',             check: u => u.kills >= 100 },
  { id: 'killer_500',   name: 'מסיר ראשים',     description: 'הרוג 500 בוטים',             check: u => u.kills >= 500 },
  { id: 'killer_1000',  name: 'אגדה',          description: 'הרוג 1000 בוטים',            check: u => u.kills >= 1000 },
  { id: 'first_win',    name: 'ניצחון ראשון',   description: 'נצח במשחק אחד',              check: u => u.victories >= 1 },
  { id: 'winner_10',    name: 'מנצח סדרתי',     description: 'נצח ב-10 משחקים',             check: u => u.victories >= 10 },
  { id: 'winner_50',    name: 'אלוף',          description: 'נצח ב-50 משחקים',             check: u => u.victories >= 50 },
  { id: 'coin_hoarder', name: 'אספן מטבעות',    description: 'צבור 500 מטבעות לאורך זמן', check: u => u.coins >= 500 },
  { id: 'rich',         name: 'עשיר',         description: 'צבור 2000 מטבעות',           check: u => u.coins >= 2000 },
  { id: 'veteran',      name: 'ותיק',          description: 'שחק ב-25 משחקים',             check: u => u.games_played >= 25 },
  { id: 'pvp_starter',  name: 'לוחם PvP',     description: 'הגע לדירוג PvP 1100',        check: u => u.pvp_elo >= 1100 },
  { id: 'pvp_master',   name: 'מאסטר PvP',    description: 'הגע לדירוג PvP 1300',        check: u => u.pvp_elo >= 1300 },
];

app.get('/api/me/achievements', authMiddleware(true), async (req, res) => {
  const u = req.user;
  const stats = {
    kills: u.kills, victories: u.victories, deaths: u.deaths,
    games_played: u.games_played, coins: u.coins, pvp_elo: u.pvp_elo,
  };
  const list = ACHIEVEMENTS.map(a => ({
    id: a.id, name: a.name, description: a.description, unlocked: a.check(stats),
  }));
  res.json({ achievements: list, unlockedCount: list.filter(a => a.unlocked).length, total: list.length });
});

// ─── Shop ────────────────────────────────────────────────────────────────
app.get('/api/shop/items', (req, res) => {
  // Just the costs/kinds — the client knows the human-readable details
  res.json({ items: SHOP_ITEMS });
});

app.post('/api/me/buy', authMiddleware(true), async (req, res) => {
  const itemId = req.body && req.body.itemId;
  if (typeof itemId !== 'string' || !SHOP_ITEMS[itemId]) {
    return res.status(400).json({ error: 'פריט לא קיים בחנות' });
  }
  const { cost } = SHOP_ITEMS[itemId];
  // Refresh the user record so we don't act on a stale balance
  const fresh = await findUserById(req.user.id);
  if (!fresh) return res.status(404).json({ error: 'משתמש לא נמצא' });
  if ((fresh.owned_items || []).includes(itemId)) {
    return res.status(409).json({ error: 'כבר ברשותך' });
  }
  if (fresh.coins < cost) {
    return res.status(402).json({ error: 'אין מספיק מטבעות' });
  }
  const updated = await buyItem(req.user.id, itemId, cost);
  if (!updated) return res.status(409).json({ error: 'הקנייה נכשלה' });
  res.json({ user: publicUser(updated) });
});

// ─── Admin endpoints ─────────────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware(true), adminOnly, async (req, res) => {
  const rows = await listAllUsers();
  res.json({ users: rows.map(publicUser) });
});

app.patch('/api/admin/users/:id/disable', authMiddleware(true), adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'לא ניתן להשבית את עצמך' });
  await setUserDisabled(id, true);
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id/enable', authMiddleware(true), adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await setUserDisabled(id, false);
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id/promote', authMiddleware(true), adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await setUserAdmin(id, true);
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id/demote', authMiddleware(true), adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'לא ניתן להוריד את עצמך' });
  await setUserAdmin(id, false);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware(true), adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'לא ניתן למחוק את עצמך' });
  await deleteUser(id);
  res.json({ ok: true });
});

// Admin: add or subtract coins from a user. Body: { amount: integer (±) }.
// We clamp the resulting balance at 0 in the DB so a huge negative can't
// leave anyone in the red.
app.patch('/api/admin/users/:id/coins', authMiddleware(true), adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const amount = parseInt(req.body && req.body.amount, 10);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'סכום לא תקין' });
  }
  // Guardrail: cap a single grant at ±1,000,000 so a typo can't blow the economy
  if (Math.abs(amount) > 1_000_000) {
    return res.status(400).json({ error: 'סכום גדול מדי (מקסימום מיליון לפעולה)' });
  }
  await adminAddCoins(id, amount);
  res.json({ ok: true });
});

// ─── Health check ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'db unreachable' });
  }
});

// ─── Static client (production) ──────────────────────────────────────────
const distDir = path.join(__dirname, 'dist');
// Hashed Vite bundles inside /assets/* are content-addressed — safe to cache
// for a long time; their filenames change on every rebuild.
app.use('/assets', express.static(path.join(distDir, 'assets'), {
  maxAge: '30d',
  immutable: true,
}));
// Everything else (manifest, icon, etc.) — short cache so deploys propagate
app.use(express.static(distDir, { maxAge: '5m' }));
// SPA fallback. The HTML itself MUST NOT be cached aggressively or browsers
// keep pointing at stale hashed bundles after a deploy.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(distDir, 'index.html'));
});

// ─── Boot ────────────────────────────────────────────────────────────────
(async () => {
  try {
    await migrate();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🎮 FPS server listening on :${PORT}`);
    });
  } catch (e) {
    console.error('Failed to boot:', e);
    process.exit(1);
  }
})();
