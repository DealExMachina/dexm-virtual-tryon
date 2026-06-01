import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAccessoryPrompt,
  buildBackViewReframePrompt,
  CARRY_STYLES,
} from "../lib/accessories.js";

describe("buildAccessoryPrompt", () => {
  test("backpack style references image 1 and 2, bag on upper back", () => {
    const p = buildAccessoryPrompt({
      accessory_desc: "black Targus laptop backpack",
      carry_style: "backpack",
      scene: "urban",
    });
    assert.ok(p.includes("image 1"));
    assert.ok(p.includes("image 2"));
    assert.ok(p.includes("black Targus laptop backpack"));
    assert.ok(p.includes("shoulder straps"));
    assert.ok(p.includes("UPPER BACK"));
    assert.ok(p.includes("chest"));
  });

  test("back view reframe prompt turns camera behind subject", () => {
    const p = buildBackViewReframePrompt("urban");
    assert.ok(p.includes("BEHIND"));
    assert.ok(p.includes("Do NOT show the chest"));
  });

  test("rejects unknown carry styles at route layer — prompt builder defaults to backpack", () => {
    const p = buildAccessoryPrompt({ carry_style: "unknown" });
    assert.ok(p.includes("backpack"));
  });

  test("carry style constants cover retail cases", () => {
    assert.deepEqual(CARRY_STYLES, ["backpack", "crossbody", "shoulder", "hand"]);
  });
});
