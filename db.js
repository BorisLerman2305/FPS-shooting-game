// Postgres connection + queries.
//
// Railway provides DATABASE_URL automatically when a Postgres add-on is linked
// to the service via Reference Variable. Locally, set it in .env or shell.

import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set. The app will fail to query.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres connection doesn't require SSL; the public one does.
  // Detect by URL — if it contains "railway.internal" we skip SSL.
  ssl: process.env.DATABASE_URL && /railway\.internal/.test(process.env.DATABASE_URL)
    ? false
    : { rejectUnauthorized: false },
});

// CREATE TABLE IF NOT EXISTS — runs on every server boot. Safe & idempotent.
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      username        VARCHAR(20) UNIQUE NOT NULL,
      password_hash   VARCHAR(120) NOT NULL,
      is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
      is_disabled     BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login      TIMESTAMPTZ,
      kills           INTEGER NOT NULL DEFAULT 0,
      victories       INTEGER NOT NULL DEFAULT 0,
      deaths          INTEGER NOT NULL DEFAULT 0,
      games_played   INTEGER NOT NULL DEFAULT 0,
      coins           INTEGER NOT NULL DEFAULT 0,
      favorite_weapon VARCHAR(20) NOT NULL DEFAULT 'pistol'
    )
  `);
  // Make sure existing databases also pick up the new column.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS owned_items TEXT[] NOT NULL DEFAULT '{}'`);
  // B4: PvP rating (Elo-style, starts at 1000)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pvp_elo INTEGER NOT NULL DEFAULT 1000`);
  // B2: daily challenges — server stores the rolled set + per-challenge progress
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_challenges JSONB NOT NULL DEFAULT '{}'::jsonb`);
  // Cosmetic skin — which avatar appearance the player currently wears
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS skin VARCHAR(20) NOT NULL DEFAULT 'classic'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_kills_idx     ON users (kills DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_victories_idx ON users (victories DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_coins_idx     ON users (coins DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_pvp_elo_idx   ON users (pvp_elo DESC)`);
  console.log('[db] migration complete');
}

// Public-facing user shape we return to the client (no password fields)
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.username,
    isAdmin: row.is_admin,
    isDisabled: row.is_disabled,
    createdAt: row.created_at,
    lastLogin: row.last_login,
    stats: {
      kills: row.kills,
      victories: row.victories,
      deaths: row.deaths,
      gamesPlayed: row.games_played,
      coins: row.coins,
      pvpElo: row.pvp_elo,
    },
    loadout: {
      favoriteWeapon: row.favorite_weapon,
      skin: row.skin || 'classic',
    },
    ownedItems: row.owned_items || [],
    dailyChallenges: row.daily_challenges || {},
  };
}

// ─── Shop ────────────────────────────────────────────────────────────────
// Atomically charge a user `cost` coins and add `itemId` to their owned list.
// Returns the updated row (or null if the user couldn't afford it / already owns it).
export async function buyItem(id, itemId, cost) {
  const { rows } = await pool.query(
    `UPDATE users
     SET coins = coins - $3,
         owned_items = array_append(owned_items, $2)
     WHERE id = $1
       AND coins >= $3
       AND NOT ($2 = ANY(owned_items))
     RETURNING *`,
    [id, itemId, cost]
  );
  return rows[0] || null;
}

// ─── Queries ─────────────────────────────────────────────────────────────
export async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function userCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  return rows[0].n;
}

export async function createUser({ username, passwordHash, isAdmin }) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, is_admin, last_login)
     VALUES ($1, $2, $3, NOW())
     RETURNING *`,
    [username, passwordHash, !!isAdmin]
  );
  return rows[0];
}

export async function touchLastLogin(id) {
  await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [id]);
}

export async function updateLoadout(id, favoriteWeapon) {
  await pool.query('UPDATE users SET favorite_weapon = $1 WHERE id = $2', [favoriteWeapon, id]);
}

export async function updateSkin(id, skin) {
  await pool.query('UPDATE users SET skin = $1 WHERE id = $2', [skin, id]);
}

export async function bumpStats(id, deltas) {
  // deltas: { kills?, victories?, deaths?, gamesPlayed?, coins? } — integers
  const { kills = 0, victories = 0, deaths = 0, gamesPlayed = 0, coins = 0 } = deltas;
  await pool.query(
    `UPDATE users SET
       kills = kills + $2,
       victories = victories + $3,
       deaths = deaths + $4,
       games_played = games_played + $5,
       coins = coins + $6
     WHERE id = $1`,
    [id, kills, victories, deaths, gamesPlayed, coins]
  );
}

export async function listAllUsers() {
  const { rows } = await pool.query(
    `SELECT * FROM users ORDER BY is_disabled ASC, last_login DESC NULLS LAST, created_at DESC`
  );
  return rows;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────
const LEADERBOARD_SORTS = {
  kills:     'kills DESC',
  victories: 'victories DESC',
  coins:     'coins DESC',
  pvp_elo:   'pvp_elo DESC',
};
export async function leaderboard(sort = 'kills', limit = 50) {
  const order = LEADERBOARD_SORTS[sort] || LEADERBOARD_SORTS.kills;
  const { rows } = await pool.query(
    `SELECT id, username, kills, victories, deaths, games_played, coins, pvp_elo, is_admin
       FROM users
       WHERE is_disabled = FALSE
       ORDER BY ${order}
       LIMIT $1`,
    [Math.max(1, Math.min(200, limit))]
  );
  return rows;
}

// ─── PvP Elo ─────────────────────────────────────────────────────────────
// Standard Elo with K=32. Winner gains expected_to_lose × K, loser loses
// the same. Floor at 100 so a bad streak can't go negative.
export async function applyPvpKill(winnerId, loserId) {
  if (!winnerId || !loserId || winnerId === loserId) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, pvp_elo FROM users WHERE id = ANY($1::int[]) FOR UPDATE',
      [[winnerId, loserId]]
    );
    const w = rows.find(r => r.id === winnerId);
    const l = rows.find(r => r.id === loserId);
    if (!w || !l) { await client.query('ROLLBACK'); return null; }
    const Ew = 1 / (1 + Math.pow(10, (l.pvp_elo - w.pvp_elo) / 400));
    const K = 32;
    const delta = Math.round(K * (1 - Ew));
    const newW = Math.max(100, w.pvp_elo + delta);
    const newL = Math.max(100, l.pvp_elo - delta);
    await client.query('UPDATE users SET pvp_elo = $1 WHERE id = $2', [newW, winnerId]);
    await client.query('UPDATE users SET pvp_elo = $1 WHERE id = $2', [newL, loserId]);
    await client.query('COMMIT');
    return { winnerElo: newW, loserElo: newL, delta };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Daily challenges ────────────────────────────────────────────────────
// JSONB shape stored per user: { date: 'YYYY-MM-DD', list: [{...}, {...}, {...}] }
// Each challenge: { id, type, target, progress, claimed }
export async function setDailyChallenges(userId, payload) {
  await pool.query('UPDATE users SET daily_challenges = $1 WHERE id = $2', [payload, userId]);
}
export async function getDailyChallenges(userId) {
  const { rows } = await pool.query('SELECT daily_challenges FROM users WHERE id = $1', [userId]);
  return rows[0]?.daily_challenges || {};
}

export async function setUserDisabled(id, disabled) {
  await pool.query('UPDATE users SET is_disabled = $1 WHERE id = $2', [disabled, id]);
}

export async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

export async function setUserAdmin(id, isAdmin) {
  await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, id]);
}

// Admin: add (or subtract) coins from a user. Clamped at 0 so balances can't
// go negative regardless of how aggressive the delta is.
export async function adminAddCoins(id, delta) {
  await pool.query(
    'UPDATE users SET coins = GREATEST(0, coins + $2) WHERE id = $1',
    [id, delta]
  );
}
