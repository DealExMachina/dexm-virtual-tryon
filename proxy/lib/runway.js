/**
 * Runway image-to-video client.
 *
 * API notes (https://docs.dev.runwayml.com/api/):
 *  - image_to_video: promptImage = first frame, promptText = motion/action in the clip
 *  - Same promptImage in parallel → near-identical outputs (expression won't change)
 *  - Credible mood chains: sequential clips + last-frame handoff + ffmpeg stitch
 *  - act_two / character_performance needs a reference performance video (not used here)
 *
 * @see https://docs.dev.runwayml.com/guides/using-the-api/
 * @see https://docs.dev.runwayml.com/api-details/versioning/  (X-Runway-Version: 2024-11-06)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export const RUNWAY_API = "https://api.dev.runwayml.com/v1";
export const RUNWAY_VERSION = "2024-11-06";

export const DEFAULT_RUNWAY_MODEL = "gen3a_turbo";
export const DEFAULT_RUNWAY_RATIO = "768:1280";

export const CREDIT_USD = 0.01;

export const VIDEO_CREDITS_PER_SECOND = {
  seedance2: 36,
  "gen4.5": 12,
  gen4_turbo: 5,
  gen4_aleph: 15,
  gen3a_turbo: 5,
  act_two: 5,
  veo3: 40,
  "veo3.1": 40,
  veo3_1_fast: 15,
  happyhorse_1_0: 15,
};

export const DEFAULT_G_CO2_PER_CREDIT = 0.4;

const round2 = n => Math.round(n * 100) / 100;
const delay = ms => new Promise(r => setTimeout(r, ms));

/** Shared camera / identity lock — keeps chained clips visually continuous. */
const VIKING_LOCK =
  "Static locked-off camera, head-and-shoulders portrait, same Viking warrior throughout, " +
  "identical braids and features, plain white studio background, photorealistic fashion editorial.";

/**
 * Default: 4×5s chained moods. Each promptText describes MOTION from the input frame
 * (Runway API: promptImage = first frame, promptText = what happens next).
 */
export const VIKING_MOOD_SEQUENCE = [
  {
    name: "neutral",
    mood: "neutral",
    duration: 5,
    promptText:
      `${VIKING_LOCK} Only subtle lifelike motion: slow blinks, gentle breathing. ` +
      "Lips stay closed and relaxed, no smile, calm steady gaze into camera.",
  },
  {
    name: "smile",
    mood: "warm smile",
    duration: 5,
    promptText:
      `${VIKING_LOCK} Starting from this face, animate a gradual warm smile forming — ` +
      "mouth corners lift slowly, cheeks rise, eyes soften. Clear visible change from neutral to smiling.",
  },
  {
    name: "grin",
    mood: "grin",
    duration: 5,
    promptText:
      `${VIKING_LOCK} Starting from this smiling face, animate the smile widening into a broad toothy grin — ` +
      "teeth become visible, eyes crinkle, slight playful head tilt. Joyful energy building.",
  },
  {
    name: "serious",
    mood: "deadly serious",
    duration: 5,
    promptText:
      `${VIKING_LOCK} Starting from this grin, animate the expression dropping to deadly serious — ` +
      "smile vanishes, jaw clenches, brow tightens, eyes turn cold and hard, unblinking stare.",
  },
];

/** One 10s continuous arc — cheaper (~50 credits) but less control than chained sequence. */
export const EXPRESSION_ARC_SINGLE = [
  {
    name: "expression_arc",
    mood: "neutral → smile → grin → serious",
    duration: 10,
    promptText:
      `${VIKING_LOCK} One continuous performance in a single take: ` +
      "(0–2s) neutral resting face, lips closed; " +
      "(2–5s) warm smile slowly grows; " +
      "(5–7s) smile erupts into a wide toothy grin; " +
      "(7–10s) grin collapses into a cold deadly serious stare. Smooth emotional progression.",
  },
];

/** @deprecated — use VIKING_MOOD_SEQUENCE */
export const EXPRESSION_SEQUENCE_CHAINED = VIKING_MOOD_SEQUENCE;
export const DEFAULT_ANIMATION_SEQUENCE = VIKING_MOOD_SEQUENCE;

export function estimateClipCost(model, durationSeconds) {
  const cps = VIDEO_CREDITS_PER_SECOND[model] ?? 5;
  const credits = cps * durationSeconds;
  return {
    model,
    duration_seconds: durationSeconds,
    credits_per_second: cps,
    estimated_credits: credits,
    estimated_usd: round2(credits * CREDIT_USD),
  };
}

export function estimateSequenceCost(sequence, model) {
  const clips = sequence.map(c => ({
    name: c.name,
    mood: c.mood,
    ...estimateClipCost(model, c.duration),
  }));
  const estimated_credits = clips.reduce((s, c) => s + c.estimated_credits, 0);
  return {
    model,
    clip_count: sequence.length,
    total_duration_seconds: sequence.reduce((s, c) => s + c.duration, 0),
    estimated_credits,
    estimated_usd: round2(estimated_credits * CREDIT_USD),
    clips,
  };
}

export function withCarbonEstimate(cost) {
  const gPerCredit = Number(process.env.RUNWAY_G_CO2_PER_CREDIT ?? DEFAULT_G_CO2_PER_CREDIT);
  return {
    ...cost,
    estimated_co2_g: round2(cost.estimated_credits * gPerCredit),
    carbon_methodology:
      "credits × RUNWAY_G_CO2_PER_CREDIT — order-of-magnitude proxy, not from Runway",
    carbon_disclaimer:
      "Runway does not publish per-generation emissions. Treat as indicative only.",
  };
}

export async function fetchRunwayOrganization(apiKey) {
  const res = await fetch(`${RUNWAY_API}/organization`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Runway-Version": RUNWAY_VERSION,
    },
  });
  if (!res.ok) throw new Error(`Runway ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    credit_balance: data.creditBalance,
    estimated_usd_remaining: round2(data.creditBalance * CREDIT_USD),
    tier_max_monthly_credit_spend: data.tier?.maxMonthlyCreditSpend,
    usage_today_by_model: data.usage?.models,
  };
}

/**
 * mode "sequence" (default) — 4 chained moods, stitched into one MP4
 * mode "arc"           — 1×10s continuous arc
 */
export function resolveAnimationSequence(body) {
  if (body.prompt && body.duration) {
    return [{ name: "custom", mood: "custom", duration: body.duration, promptText: body.prompt }];
  }

  const base = body.mode === "arc" ? EXPRESSION_ARC_SINGLE : VIKING_MOOD_SEQUENCE;

  if (Array.isArray(body.clips) && body.clips.length > 0) {
    const want = new Set(body.clips);
    const picked = base.filter(c => want.has(c.name));
    if (picked.length === 0) {
      throw new Error(`unknown clip names: ${body.clips.join(", ")}`);
    }
    return picked;
  }
  return base;
}

export function extractVideoUrl(task) {
  if (Array.isArray(task.output) && task.output[0]) return task.output[0];
  if (typeof task.output === "string") return task.output;
  if (task.artifacts?.[0]?.url) return task.artifacts[0].url;
  if (task.video?.url) return task.video.url;
  return undefined;
}

export function buildImageToVideoPayload(imageInput, promptText, duration, opts = {}) {
  return {
    model: opts.model || DEFAULT_RUNWAY_MODEL,
    promptImage: imageInput,
    promptText,
    ratio: opts.ratio || DEFAULT_RUNWAY_RATIO,
    duration,
  };
}

export function jpegToDataUri(jpegBuf) {
  return `data:image/jpeg;base64,${jpegBuf.toString("base64")}`;
}

/** Last frame of a clip — scaled to Runway ratio for reliable chained handoff. */
export async function videoUrlToLastFrameDataUri(videoUrl, secondsBeforeEnd = 0.5, ratio = DEFAULT_RUNWAY_RATIO) {
  const dir = await mkdtemp(join(tmpdir(), "runway-frame-"));
  const mp4 = join(dir, "clip.mp4");
  const jpg = join(dir, "last.jpg");
  const [tw, th] = ratio.split(":").map(Number);
  const scale = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=white`;
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`failed to download video: HTTP ${res.status}`);
    await writeFile(mp4, Buffer.from(await res.arrayBuffer()));
    await execFileAsync("ffmpeg", [
      "-sseof", `-${secondsBeforeEnd}`, "-i", mp4,
      "-vframes", "1", "-vf", scale, "-q:v", "1", "-y", jpg,
    ], { timeout: 60_000 });
    const buf = await readFile(jpg);
    if (buf.length < 1000) throw new Error("extracted frame too small");
    return jpegToDataUri(buf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Concatenate clip MP4s into one continuous video (re-encode for clean joins). */
export async function stitchVideoUrls(videoUrls) {
  if (videoUrls.length === 0) throw new Error("no clips to stitch");
  if (videoUrls.length === 1) {
    const res = await fetch(videoUrls[0]);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const dir = await mkdtemp(join(tmpdir(), "runway-stitch-"));
  const listFile = join(dir, "concat.txt");
  const outFile = join(dir, "stitched.mp4");
  try {
    const paths = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const p = join(dir, `clip_${i}.mp4`);
      const res = await fetch(videoUrls[i]);
      if (!res.ok) throw new Error(`download clip ${i} failed: HTTP ${res.status}`);
      await writeFile(p, Buffer.from(await res.arrayBuffer()));
      paths.push(p);
    }
    await writeFile(
      listFile,
      paths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
    );
    await execFileAsync("ffmpeg", [
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-pix_fmt", "yuv420p", "-an", "-y", outFile,
    ], { timeout: 120_000 });
    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runwayRequest(apiKey, endpoint, payload, attempt = 0) {
  const MAX_RETRIES = 3;
  try {
    const res = await fetch(`${RUNWAY_API}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Runway-Version": RUNWAY_VERSION,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Runway ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    const retryable = ["fetch failed", "ECONNRESET", "UND_ERR_SOCKET"].some(
      s => e.message.includes(s) || e.cause?.code === s
    );
    if (retryable && attempt < MAX_RETRIES) {
      await delay((attempt + 1) * 1000);
      return runwayRequest(apiKey, endpoint, payload, attempt + 1);
    }
    throw e;
  }
}

export async function runwayPoll(apiKey, taskId, maxAttempts = 300) {
  for (let i = 0; i < maxAttempts; i++) {
    await delay(2000);
    try {
      const res = await fetch(`${RUNWAY_API}/tasks/${taskId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Runway-Version": RUNWAY_VERSION,
        },
      });
      const data = await res.json();
      const status = data.status?.toLowerCase();
      if (status === "succeeded" || status === "completed") return data;
      if (status === "failed" || status === "cancelled") {
        throw new Error(`Task failed: ${data.failure || data.error || data.failureCode || "unknown error"}`);
      }
      console.log(`[runway/${taskId}] ${data.status}...`);
    } catch (e) {
      if (e.message.startsWith("Task failed:")) throw e;
      if (i < maxAttempts - 1) console.error(`[runway poll] error: ${e.message}, retrying...`);
      else throw e;
    }
  }
  throw new Error("Runway task polling timeout");
}

export function resolvePublicImageUrl(imageUrl, publicBaseUrl) {
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) return imageUrl;
  const base = publicBaseUrl?.replace(/\/$/, "");
  if (imageUrl.startsWith("/") && base) return `${base}${imageUrl}`;
  throw new Error(
    "image_url must be an absolute URL (set PUBLIC_BASE_URL to resolve relative /images/ paths)"
  );
}

export function runAnimationJob(
  jobs, jobId, imageInput, apiKey,
  sequence = VIKING_MOOD_SEQUENCE,
  opts = {},
) {
  const model = opts.model || DEFAULT_RUNWAY_MODEL;
  const chainFrames = sequence.length > 1;
  const stitchOutput = chainFrames && opts.stitch !== false;
  const preview = imageInput.startsWith("data:") ? "(data URI)" : imageInput.slice(0, 60);
  console.log(
    `[animations/${jobId}] ${sequence.length} clip(s) sequential` +
    `${chainFrames ? "+chained" : ""}${stitchOutput ? "+stitch" : ""} from ${preview}...`
  );

  (async () => {
    const clips = [];
    let frameInput = imageInput;

    try {
      for (let i = 0; i < sequence.length; i++) {
        const clip = sequence[i];
        jobs.set(jobId, { ...jobs.get(jobId), clips: [...clips], status: "pending" });

        try {
          const result = await runwayRequest(apiKey, "image_to_video", buildImageToVideoPayload(
            frameInput, clip.promptText, clip.duration, opts
          ));
          console.log(`[animations/${jobId}/${clip.name}] task=${result.id}, polling...`);
          const finalData = await runwayPoll(apiKey, result.id);
          const video_url = extractVideoUrl(finalData);
          if (!video_url) throw new Error("no video URL in task output");

          clips.push({
            ...clip,
            ...withCarbonEstimate(estimateClipCost(model, clip.duration)),
            task_id: result.id,
            video_url,
            status: "ready",
            chained: i > 0,
          });

          if (chainFrames && i < sequence.length - 1) {
            console.log(`[animations/${jobId}/${clip.name}] last frame → next mood input`);
            frameInput = await videoUrlToLastFrameDataUri(video_url, 0.5, opts.ratio || DEFAULT_RUNWAY_RATIO);
          }
        } catch (e) {
          console.error(`[animations/${jobId}/${clip.name}] error: ${e.message}`);
          clips.push({
            ...clip,
            ...withCarbonEstimate(estimateClipCost(model, clip.duration)),
            status: "failed",
            error: e.message,
          });
          break;
        }
      }

      const failed = clips.filter(c => c.status === "failed" || !c.video_url);
      const cost = withCarbonEstimate({
        model,
        clip_count: clips.length,
        total_duration_seconds: clips.reduce((s, c) => s + (c.duration || 0), 0),
        estimated_credits: clips.reduce((s, c) => s + (c.estimated_credits || 0), 0),
        estimated_usd: round2(clips.reduce((s, c) => s + (c.estimated_usd || 0), 0)),
      });

      if (failed.length === 0 && clips.length === sequence.length) {
        const videoUrls = clips.map(c => c.video_url).filter(Boolean);
        let stitched_mp4;
        if (stitchOutput && videoUrls.length > 1) {
          console.log(`[animations/${jobId}] stitching ${videoUrls.length} clips...`);
          stitched_mp4 = await stitchVideoUrls(videoUrls);
        }
        console.log(`[animations/${jobId}] ready (~${cost.estimated_credits} credits)`);
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: "ready",
          clips,
          video_urls: videoUrls,
          stitched_mp4,
          total_duration: clips.reduce((s, c) => s + c.duration, 0),
          cost,
        });
      } else {
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: "failed",
          clips,
          cost,
          error: failed.length ? `${failed.length} clip(s) failed` : "incomplete sequence",
        });
      }
    } catch (e) {
      console.error(`[animations/${jobId}] fatal error: ${e.message}`);
      jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: e.message, clips });
    }
  })();
}
