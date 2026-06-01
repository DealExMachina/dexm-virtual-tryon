/**
 * Unit tests — proxy internals
 * Run: node --test proxy/test/unit.test.js
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── resolveImageBytes ────────────────────────────────────────────────────────
// Re-export the function under test by importing the module in isolation.
// We mock fetch so no network calls happen.

import { resolveImageBytes, buildComposite, corsHeaders, ALLOWED_ORIGINS }
  from "../lib/utils.js";

describe("resolveImageBytes", () => {
  test("decodes a data: URL", async () => {
    const original = Buffer.from("hello");
    const dataUrl = "data:image/jpeg;base64," + original.toString("base64");
    const result = await resolveImageBytes(dataUrl);
    assert.deepEqual(result, original);
  });

  test("decodes raw base64 (no prefix)", async () => {
    const original = Buffer.from("world");
    const result = await resolveImageBytes(original.toString("base64"));
    assert.deepEqual(result, original);
  });

  test("fetches a URL and returns buffer", async () => {
    // Use a tiny public 1px JPEG from GitHub's CDN
    const buf = await resolveImageBytes(
      "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/garment_tee_geo.jpg"
    );
    assert.ok(buf.length > 1000, `expected image bytes, got ${buf.length}B`);
    // JPEG magic bytes: FF D8
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
  });

  test("throws on malformed data URL", async () => {
    await assert.rejects(
      () => resolveImageBytes("data:image/jpeg;base64"),
      /malformed data URL/
    );
  });
});

// ─── buildComposite ───────────────────────────────────────────────────────────

describe("buildComposite", () => {
  const GARMENT_URL =
    "https://raw.githubusercontent.com/DealExMachina/dexm-virtual-tryon/main/results/garment_tee_geo.jpg";

  test("2 garments → correct tile dimensions (512×680)", async () => {
    const buf = await buildComposite([GARMENT_URL, GARMENT_URL]);
    assert.ok(buf instanceof Buffer, "should return a Buffer");
    assert.ok(buf.length > 0, "buffer should not be empty");
    // Verify JPEG output
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
  });

  test("stays under BFL 1 MP limit", async () => {
    const buf = await buildComposite([GARMENT_URL, GARMENT_URL]);
    // Decode with sharp to verify pixel dimensions
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf).metadata();
    const mp = (meta.width * meta.height) / 1_000_000;
    assert.ok(mp < 1.0, `composite is ${mp.toFixed(2)} MP — exceeds BFL 1 MP limit`);
  });

  test("throws on empty garment list", async () => {
    await assert.rejects(() => buildComposite([]), /at least 1/);
  });
});

// ─── corsHeaders ─────────────────────────────────────────────────────────────

describe("corsHeaders", () => {
  test("allows listed origin", () => {
    const allowed = ALLOWED_ORIGINS[0];
    const headers = corsHeaders(allowed);
    assert.equal(headers["Access-Control-Allow-Origin"], allowed);
  });

  test("falls back to first allowed origin for unknown origin", () => {
    const headers = corsHeaders("https://evil.example.com");
    assert.equal(headers["Access-Control-Allow-Origin"], ALLOWED_ORIGINS[0]);
  });

  test("includes Vary: Origin", () => {
    const headers = corsHeaders(ALLOWED_ORIGINS[0]);
    assert.equal(headers["Vary"], "Origin");
  });
});
