# DEXM — Virtual Try-On

An interactive virtual try-on demo built on Black Forest Labs' [FLUX VTO](https://bfl.ai/blog).

Pick a model, click any garment, see the result in seconds. Pair a top with an outer layer in a single multi-garment composition call.

![DEXM](https://img.shields.io/badge/FLUX-VTO-CCFF00?style=flat-square)
![Node](https://img.shields.io/badge/node-26+-black?style=flat-square)

## What it does

- **6 preset models** spanning ages, body types, and ethnicities — every shopper, every body
- **12 fictional garments** (6 tops + 6 outer layers), each generated as a clean packshot
- **Step 1**: pick a model (or generate a custom one from a prompt)
- **Step 2**: click any garment — instant try-on, no modal, no scroll-back
- **Step 3**: see the result inline, with a stylist's pairing suggestion + bundle CTA

## Features

- **Single-garment VTO** via `/v1/flux-tools/vto-v1`
- **Multi-garment composition** — 2x2 canvas grid + enumerative prompt format per BFL's recommended spec
- **Async polling** so generations never time out in the browser
- **Image proxy** for cross-origin canvas operations
- **24h booking promo** with a live countdown banner

## Setup

```bash
# Get an API key from https://docs.bfl.ml
echo 'BFL_API_KEY=your-key-here' > .env

npm start
# → http://localhost:8091
```

Requires Node 26+ (native `fetch` and `--env-file`).

## API endpoints (server.js)

- `POST /api/generate` — submit a model generation, returns `job_id`
- `POST /api/vto` — submit a try-on (single or multi-garment), returns `job_id`
- `GET  /api/job?id=...` — poll a job status; returns `{ status, image_url, local_path }`
- `GET  /api/proxy?url=...` — same-origin image proxy for browser canvas

## Notes

All models and garments in this demo are AI-generated for demonstration purposes. No real brand, product, or person is depicted.

---

Built with [FLUX](https://bfl.ai) · MIT
