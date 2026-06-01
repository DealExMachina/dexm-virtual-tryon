/**
 * Reveal cost / sequence smoke — pure unit checks, no HTTP, no tokens.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutfitRevealSequence,
  estimateSequenceCost,
} from "../lib/runway.js";

describe("smoke: reveal sequence economics", () => {
  const seq = buildOutfitRevealSequence({
    shirt_desc: "white cotton tee",
    jacket_desc: "black bomber jacket",
  });

  test("full reveal is 4 beats × 5s", () => {
    assert.equal(seq.length, 4);
    assert.deepEqual(
      seq.map(c => c.name),
      ["confident_base", "shirt_surprise", "full_look_ecstatic", "calm_confident"],
    );
    assert.ok(seq.every(c => c.duration === 5));
  });

  test("credit estimates documented for go/no-go", () => {
    const g3 = estimateSequenceCost(seq, "gen3a_turbo");
    const g45 = estimateSequenceCost(seq, "gen4.5");
    assert.equal(g3.estimated_credits, 100);
    assert.equal(g45.estimated_credits, 240);
    console.log(
      `  full reveal: gen3a_turbo=${g3.estimated_credits} cr, gen4.5=${g45.estimated_credits} cr`
    );
  });

  test("single-beat subset for cheap live test", () => {
    const one = seq.filter(c => c.name === "confident_base");
    const cost = estimateSequenceCost(one, "gen3a_turbo");
    assert.equal(cost.estimated_credits, 25);
    console.log(`  one beat only: ${cost.estimated_credits} credits (gen3a_turbo)`);
  });
});
