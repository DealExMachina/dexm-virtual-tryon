# dexm — The Virtual Atelier

![dexm Virtual Atelier — composed outfit with bundle CTA](docs/assets/social-preview.jpg)

An interactive virtual try-on experience built on **Black Forest Labs [FLUX VTO](https://bfl.ai)**.

Pick a likeness, select a piece from the edit, and see yourself in the cloth — rendered in seconds.

**[Try the demo →](https://dealexmachina.github.io/dexm-virtual-tryon/)**

## Architecture

Two deployments from one repo:

```
docs/index.html   →  GitHub Pages   (static UI, no secrets)
proxy/server.js   →  Koyeb          (BFL API proxy, holds BFL_API_KEY)
```

The browser never sees the API key or BFL signed URLs. The proxy owns the full pipeline: submit → poll → download → convert (WebP) → serve.

## Why the proxy runs on Koyeb

GitHub Pages only serves static files — no Node, no secrets, no server-side image processing. The demo UI must still call BFL, which creates three hard requirements:

1. **Hide the API key** — `BFL_API_KEY` cannot live in client-side JavaScript shipped to every visitor.
2. **Bypass CORS** — BFL's API does not accept browser `fetch()` from `*.github.io` origins.
3. **Own the pipeline** — download BFL results server-side, convert to WebP with Sharp, serve stable `/images/:id` URLs instead of leaking expiring signed links.

Koyeb fits this role with minimal ceremony: connect the GitHub repo, set `workdir: proxy`, inject `BFL_API_KEY` as a secret, auto-deploy on push. The free tier is enough for a demo; the UI stays on Pages where it belongs.

| Layer | URL |
|-------|-----|
| **Demo UI** | [dealexmachina.github.io/dexm-virtual-tryon/](https://dealexmachina.github.io/dexm-virtual-tryon/) |
| **API proxy** | `https://exuberant-octavia-dealexmachina-a8182cc0.koyeb.app` |

## What it does

- **6 preset models** — diverse ages, builds, and styles
- **12 fictional garments** — tops and outer layers as clean packshots
- **Single-garment fitting** — one click, ~8 seconds
- **Multi-garment outfits** — shirt + jacket composed server-side at BFL's 0.35 MP spec
- **WebP delivery** — ~50% smaller than JPEG, negotiated via `Accept` header

## Features

- RESTful proxy routes (`/fittings`, `/outfits`, `/jobs/:id`, `/images/:id`)
- Server-side image composition with Sharp (no brittle browser canvas)
- CORS allowlist for GitHub Pages origins
- Stylist pairing suggestions with bundle CTA

## Local development

**Static UI only** (needs a running proxy):

```bash
# Serve docs/ on any static server, e.g.:
python3 -m http.server 8092 --directory docs
```

**Full stack** (proxy + BFL key):

```bash
cd proxy
echo 'BFL_API_KEY=your-key' > ../.env
npm install
npm start
# → http://localhost:8080
```

Set the proxy URL in the demo: `localStorage.setItem('dexm.proxyUrl', 'http://localhost:8080')` then reload.

## Proxy API

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/models` | `{ prompt, width?, height? }` | `{ job_id }` |
| POST | `/fittings` | `{ person_url, garment_url, prompt }` | `{ job_id }` |
| POST | `/outfits` | `{ person_url, garment_urls: […], prompt }` | `{ job_id }` |
| GET | `/jobs/:id` | — | `{ status, image_url?, error? }` |
| GET | `/images/:id` | — | WebP or JPEG (by `Accept`) |
| GET | `/healthz` | — | `{ ok: true }` |

Poll `/jobs/:id` until `status === "ready"`, then load `PROXY + image_url`.

See [proxy/README.md](proxy/README.md) for Koyeb deployment.

## Social preview asset

The repo hero image (`docs/assets/social-preview.jpg`) is a 1200×630 app snapshot — composed outfit plus bundle CTA — generated from [docs/assets/social-preview.html](docs/assets/social-preview.html) (uses `outfit-sample.jpg` as the fitting photo). Re-render after UI changes:

```bash
# requires playwright (one-off)
npx playwright screenshot file://$(pwd)/docs/assets/social-preview.html \
  docs/assets/social-preview.jpg --viewport-size=1200,630
```

## Credits

**Rendering engine:** [Black Forest Labs](https://bfl.ai) — FLUX Klein (`flux-2-klein-9b`) for likeness generation, FLUX VTO (`flux-tools/vto-v1`) for garment fitting. Enormous thanks to the BFL team for shipping a dedicated VTO endpoint, clear multi-garment composition guidance, and an API that made this maison preview possible in a weekend.

**Hosting:** GitHub Pages (static) + [Koyeb](https://koyeb.com) (proxy).

All models and garments in this demo are AI-generated fictions. No real brand, product, or person is depicted.

## For AI coding agents

- Do **not** read image files under `results/` — JPEGs explode LLM context when decoded as vision tokens.
- Do **not** log or inspect full base64 VTO payloads (one request ≈ 100k+ tokens of opaque text).
- Use `.cursorignore` patterns: `results/`, `*.jpg`, `*.webp`.

---

MIT · an edition of 2026
