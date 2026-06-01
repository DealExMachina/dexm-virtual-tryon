# dexm · BFL VTO + Runway Proxy

A zero-framework Node 20+ proxy that lets a browser-only static demo call
[BFL FLUX VTO](https://docs.bfl.ml/) and [Runway image-to-video](https://docs.dev.runwayml.com/)
without exposing API keys or hitting CORS.

**Requires ffmpeg** on the host for animation frame extraction and clip stitching.

## Routes

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/models` | Generate a person image from a text prompt |
| `POST` | `/fittings` | Single-garment virtual try-on |
| `POST` | `/outfits` | Multi-garment VTO (2–4 pieces) |
| `POST` | `/animations` | Viking mood sequence → stitched MP4 |
| `GET` | `/jobs/:id` | Poll a job (image or animation) |
| `GET` | `/images/:id` | Serve rendered image (WebP or JPEG) |
| `GET` | `/videos/:id` | Stitched animation MP4 |
| `GET` | `/runway/balance` | Runway dev portal credit balance |
| `GET` | `/healthz` | Liveness check |

## Animations (`POST /animations`)

Generates a **sequential, chained** expression sequence. Each clip uses the last frame of the previous clip as `promptImage`, so moods actually change (parallel jobs with the same photo produce near-identical motion-only output).

### Default sequence (mode: `sequence`)

| Clip | Duration | Mood |
|------|----------|------|
| `neutral` | 5s | Subtle motion, closed lips |
| `smile` | 5s | Warm smile forming |
| `grin` | 5s | Broad toothy grin |
| `serious` | 5s | Expression drops to cold stare |

Clips are stitched with ffmpeg into one MP4 served at `GET /videos/:id`.

### Request body

```json
{
  "image_url": "https://…/photo.jpg",
  "image_job_id": "job_…",
  "mode": "sequence",
  "clips": ["neutral", "smile"],
  "stitch": true
}
```

- `image_url` — absolute URL, or `data:image/jpeg;base64,…` data URI
- `image_job_id` — use JPEG from a completed `/fittings` job (no public URL needed)
- `mode` — `"sequence"` (default, 4×5s chained) or `"arc"` (1×10s continuous)
- `clips` — optional subset for cheap tests, e.g. `["neutral", "smile"]`
- `prompt` + `duration` — custom single clip instead of the Viking sequence

### Response

```json
{ "job_id": "job_…", "cost": { "estimated_credits": 120, "estimated_usd": 1.2, … } }
```

Poll `GET /jobs/:id` until `status` is `ready` or `failed`. On success, `video_url` is `/videos/:id` and `clips[]` lists each segment with Runway CDN URLs.

### Runway API fields (reference)

Aligned with [Runway dev API](https://docs.dev.runwayml.com/guides/using-the-api/):

- Endpoint: `POST /v1/image_to_video`
- Header: `X-Runway-Version: 2024-11-06`
- Body: `promptImage`, `promptText`, `model`, `ratio`, `duration`

`promptImage` = first frame; `promptText` = motion/action in the clip.

### Models and cost (credits per second)

| Model | Credits/s | Notes |
|-------|-----------|-------|
| `gen4.5` | 12 | **Recommended** — best quality in testing |
| `gen3a_turbo` | 5 | Cheaper; good for prompt/chain validation |
| `gen4_turbo` | 5 | Alternative |

Full 4-clip sequence: **~240 credits** on `gen4.5` (~$2.40), **~100 credits** on `gen3a_turbo`. Cheap 2-clip test: half that.

## Runway: “dev” vs “app” credits (not linked)

The demo proxy only talks to the **Runway Developer API** (`api.dev.runwayml.com`). It uses one secret:

- `GEN3_API_KEY` or `RUNWAYML_API_SECRET` on Koyeb / in your shell

`GET /runway/balance` returns the balance for **that key’s organization** — nothing else.

Runway keeps these wallets **separate** ([API FAQ](https://help.runwayml.com/hc/en-us/articles/21668552945171-Runway-API-FAQs)):

| Where you see credits | Used by this proxy? |
|----------------------|---------------------|
| [dev.runwayml.com](https://dev.runwayml.com) → Billing | **Yes** — API credits |
| [app.runwayml.com](https://app.runwayml.com) (web editor) | **No** — never deducted by `/animations` |

There is **no** setting to “connect” or merge web-app credits into API credits. If the portal shows **500** on the web app but Koyeb `/runway/balance` shows **15**, that is expected until you fund the **same dev org** whose API key is on Koyeb.

### Wire the app to the wallet you want

1. Open [dev.runwayml.com](https://dev.runwayml.com) (not the web app).
2. Top-left **organization switcher** — list every org you belong to. Note which one shows ~**500** vs ~**15** under **Billing**.
3. Select the org with enough API credits → **API Keys** → create a key (e.g. `dexm-koyeb-prod`) → copy once.
4. **Koyeb** → service `exuberant-octavia-…` → **Settings → Environment** → set `GEN3_API_KEY` to that key (remove old value). Redeploy.
5. Verify (should match the org you picked):

   ```bash
   curl -s https://YOUR-PROXY.koyeb.app/runway/balance
   ```

6. Local dev: same key in `proxy/.env` or export before `npm start`.

Optional: invite teammates to one dev org ([members](https://docs.dev.runwayml.com/usage/organizations-and-roles/)) so everyone shares one billing bucket — still one key on Koyeb for production.

If **500** exists only on the web app, add API credits on dev.runwayml.com **Billing** (or use autobilling) for the org that owns the Koyeb key.

## Deploy to Koyeb

1. Push this repo to GitHub (`DealExMachina/dexm-virtual-tryon`).
2. In Koyeb: **Create Service → GitHub** → pick the repo.
3. **Service type:** Web Service.
4. **Run command:** `npm start --prefix proxy` (or set work directory to `/proxy`).
5. **Environment variables:**

   | Variable | Required | Default / notes |
   |----------|----------|-----------------|
   | `BFL_API_KEY` | yes | BFL FLUX VTO |
   | `GEN3_API_KEY` or `RUNWAYML_API_SECRET` | for `/animations` | Runway API key |
   | `RUNWAY_MODEL` | no | `gen3a_turbo`; use **`gen4.5`** for production quality |
   | `RUNWAY_RATIO` | no | `768:1280` (gen3 portrait); **`720:1280`** for gen4.5 portrait |
   | `RUNWAY_G_CO2_PER_CREDIT` | no | `0.4` — rough carbon proxy, not from Runway |
   | `PUBLIC_BASE_URL` | no | Proxy public URL; needed for relative `/images/:id` paths |
   | `ALLOWED_ORIGINS` | no | Comma-separated CORS allowlist |
   | `PORT` | auto | Provided by Koyeb |

6. Ensure **ffmpeg** is available in the runtime (Koyeb buildpack images include it; verify if using a custom Dockerfile).

Once live, set the demo proxy URL:

```js
localStorage.setItem('dexm.proxyUrl', 'https://dexm-proxy-XXX.koyeb.app');
location.reload();
```

Or edit `DEFAULT_PROXY` in `docs/index.html`.

## Tests (no token burn)

```bash
cd proxy
npm install

# Unit + reveal cost math — no API calls
npm test

# Local HTTP smoke — no BFL/Runway keys, validates routes + reveal 400/404
npm run test:smoke

# Live deployed proxy — read-only balance + validation only
npm run smoke:live
# or: SMOKE_BASE_URL=https://your-proxy.koyeb.app npm run test:smoke:live
```

`npm run test:e2e` calls **real BFL** and spends credits — use only when intentionally testing generation.

## Run locally

```bash
cd proxy
npm install
BFL_API_KEY=bfl_… GEN3_API_KEY=… RUNWAY_MODEL=gen4.5 RUNWAY_RATIO=720:1280 npm start
# → http://localhost:8080
```

Point the demo: `localStorage.setItem('dexm.proxyUrl', 'http://localhost:8080')`.

### Example: cheap 2-clip test

```bash
curl -X POST http://localhost:8080/animations \
  -H "Content-Type: application/json" \
  -d '{"image_url":"https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/preset_viking.jpg","clips":["neutral","smile"]}'
```

### Example: full sequence

```bash
curl -X POST http://localhost:8080/animations \
  -H "Content-Type: application/json" \
  -d '{"image_url":"https://…","mode":"sequence"}'
```

## Tests

```bash
npm test              # unit + Runway helpers
npm run test:e2e      # live BFL/Runway (needs .env)
```

Logic lives in `lib/runway.js` — prompts, chaining, cost estimates, stitching.
