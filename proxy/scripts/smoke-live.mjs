#!/usr/bin/env node
/**
 * Quick live smoke against a deployed proxy — no BFL/Runway generation.
 *
 *   node scripts/smoke-live.mjs
 *   SMOKE_BASE_URL=https://your-proxy.koyeb.app node scripts/smoke-live.mjs
 */
const BASE = (process.env.SMOKE_BASE_URL ||
  "https://exuberant-octavia-dealexmachina-a8182cc0.koyeb.app"
).replace(/\/$/, "");

const PERSON_URL =
  "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/preset_viking.jpg";

let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

async function json(method, path, body) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, ms };
}

console.log(`\nSmoke (live, no token burn) → ${BASE}\n`);

await check("GET /healthz", async () => {
  const { status, data, ms } = await json("GET", "/healthz");
  if (status !== 200 || !data.ok) throw new Error(`${status} in ${ms}ms`);
  if (ms > 8000) console.log(`       (cold start ${ms}ms — wake before a reveal session)`);
});

await check("GET /runway/balance (read-only)", async () => {
  const { status, data } = await json("GET", "/runway/balance");
  if (status !== 200) throw new Error(`${status}: ${JSON.stringify(data)}`);
  console.log(
    `       credits=${data.credit_balance} (~$${data.estimated_usd_remaining})`
  );
});

await check("POST /animations reveal stale jobs → 404", async () => {
  const { status, data } = await json("POST", "/animations", {
    mode: "reveal",
    shirt_job_id: "job_smoke_stale",
    combo_job_id: "job_smoke_stale",
    base_image_url: PERSON_URL,
  });
  if (status !== 404) throw new Error(`expected 404, got ${status}: ${data.error}`);
});

await check("POST /fittings missing prompt → 400", async () => {
  const { status } = await json("POST", "/fittings", {
    person_url: PERSON_URL,
    garment_url: PERSON_URL,
  });
  if (status !== 400) throw new Error(`expected 400, got ${status}`);
});

console.log(failed ? `\n${failed} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(failed ? 1 : 0);
