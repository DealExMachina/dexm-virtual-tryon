/**
 * Reveal route smoke — validates 400/404 paths before any Runway job is queued.
 * Uses a placeholder GEN3 key at startup (no real Runway calls for these cases).
 *
 *   npm run test:smoke
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const TEST_PORT = 18082;
process.env.PORT = String(TEST_PORT);
process.env.ALLOWED_ORIGINS = `http://localhost:${TEST_PORT}`;
process.env.BFL_API_KEY = process.env.BFL_API_KEY || "bfl_smoke_placeholder";
process.env.GEN3_API_KEY = process.env.GEN3_API_KEY || "rw_smoke_placeholder_no_api_calls";
delete process.env.RUNWAYML_API_SECRET;

await import("../server.js");

const BASE = `http://localhost:${TEST_PORT}`;
const PERSON_URL =
  "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/preset_viking.jpg";

async function json(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

describe("smoke: reveal mode (no Runway job started)", () => {
  test("missing shirt_job_id → 400", async () => {
    const { status, data } = await json("POST", "/animations", {
      mode: "reveal",
      combo_job_id: "job_fake_combo",
      base_image_url: PERSON_URL,
    });
    assert.equal(status, 400);
    assert.match(data.error, /shirt_job_id/i);
  });

  test("missing combo_job_id → 400", async () => {
    const { status, data } = await json("POST", "/animations", {
      mode: "reveal",
      shirt_job_id: "job_fake_shirt",
      base_image_url: PERSON_URL,
    });
    assert.equal(status, 400);
    assert.match(data.error, /combo_job_id/i);
  });

  test("missing base_image_url → 400", async () => {
    const { status, data } = await json("POST", "/animations", {
      mode: "reveal",
      shirt_job_id: "job_fake_shirt",
      combo_job_id: "job_fake_combo",
    });
    assert.equal(status, 400);
    assert.match(data.error, /base_image_url|person_url|image_url/i);
  });

  test("stale job ids (proxy slept / restarted) → 404", async () => {
    const { status, data } = await json("POST", "/animations", {
      mode: "reveal",
      shirt_job_id: "job_sleep_lost_shirt",
      combo_job_id: "job_sleep_lost_combo",
      base_image_url: PERSON_URL,
    });
    assert.equal(status, 404);
    assert.match(data.error, /not found|not ready/i);
  });
});
