/**
 * BFL FLUX.2 accessory placement — person + product reference (bags, etc.)
 * @see https://docs.bfl.ai/flux_2/flux2_image_editing
 * @see https://docs.bfl.ai/guides/usecases_editing_clothing_tryon
 */

import { sceneBackdrop } from "./scenes.js";

export const DEFAULT_ACCESSORY_MODEL = "flux-2-pro";
export const DEFAULT_ACCESSORY_SCENE = "urban";

export const CARRY_STYLES = ["backpack", "crossbody", "shoulder", "hand"];

function identityLock(scene) {
  if (scene === "studio") {
    return "maintaining exactly their face, body proportions, pose, clothing and background";
  }
  return (
    "maintaining exactly their face, body proportions, pose and clothing. " +
    sceneBackdrop(scene)
  );
}

/** Step 1 for backpacks: turn a front-facing outfit shot into a back view. */
export function buildBackViewReframePrompt(scene = DEFAULT_ACCESSORY_SCENE) {
  return (
    "Same person, same outfit, same hair, beard and colors — change ONLY the camera angle. " +
    "Show them from BEHIND at a three-quarter back angle: we see their back, shoulders, and the back of their head. " +
    "They walk slightly away from the camera. Do NOT show the chest, front torso, or front of the face. " +
    sceneBackdrop(scene)
  );
}

/**
 * Step 2 for backpacks: person image should already be a back / over-shoulder view.
 * Multi-reference: image 1 = person from behind, image 2 = bag product shot.
 */
export function buildBackpackOnBackPrompt({
  accessory_desc,
  scene = DEFAULT_ACCESSORY_SCENE,
  extra,
} = {}) {
  const item = accessory_desc || "backpack from image 2";
  const tail = extra ? ` ${extra}` : "";
  return (
    `Photo from behind the person in image 1 — over-the-shoulder back view. ` +
    `They wear the ${item} from image 2 correctly on their UPPER BACK: main bag panel against the back, ` +
    `both shoulder straps over the shoulders, top handle up. ` +
    `The backpack faces away from the camera; do NOT place the bag on the chest or front body. ` +
    `Preserve bag materials, zippers, logos and hardware from image 2. ` +
    sceneBackdrop(scene) +
    tail
  );
}

/**
 * Multi-reference prompt for FLUX.2: image 1 = person, image 2 = accessory product shot.
 */
export function buildAccessoryPrompt({
  accessory_desc,
  carry_style = "backpack",
  scene = DEFAULT_ACCESSORY_SCENE,
  extra,
} = {}) {
  if (carry_style === "backpack") {
    return buildBackpackOnBackPrompt({ accessory_desc, scene, extra });
  }

  const item = accessory_desc || "accessory from image 2";
  const tail = extra ? ` ${extra}` : "";
  const lock = identityLock(scene);

  const byStyle = {
    crossbody:
      `The person from image 1, ${lock}. ` +
      `They wear the ${item} from image 2 crossbody — strap diagonally across the torso, bag at hip height.${tail}`,

    shoulder:
      `The person from image 1, ${lock}. ` +
      `They carry the ${item} from image 2 on one shoulder — single strap, bag hanging at their side.${tail}`,

    hand:
      `The person from image 1, ${lock}. ` +
      `They hold the ${item} from image 2 in one hand at a natural carrying height.${tail}`,
  };

  return byStyle[carry_style] ?? buildBackpackOnBackPrompt({ accessory_desc: item, scene, extra: tail });
}

/** Prefer closed packshots — open/clamshell product shots confuse placement. */
export const BAG_PROMPT_DEFAULTS = {
  targus_backpack:
    "black Targus laptop backpack with orange interior lining, multiple zippered compartments, padded shoulder straps and Targus-branded zipper pulls",
};
