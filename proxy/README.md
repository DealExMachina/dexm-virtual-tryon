# dexm · BFL VTO Proxy

A tiny, zero-dependency Node 20+ proxy that lets a browser-only static demo
call [BFL FLUX VTO](https://docs.bfl.ml/) without exposing the API key and
without hitting the browser CORS wall.

Routes:

- `POST /api/vto` — submit a virtual try-on, returns `{ ok, job_id }`
- `POST /api/generate` — submit a text-to-image (model generation)
- `GET  /api/job?id=…` — poll a job, returns `{ status, image_url }`
- `GET  /healthz` — liveness check

## Deploy to Koyeb

1. Push this repo to GitHub (it's already pushed under
   `DealExMachina/dexm-virtual-tryon`).
2. In Koyeb, **Create Service → GitHub** → pick `dexm-virtual-tryon`.
3. **Service type:** Web Service.
4. **Builder:** Buildpack (or Dockerfile if you prefer).
5. **Run command:** `npm start --prefix proxy`
   (or set the **Work directory** to `/proxy` and use `npm start`).
6. **Environment variables:**
   - `BFL_API_KEY` = your BFL key (required)
   - `ALLOWED_ORIGINS` = comma-separated allowlist; defaults to
     `https://dealexmachina.github.io,https://jeanbapt.github.io,http://localhost:8091`
   - `PORT` is provided by Koyeb automatically.
7. Deploy. You'll get a URL like `https://dexm-proxy-XXX.koyeb.app/`.

Once live, copy the URL and set it on the static demo:

```js
// In the browser console on https://dealexmachina.github.io/dexm-virtual-tryon/
localStorage.setItem('dexm.proxyUrl', 'https://dexm-proxy-XXX.koyeb.app');
location.reload();
```

Or hardcode it by editing `docs/index.html`'s `DEFAULT_PROXY` constant
and pushing — the demo will then work for everyone with no setup.

## Run locally

```bash
cd proxy
BFL_API_KEY=bfl_… npm start
# proxy listens on :8080
```

Then on the demo, set `localStorage.setItem('dexm.proxyUrl', 'http://localhost:8080')`.
