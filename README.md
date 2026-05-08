# 🎮 FPS Game

Browser-based first-person shooter built with **Three.js**, **Vite**, and **PeerJS**.
A father–son coding project — the gameplay grows alongside the build.

## Features

- **6 weapons**: pistol, assault rifle, sniper rifle, shotgun, sword, flamethrower
- **Bots with AI**: 3 difficulty levels, line-of-sight chasing, configurable kill quota (1–200)
- **Pickups**: med kits, ammo crates, grenade packs, flamethrower fuel — respawn on a timer
- **Throwable grenades** (`G` key) with ballistic arc + AOE damage
- **Stamina + sprint** (Shift)
- **Local user accounts** with stats and a favorite-weapon loadout
- **Multiplayer co-op** (up to 4 players) via PeerJS / WebRTC — share a 5-character room code
- **Postprocessing**: bloom, tone mapping, procedural grass/wood/stone textures
- **Synthesized sound effects** via WebAudio (no asset files)

## Architecture

- **Frontend**: Vite + Three.js, talks to the API over `/api/*`
- **Backend**: Express + PostgreSQL (`server.js` + `db.js`)
- **Auth**: bcrypt-hashed passwords, JWT session tokens (30-day expiry)
- **Admin panel**: the first user to register becomes admin automatically

## Run locally

You'll need a local Postgres instance. Then:

```bash
cp .env.example .env
# edit .env — set DATABASE_URL + JWT_SECRET
npm install
npm run dev    # runs Vite (5174) + Express (3001) concurrently
```

Open http://localhost:5174 — the first user to register is granted admin.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** → pick this repo.
3. **+ New → Database → Add PostgreSQL** in the same project.
4. On the web service: **Variables → New Variable → Add Reference** →
   pick `DATABASE_URL` from the Postgres service. Railway will inject it.
5. **Variables → New Variable** → add `JWT_SECRET` set to a long random string.
   Generate one with: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
6. **Settings → Networking → Generate Domain** to get a public HTTPS URL.
7. Open the URL — register the first account; you become admin.

## Build for production

```bash
npm run build  # bundles the frontend into dist/
npm start      # `node server.js` — serves dist/ + API on $PORT
```

## Multiplayer

1. One player picks **🌐 ארח חדר** → "צור חדר" → shares the 5-character code
2. Friends pick **🔗 הצטרף**, type the code, and join
3. The host clicks a difficulty → everyone starts the same level together

## Tech

- **Three.js** for 3D rendering
- **Vite** for dev server + build
- **PeerJS** (WebRTC) for peer-to-peer multiplayer (no backend required)
- **WebAudio** for sound synthesis
- **localStorage** for user accounts (SHA-256 + per-user salt)

## Controls

| Key | Action |
|-----|--------|
| `WASD` | Move |
| `Mouse` | Look |
| `Shift` | Sprint (drains stamina) |
| `Space` | Jump |
| `Left click` | Fire / hold for auto |
| `Right click` | Zoom (sniper only) |
| `R` | Reload |
| `1-6` | Switch weapons |
| `G` | Throw grenade |
| `Esc` | Pause |
