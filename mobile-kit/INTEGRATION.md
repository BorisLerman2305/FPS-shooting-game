# Integration Recipe

Apply the kit to a target web app in 5 steps. Each step lists *what to do*
and *how to verify it worked* before moving on.

> **Symbols used below**
> - `$ROOT` = the target project's repo root
> - `$STATIC` = wherever the target serves static files from (Vite/Next/CRA: `public/`; plain HTML: same folder as `index.html`; Django: `static/`; Rails: `public/`)
> - `$HEAD` = wherever the target's `<head>` lives (single HTML file, or framework layout component)

---

## Step 1 — PWA assets (manifest + icon)

Copy:
- `mobile-kit/public/manifest.json` → `$ROOT/$STATIC/manifest.json`
- `mobile-kit/public/icon.svg`      → `$ROOT/$STATIC/icon.svg`

Then edit `manifest.json`:
- `name`        — the long app name (e.g. "My Cool App")
- `short_name`  — 12 chars or fewer (shows under the home-screen icon)
- `description` — one-liner
- `theme_color` + `background_color` — keep them identical for a clean PWA splash
- `lang`        — language code, e.g. `"en"` or `"he"`
- `dir`         — `"ltr"` or `"rtl"`

If the user provided a custom icon, replace `icon.svg`. If they only have a
PNG, swap the manifest icon entry to:
```json
{ "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
```
…and drop the PNG into `$STATIC/`.

**Verify:** open `https://your-domain/manifest.json` — should return the JSON.
Open `/icon.svg` — should return the SVG.

---

## Step 2 — `<head>` additions

Copy the contents of `mobile-kit/head-snippet.html` into the target's `<head>`,
just after the existing `<title>` / `<meta charset>` lines.

If the target uses a framework layout (Next.js `_document.tsx`, Nuxt
`app.vue`, etc.), translate to the framework's idiom — keep the *meta names*
and *link rels* identical.

In any meta tag with placeholder text, swap the placeholder for the user's
real value. Look for `MY APP NAME` and `#16213e` and replace.

**Verify:** view-source on the deployed page — confirm:
- `<link rel="manifest" href="/manifest.json">` is present
- `<meta name="apple-mobile-web-app-capable" content="yes">` is present
- `<meta name="theme-color" content="#…">` matches the app's brand

---

## Step 3 — JavaScript

Copy:
- `mobile-kit/mobile-bootstrap.js` → `$ROOT/$STATIC/mobile-bootstrap.js`
   (or anywhere your build can serve as a static module)

Reference it from your entry HTML, just before `</body>`:

```html
<script type="module" src="/mobile-bootstrap.js"></script>
```

If the target is bundled (Vite/webpack/esbuild), instead `import` it from
the entry script:

```js
import './mobile-bootstrap.js';
```

The module is **side-effect-only**: it runs immediately and wires up the
fullscreen behavior, iOS hint, and viewport-resize fixes. No exports to
configure.

**Verify:** open the page on a real Android device, tap any button. URL bar
should disappear into fullscreen.

---

## Step 4 — CSS

Copy `mobile-kit/mobile.css` into the target's stylesheet folder, then
import or `<link>` it AFTER any other CSS so its rules take precedence.

```html
<link rel="stylesheet" href="/mobile.css" />
```

The stylesheet:
- Adds `body.is-touch` selector hooks (the JS adds the class on touch devices)
- Defines responsive media queries for landscape phones + small portrait
- Wires `env(safe-area-inset-*)` so notch/Dynamic Island/home bar are respected
- Styles the iOS install hint banner (`#mobileKitIOSHint`)

If the target already has a CSS reset or theme, the kit's rules are
non-destructive (only target their own selectors).

**Verify:** open dev tools on a deployed mobile session, inspect `<body>` —
class list should include `is-touch` on a real phone (won't on desktop).

---

## Step 5 — Server cache headers

Required for the "deploys propagate immediately" behavior. Without this
step, mobile users will see stale HTML for hours after each deploy.

Open `mobile-kit/server-cache-headers.md` and apply the snippet that
matches the target's server (Express, Fastify, nginx, Cloudflare Pages,
Netlify, Vercel, etc.).

The pattern is always the same:
- Files in `/assets/*` (or any content-hashed path) → `max-age=2592000, immutable`
- Everything else, especially HTML → `Cache-Control: no-cache, must-revalidate`

**Verify:** deploy a change, hard-refresh on mobile. The change should
appear immediately, not after waiting for the cache to expire.

---

## Manual smoke test (final)

1. **Android Chrome** — tap a button → URL bar collapses → no black strip
2. **iOS Safari** — gold hint appears once → Add to Home Screen → opens chrome-less
3. **Desktop browser** — nothing changed; site works as before
4. **Rotate the phone** — landscape and portrait both render correctly
5. **Hard refresh after deploy** — new code shows immediately

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Manifest says "no icon" in DevTools | Icon path wrong | Visit `/icon.svg` directly; ensure 200 OK |
| iOS hint never appears | Already in standalone OR sessionStorage already set OR not Safari | Clear `sessionStorage`, open in Safari (not Chrome iOS) |
| Black strip at bottom on Android | Resize listener not running | Check console — `mobile-bootstrap.js` should log `[mobile-kit] ready` |
| Theme color not respected | Multiple `theme-color` metas | Make sure only one `<meta name="theme-color">` exists |
| Add-to-home-screen still opens in Safari | `apple-mobile-web-app-capable` missing | Re-check head snippet was applied to the live page |
| Stale code on mobile after deploy | Cache headers not set OR stale CDN | Check `Cache-Control` header on the HTML response (DevTools → Network) — should be `no-cache, must-revalidate` |
