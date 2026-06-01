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
 *   POST  /accessories       Bag/accessory on person via FLUX.2 multi-reference
 *   POST  /animations        Runway image-to-video sequence (4 Viking editorial clips)
 *   GET   /jobs/:id          Poll async job status (image or animation)
 *   GET   /images/:id        Serve the rendered image (WebP or JPEG)
 *   GET   /videos/:id        Stitched mood sequence MP4 (animation jobs)
 *
 * Environment
 *   BFL_API_KEY      required
 *   GEN3_API_KEY or RUNWAYML_API_SECRET  required for POST /animations
 *   RUNWAY_MODEL     default gen3a_turbo (see docs.dev.runwayml.com/guides/models/)
 *   RUNWAY_RATIO     default 768:1280 for gen3a_turbo portrait
 *   RUNWAY_G_CO2_PER_CREDIT  rough gCO2e proxy per credit (default 0.4, not from Runway)
 *   PUBLIC_BASE_URL  optional — resolves relative /images/:id paths for Runway
 *   PORT             default 8080
 */

import { createServer } from "node:http";
import {
  ALLOWED_ORIGINS, TILE_W, TILE_H,
  resolveImageBytes, toBase64ForBFL,
  buildComposite, toWebP, toJpeg,
  corsHeaders,
} from "./lib/utils.js";
import {
  resolvePublicImageUrl, runAnimationJob, jpegToDataUri,
  DEFAULT_RUNWAY_MODEL, DEFAULT_RUNWAY_RATIO,
  resolveAnimationSequence, buildOutfitRevealSequence,
  estimateSequenceCost, withCarbonEstimate, fetchRunwayOrganization,
} from "./lib/runway.js";
import {
  buildAccessoryPrompt,
  buildBackViewReframePrompt,
  DEFAULT_ACCESSORY_MODEL,
  CARRY_STYLES,
} from "./lib/accessories.js";
import { withScene, SCENE_IDS } from "./lib/scenes.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const BFL = "https://api.bfl.ai/v1";
const PORT = process.env.PORT || 8080;
const KEY  = process.env.BFL_API_KEY;
const GEN3 = process.env.GEN3_API_KEY || process.env.RUNWAYML_API_SECRET;
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL;
const RUNWAY_MODEL = process.env.RUNWAY_MODEL || DEFAULT_RUNWAY_MODEL;
const RUNWAY_RATIO = process.env.RUNWAY_RATIO || DEFAULT_RUNWAY_RATIO;

if (!KEY) { console.error("FATAL: BFL_API_KEY is required"); process.exit(1); }
if (!GEN3) console.warn("WARNING: GEN3_API_KEY / RUNWAYML_API_SECRET not set — POST /animations disabled");

// BFL model identifiers
const MODEL_GENERATE = "flux-2-klein-9b";   // fast, cheap — good enough for demo models
const MODEL_VTO      = "flux-tools/vto-v1"; // dedicated VTO endpoint
const MODEL_ACCESSORY = process.env.BFL_ACCESSORY_MODEL || DEFAULT_ACCESSORY_MODEL;

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

// (image processing imported from lib/utils.js)

// ─── Job runner ───────────────────────────────────────────────────────────────

async function flux2Generate(endpoint, payload) {
  const sub = await bflSubmit(endpoint, payload);
  const result = await bflPoll(sub.polling_url);
  if (result.status !== "Ready") throw new Error(`BFL ${result.status}`);
  return fetch(result.result.sample).then(r => r.arrayBuffer()).then(Buffer.from);
}

async function storeImageJob(jobId, rawBuf) {
  const webpBuf = await toWebP(rawBuf);
  const jpegBuf = await toJpeg(rawBuf);
  jobs.set(jobId, {
    ...jobs.get(jobId),
    status: "ready",
    webp: webpBuf,
    jpeg: jpegBuf,
  });
  console.log(`[${jobId}] ✓ ready (webp ${webpBuf.length}B, jpeg ${jpegBuf.length}B)`);
}

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
    const rawBuf = await fetch(result.result.sample).then(r => r.arrayBuffer()).then(Buffer.from);
    await storeImageJob(jobId, rawBuf);
  } catch (e) {
    console.error(`[${jobId}] error:`, e.message);
    jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message });
  }
}

/** Backpacks: reframe person to back view, then place bag (single FLUX call often puts bag on chest). */
function runAccessoryJob(jobId, {
  personB64,
  accessoryB64,
  carryStyle,
  scene,
  prompt,
  accessoryDesc,
  width,
  height,
  safety_tolerance,
  reframeBack,
}) {
  (async () => {
    try {
      let personInput = personB64;
      const w = width || 832;
      const h = height || 1216;
      const safety = safety_tolerance ?? 2;
      const basePayload = { width: w, height: h, safety_tolerance: safety, output_format: "jpeg" };

      if (carryStyle === "backpack" && reframeBack !== false) {
        jobs.set(jobId, { ...jobs.get(jobId), step: "reframe_back" });
        console.log(`[accessories/${jobId}] step 1/2 reframe → back view`);
        const reframeBuf = await flux2Generate(MODEL_ACCESSORY, {
          ...basePayload,
          prompt: buildBackViewReframePrompt(scene),
          input_image: personInput,
        });
        personInput = reframeBuf.toString("base64");
      }

      jobs.set(jobId, { ...jobs.get(jobId), step: "place_accessory" });
      const stepNum = carryStyle === "backpack" && reframeBack !== false ? "2/2" : "1/1";
      console.log(`[accessories/${jobId}] step ${stepNum} place accessory`);
      const placePrompt = prompt || buildAccessoryPrompt({
        accessory_desc: accessoryDesc,
        carry_style: carryStyle,
        scene,
      });

      const rawBuf = await flux2Generate(MODEL_ACCESSORY, {
        ...basePayload,
        prompt: placePrompt,
        input_image: personInput,
        input_image_2: accessoryB64,
      });
      await storeImageJob(jobId, rawBuf);
    } catch (e) {
      console.error(`[accessories/${jobId}] error:`, e.message);
      jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message });
    }
  })();
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// POST /models
// Body: { prompt, width?, height? }
// → Generates a person image from a text prompt
async function handleModels(body) {
  validate(body, ["prompt"]);
  const jobId = newJobId();
  jobs.set(jobId, { status: "pending", type: "image", created: Date.now() });
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
  jobs.set(jobId, { status: "pending", type: "image", created: Date.now() });
  runJob(jobId, MODEL_VTO, {
    person:  personB64,
    garment: garmentB64,
    prompt:  withScene(
      body.prompt ||
        "The person of image 1, maintaining exactly their face and pose, wearing the garment of image 2.",
      body.scene,
    ),
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
  jobs.set(jobId, { status: "pending", type: "image", created: Date.now() });
  runJob(jobId, MODEL_VTO, {
    person:  personB64,
    garment: compositeB64,
    prompt:  withScene(body.prompt, body.scene),
    output_format: "jpeg",
  });
  return { job_id: jobId };
}

// POST /accessories
// Body: { person_url | person_b64 | person_job_id, accessory_url | accessory_b64,
//         carry_style?, accessory_desc?, prompt?, width?, height? }
// → FLUX.2 multi-reference: person + bag/accessory product shot
async function handleAccessories(body) {
  let personSrc = body.person_b64 || body.person_url;
  if (body.person_job_id) {
    const src = jobs.get(body.person_job_id);
    if (!src?.jpeg) throw new ClientError("person_job_id not found or not ready", 404);
    personSrc = `data:image/jpeg;base64,${src.jpeg.toString("base64")}`;
  }
  if (!personSrc) throw new ClientError('"person_url", "person_b64", or "person_job_id" is required', 400);

  const accessorySrc = body.accessory_b64 || body.accessory_url;
  if (!accessorySrc) throw new ClientError('"accessory_url" or "accessory_b64" is required', 400);

  const carryStyle = body.carry_style || "backpack";
  if (!CARRY_STYLES.includes(carryStyle)) {
    throw new ClientError(`carry_style must be one of: ${CARRY_STYLES.join(", ")}`, 400);
  }

  const [personB64, accessoryB64] = await Promise.all([
    toBase64ForBFL(personSrc),
    toBase64ForBFL(accessorySrc),
  ]);

  const scene = body.scene || "urban";
  if (body.scene && !SCENE_IDS.includes(body.scene)) {
    throw new ClientError(`scene must be one of: ${SCENE_IDS.join(", ")}`, 400);
  }

  const prompt = body.prompt || buildAccessoryPrompt({
    accessory_desc: body.accessory_desc,
    carry_style: carryStyle,
    scene,
  });

  const jobId = newJobId();
  jobs.set(jobId, {
    status: "pending",
    type: "accessory",
    carry_style: carryStyle,
    created: Date.now(),
  });

  const reframeBack = body.reframe_back !== false;
  console.log(
    `[accessories/${jobId}] ${MODEL_ACCESSORY} carry=${carryStyle}` +
    (carryStyle === "backpack" && reframeBack ? " (2-step back view)" : "")
  );

  runAccessoryJob(jobId, {
    personB64,
    accessoryB64,
    carryStyle,
    scene,
    prompt,
    accessoryDesc: body.accessory_desc,
    width: body.width,
    height: body.height,
    safety_tolerance: body.safety_tolerance,
    reframeBack,
  });

  return {
    job_id: jobId,
    model: MODEL_ACCESSORY,
    carry_style: carryStyle,
    scene,
    reframe_back: carryStyle === "backpack" && reframeBack,
  };
}

// POST /animations
// Body: { image_url | image_job_id, mode?, clips? }
//   mode "sequence" (default) — 4 chained Viking moods → one stitched MP4
//   mode "arc"              — 1×10s continuous arc
//   mode "reveal"           — outfit reveal: base → shirt → combo → calm
//     requires: base_image_url, shirt_job_id, combo_job_id
//     optional: shirt_desc, jacket_desc
async function handleAnimations(body) {
  if (!GEN3) throw new ClientError("GEN3_API_KEY not configured", 503);

  if (body.mode === "reveal") return handleRevealAnimation(body);

  let sequence;
  try {
    sequence = resolveAnimationSequence(body);
  } catch (e) {
    throw new ClientError(e.message, 400);
  }

  let imageInput;
  if (body.image_job_id) {
    const src = jobs.get(body.image_job_id);
    if (!src?.jpeg) throw new ClientError("image job not found or not ready", 404);
    imageInput = jpegToDataUri(src.jpeg);
  } else if (body.image_url?.startsWith("data:")) {
    imageInput = body.image_url;
  } else if (body.image_url) {
    try {
      imageInput = resolvePublicImageUrl(body.image_url, PUBLIC_BASE);
    } catch (e) {
      throw new ClientError(e.message, 400);
    }
  } else {
    throw new ClientError('"image_url" or "image_job_id" is required', 400);
  }

  const jobId = newJobId();
  const cost = withCarbonEstimate(estimateSequenceCost(sequence, RUNWAY_MODEL));
  jobs.set(jobId, {
    status: "pending",
    type: "animation",
    mode: body.mode === "arc" ? "arc" : "sequence",
    created: Date.now(),
    clips: [],
    cost,
    model: RUNWAY_MODEL,
    ratio: RUNWAY_RATIO,
  });
  runAnimationJob(jobs, jobId, GEN3, sequence, {
    defaultImage: imageInput,
    model: RUNWAY_MODEL,
    ratio: RUNWAY_RATIO,
    stitch: body.stitch !== false,
  });
  return { job_id: jobId, cost };
}

async function handleRevealAnimation(body) {
  if (!body.shirt_job_id || !body.combo_job_id) {
    throw new ClientError('"shirt_job_id" and "combo_job_id" are required for mode reveal', 400);
  }

  const baseUrl = body.base_image_url || body.person_url || body.image_url;
  if (!baseUrl) {
    throw new ClientError('"base_image_url" (or person_url) is required for mode reveal', 400);
  }

  const shirtJob = jobs.get(body.shirt_job_id);
  const comboJob = jobs.get(body.combo_job_id);
  if (!shirtJob?.jpeg) throw new ClientError("shirt_job_id not found or not ready", 404);
  if (!comboJob?.jpeg) throw new ClientError("combo_job_id not found or not ready", 404);

  let baseInput;
  if (baseUrl.startsWith("data:")) {
    baseInput = baseUrl;
  } else {
    try {
      baseInput = resolvePublicImageUrl(baseUrl, PUBLIC_BASE);
    } catch (e) {
      throw new ClientError(e.message, 400);
    }
  }

  const sequence = buildOutfitRevealSequence({
    shirt_desc: body.shirt_desc,
    jacket_desc: body.jacket_desc,
  }).filter(c => {
    if (!Array.isArray(body.clips) || body.clips.length === 0) return true;
    return body.clips.includes(c.name);
  });
  if (sequence.length === 0) {
    throw new ClientError("no reveal clips matched body.clips", 400);
  }

  const jobId = newJobId();
  const cost = withCarbonEstimate(estimateSequenceCost(sequence, RUNWAY_MODEL));
  const { credit_balance } = await fetchRunwayOrganization(GEN3);
  if (credit_balance < cost.estimated_credits) {
    throw new ClientError(
      `Need ~${cost.estimated_credits} Runway credits for this reveal (${RUNWAY_MODEL}); balance is ${credit_balance}. Top up at https://dev.runwayml.com`,
      402,
    );
  }

  jobs.set(jobId, {
    status: "pending",
    type: "animation",
    mode: "reveal",
    created: Date.now(),
    clips: [],
    cost,
    model: RUNWAY_MODEL,
    ratio: RUNWAY_RATIO,
  });

  runAnimationJob(jobs, jobId, GEN3, sequence, {
    imageMap: {
      base: baseInput,
      shirt: jpegToDataUri(shirtJob.jpeg),
      combo: jpegToDataUri(comboJob.jpeg),
    },
    model: RUNWAY_MODEL,
    ratio: RUNWAY_RATIO,
    stitch: body.stitch !== false,
  });

  return { job_id: jobId, cost, mode: "reveal" };
}

// GET /runway/balance — live credit balance from Runway dev portal
async function handleRunwayBalance() {
  if (!GEN3) throw new ClientError("GEN3_API_KEY not configured", 503);
  const org = await fetchRunwayOrganization(GEN3);
  const revealCost = estimateSequenceCost(buildOutfitRevealSequence({}), RUNWAY_MODEL);
  const need = revealCost.estimated_credits;
  return {
    ...org,
    runway_model: RUNWAY_MODEL,
    reveal: {
      clip_count: revealCost.clip_count,
      estimated_credits: need,
      estimated_usd: revealCost.estimated_usd,
    },
    sufficient_for_reveal: org.credit_balance >= need,
  };
}

// GET /jobs/:id
function handleJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new ClientError("job not found", 404);

  if (job.type === "animation") {
    const hasStitch = Boolean(job.stitched_mp4);
    return {
      status:         job.status,
      type:           "animation",
      mode:           job.mode,
      model:          job.model,
      clips:          job.clips,
      video_urls:     job.status === "ready" ? job.video_urls : undefined,
      video_url:      job.status === "ready" && hasStitch ? `/videos/${jobId}` : undefined,
      total_duration: job.total_duration,
      cost:           job.cost,
      error:          job.error,
    };
  }

  return {
    status:    job.status,
    type:      job.type || "image",
    image_url: job.status === "ready" ? `/images/${jobId}` : undefined,
    error:     job.error,
  };
}

// GET /videos/:id — stitched animation MP4
function handleVideo(jobId) {
  const job = jobs.get(jobId);
  if (!job?.stitched_mp4) throw new ClientError("video not found", 404);
  return { bytes: job.stitched_mp4, contentType: "video/mp4" };
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

// ─── HTTP layer ──────────────────────────────────────────────────────────────

class ClientError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validate(body, required) {
  for (const f of required) {
    if (!body[f]) throw new ClientError(`"${f}" is required`, 400);
  }
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
  ["GET", "/healthz",        async () => ({ ok: true })],
  ["GET", "/runway/balance", async () => handleRunwayBalance()],

  // Resources
  ["POST", "/models",      async (b) => handleModels(b)],
  ["POST", "/fittings",    async (b) => handleFittings(b)],
  ["POST", "/outfits",     async (b) => handleOutfits(b)],
  ["POST", "/accessories", async (b) => handleAccessories(b)],
  ["POST", "/animations",  async (b) => handleAnimations(b)],
  ["GET",  "/jobs/:id",    async (_, p) => handleJobStatus(p.id)],
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

  // Binary video serving (stitched animation)
  if (method === "GET" && url.startsWith("/videos/")) {
    const jobId = url.slice("/videos/".length).split("?")[0];
    try {
      const { bytes, contentType } = handleVideo(jobId);
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
  console.log(`  routes: POST /models  POST /fittings  POST /outfits  POST /accessories  POST /animations`);
  console.log(`          GET  /jobs/:id  GET /images/:id  GET /videos/:id  GET /runway/balance`);
  console.log(`  runway: ${GEN3 ? `${RUNWAY_MODEL} enabled` : "disabled (set GEN3_API_KEY)"}`);
  console.log(`  origins: ${ALLOWED_ORIGINS.join(", ")}\n`);
});

const delay = ms => new Promise(r => setTimeout(r, ms));
