# Mobile Web App Kit

A drop-in bundle that turns a web app into a **fullscreen-feeling PWA** on
phones and tablets, without touching the rest of the app's logic.

Extracted from a working FPS game that runs as a home-screen app on both
Android Chrome and iOS Safari.

## What you get when applied

| Behavior | How |
|---|---|
| URL bar auto-hides on Android on first user tap | Fullscreen API on first gesture |
| Site can be added to iPhone home screen as a true app | PWA manifest + Apple meta tags |
| One-time gold "Add to Home Screen" hint for iOS Safari users | JS in `mobile-bootstrap.js` |
| iPhone notch / Dynamic Island / home bar respected | `env(safe-area-inset-*)` in CSS |
| No "black strip" at the bottom of the canvas when URL bar collapses | `visualViewport` + multiple resize listeners |
| Both portrait and landscape work | Layered `@media (orientation: …)` rules |
| Touch-only UI elements toggle automatically | `body.is-touch` class flipped by JS |
| Deploys propagate immediately — no "stale HTML on mobile" | Cache headers (HTML no-cache, hashed assets long-lived) |
| Status bar tint matches the app | `theme-color` meta + Apple status-bar style |

## What's in the bundle

```
mobile-kit/
├── CLAUDE_INSTRUCTIONS.md   ← read this if you're an AI agent
├── README.md                ← you are here
├── INTEGRATION.md           ← step-by-step integration recipe
├── public/
│   ├── manifest.json        ← PWA manifest template
│   └── icon.svg             ← placeholder crosshair icon
├── head-snippet.html        ← <head> additions
├── mobile-bootstrap.js      ← vanilla JS module
├── mobile.css               ← vanilla CSS
└── server-cache-headers.md  ← Express + nginx + Cloudflare patterns
```

Everything is **vanilla**: no React, no build step, no npm packages needed.
Compatible with any web stack.

## Quick start

For humans: read `INTEGRATION.md`.
For AI agents acting on a target project: read `CLAUDE_INSTRUCTIONS.md` first.

## Honest scope

**Included:** presentation layer (PWA install, fullscreen, viewport, caching).

**Not included:**
- Touch input controls (virtual joystick, drag-to-look) — game-specific
- Service Worker / offline mode — separate concern, not needed for fullscreen
- Push notifications — out of scope
- Auth, networking, persistence — out of scope

## Origin

Extracted from the FPS Game project at https://github.com/BorisLerman2305/FPS-shooting-game
under the same conditions (free to copy + adapt).
