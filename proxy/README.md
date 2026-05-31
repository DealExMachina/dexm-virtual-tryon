# dexm · BFL VTO Proxy

A small Node 20+ service that lets a browser-only static demo call [BFL FLUX VTO](https://docs.bfl.ai/) without exposing the API key or hitting CORS limits.

The proxy owns the full pipeline: submit → poll BFL → download → convert to WebP → serve from `/images/:id`.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/models` | Generate a person from a text prompt |
| POST | `/fittings` | Single-garment virtual try-on |
| POST | `/outfits` | Multi-garment VTO (2×2 composite, server-side) |
| GET | `/jobs/:id` | Poll async job → `{ status, image_url }` |
| GET | `/images/:id` | Serve result (WebP if `Accept: image/webp`, else JPEG) |
| GET | `/healthz` | Liveness probe |

## Deploy to Koyeb (GitHub pull)

1. **Create Service → GitHub** → `DealExMachina/dexm-virtual-tryon`
2. **Work directory:** `proxy`
3. **Run command:** `npm start`
4. **Environment:**
   - `BFL_API_KEY` — required
   - `ALLOWED_ORIGINS` — defaults to `dealexmachina.github.io`, `jeanbapt.github.io`, localhost
5. **Port:** 8000 (Koyeb sets `PORT` automatically)

Requires `package-lock.json` in `proxy/` for the Heroku Node buildpack (Sharp dependency).

Once live, set `DEFAULT_PROXY` in `docs/index.html` or push the Koyeb URL so GitHub Pages visitors connect automatically.

## Run locally

```bash
cd proxy
npm install
BFL_API_KEY=bfl_… npm start
# → http://localhost:8080
```

## Tests

```bash
npm test              # unit tests (no API key)
npm run test:e2e      # live BFL calls (needs BFL_API_KEY)
```

---

Part of [dexm-virtual-tryon](../README.md) · powered by [Black Forest Labs](https://bfl.ai)
