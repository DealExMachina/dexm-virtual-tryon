/**
 * Live smoke tests — hit a deployed proxy (default: Koyeb). Zero BFL/Runway spend.
 * Only GET /healthz, GET /runway/balance (read), and validation POSTs that fail fast.
 *
 *   SMOKE_BASE_URL=https://your-proxy.koyeb.app npm run test:smoke:live
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.SMOKE_BASE_URL || "")
  .replace(/\/$/, "");

const skipLive = !BASE;

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
  return { status: r.status, data };
}

describe("smoke-live: deployed proxy", { skip: skipLive }, () => {
  test(`target is ${BASE || "(unset)"}`, () => {
    assert.ok(BASE.startsWith("http"));
  });

  test("GET /healthz → 200 (wake instance)", async () => {
    const t0 = Date.now();
    const { status, data } = await json("GET", "/healthz");
    const ms = Date.now() - t0;
    assert.equal(status, 200, `healthz failed in ${ms}ms`);
    assert.equal(data.ok, true);
    if (ms > 8000) {
      console.warn(`  warn: cold start ${ms}ms — redo fittings after wake before reveal`);
    }
  });

  test("GET /runway/balance → 200 (read-only, no generation)", async () => {
    const { status, data } = await json("GET", "/runway/balance");
    assert.equal(status, 200);
    assert.equal(typeof data.credit_balance, "number");
    if (data.reveal) {
      assert.equal(typeof data.reveal.estimated_credits, "number");
      assert.equal(typeof data.sufficient_for_reveal, "boolean");
      console.log(
        `  Runway credits: ${data.credit_balance}, reveal ~${data.reveal.estimated_credits}, ok=${data.sufficient_for_reveal}`
      );
    } else {
      console.log(
        `  Runway credits on proxy key: ${data.credit_balance}` +
          ` (~$${data.estimated_usd_remaining}) — deploy proxy for reveal fields`
      );
    }
  });

  test("POST /fittings without prompt → 400 (no BFL job)", async () => {
    const { status } = await json("POST", "/fittings", {
      person_url: PERSON_URL,
      garment_url: PERSON_URL,
    });
    assert.equal(status, 400);
  });

  test("POST /animations reveal with fake job ids → 404 (sleep scenario)", async () => {
    const { status, data } = await json("POST", "/animations", {
      mode: "reveal",
      shirt_job_id: "job_smoke_stale_shirt",
      combo_job_id: "job_smoke_stale_combo",
      base_image_url: PERSON_URL,
    });
    assert.equal(status, 404);
    assert.match(data.error, /not found|not ready/i);
  });

  test("POST /animations without input → 400 (no Runway job)", async () => {
    const { status, data } = await json("POST", "/animations", {});
    assert.ok(status === 400 || status === 503);
    if (status === 400) {
      assert.match(data.error, /image_url|image_job_id/i);
    }
  });
});
