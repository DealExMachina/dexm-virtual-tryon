import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 8091;
const BFL_API = "https://api.bfl.ai/v1";
const API_KEY = process.env.BFL_API_KEY;

if (!API_KEY) {
  console.error("ERROR: Set BFL_API_KEY in .env");
  console.error("  echo 'BFL_API_KEY=your-key' > .env");
  process.exit(1);
}

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function bflRequest(endpoint, payload, attempt = 0) {
  const MAX_RETRIES = 3;
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
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BFL ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    // Retry only on transient network errors, not on BFL 4xx/5xx
    const isNetworkErr = e.message === "fetch failed" || e.cause?.code === "ECONNRESET" || e.cause?.code === "UND_ERR_SOCKET";
    if (isNetworkErr && attempt < MAX_RETRIES) {
      const delay = (attempt + 1) * 1500;
      console.log(`  [retry] ${endpoint} attempt ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${e.message})`);
      await new Promise(r => setTimeout(r, delay));
      return bflRequest(endpoint, payload, attempt + 1);
    }
    throw e;
  }
}

async function bflPoll(pollingUrl, maxWait = 300) {
  const start = Date.now();
  while (Date.now() - start < maxWait * 1000) {
    const res = await fetch(pollingUrl, {
      headers: { "X-Key": API_KEY, "accept": "application/json" },
    });
    const result = await res.json();
    if (result.status === "Ready") return result;
    if (["Error", "Content Moderated", "Request Moderated", "Failed"].includes(result.status)) return result;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { status: "Timeout" };
}

async function downloadImage(imageUrl, filename) {
  const dir = join(__dirname, "results");
  await mkdir(dir, { recursive: true });
  const res = await fetch(imageUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  const path = join(dir, filename);
  await writeFile(path, buf);
  return `/results/${filename}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// In-memory job tracker. Jobs never expire — fine for a demo.
const jobs = new Map();

async function runJob(jobId, endpoint, payload, filenamePrefix) {
  try {
    const resp = await bflRequest(endpoint, payload);
    console.log(`[${jobId}] submitted: ${resp.id}, polling: ${resp.polling_url}`);
    const result = await bflPoll(resp.polling_url, 300);
    console.log(`[${jobId}] status: ${result.status}`);
    if (result.status === "Ready") {
      const imageUrl = result.result.sample;
      const localPath = await downloadImage(imageUrl, `${filenamePrefix}_${Date.now()}.jpg`);
      jobs.set(jobId, { status: "ready", image_url: imageUrl, local_path: localPath });
    } else {
      jobs.set(jobId, { status: "failed", detail: result });
    }
  } catch (e) {
    console.error(`[${jobId}] error:`, e.message);
    jobs.set(jobId, { status: "failed", error: e.message });
  }
}

async function handleGenerate(req, res) {
  const body = await readBody(req);
  console.log(`[generate] ${body.prompt?.slice(0, 80)}...`);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "pending" });
  runJob(jobId, "flux-2-klein-9b", {
    prompt: body.prompt,
    width: body.width || 832,
    height: body.height || 1216,
    safety_tolerance: 2,
    output_format: "jpeg",
  }, "model");
  jsonResponse(res, { ok: true, job_id: jobId });
}

async function handleVto(req, res) {
  const body = await readBody(req);
  // Both person and garment may come as a URL OR a base64 data URL
  const person = body.person_b64 || body.person_url;
  const garment = body.garment_b64 || body.garment_url;
  const isComposite = !!body.garment_b64;
  const personIsLocal = !!body.person_b64 || body.person_url?.startsWith("/");

  // Validate base64 payloads — reject malformed input early
  function validateB64(label, value) {
    if (!value?.startsWith("data:")) return null;
    const comma = value.indexOf(",");
    if (comma < 0) return `${label} missing comma after data: prefix`;
    const b64 = value.slice(comma + 1);
    if (b64.length < 100) return `${label} base64 too short (${b64.length} chars) — image failed to compose`;
    if (b64.length % 4 !== 0) return `${label} base64 length ${b64.length} not a multiple of 4`;
    return null;
  }
  for (const [label, v] of [["person", person], ["garment", garment]]) {
    const err = validateB64(label, v);
    if (err) {
      console.log(`[vto] REJECT: ${err}`);
      jsonResponse(res, { ok: false, error: err }, 400);
      return;
    }
  }

  console.log(`[vto] person=${personIsLocal ? `<base64 ${Math.round((person?.length||0)/1024)}KB>` : body.person_url?.slice(0, 60) + '...'} garment=${isComposite ? `<composite ${Math.round(garment.length/1024)}KB>` : garment?.slice(0, 60) + '...'}`);
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: "pending" });

  // BFL can't fetch localhost paths. Any /results/... path must be inlined as base64.
  async function resolveImage(label, value) {
    if (typeof value !== "string") return value;
    // Local path → read from disk, return raw base64
    if (value.startsWith("/results/")) {
      try {
        const buf = await readFile(join(__dirname, value));
        return buf.toString("base64");
      } catch (e) {
        throw new Error(`${label} local read failed: ${e.message}`);
      }
    }
    // Data URL → strip prefix, return raw base64
    if (value.startsWith("data:")) {
      const comma = value.indexOf(",");
      return comma >= 0 ? value.slice(comma + 1) : value;
    }
    // Public URL or already raw base64 → pass through
    return value;
  }

  let personValue, garmentValue;
  try {
    [personValue, garmentValue] = await Promise.all([
      resolveImage("person", person),
      resolveImage("garment", garment),
    ]);
  } catch (e) {
    jsonResponse(res, { ok: false, error: e.message }, 400);
    return;
  }

  const payload = {
    person: personValue,
    garment: garmentValue,
    prompt: (body.prompt && body.prompt.trim()) || (isComposite
      ? "The person of image 1, maintaining exactly their face and pose, wearing the garments of image 2."
      : "The person of image 1, maintaining exactly their face and pose, wearing the garment of image 2."),
    output_format: "jpeg",
  };
  runJob(jobId, "flux-tools/vto-v1", payload, "vto");
  jsonResponse(res, { ok: true, job_id: jobId });
}

async function handleImageProxy(req, res) {
  const url = new URL(req.url, "http://localhost");
  const target = url.searchParams.get("url");
  if (!target) {
    res.writeHead(400);
    res.end("missing url");
    return;
  }
  try {
    const upstream = await fetch(target);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502);
    res.end("proxy error: " + e.message);
  }
}

function handleJobStatus(req, res) {
  const url = new URL(req.url, "http://localhost");
  const jobId = url.searchParams.get("id");
  const job = jobs.get(jobId);
  if (!job) {
    jsonResponse(res, { status: "not_found" }, 404);
    return;
  }
  jsonResponse(res, { ok: job.status === "ready", ...job });
}

async function serveStatic(req, res) {
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = join(__dirname, url);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/generate") return handleGenerate(req, res);
  if (req.method === "POST" && req.url === "/api/vto") return handleVto(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/job")) return handleJobStatus(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/proxy")) return handleImageProxy(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  Baziszt VTO Demo → http://localhost:${PORT}`);
  console.log(`  API key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}\n`);
});
