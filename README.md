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

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5174 — register an account, pick a weapon, hit a difficulty.

## Build for production

```bash
npm run build
npm start    # serves dist/ on port $PORT (or 3000 by default)
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
