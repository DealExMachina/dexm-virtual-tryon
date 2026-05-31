/**
 * dexm VTO Proxy
 *
 * Design principles:
 *  1. RESTful resource routes — not action verbs
 *  2. Never leak BFL signed URLs to the browser.
 *     The proxy owns the full pipeline: submit → poll → download → convert → serve.
 *  3. Images served as WebP (Accept-header negotiation, JPEG fallback).
 *     Sharp converts BFL JPEG output to WebP on the fly: ~35% smaller, same quality.
 *  4. All image composition happens server-side with Sharp.
 *     Browser canvas is unreliable (Safari CORS taint, size limits).
 *     Multi-garment composites are built at exactly 0.35 MP (BFL: ~0.5 MP, max 1 MP).
 *  5. Input normalisation in one place: base64 data-URLs, relative paths and
 *     public URLs are all resolved to raw bytes before hitting BFL.
 *
 * Routes
 *   POST  /models            Generate a person image from a text prompt
 *   POST  /fittings          Single-garment virtual try-on
 *   POST  /outfits           Multi-garment VTO (2–4 pieces, 2×2 grid composite)
 *   GET   /jobs/:id          Poll async job status
 *   GET   /images/:id        Serve the rendered image (WebP or JPEG)
 *   GET   /healthz           Liveness probe
 *
 * Environment
 *   BFL_API_KEY      required
 *   ALLOWED_ORIGINS  comma-separated list (default: both github.io previews + localhost)
 *   PORT             default 8080
 */

import { createServer } from "node:http";
import sharp from "sharp";

// ─── Config ───────────────────────────────────────────────────────────────────

const BFL = "https://api.bfl.ai/v1";
const PORT = process.env.PORT || 8080;
const KEY  = process.env.BFL_API_KEY;

if (!KEY) { console.error("FATAL: BFL_API_KEY is required"); process.exit(1); }

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://dealexmachina.github.io,https://jeanbapt.github.io," +
  "http://localhost:8091,http://localhost:8092,http://localhost:5500,http://localhost:8000"
).split(",").map(s => s.trim());

// BFL model identifiers
const MODEL_GENERATE = "flux-2-klein-9b";       // fast, cheap — good enough for demo models
const MODEL_VTO      = "flux-tools/vto-v1";     // dedicated VTO endpoint

// Multi-garment composite target: 0.35 MP (BFL: ~0.5 MP, max 1 MP)
const TILE_W = 256, TILE_H = 340;               // each garment tile: 256×340

// Job TTL
const JOB_TTL_MS = 3_600_000; // 1 hour

// ─── Job store ────────────────────────────────────────────────────────────────
// Each job: { status: "pending"|"ready"|"failed", imageBytes?, contentType?, error? }

const jobs = new Map();
setInterval(() => {
  const cut = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.created < cut) jobs.delete(id);
}, 60_000);

function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── BFL client ───────────────────────────────────────────────────────────────

async function bflSubmit(endpoint, payload, attempt = 0) {
  try {
    const r = await fetch(`${BFL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Key": KEY, accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`BFL ${r.status}: ${await r.text()}`);
    return r.json();
  } catch (e) {
    const retryable = ["fetch failed", "ECONNRESET", "UND_ERR_SOCKET"].some(
      s => e.message.includes(s) || e.cause?.code === s
    );
    if (retryable && attempt < 3) {
      await delay((attempt + 1) * 1500);
      return bflSubmit(endpoint, payload, attempt + 1);
    }
    throw e;
  }
}

async function bflPoll(pollingUrl, maxMs = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await fetch(pollingUrl, { headers: { "X-Key": KEY, accept: "application/json" } });
    const d = await r.json();
    if (d.status === "Ready") return d;
    if (["Error", "Failed", "Content Moderated", "Request Moderated"].includes(d.status)) return d;
    await delay(1500);
  }
  return { status: "Timeout" };
}

// ─── Image processing ─────────────────────────────────────────────────────────

// Convert any BFL JPEG result to WebP (or keep as JPEG fallback).
async function convertToWebP(buf) {
  return sharp(buf).webp({ quality: 82 }).toBuffer();
}

async function convertToJpeg(buf) {
  return sharp(buf).jpeg({ quality: 88 }).toBuffer();
}

// Build a 2×2 grid composite from an array of image URLs.
// Result is always ~0.35 MP: 512×680 (2 columns × 256, 2 rows × 340).
async function buildComposite(urls) {
  const cols = 2, rows = 2;
  const bufs = await Promise.all(
    urls.slice(0, cols * rows).map(async url => {
      const src = await resolveImageBytes(url);
      return sharp(src)
        .resize(TILE_W, TILE_H, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255 },
        })
        .jpeg({ quality: 88 })
        .toBuffer();
    })
  );

  return sharp({
    create: { width: TILE_W * cols, height: TILE_H * rows, channels: 3,
               background: { r: 255, g: 255, b: 255 } },
  })
    .composite(bufs.map((buf, i) => ({
      input: buf,
      left: (i % cols) * TILE_W,
      top:  Math.floor(i / cols) * TILE_H,
    })))
    .jpeg({ quality: 88 })
    .toBuffer();
}

// Normalise an image source to raw bytes:
//   - public HTTPS URL → fetch
//   - data:image/…;base64,<data> → decode base64
//   - raw base64 string (no prefix) → decode
async function resolveImageBytes(src) {
  if (typeof src !== "string") throw new Error("image source must be a string");

  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL");
    return Buffer.from(src.slice(comma + 1), "base64");
  }

  if (/^[A-Za-z0-9+/=\r\n]+$/.test(src.slice(0, 64)) && !src.startsWith("http")) {
    return Buffer.from(src, "base64");
  }

  const r = await fetch(src);
  if (!r.ok) throw new Error(`fetch image ${src}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Convert resolved image bytes to raw base64 for BFL (no data: prefix).
async function toBase64ForBFL(src) {
  const buf = await resolveImageBytes(src);
  return buf.toString("base64");
}

// ─── Job runner ───────────────────────────────────────────────────────────────

async function runJob(jobId, endpoint, payload) {
  try {
    const sub = await bflSubmit(endpoint, payload);
    console.log(`[${jobId}] submitted → BFL ${sub.id}`);

    const result = await bflPoll(sub.polling_url);
    if (result.status !== "Ready") {
      jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: result.status });
      console.log(`[${jobId}] ✗ ${result.status}`);
      return;
    }

    // Download and convert to WebP — never hand BFL's signed URL to the browser
    const rawBuf = await fetch(result.result.sample).then(r => r.arrayBuffer()).then(Buffer.from);
    const webpBuf  = await convertToWebP(rawBuf);
    const jpegBuf  = await convertToJpeg(rawBuf);

    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: "ready",
      webp: webpBuf,
      jpeg: jpegBuf,
    });
    console.log(`[${jobId}] ✓ ready (webp ${webpBuf.length}B, jpeg ${jpegBuf.length}B)`);
  } catch (e) {
    console.error(`[${jobId}] error:`, e.message);
    jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message });
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// POST /models
// Body: { prompt, width?, height? }
// → Generates a person image from a text prompt
async function handleModels(body) {
  validate(body, ["prompt"]);
  const jobId = newJobId();
  jobs.set(jobId, { status: "pending", created: Date.now() });
  runJob(jobId, MODEL_GENERATE, {
    prompt: body.prompt,
    width:  body.width  || 832,
    height: body.height || 1216,
    safety_tolerance: 2,
    output_format: "jpeg",
  });
  return { job_id: jobId };
}

// POST /fittings
// Body: { person_url | person_b64, garment_url | garment_b64, prompt? }
// → Single garment VTO
async function handleFittings(body) {
  validate(body, ["prompt"]); // at least a prompt so BFL knows intent
  const [personB64, garmentB64] = await Promise.all([
    toBase64ForBFL(body.person_b64 || body.person_url),
    toBase64ForBFL(body.garment_b64 || body.garment_url),
  ]);
  const jobId = newJobId();
  jobs.set(jobId, { status: "pending", created: Date.now() });
  runJob(jobId, MODEL_VTO, {
    person:  personB64,
    garment: garmentB64,
    prompt:  body.prompt ||
      "The person of image 1, maintaining exactly their face and pose, wearing the garment of image 2.",
    output_format: "jpeg",
  });
  return { job_id: jobId };
}

// POST /outfits
// Body: { person_url | person_b64, garment_urls: [url, url, …], prompt }
// → Multi-garment VTO using a 2×2 composite at ~0.35 MP (BFL spec)
async function handleOutfits(body) {
  validate(body, ["garment_urls", "prompt"]);
  if (!Array.isArray(body.garment_urls) || body.garment_urls.length < 2)
    throw new ClientError("garment_urls must be an array of at least 2 items", 400);

  const personB64   = await toBase64ForBFL(body.person_b64 || body.person_url);
  const compositeBuf = await buildComposite(body.garment_urls);
  const compositeB64 = compositeBuf.toString("base64");

  console.log(`[outfits] composite ${body.garment_urls.length} garments → ${compositeBuf.length}B`);

  const jobId = newJobId();
  jobs.set(jobId, { status: "pending", created: Date.now() });
  runJob(jobId, MODEL_VTO, {
    person:  personB64,
    garment: compositeB64,
    prompt:  body.prompt,
    output_format: "jpeg",
  });
  return { job_id: jobId };
}

// GET /jobs/:id
function handleJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new ClientError("job not found", 404);
  return {
    status:     job.status,
    image_url:  job.status === "ready" ? `/images/${jobId}` : undefined,
    error:      job.error,
  };
}

// GET /images/:id  (content-negotiated: WebP or JPEG)
function handleImage(jobId, acceptHeader) {
  const job = jobs.get(jobId);
  if (!job?.webp) throw new ClientError("image not found", 404);
  const wantsWebP = acceptHeader?.includes("image/webp");
  return wantsWebP
    ? { bytes: job.webp, contentType: "image/webp" }
    : { bytes: job.jpeg, contentType: "image/jpeg" };
}

// ─── HTTP layer ───────────────────────────────────────────────────────────────

class ClientError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validate(body, required) {
  for (const f of required) {
    if (!body[f]) throw new ClientError(`"${f}" is required`, 400);
  }
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age":       "600",
    "Vary": "Origin",
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function sendJSON(res, origin, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":   "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(origin),
  });
  res.end(body);
}

// Simple route matcher: [method, pattern, handler]
// Pattern tokens starting with ":" are captured as params.
function matchRoute(method, url, routes) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pParts = pattern.split("/");
    const uParts = url.split("?")[0].split("/");
    if (pParts.length !== uParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(":")) params[pParts[i].slice(1)] = uParts[i];
      else if (pParts[i] !== uParts[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

const ROUTES = [
  // Liveness
  ["GET", "/healthz", async () => ({ ok: true })],

  // Resources
  ["POST", "/models",   async (b) => handleModels(b)],
  ["POST", "/fittings", async (b) => handleFittings(b)],
  ["POST", "/outfits",  async (b) => handleOutfits(b)],
  ["GET",  "/jobs/:id", async (_, p) => handleJobStatus(p.id)],
  // /images/:id is handled separately (binary response)
];

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const { method, url } = req;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  // Binary image serving
  if (method === "GET" && url.startsWith("/images/")) {
    const jobId = url.slice("/images/".length).split("?")[0];
    try {
      const { bytes, contentType } = handleImage(jobId, req.headers.accept);
      res.writeHead(200, {
        "Content-Type":  contentType,
        "Content-Length": bytes.length,
        "Cache-Control": "public, max-age=3600",
        ...corsHeaders(origin),
      });
      res.end(bytes);
    } catch (e) {
      sendJSON(res, origin, { error: e.message }, e.status ?? 500);
    }
    return;
  }

  // JSON routes
  const match = matchRoute(method, url.split("?")[0], ROUTES);
  if (!match) {
    sendJSON(res, origin, { error: "not found" }, 404);
    return;
  }

  try {
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : {};
    const result = await match.handler(body, match.params);
    sendJSON(res, origin, result);
  } catch (e) {
    if (e instanceof ClientError) {
      sendJSON(res, origin, { error: e.message }, e.status);
    } else {
      console.error("server error:", e);
      sendJSON(res, origin, { error: "internal server error" }, 500);
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  dexm VTO proxy → http://localhost:${PORT}`);
  console.log(`  routes: POST /models  POST /fittings  POST /outfits`);
  console.log(`          GET  /jobs/:id  GET /images/:id`);
  console.log(`  origins: ${ALLOWED_ORIGINS.join(", ")}\n`);
});

// ─── Util ─────────────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));
