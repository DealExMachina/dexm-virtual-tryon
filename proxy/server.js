// BFL VTO proxy — minimal Node server with CORS for the dexm static demo.
// Deploy to Koyeb (or any Node host) and set BFL_API_KEY as an env var.
// Routes:
//   POST /api/generate  → submit text-to-image, returns { ok, job_id }
//   POST /api/vto       → submit virtual try-on, returns { ok, job_id }
//   GET  /api/job?id=…  → poll job status, returns { status, image_url?, … }
//   GET  /healthz       → 200 OK
// Async job pattern: submit returns immediately, frontend polls.
import { createServer } from "node:http";

const BFL_API = "https://api.bfl.ai/v1";
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.BFL_API_KEY;

if (!API_KEY) {
  console.error("FATAL: BFL_API_KEY env var is required.");
  process.exit(1);
}

// Static-site origins permitted to call this proxy.
// Set ALLOWED_ORIGINS env var (comma-separated) to override.
const ALLOWED = (process.env.ALLOWED_ORIGINS ||
  "https://dealexmachina.github.io,https://jeanbapt.github.io,http://localhost:8091,http://localhost:5500,http://localhost:8000")
  .split(",").map(s => s.trim());

// In-memory job tracker. Jobs expire after 1h.
const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, v] of jobs) if (v.created < cutoff) jobs.delete(k);
}, 60_000);

async function bflRequest(endpoint, payload, attempt = 0) {
  try {
    const res = await fetch(`${BFL_API}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Key": API_KEY,
        "accept": "application/json",
      },
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
  if (typeof v !== "string") return v;
  if (v.startsWith("data:")) {
    const c = v.indexOf(",");
    return c >= 0 ? v.slice(c + 1) : v;
  }
  return v;
};

async function runJob(jobId, endpoint, payload) {
  try {
    const resp = await bflRequest(endpoint, payload);
    console.log(`[${jobId}] submitted to ${endpoint}, BFL id=${resp.id}`);
    const result = await bflPoll(resp.polling_url);
    if (result.status === "Ready") {
      const job = jobs.get(jobId);
      jobs.set(jobId, { ...job, status: "ready", image_url: result.result.sample });
      console.log(`[${jobId}] ready`);
    } else {
      jobs.set(jobId, { ...jobs.get(jobId), status: "failed", detail: result });
      console.log(`[${jobId}] failed: ${result.status}`);
    }
  } catch (e) {
    console.error(`[${jobId}] error:`, e.message);
    jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message });
  }
}

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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(origin),
  });
  res.end(body);
}

async function handleGenerate(req, res, origin) {
  const body = await readBody(req);
  console.log(`[generate] ${body.prompt?.slice(0, 80)}…`);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "pending", created: Date.now() });
  runJob(jobId, "flux-2-klein-9b", {
    prompt: body.prompt,
    width: body.width || 832,
    height: body.height || 1216,
    safety_tolerance: 2,
    output_format: "jpeg",
  });
  jsonResponse(res, origin, { ok: true, job_id: jobId });
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
    person,
    garment,
    prompt: (body.prompt && body.prompt.trim()) ||
      "The person of image 1, maintaining exactly their face and pose, wearing the garment of image 2.",
    output_format: "jpeg",
  });
  jsonResponse(res, origin, { ok: true, job_id: jobId });
}

function handleJobStatus(req, res, origin) {
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id");
  const job = jobs.get(id);
  if (!job) {
    jsonResponse(res, origin, { status: "not_found" }, 404);
    return;
  }
  jsonResponse(res, origin, {
    ok: job.status === "ready",
    status: job.status,
    image_url: job.image_url,
    detail: job.detail,
    error: job.error,
  });
}

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
    if (req.method === "POST" && req.url === "/api/generate") return await handleGenerate(req, res, origin);
    if (req.method === "POST" && req.url === "/api/vto") return await handleVto(req, res, origin);
    if (req.method === "GET" && req.url.startsWith("/api/job")) return handleJobStatus(req, res, origin);
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
