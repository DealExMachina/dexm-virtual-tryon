/**
 * Shared utilities — pure functions with no side effects.
 * Separated so they can be unit-tested without starting an HTTP server.
 */
import sharp from "sharp";

// Tile dimensions for BFL 2×2 multi-garment grid.
// 256×340 × 4 tiles = 512×680 = 0.35 MP (BFL target: ~0.5 MP, hard max: 1 MP)
export const TILE_W = 256;
export const TILE_H = 340;

// Allowed CORS origins
export const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://dealexmachina.github.io,https://jeanbapt.github.io," +
  "http://localhost:8091,http://localhost:8092,http://localhost:5500,http://localhost:8000"
).split(",").map(s => s.trim());

// ─── Image source normalisation ───────────────────────────────────────────────

/**
 * Resolve any image source to raw bytes.
 * Accepts:
 *   - "data:image/jpeg;base64,<data>"  → strips prefix, decodes base64
 *   - raw base64 string (no prefix)    → decodes base64
 *   - "https://..."                    → fetches and buffers
 */
export async function resolveImageBytes(src) {
  if (typeof src !== "string") throw new Error("image source must be a string");

  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    if (comma < 0) throw new Error("malformed data URL: missing comma after data: prefix");
    return Buffer.from(src.slice(comma + 1), "base64");
  }

  // Heuristic: raw base64 — doesn't start with http, is ≥100 chars, matches charset
  if (!src.startsWith("http") && src.length >= 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(src.slice(0, 200))) {
    return Buffer.from(src, "base64");
  }

  const r = await fetch(src);
  if (!r.ok) throw new Error(`failed to fetch image from ${src}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Convert bytes to raw base64 (no data: prefix) for BFL API payloads.
 */
export async function toBase64ForBFL(src) {
  const buf = await resolveImageBytes(src);
  return buf.toString("base64");
}

// ─── Image composition ────────────────────────────────────────────────────────

/**
 * Build a 2×2 grid composite from garment image URLs.
 * Output is always ~0.35 MP: 512×680 px (well within BFL's 1 MP hard limit).
 * Each garment is fitted (contain) into a 256×340 tile on a white background.
 * Returns a JPEG buffer ready to be base64-encoded for BFL.
 */
export async function buildComposite(urls) {
  if (!Array.isArray(urls) || urls.length < 1)
    throw new Error("buildComposite requires at least 1 garment URL");

  const cols = 2, rows = 2;
  const slots = urls.slice(0, cols * rows);

  const tiles = await Promise.all(
    slots.map(async url => {
      const src = await resolveImageBytes(url);
      return sharp(src)
        .resize(TILE_W, TILE_H, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255 },
        })
        .jpeg({ quality: 88 })
        .toBuffer();
    })
  );

  return sharp({
    create: {
      width:    TILE_W * cols,
      height:   TILE_H * rows,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(tiles.map((buf, i) => ({
      input: buf,
      left:  (i % cols) * TILE_W,
      top:   Math.floor(i / cols) * TILE_H,
    })))
    .jpeg({ quality: 88 })
    .toBuffer();
}

// ─── Image format conversion ──────────────────────────────────────────────────

export async function toWebP(buf) {
  return sharp(buf).webp({ quality: 82 }).toBuffer();
}

export async function toJpeg(buf) {
  return sharp(buf).jpeg({ quality: 88 }).toBuffer();
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

export function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age":       "600",
    "Vary": "Origin",
  };
}
