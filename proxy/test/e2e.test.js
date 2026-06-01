/**
 * End-to-end tests — full HTTP flow against a live proxy instance.
 * Requires BFL_API_KEY in environment.
 * Run: node --test --env-file=../../baziszt-tryon/.env proxy/test/e2e.test.js
 *
 * These tests make real BFL API calls — they count against your credits.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Start the proxy on a random port for tests
const TEST_PORT = 18080;
process.env.PORT = TEST_PORT;
process.env.ALLOWED_ORIGINS = `http://localhost:${TEST_PORT},http://test.example`;

// Dynamic import so env vars are set before the module reads them
const { default: startServer } = await import("../server.js");

const BASE = `http://localhost:${TEST_PORT}`;

const PERSON_URL  = "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/preset_viking.jpg";
const GARMENT_1   = "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/garment_tee_geo.jpg";
const GARMENT_2   = "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/garment_bomber_black.jpg";

// Helper: poll /jobs/:id until done
async function waitForJob(jobId, maxMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`${BASE}/jobs/${jobId}`);
    const d = await r.json();
    if (d.status === "ready" || d.status === "failed") return d;
  }
  throw new Error(`job ${jobId} timed out after ${maxMs}ms`);
}

// ─── /healthz ────────────────────────────────────────────────────────────────

describe("GET /healthz", () => {
  test("returns 200 ok", async () => {
    const r = await fetch(`${BASE}/healthz`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.ok, true);
  });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe("CORS", () => {
  test("OPTIONS preflight returns 204", async () => {
    const r = await fetch(`${BASE}/fittings`, {
      method: "OPTIONS",
      headers: {
        "Origin": `http://localhost:${TEST_PORT}`,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(r.status, 204);
    assert.ok(r.headers.get("access-control-allow-origin"));
  });

  test("allows listed origin", async () => {
    const r = await fetch(`${BASE}/healthz`, {
      headers: { "Origin": `http://localhost:${TEST_PORT}` },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), `http://localhost:${TEST_PORT}`);
  });
});

// ─── Route validation ─────────────────────────────────────────────────────────

describe("Route validation", () => {
  test("POST /fittings — missing prompt → 400", async () => {
    const r = await fetch(`${BASE}/fittings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_url: PERSON_URL, garment_url: GARMENT_1 }),
    });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.ok(d.error.includes("prompt"));
  });

  test("POST /outfits — garment_urls not array → 400", async () => {
    const r = await fetch(`${BASE}/outfits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_url: PERSON_URL, garment_urls: GARMENT_1, prompt: "test" }),
    });
    assert.equal(r.status, 400);
  });

  test("GET /jobs/unknown-id → 404", async () => {
    const r = await fetch(`${BASE}/jobs/nonexistent`);
    assert.equal(r.status, 404);
  });

  test("GET /images/unknown-id → 404", async () => {
    const r = await fetch(`${BASE}/images/nonexistent`);
    assert.equal(r.status, 404);
  });

  test("unknown route → 404", async () => {
    const r = await fetch(`${BASE}/doesnotexist`);
    assert.equal(r.status, 404);
  });

  test("POST /animations — missing image input → 400", async () => {
    const r = await fetch(`${BASE}/animations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!process.env.GEN3_API_KEY && !process.env.RUNWAYML_API_SECRET) {
      assert.equal(r.status, 503);
      return;
    }
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.ok(d.error.includes("image_url") || d.error.includes("image_job_id"));
  });
});

// ─── /fittings — live BFL call ────────────────────────────────────────────────

describe("POST /fittings (live)", () => {
  test("submits and returns job_id", async () => {
    const r = await fetch(`${BASE}/fittings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person_url:  PERSON_URL,
        garment_url: GARMENT_1,
        prompt: "The person of image 1, maintaining exactly their face and pose, wearing the plain white cotton t-shirt with a small black geometric triangle chest print of image 2.",
      }),
    });
    assert.equal(r.status, 200);
    const { job_id } = await r.json();
    assert.ok(job_id, "should return a job_id");

    // Poll until ready
    const job = await waitForJob(job_id);
    assert.equal(job.status, "ready", `job failed: ${job.error}`);
    assert.ok(job.image_url?.startsWith("/images/"), `expected /images/:id, got ${job.image_url}`);

    // Fetch as WebP
    const imgR = await fetch(`${BASE}${job.image_url}`, {
      headers: { Accept: "image/webp,image/*" },
    });
    assert.equal(imgR.status, 200);
    assert.equal(imgR.headers.get("content-type"), "image/webp");
    const buf = Buffer.from(await imgR.arrayBuffer());
    assert.ok(buf.length > 5000, `WebP too small: ${buf.length}B`);

    // Fetch as JPEG fallback
    const jpegR = await fetch(`${BASE}${job.image_url}`);
    assert.equal(jpegR.headers.get("content-type"), "image/jpeg");
    const jbuf = Buffer.from(await jpegR.arrayBuffer());
    assert.equal(jbuf[0], 0xff);
    assert.equal(jbuf[1], 0xd8);
  });
});

// ─── /outfits — live BFL call ─────────────────────────────────────────────────

describe("POST /outfits (live)", () => {
  test("composites 2 garments and returns a valid image", async () => {
    const r = await fetch(`${BASE}/outfits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        person_url:   PERSON_URL,
        garment_urls: [GARMENT_1, GARMENT_2],
        prompt: "The person of image 1, maintaining exactly their face and pose, wearing the plain white cotton t-shirt with a small black geometric triangle chest print and the black nylon MA-1 bomber jacket with orange lining of image 2.",
      }),
    });
    assert.equal(r.status, 200);
    const { job_id } = await r.json();
    assert.ok(job_id);

    const job = await waitForJob(job_id);
    assert.equal(job.status, "ready", `outfit job failed: ${job.error}`);

    const imgR = await fetch(`${BASE}${job.image_url}`, {
      headers: { Accept: "image/webp" },
    });
    assert.equal(imgR.status, 200);
    const buf = Buffer.from(await imgR.arrayBuffer());
    assert.ok(buf.length > 10_000, `result image too small: ${buf.length}B`);
  });
});
