/**
 * Unit tests — Runway Gen-3 helpers
 * Run: node --test proxy/test/runway.test.js
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ANIMATION_SEQUENCE,
  VIKING_MOOD_SEQUENCE,
  buildOutfitRevealSequence,
  resolvePublicImageUrl,
  resolveAnimationSequence,
  resolveClipImageInput,
  buildImageToVideoPayload,
  extractVideoUrl,
  estimateClipCost,
  estimateSequenceCost,
  withCarbonEstimate,
} from "../lib/runway.js";

describe("DEFAULT_ANIMATION_SEQUENCE", () => {
  test("default sequence mode is 4 chained Viking moods", () => {
    assert.equal(resolveAnimationSequence({}).length, 4);
    assert.deepEqual(
      resolveAnimationSequence({}).map(c => c.name),
      ["neutral", "smile", "grin", "serious"]
    );
  });

  test("arc mode is one 10s clip", () => {
    assert.equal(resolveAnimationSequence({ mode: "arc" }).length, 1);
    assert.equal(resolveAnimationSequence({ mode: "arc" })[0].name, "expression_arc");
  });

  test("each mood clip is 5 seconds with motion-first prompts", () => {
    for (const clip of DEFAULT_ANIMATION_SEQUENCE) {
      assert.equal(clip.duration, 5);
      assert.ok(clip.promptText.length > 50);
      assert.ok(clip.mood);
    }
    assert.ok(VIKING_MOOD_SEQUENCE[1].promptText.includes("Starting from"));
  });
});

describe("resolvePublicImageUrl", () => {
  test("passes through absolute URLs", () => {
    const url = "https://example.com/outfit.jpg";
    assert.equal(resolvePublicImageUrl(url, ""), url);
  });

  test("resolves relative /images paths with PUBLIC_BASE_URL", () => {
    assert.equal(
      resolvePublicImageUrl("/images/job_123", "https://proxy.koyeb.app"),
      "https://proxy.koyeb.app/images/job_123"
    );
  });

  test("throws on relative path without PUBLIC_BASE_URL", () => {
    assert.throws(
      () => resolvePublicImageUrl("/images/job_123", ""),
      /absolute URL/
    );
  });
});

describe("buildImageToVideoPayload", () => {
  test("matches Runway API field names", () => {
    const payload = buildImageToVideoPayload("https://example.com/a.jpg", "walk", 5);
    assert.equal(payload.model, "gen3a_turbo");
    assert.equal(payload.promptImage, "https://example.com/a.jpg");
    assert.equal(payload.promptText, "walk");
    assert.equal(payload.ratio, "768:1280");
    assert.equal(payload.duration, 5);
  });

  test("accepts data URI promptImage", () => {
    const payload = buildImageToVideoPayload("data:image/jpeg;base64,abc", "walk", 5);
    assert.ok(payload.promptImage.startsWith("data:image/jpeg"));
  });
});

describe("extractVideoUrl", () => {
  test("reads task.output[0] per SDK docs", () => {
    assert.equal(
      extractVideoUrl({ output: ["https://cdn.example/v.mp4"] }),
      "https://cdn.example/v.mp4"
    );
  });
});

describe("estimateClipCost", () => {
  test("gen3a_turbo 5s = 25 credits / $0.25", () => {
    const c = estimateClipCost("gen3a_turbo", 5);
    assert.equal(c.estimated_credits, 25);
    assert.equal(c.estimated_usd, 0.25);
  });
});

describe("estimateSequenceCost", () => {
  test("sums default 5-clip sequence on gen3a_turbo", () => {
    const seq = [
      { name: "a", duration: 5 },
      { name: "b", duration: 10 },
    ];
    const t = estimateSequenceCost(seq, "gen3a_turbo");
    assert.equal(t.estimated_credits, 75); // 25 + 50
    assert.equal(t.estimated_usd, 0.75);
  });
});

describe("withCarbonEstimate", () => {
  test("adds co2 fields with disclaimer", () => {
    const c = withCarbonEstimate({ estimated_credits: 25, estimated_usd: 0.25 });
    assert.equal(c.estimated_co2_g, 10);
    assert.ok(c.carbon_disclaimer.includes("Runway"));
  });
});

describe("buildOutfitRevealSequence", () => {
  test("returns 4 keyframe beats with garment descriptions", () => {
    const seq = buildOutfitRevealSequence({
      shirt_desc: "white oxford shirt",
      jacket_desc: "black leather biker jacket over the shirt",
    });
    assert.equal(seq.length, 4);
    assert.deepEqual(seq.map(c => c.name), [
      "confident_base", "shirt_surprise", "full_look_ecstatic", "calm_confident",
    ]);
    assert.equal(seq[0].imageKey, "base");
    assert.equal(seq[1].imageKey, "shirt");
    assert.equal(seq[2].imageKey, "combo");
    assert.equal(seq[3].chainFromPrevious, true);
    assert.ok(seq[1].promptText.includes("white oxford shirt"));
    assert.ok(seq[2].promptText.includes("black leather biker jacket"));
  });
});

describe("resolveClipImageInput", () => {
  test("uses keyframe map when imageKey is set", () => {
    const clip = { name: "shirt", imageKey: "shirt" };
    const r = resolveClipImageInput(clip, 1, [], {
      imageMap: { shirt: "data:image/jpeg;base64,abc" },
    });
    assert.equal(r.source, "keyframe");
    assert.equal(r.input, "data:image/jpeg;base64,abc");
  });

  test("expression chain falls back to previous clip video", () => {
    const clip = { name: "smile" };
    const r = resolveClipImageInput(clip, 1, [{ video_url: "https://cdn/a.mp4" }], {
      defaultImage: "https://base.jpg",
    });
    assert.equal(r.source, "chain");
    assert.equal(r.videoUrl, "https://cdn/a.mp4");
  });
});
