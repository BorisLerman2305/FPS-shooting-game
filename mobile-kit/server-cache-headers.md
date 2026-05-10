# Server cache headers

Required for the kit's "deploys propagate immediately" behavior. Without
this, mobile users will run **stale code** for hours after every deploy
because phones aggressively cache HTML.

## The pattern (all servers)

| Resource | Cache-Control |
|---|---|
| `/assets/*` (or any content-hashed bundle) | `public, max-age=2592000, immutable` |
| `manifest.json`, `icon.svg`, robots.txt | `public, max-age=300` (5 min) |
| **HTML** (especially `index.html`) | `no-cache, must-revalidate` |

The HTML must NOT be cached because it references content-hashed bundles by
name. New deploys produce new hashes, but if the cached HTML still points to
the old hashes the new bundles never load.

---

## Express (Node)

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const distDir = path.join(__dirname, 'dist');

// Hashed bundles — long cache, immutable
app.use('/assets', express.static(path.join(distDir, 'assets'), {
  maxAge: '30d',
  immutable: true,
}));

// Static fallback for everything else (manifest, icon, etc.) — short cache
app.use(express.static(distDir, { maxAge: '5m' }));

// SPA index — no cache, MUST be re-fetched on every navigation
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(distDir, 'index.html'));
});
```

## Fastify

```js
import fastifyStatic from '@fastify/static';
import path from 'node:path';

await app.register(fastifyStatic, {
  root: path.join(distDir, 'assets'),
  prefix: '/assets/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  immutable: true,
});
await app.register(fastifyStatic, {
  root: distDir,
  decorateReply: false,
  maxAge: 5 * 60 * 1000,
});

app.setNotFoundHandler((req, reply) => {
  reply.header('Cache-Control', 'no-cache, must-revalidate');
  reply.sendFile('index.html');
});
```

## nginx

```nginx
server {
  listen 80;
  root /var/www/dist;

  # Hashed bundles — long cache
  location ^~ /assets/ {
    add_header Cache-Control "public, max-age=2592000, immutable";
    try_files $uri =404;
  }

  # Static (manifest etc.) — short cache
  location ~* \.(json|svg|png|ico)$ {
    add_header Cache-Control "public, max-age=300";
    try_files $uri =404;
  }

  # HTML / SPA fallback — no cache
  location / {
    add_header Cache-Control "no-cache, must-revalidate";
    try_files $uri /index.html;
  }
}
```

## Cloudflare Pages / Workers

Add `_headers` at the project root:

```
/assets/*
  Cache-Control: public, max-age=2592000, immutable

/manifest.json
  Cache-Control: public, max-age=300

/icon.svg
  Cache-Control: public, max-age=300

/*.html
  Cache-Control: no-cache, must-revalidate

/
  Cache-Control: no-cache, must-revalidate
```

## Netlify

Add `_headers` at the publish directory:

```
/assets/*
  Cache-Control: public, max-age=2592000, immutable

/*
  Cache-Control: no-cache, must-revalidate
```

## Vercel

Add to `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=2592000, immutable" }]
    },
    {
      "source": "/(.*\\.html)?",
      "headers": [{ "key": "Cache-Control", "value": "no-cache, must-revalidate" }]
    }
  ]
}
```

---

## Verifying it worked

After deploying, open the live URL on a phone with DevTools attached
(or check from desktop):

1. **Open DevTools → Network** tab
2. Reload the page
3. Click the row for `index.html` (or `/`)
4. Check the response headers:
   - `Cache-Control: no-cache, must-revalidate` ✅
5. Click an `/assets/*.js` row:
   - `Cache-Control: public, max-age=2592000, immutable` ✅

If both check out, deploy a tiny change and reload on mobile — the change
should appear immediately, no manual cache-clear needed.
