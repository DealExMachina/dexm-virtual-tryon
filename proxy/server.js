// BFL VTO proxy — minimal Node server with CORS for the dexm static demo.
//
// KEY DESIGN PRINCIPLES:
// 1. Never return BFL signed delivery URLs to the browser.
//    The proxy downloads images and serves them from its own origin so
//    the browser always loads same-origin images (no CORS, no expiry,
//    works on Safari).
//
// 2. All image composition happens server-side.
//    Browser canvas is unreliable: cross-origin taint in Safari,
//    and easy to exceed BFL's 1 MP garment image limit.
//    /api/outfit-vto does server-side 2×2 grid at exactly ~0.5 MP
//    per BFL's multi-garment spec.
//
// Routes:
//   POST /api/generate         → text-to-image,      returns { ok, job_id }
//   POST /api/vto              → single garment VTO,  returns { ok, job_id }
//   POST /api/outfit-vto       → multi-garment VTO,   returns { ok, job_id }
//   GET  /api/job?id=…         → poll status,         returns { status, image_path? }
//   GET  /api/image/:jobId     → serve image bytes    (same-origin)
//   GET  /healthz              → 200 OK
import { createServer } from "node:http";
import sharp from "sharp";

const BFL_API = "https://api.bfl.ai/v1";
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.BFL_API_KEY;

if (!API_KEY) {
  console.error("FATAL: BFL_API_KEY env var is required.");
  process.exit(1);
}

const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  "https://dealexmachina.github.io,https://jeanbapt.github.io,http://localhost:8091,http://localhost:8092,http://localhost:5500,http://localhost:8000")
  .split(",").map(s => s.trim());

// In-memory job store. Holds metadata + image bytes.
// Expires after 1h to avoid memory growth on Koyeb's free tier.
const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, v] of jobs) if (v.created < cutoff) jobs.delete(k);
}, 60_000);

// ─── BFL helpers ──────────────────────────────────────────────────────────────

async function bflRequest(endpoint, payload, attempt = 0) {
  try {
    const res = await fetch(`${BFL_API}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Key": API_KEY, "accept": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`BFL ${res.status}: ${await res.text()}`);
    return res.json();
  } catch (e) {
    const transient = e.message === "fetch failed" || e.cause?.code === "ECONNRESET";
    if (transient && attempt < 3) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
      return bflRequest(endpoint, payload, attempt + 1);
    }
    throw e;
  }
}

async function bflPoll(pollingUrl, maxWaitMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(pollingUrl, { headers: { "X-Key": API_KEY, accept: "application/json" } });
    const result = await res.json();
    if (result.status === "Ready") return result;
    if (["Error", "Failed", "Content Moderated", "Request Moderated"].includes(result.status)) return result;
    await new Promise(r => setTimeout(r, 1500));
  }
  return { status: "Timeout" };
}

const stripDataPrefix = v => {
  if (typeof v !== "string" || !v.startsWith("data:")) return v;
  const c = v.indexOf(",");
  return c >= 0 ? v.slice(c + 1) : v;
};

// ─── Job runner ───────────────────────────────────────────────────────────────

async function runJob(jobId, endpoint, payload) {
  try {
    const resp = await bflRequest(endpoint, payload);
    console.log(`[${jobId}] submitted, BFL id=${resp.id}`);

    const result = await bflPoll(resp.polling_url);
    if (result.status !== "Ready") {
      jobs.set(jobId, { ...jobs.get(jobId), status: "failed", detail: result.status });
      console.log(`[${jobId}] failed: ${result.status}`);
      return;
    }

    // Download the image bytes here in the proxy — never pass the BFL signed
    // URL to the browser, which can't reliably load cross-origin images from
    // BFL's CDN (expiry, Safari privacy mode, no ACAO header).
    const imgRes = await fetch(result.result.sample);
    if (!imgRes.ok) throw new Error(`image download failed ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";

    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: "ready",
      imageBytes: buf,
      contentType,
      image_path: `/api/image/${jobId}`,
    });
    console.log(`[${jobId}] ready — ${buf.length}B`);
  } catch (e) {
    console.error(`[${jobId}] error:`, e.message);
    jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message });
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function corsHeaders(origin) {
  const allowed = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function jsonResponse(res, origin, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...corsHeaders(origin) });
  res.end(body);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleGenerate(req, res, origin) {
  const body = await readBody(req);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "pending", created: Date.now() });
  console.log(`[generate] ${body.prompt?.slice(0, 80)}…`);
  runJob(jobId, "flux-2-klein-9b", {
    prompt: body.prompt, width: body.width || 832, height: body.height || 1216,
    safety_tolerance: 2, output_format: "jpeg",
  });
  jsonResponse(res, origin, { ok: true, job_id: jobId });
}

// Build a 2×2 grid composite from multiple garment URLs.
// Target: ~0.5 MP total (BFL spec: "~0.5 MP, 1 MP max").
// Each tile: 256×340 px → total: 512×680 = 0.35 MP (safe margin).
async function buildGarmentComposite(garmentUrls) {
  const TILE_W = 256, TILE_H = 340;
  const COLS = 2, ROWS = 2;

  // Download all garments (up to 4)
  const urls = garmentUrls.slice(0, 4);
  const buffers = await Promise.all(urls.map(async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`failed to fetch garment ${url}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }));

  // Resize each garment to fit within tile, preserve aspect ratio, white bg
  const tiles = await Promise.all(buffers.map(buf =>
    sharp(buf)
      .resize(TILE_W, TILE_H, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 90 })
      .toBuffer()
  ));

  // Build 2×2 canvas (white background, tiles placed top-left through their slot)
  const canvas = sharp({
    create: {
      width: TILE_W * COLS,
      height: TILE_H * ROWS,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  const composites = tiles.map((tile, i) => ({
    input: tile,
    left: (i % COLS) * TILE_W,
    top: Math.floor(i / COLS) * TILE_H,
  }));

  return canvas.composite(composites).jpeg({ quality: 90 }).toBuffer();
}

async function handleOutfitVto(req, res, origin) {
  // Accepts: { person_url, garment_urls: [url1, url2, …], prompt }
  // Composes the garments server-side into a 2×2 grid at ~0.5 MP,
  // then submits a single VTO call to BFL.
  const body = await readBody(req);
  const { garment_urls, prompt } = body;
  const person = stripDataPrefix(body.person_b64 || body.person_url);

  if (!person || !garment_urls?.length) {
    jsonResponse(res, origin, { ok: false, error: "person and garment_urls[] are required" }, 400);
    return;
  }

  console.log(`[outfit-vto] person=${Math.round(person.length / 1024)}KB garments=${garment_urls.length}`);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "pending", created: Date.now() });

  // Respond immediately — composition + BFL call happens in the background
  jsonResponse(res, origin, { ok: true, job_id: jobId });

  try {
    const compositeBuf = await buildGarmentComposite(garment_urls);
    const garmentB64 = compositeBuf.toString("base64");
    console.log(`[${jobId}] composite built: ${compositeBuf.length}B (${Math.round(compositeBuf.length / 1024)}KB)`);
    await runJob(jobId, "flux-tools/vto-v1", {
      person: stripDataPrefix(person),
      garment: garmentB64,
      prompt: prompt?.trim() ||
        "The person of image 1, maintaining exactly their face and pose, wearing the garments of image 2.",
      output_format: "jpeg",
    });
  } catch (e) {
    console.error(`[${jobId}] outfit-vto error:`, e.message);
    jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message });
  }
}

async function handleVto(req, res, origin) {
  const body = await readBody(req);
  const person = stripDataPrefix(body.person_b64 || body.person_url);
  const garment = stripDataPrefix(body.garment_b64 || body.garment_url);
  if (!person || !garment) {
    jsonResponse(res, origin, { ok: false, error: "person and garment are required" }, 400);
    return;
  }
  console.log(`[vto] person=${Math.round(person.length / 1024)}KB garment=${Math.round(garment.length / 1024)}KB`);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "pending", created: Date.now() });
  runJob(jobId, "flux-tools/vto-v1", {
    person, garment,
    prompt: (body.prompt?.trim()) ||
      "The person of image 1, maintaining exactly their face and pose, wearing the garment of image 2.",
    output_format: "jpeg",
  });
  jsonResponse(res, origin, { ok: true, job_id: jobId });
}

function handleJobStatus(req, res, origin) {
  const id = new URL(req.url, "http://x").searchParams.get("id");
  const job = jobs.get(id);
  if (!job) { jsonResponse(res, origin, { status: "not_found" }, 404); return; }
  // Return image_path (proxy-served, same-origin) — never the BFL URL
  jsonResponse(res, origin, {
    ok: job.status === "ready",
    status: job.status,
    image_path: job.image_path,   // → /api/image/:jobId
    error: job.error,
    detail: job.detail,
  });
}

function handleImageServe(req, res, origin) {
  // Extract jobId from /api/image/:jobId
  const jobId = req.url.replace("/api/image/", "").split("?")[0];
  const job = jobs.get(jobId);
  if (!job?.imageBytes) {
    res.writeHead(404, corsHeaders(origin));
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": job.contentType || "image/jpeg",
    "Content-Length": job.imageBytes.length,
    "Cache-Control": "public, max-age=3600",
    ...corsHeaders(origin),
  });
  res.end(job.imageBytes);
}

// ─── Main server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  if (req.url === "/healthz" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain", ...corsHeaders(origin) });
    res.end("ok");
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/api/generate")    return await handleGenerate(req, res, origin);
    if (req.method === "POST" && req.url === "/api/vto")         return await handleVto(req, res, origin);
    if (req.method === "POST" && req.url === "/api/outfit-vto")  return await handleOutfitVto(req, res, origin);
    if (req.method === "GET"  && req.url.startsWith("/api/job"))    return handleJobStatus(req, res, origin);
    if (req.method === "GET"  && req.url.startsWith("/api/image/")) return handleImageServe(req, res, origin);
  } catch (e) {
    console.error("handler error:", e);
    jsonResponse(res, origin, { ok: false, error: e.message }, 500);
    return;
  }

  res.writeHead(404, corsHeaders(origin));
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`dexm proxy → port ${PORT}`);
  console.log(`allowed origins: ${ALLOWED.join(", ")}`);
});
