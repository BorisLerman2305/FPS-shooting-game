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
      favorite_weapon VARCHAR(20) NOT NULL DEFAULT 'pistol'
    )
  `);
  // Add a unique-ish lookup index for case-insensitive username search later if needed
  await pool.query(`CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))`);
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
    },
    loadout: {
      favoriteWeapon: row.favorite_weapon,
    },
  };
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

export async function bumpStats(id, deltas) {
  // deltas: { kills?, victories?, deaths?, gamesPlayed? } — all integers
  const { kills = 0, victories = 0, deaths = 0, gamesPlayed = 0 } = deltas;
  await pool.query(
    `UPDATE users SET
       kills = kills + $2,
       victories = victories + $3,
       deaths = deaths + $4,
       games_played = games_played + $5
     WHERE id = $1`,
    [id, kills, victories, deaths, gamesPlayed]
  );
}

export async function listAllUsers() {
  const { rows } = await pool.query(
    `SELECT * FROM users ORDER BY is_disabled ASC, last_login DESC NULLS LAST, created_at DESC`
  );
  return rows;
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
