"use strict";

/**
 * Validation for AI responses and generated tutorial content.
 * Never trust raw output from the AI provider or the client.
 */

const ALLOWED_MODES = ["easy", "detailed", "realistic"];
const ALLOWED_STEP_COUNTS = [6, 8, 10, 12];

function validatePlan(plan, opts) {
  const errors = [];
  const expected = Number(opts.stepCount);

  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan is not an object"] };
  }
  if (!ALLOWED_MODES.includes(opts.mode)) {
    errors.push(`unsupported mode: ${opts.mode}`);
  }
  if (!ALLOWED_STEP_COUNTS.includes(expected)) {
    errors.push(`unsupported step count: ${expected}`);
  }
  if (typeof plan.title !== "string" || !plan.title.trim()) {
    errors.push("missing title");
  }
  if (!Array.isArray(plan.steps)) {
    errors.push("steps is not an array");
    return { ok: false, errors };
  }

  const steps = plan.steps;
  if (steps.length !== expected) {
    errors.push(`expected ${expected} steps, got ${steps.length}`);
  }

  const seen = new Set();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const n = Number(s.step);
    if (!s || typeof s !== "object") {
      errors.push(`step ${i + 1} is not an object`);
      continue;
    }
    if (!Number.isInteger(n) || n < 1) {
      errors.push(`step ${i + 1} has invalid step number`);
    } else {
      if (seen.has(n)) errors.push(`duplicate step number ${n}`);
      seen.add(n);
    }
    if (n !== i + 1) errors.push(`step numbers must be sequential (expected ${i + 1}, got ${n})`);
    if (typeof s.title !== "string" || !s.title.trim()) errors.push(`step ${n}: missing title`);
    if (typeof s.instruction !== "string" || !s.instruction.trim()) errors.push(`step ${n}: missing instruction`);
    if (s.tip !== undefined && typeof s.tip !== "string") errors.push(`step ${n}: tip must be a string`);
  }

  return { ok: errors.length === 0, errors };
}

/** Validate a completed tutorial before it is exposed to the client. */
function validateTutorial({ plan, stepCount, images }) {
  const errors = [];
  if (!plan || plan.steps.length !== stepCount) {
    errors.push("step count mismatch between plan and requested count");
  }
  if (!Array.isArray(images) || images.length !== stepCount) {
    errors.push(`expected ${stepCount} step images, got ${Array.isArray(images) ? images.length : 0}`);
  }
  for (let i = 0; i < images.length; i++) {
    if (!images[i] || !images[i].length || images[i].length < 500) {
      errors.push(`step image ${i + 1} is missing or empty`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateUploadMeta({ mode, stepCount, shading, fileSize, maxSize }) {
  const errors = [];
  if (!ALLOWED_MODES.includes(mode)) errors.push(`unsupported drawing mode: ${mode}`);
  if (!ALLOWED_STEP_COUNTS.includes(Number(stepCount))) errors.push(`unsupported step count: ${stepCount}`);
  if (typeof shading !== "boolean" && shading !== "true" && shading !== "false" && shading !== "1" && shading !== "0") {
    errors.push("invalid shading value");
  }
  if (fileSize > maxSize) errors.push("file too large");
  if (fileSize <= 0) errors.push("empty file");
  return { ok: errors.length === 0, errors };
}

module.exports = { validatePlan, validateTutorial, validateUploadMeta, ALLOWED_MODES, ALLOWED_STEP_COUNTS };
