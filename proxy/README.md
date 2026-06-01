# dexm · BFL VTO + Runway Proxy

A zero-framework Node 20+ proxy that lets a browser-only static demo call
[BFL FLUX VTO](https://docs.bfl.ai/) and [Runway image-to-video](https://docs.dev.runwayml.com/)
without exposing API keys or hitting CORS.

**Requires ffmpeg** on the host for animation frame extraction and clip stitching.

## Routes

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/models` | Generate a person image from a text prompt |
| `POST` | `/fittings` | Single-garment virtual try-on |
| `POST` | `/outfits` | Multi-garment VTO (2–4 pieces) |
| `POST` | `/accessories` | Bag/accessory on person (FLUX.2 multi-reference) |
| `POST` | `/animations` | Mood or outfit-reveal sequence → stitched MP4 |
| `GET` | `/jobs/:id` | Poll a job (image or animation) |
| `GET` | `/images/:id` | Serve rendered image (WebP or JPEG) |
| `GET` | `/videos/:id` | Stitched animation MP4 |
| `GET` | `/runway/balance` | Runway dev portal credit balance |
| `GET` | `/healthz` | Liveness check |

## Accessories (`POST /accessories`)

Places a bag or accessory on a person using **FLUX.2 Pro** (`flux-2-pro` by default).

Backpacks use a **two-step pipeline**: reframe to a back view, then place the product — a single call often puts the bag on the chest when the person faces the camera.

```json
{
  "person_job_id": "job_…",
  "accessory_url": "https://…/targus_backpack_side.png",
  "carry_style": "backpack",
  "scene": "urban",
  "accessory_desc": "black Targus laptop backpack with orange interior lining…"
}
```

`carry_style`: `backpack` | `crossbody` | `shoulder` | `hand`. Set `reframe_back: false` to skip the back-view step.

## Animations (`POST /animations`)

Generates a **sequential, chained** expression sequence. Each clip uses the last frame of the previous clip as `promptImage`.

### Default sequence (mode: `sequence`)

| Clip | Duration | Mood |
|------|----------|------|
| `neutral` | 5s | Subtle motion, closed lips |
| `smile` | 5s | Warm smile forming |
| `grin` | 5s | Broad toothy grin |
| `serious` | 5s | Expression drops to cold stare |

Use `mode: "reveal"` for outfit keyframes (base → shirt → combo → calm). Clips are stitched with ffmpeg into one MP4 at `GET /videos/:id`.

### Models and cost (credits per second)

| Model | Credits/s | Notes |
|-------|-----------|-------|
| `gen4.5` | 12 | **Recommended** — best quality in testing |
| `gen3a_turbo` | 5 | Cheaper; good for prompt/chain validation |

Full 4-clip sequence: **~240 credits** on `gen4.5` (~$2.40), **~100 credits** on `gen3a_turbo`.

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

1. **Create Service → GitHub** → `DealExMachina/dexm-virtual-tryon`
2. **Work directory:** `proxy`
3. **Run command:** `npm start`
4. **Environment:**

   | Variable | Required | Notes |
   |----------|----------|-------|
   | `BFL_API_KEY` | yes | BFL FLUX VTO + FLUX.2 accessories |
   | `GEN3_API_KEY` or `RUNWAYML_API_SECRET` | for `/animations` | Runway API key |
   | `RUNWAY_MODEL` | no | **`gen4.5`** recommended |
   | `RUNWAY_RATIO` | no | **`720:1280`** for gen4.5 portrait |
   | `PUBLIC_BASE_URL` | no | Proxy public URL for relative `/images/:id` |
   | `ALLOWED_ORIGINS` | no | CORS allowlist |

5. Requires `package-lock.json` in `proxy/` for the Node buildpack (Sharp).
6. Ensure **ffmpeg** is available for animations.

Once live, set `DEFAULT_PROXY` in `docs/index.html` or push the Koyeb URL.

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

## Tests

```bash
npm test              # unit tests (no API key)
npm run test:e2e      # live BFL/Runway (needs .env)
```

---

Part of [dexm-virtual-tryon](../README.md) · powered by [Black Forest Labs](https://bfl.ai)
