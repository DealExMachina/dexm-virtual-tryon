/**
 * Smoke tests — HTTP checks against a local proxy with NO paid API keys.
 * Does not call BFL or Runway. Safe to run anytime.
 *
 *   npm run test:smoke
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const TEST_PORT = 18081;
process.env.PORT = String(TEST_PORT);
process.env.ALLOWED_ORIGINS = `http://localhost:${TEST_PORT},http://test.example`;
// Placeholders only — server exits without BFL; tests never hit paid APIs.
process.env.BFL_API_KEY = process.env.BFL_API_KEY || "bfl_smoke_placeholder";
delete process.env.GEN3_API_KEY;
delete process.env.RUNWAYML_API_SECRET;

await import("../server.js");

const BASE = `http://localhost:${TEST_PORT}`;
const PERSON_URL =
  "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/preset_viking.jpg";

async function json(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  return { status: r.status, data, headers: r.headers };
}

// ─── Liveness & CORS ─────────────────────────────────────────────────────────

describe("smoke: liveness", () => {
  test("GET /healthz → 200", async () => {
    const { status, data } = await json("GET", "/healthz");
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  test("OPTIONS /fittings → 204 + CORS", async () => {
    const r = await fetch(`${BASE}/fittings`, {
      method: "OPTIONS",
      headers: {
        Origin: `http://localhost:${TEST_PORT}`,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(r.status, 204);
    assert.ok(r.headers.get("access-control-allow-origin"));
  });
});

// ─── Runway disabled (no key) ────────────────────────────────────────────────

describe("smoke: runway gated off without API key", () => {
  test("GET /runway/balance → 503", async () => {
    const { status, data } = await json("GET", "/runway/balance");
    assert.equal(status, 503);
    assert.match(data.error, /GEN3_API_KEY|not configured/i);
  });

  test("POST /animations → 503", async () => {
    const { status } = await json("POST", "/animations", { image_url: PERSON_URL });
    assert.equal(status, 503);
  });
});

// ─── Validation (no upstream calls) ──────────────────────────────────────────

describe("smoke: route validation", () => {
  test("POST /models — missing prompt → 400", async () => {
    const { status, data } = await json("POST", "/models", {});
    assert.equal(status, 400);
    assert.match(data.error, /prompt/i);
  });

  test("POST /fittings — missing prompt → 400", async () => {
    const { status, data } = await json("POST", "/fittings", {
      person_url: PERSON_URL,
      garment_url: PERSON_URL,
    });
    assert.equal(status, 400);
    assert.match(data.error, /prompt/i);
  });

  test("POST /outfits — garment_urls not array → 400", async () => {
    const { status } = await json("POST", "/outfits", {
      person_url: PERSON_URL,
      garment_urls: PERSON_URL,
      prompt: "test",
    });
    assert.equal(status, 400);
  });

  test("POST /accessories — missing person → 400", async () => {
    const { status, data } = await json("POST", "/accessories", {
      accessory_url: PERSON_URL,
    });
    assert.equal(status, 400);
    assert.match(data.error, /person/i);
  });

  test("GET /jobs/unknown → 404", async () => {
    const { status } = await json("GET", "/jobs/job_does_not_exist");
    assert.equal(status, 404);
  });

  test("GET /images/unknown → 404", async () => {
    const r = await fetch(`${BASE}/images/job_does_not_exist`);
    assert.equal(r.status, 404);
  });

  test("GET /videos/unknown → 404", async () => {
    const r = await fetch(`${BASE}/videos/job_does_not_exist`);
    assert.equal(r.status, 404);
  });
});

