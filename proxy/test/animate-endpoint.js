#!/usr/bin/env node
/**
 * Manual test for POST /animations
 *
 * Usage:
 *   node test/animate-endpoint.js <image_url>
 *
 * Example (after a fitting):
 *   node test/animate-endpoint.js https://exuberant-octavia-dealexmachina-a8182cc0.koyeb.app/images/job_xxx
 */
const SERVER = process.env.SERVER_URL || "http://localhost:8080";
const imageUrl = process.argv[2];

if (!imageUrl) {
  console.error("Usage: node test/animate-endpoint.js <image_url>");
  process.exit(1);
}

console.log(`\nServer: ${SERVER}`);
console.log(`Image:  ${imageUrl.slice(0, 80)}...\n`);

const submitRes = await fetch(`${SERVER}/animations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ image_url: imageUrl }),
});

if (!submitRes.ok) {
  console.error(`Submit failed (${submitRes.status}):`, await submitRes.text());
  process.exit(1);
}

const { job_id } = await submitRes.json();
console.log(`Job submitted: ${job_id}`);
console.log("Polling (4 clips × ~20s each — allow 2–3 min)...\n");

for (let i = 0; i < 600; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const statusRes = await fetch(`${SERVER}/jobs/${job_id}`);
  const d = await statusRes.json();

  if (d.clips?.length) {
    const summary = d.clips
      .map(c => `${c.name}=${c.video_url ? "done" : c.status === "failed" ? "fail" : "..."}`)
      .join(", ");
    process.stdout.write(`\r[${i * 3}s] ${d.status} — ${summary}   `);
  }

  if (d.status === "ready") {
    console.log("\n\nReady!");
    console.log(`Clips: ${d.video_urls?.length}`);
    d.video_urls?.forEach((url, n) => console.log(`  [${n + 1}] ${url}`));
    process.exit(0);
  }
  if (d.status === "failed") {
    console.error("\n\nFailed:", d.error);
    process.exit(1);
  }
}

console.error("\nTimeout");
process.exit(1);
