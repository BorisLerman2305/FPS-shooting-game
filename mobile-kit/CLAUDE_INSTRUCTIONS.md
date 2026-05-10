# Instructions for a Claude Code agent

**You are being asked to integrate a mobile-friendly web app kit into a target project.**

This folder (`mobile-kit/`) contains battle-tested code extracted from a working FPS game that runs as a fullscreen PWA on Android and iOS. Apply it to the project the user just gave you.

---

## Step 1 — Inventory

Run `ls mobile-kit/` and confirm you see:

```
CLAUDE_INSTRUCTIONS.md   ← you are here
README.md                ← human-readable overview
INTEGRATION.md           ← step-by-step recipe (READ THIS NEXT)
public/manifest.json     ← PWA manifest template
public/icon.svg          ← placeholder icon
head-snippet.html        ← <head> meta tags + links to inject
mobile-bootstrap.js      ← drop-in JS module
mobile.css               ← drop-in stylesheet
server-cache-headers.md  ← server-side caching patterns
```

## Step 2 — Understand what the kit provides

Before touching the target codebase, read these in order:
1. `README.md` — what behaviors the kit gives you
2. `INTEGRATION.md` — exact files to add and edits to make
3. Skim each asset (head-snippet, JS, CSS, manifest) so you know what you're injecting

**Do not blindly copy.** The kit was extracted from a Vite + Three.js + Express app. The target project may use different frameworks (React, Next.js, plain HTML, Django, Rails, …). Adapt:
- `head-snippet.html` → translate into the framework's head/layout component
- `mobile-bootstrap.js` → adjust import path; on bundled apps import as a module, on plain HTML use `<script type="module">`
- `mobile.css` → import or link as appropriate
- `server-cache-headers.md` → match the user's actual server (Express, Fastify, nginx, Cloudflare Pages, etc.)

## Step 3 — Ask the user 3 things before integrating

Before touching files in the target project, surface these questions:

1. **App name** for the PWA (shows on the home-screen icon, e.g. "FPS Game"). Used in `manifest.json` and apple meta tags.
2. **Theme color** (single hex, used for the status bar tint and PWA splash). Default `#16213e` if unspecified.
3. **Brand icon** — do they have a PNG/SVG they want? If not, the kit ships a generic crosshair `icon.svg`; offer to keep it or generate a quick alternative.

## Step 4 — Apply

Follow `INTEGRATION.md` precisely. The order matters: meta tags + manifest → JS → CSS → server. Verify each step before moving on.

## Step 5 — Verify

After applying, the target project must pass these manual checks:

- **Android Chrome**: open the URL → tap any button → URL bar collapses, fullscreen activates. No "black bar" at bottom of screen.
- **iOS Safari**: open the URL → wait ~1.2s → see the gold "Add to Home Screen" hint (one-time). Tap Share → Add to Home Screen → open from home screen → no Safari chrome.
- **Desktop**: nothing changes. App still works exactly as before.
- **Hard refresh after deploy**: change something in the source, redeploy, hard-refresh on mobile. The new version should appear immediately (no stale HTML cached).

If any check fails, revisit `INTEGRATION.md` § Troubleshooting.

---

## What this kit does NOT include

The FPS game's *touch input system* (virtual joystick, look area, fire buttons) is game-specific and lives in `src/touch.js` of the source project. That code isn't packaged here because most apps don't need it. If the target is also a game, the user will need to ask for it separately.

## Honest limitations

- **iOS** does not allow programmatic fullscreen for browser pages, period. Adding to the home screen is the only path. The kit handles this gracefully (shows the hint) but cannot bypass Apple's restriction.
- **In-app browsers** (Facebook, Instagram, LinkedIn, X) ignore most PWA features. Users tapping a link from those apps will get a degraded experience. Worth telling the end user.
- **PeerJS / WebRTC** behaviors from the source project are not in this kit. The kit is purely about presentation, not networking.
