# DEXM — Virtual Try-On

An interactive virtual try-on demo built on [Black Forest Labs FLUX VTO](https://bfl.ai/blog), with optional **Runway Gen-4.5** mood animations on the proxy.

Pick a model, click any garment, see the result in seconds. Pair a top with an outer layer in a single multi-garment composition call.

![DEXM](https://img.shields.io/badge/FLUX-VTO-CCFF00?style=flat-square)
![Runway](https://img.shields.io/badge/Runway-gen4.5-000?style=flat-square)
![Node](https://img.shields.io/badge/node-20+-black?style=flat-square)

## What it does

- **6 preset models** spanning ages, body types, and ethnicities
- **12 fictional garments** (6 tops + 6 outer layers), each a clean packshot
- **Step 1**: pick a model (or generate a custom one from a prompt)
- **Step 2**: click any garment — instant try-on, no modal
- **Step 3**: see the result inline, with stylist pairing + bundle CTA
- **Animations** (proxy): chained expression sequence on a try-on result — neutral → smile → grin → serious

## Architecture

| Layer | Path | Role |
|-------|------|------|
| Static demo | `docs/index.html` | GitHub Pages UI — calls the proxy |
| Proxy | `proxy/` | BFL VTO + Runway image-to-video, CORS, WebP |
| Legacy local server | `server.js` (root) | Original single-file demo; use `proxy/` for production |

The browser never sees API keys. All BFL and Runway calls go through the proxy.

## Setup

### Static demo (GitHub Pages)

No build step. Open `docs/index.html` locally or visit the deployed Pages URL.

Set the proxy URL once in the browser console:

```js
localStorage.setItem('dexm.proxyUrl', 'https://your-proxy.koyeb.app');
location.reload();
```

### Proxy (local)

Requires **Node 20+**, **ffmpeg** (for animation frame handoff and stitching), and API keys.

```bash
cd proxy
npm install

# .env or shell exports:
# BFL_API_KEY=bfl_…
# GEN3_API_KEY=…  (or RUNWAYML_API_SECRET)
# RUNWAY_MODEL=gen4.5
# RUNWAY_RATIO=720:1280

BFL_API_KEY=… GEN3_API_KEY=… RUNWAY_MODEL=gen4.5 RUNWAY_RATIO=720:1280 npm start
# → http://localhost:8080
```

Then point the demo at `http://localhost:8080`.

See [`proxy/README.md`](proxy/README.md) for Koyeb deployment, env vars, and animation API details.

## Proxy API (summary)

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/models` | Generate a person image from a text prompt |
| `POST` | `/fittings` | Single-garment virtual try-on |
| `POST` | `/outfits` | Multi-garment VTO (2–4 pieces) |
| `POST` | `/animations` | Chained mood video sequence → stitched MP4 |
| `GET` | `/jobs/:id` | Poll job status (image or animation) |
| `GET` | `/images/:id` | Rendered image (WebP/JPEG) |
| `GET` | `/videos/:id` | Stitched animation MP4 |
| `GET` | `/runway/balance` | Runway credit balance |
| `GET` | `/healthz` | Liveness |

### Animation example

```bash
curl -X POST http://localhost:8080/animations \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://…/preset_viking.jpg",
    "clips": ["neutral", "smile"]
  }'
# Poll GET /jobs/:id until status=ready, then GET /videos/:id
```

Default sequence: 4×5s chained clips (~240 credits on `gen4.5`, ~100 on `gen3a_turbo`). Use `"mode":"arc"` for a single 10s continuous take.

## Tests

```bash
cd proxy && npm test
```

## Notes

All models and garments in this demo are AI-generated for demonstration purposes. No real brand, product, or person is depicted.

---

Built with [FLUX](https://bfl.ai) · [Runway](https://runwayml.com) · MIT
