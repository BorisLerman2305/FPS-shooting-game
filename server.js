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
  createUser, touchLastLogin, updateLoadout, bumpStats,
  listAllUsers, setUserDisabled, deleteUser, setUserAdmin,
  publicUser,
} from './db.js';

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
  const fav = (req.body.favoriteWeapon || '').trim();
  const allowed = ['pistol', 'rifle', 'sniper', 'shotgun', 'sword', 'flamethrower'];
  if (!allowed.includes(fav)) return res.status(400).json({ error: 'נשק לא חוקי' });
  await updateLoadout(req.user.id, fav);
  res.json({ ok: true });
});

app.post('/api/me/stats', authMiddleware(true), async (req, res) => {
  // Accept partial deltas: { kills, victories, deaths, gamesPlayed }
  const deltas = {};
  for (const key of ['kills', 'victories', 'deaths', 'gamesPlayed']) {
    const v = req.body[key];
    if (v == null) continue;
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      return res.status(400).json({ error: `ערך לא חוקי עבור ${key}` });
    }
    deltas[key] = Math.floor(v);
  }
  await bumpStats(req.user.id, deltas);
  const row = await findUserById(req.user.id);
  res.json({ user: publicUser(row) });
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
app.use(express.static(distDir, { maxAge: '1h' }));
// SPA fallback so refreshing on any path serves the same index.html
app.get(/^(?!\/api\/).*/, (req, res) => {
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
