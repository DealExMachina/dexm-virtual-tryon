/** Backdrop presets for VTO and accessory prompts. */

export const SCENES = {
  studio:
    "Plain white studio background, soft even lighting, photorealistic fashion editorial.",
  outdoor:
    "Natural outdoor setting, soft golden-hour daylight, shallow depth of field, " +
    "trees and warm greenery softly blurred in the background, photorealistic lifestyle photography.",
  urban:
    "Urban city street setting, modern architecture and pavement softly out of focus behind the subject, " +
    "natural overcast daylight, photorealistic street-style fashion photography.",
};

export const SCENE_IDS = Object.keys(SCENES);

export function sceneBackdrop(scene = "urban") {
  return SCENES[scene] ?? SCENES.urban;
}

/** Append scene if the prompt does not already mention a setting. */
export function withScene(prompt, scene) {
  if (!scene || !SCENES[scene]) return prompt;
  const backdrop = sceneBackdrop(scene);
  const lower = prompt.toLowerCase();
  if (lower.includes("background") || lower.includes("street") || lower.includes("outdoor")) {
    return prompt;
  }
  return `${prompt.trim().replace(/\.\s*$/, "")}. ${backdrop}`;
}
