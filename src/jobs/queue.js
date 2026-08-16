"use strict";

const crypto = require("crypto");
const fs = require("fs");
const db = require("../db");
const storage = require("../storage");
const config = require("../config");
const logger = require("../logger");
const { generateSteps } = require("../ai/imageproc");
const { buildPlan } = require("../ai/plan");
const { validateTutorial, ALLOWED_STEP_COUNTS } = require("../ai/validate");
const Jimp = require("jimp");

const now = () => Date.now();

/* ------------------------------------------------------------------ */
/* Job row helpers                                                     */
/* ------------------------------------------------------------------ */

// Map internal field names to the generation_jobs columns (snake_case).
const JOB_COLUMNS = {
  status: "status",
  progress: "progress",
  stage: "stage",
  message: "error_message",
  errorCode: "error_code",
  tutorialId: "tutorial_id",
  attempt: "attempt",
  updatedAt: "updated_at",
  finishedAt: "finished_at",
};

async function insertJob({ requestId, status, stage, progress, message }) {
  const id = requestId || `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await db.run(
    `INSERT INTO generation_jobs (id, status, progress, stage, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    status,
    progress,
    stage,
    message || null,
    now(),
    now()
  );
  return id;
}

async function getJob(id) {
  return (await db.get("SELECT * FROM generation_jobs WHERE id = ?", id)) || null;
}

async function updateJob(id, fields) {
  const sets = [];
  const vals = [];
  for (const k of ["status", "progress", "stage", "message", "errorCode", "tutorialId", "attempt"]) {
    if (fields[k] !== undefined) {
      sets.push(`${JOB_COLUMNS[k]} = ?`);
      vals.push(fields[k]);
    }
  }
  sets.push("updated_at = ?");
  vals.push(now());
  if (fields.finishedAt !== undefined) {
    sets.push("finished_at = ?");
    vals.push(fields.finishedAt);
  }
  if (sets.length) {
    vals.push(id);
    await db.run(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`, ...vals);
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

async function runGeneration(jobId, upload, params) {
  const stepCount = ALLOWED_STEP_COUNTS.includes(Number(params.stepCount)) ? Number(params.stepCount) : 8;

  await updateJob(jobId, { status: "analyzing", stage: "analyzing", progress: 8, message: "Analyzing image..." });

  // 1) Analysis.
  const rawBuf = fs.readFileSync(upload.path);
  const img = await Jimp.read(rawBuf);
  const { buildAnalysis } = require("../ai/imageproc");
  const analysis = buildAnalysis(img);
  await updateJob(jobId, { progress: 18, message: "Finding basic shapes..." });

  // 2) Plan.
  await updateJob(jobId, { status: "planning", stage: "planning", progress: 28, message: "Planning drawing steps..." });
  const { plan } = await buildPlan(analysis, {
    mode: params.mode,
    stepCount,
    shading: params.shading,
    buffer: rawBuf,
  });
  await updateJob(jobId, { progress: 38, message: "Generating outlines..." });

  // 3) Step images.
  await updateJob(jobId, { status: "rendering", stage: "rendering", progress: 42, message: "Rendering steps..." });
  const { images } = await generateSteps({
    buffer: rawBuf,
    mode: params.mode,
    stepCount,
    shading: params.shading,
    thickness: params.thickness || 1.3,
  });

  const userId = params.userId || "local";
  const tutorialId = `tutorial_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

  // 4) Upload originals + step images to object storage. Steps are encoded,
  // uploaded, and released one at a time so the free instance never holds
  // every step buffer in memory at once (see requirement: keep memory low).
  await updateJob(jobId, { status: "uploading", stage: "uploading", progress: 55, message: "Uploading images..." });
  const originalJpg = await encodeJpeg(img);
  const originalUrl = await storage.saveTutorialFile(userId, tutorialId, "original.jpg", originalJpg);
  const thumbUrl = await saveThumbnail(originalJpg, userId, tutorialId);

  const stepUrls = [];
  const stepSizes = [];
  let lastStepBuffer = null;
  for (let i = 0; i < images.length; i++) {
    const buf = await images[i].getBufferAsync(Jimp.MIME_JPEG);
    stepUrls.push(await storage.saveStepImage(userId, tutorialId, i + 1, buf));
    stepSizes.push(buf.length);
    lastStepBuffer = buf;
    images[i] = null; // release the Jimp bitmap for GC
    await updateJob(jobId, {
      progress: 55 + Math.round(((i + 1) / images.length) * 30),
      message: i === images.length - 1 ? "Preparing tutorial..." : `Uploading step ${i + 1} of ${images.length}...`,
    });
  }

  const finalUrl = await storage.saveTutorialFile(userId, tutorialId, "final.jpg", lastStepBuffer);

  // 5) Persist records.
  await updateJob(jobId, { status: "saving", stage: "saving", progress: 92, message: "Saving tutorial..." });
  const ts = now();
  await db.run(
    `INSERT INTO tutorials
       (id, user_id, title, subject_label, original_image_url, final_image_url, thumbnail_url,
        mode, step_count, current_step, shading, status, saved, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, NULL, ?, ?)`,
    tutorialId,
    userId,
    plan.title,
    plan.subjectLabel || null,
    originalUrl,
    finalUrl,
    thumbUrl,
    params.mode,
    stepCount,
    params.shading ? 1 : 0,
    "in_progress",
    ts,
    ts
  );

  const insStep = db.run.bind(
    db,
    `INSERT INTO tutorial_steps (id, tutorial_id, step_number, title, instruction, artist_tip, image_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    await insStep(
      `step_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tutorialId,
      i + 1,
      s.title,
      s.instruction,
      s.tip || null,
      stepUrls[i],
      ts
    );
  }

  await db.upsert(
    "tutorial_progress",
    { user_id: userId, tutorial_id: tutorialId, current_step: 1, completed: 0, last_opened_at: ts },
    ["user_id", "tutorial_id"]
  );

  // Validate the persisted result before declaring success (step images are
  // validated by size; buffers are no longer retained).
  const validation = validateTutorial({ plan, stepCount, images: stepSizes.map((len) => ({ length: len })) });
  if (!validation.ok) {
    throw Object.assign(new Error(`Generated tutorial failed validation: ${validation.errors.join("; ")}`), {
      code: "VALIDATION_FAILED",
    });
  }

  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    stage: "completed",
    message: "Tutorial ready.",
    tutorialId,
    finishedAt: now(),
  });

  logger.info(`tutorial saved: ${tutorialId} (job ${jobId}, user ${userId})`);
  return { tutorialId };
}

async function encodeJpeg(img) {
  const out = img.clone();
  return out.getBufferAsync(Jimp.MIME_JPEG);
}

async function saveThumbnail(originalJpg, userId, tutorialId) {
  const img = await Jimp.read(originalJpg);
  const w = img.getWidth();
  const h = img.getHeight();
  const scale = Math.min(1, 480 / Math.max(w, h));
  if (scale < 1) img.resize(Math.round(w * scale), Math.round(h * scale), Jimp.RESIZE_BILINEAR);
  const buf = await img.getBufferAsync(Jimp.MIME_JPEG);
  return storage.saveTutorialFile(userId, tutorialId, "thumbnail.jpg", buf);
}

/* ------------------------------------------------------------------ */
/* Execution with retry + bounded concurrency                          */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1500, 5000];

async function executeWithRetry(jobId, upload, params) {
  let attempt = 1;
  for (;;) {
    try {
      await runGeneration(jobId, upload, params);
      return;
    } catch (err) {
      const code = err.code || "GENERATION_FAILED";
      const transient = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code) || /socket|timeout|network/i.test(String(err.message));
      if (transient && attempt < MAX_ATTEMPTS) {
        await updateJob(jobId, {
          status: "queued",
          progress: 0,
          stage: "retrying",
          message: `Retrying (attempt ${attempt + 1})...`,
          attempt: attempt + 1,
        });
        logger.warn(`job ${jobId} transient failure, retrying: ${err.message}`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] || 8000));
        attempt++;
        continue;
      }
      await updateJob(jobId, {
        status: "failed",
        stage: "failed",
        progress: 0,
        message: err.message || "Generation failed",
        errorCode: code,
        attempt,
        finishedAt: now(),
      });
      logger.error(`job ${jobId} failed: ${err.message}`);
      return;
    }
  }
}

let activeJobs = 0;
const waiters = [];

async function runJob(jobId, upload, params) {
  while (activeJobs >= config.jobConcurrency) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  activeJobs++;
  try {
    await executeWithRetry(jobId, upload, params);
  } catch (err) {
    try {
      await updateJob(jobId, {
        status: "failed",
        stage: "failed",
        errorCode: "GENERATION_FAILED",
        message: err.message || "Generation failed",
        finishedAt: now(),
      });
    } catch {
      /* ignore */
    }
  } finally {
    // Remove the ephemeral upload scratch file; it must never accumulate.
    try {
      fs.rmSync(upload.path, { force: true });
    } catch {
      /* ignore */
    }
    activeJobs--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function createJob({ requestId, upload, params, userId }) {
  // Duplicate-request protection: same idempotency key already running? reuse it.
  if (requestId) {
    const existing = await getJob(requestId);
    if (
      existing &&
      ["queued", "analyzing", "planning", "rendering", "uploading", "saving"].includes(existing.status)
    ) {
      return { jobId: existing.id, status: existing.status, duplicate: true };
    }
  }

  const jobId = await insertJob({
    requestId: requestId || undefined,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Queued",
  });
  logger.info(`generation job created: ${jobId} (mode=${params.mode} steps=${params.stepCount} shading=${params.shading} user=${userId})`);

  // Fire-and-forget processing (bounded by the concurrency semaphore).
  runJob(jobId, upload, { ...params, userId });

  return { jobId, status: "queued" };
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

async function cleanupStaleJobs() {
  const cutoff = now() - config.cleanupJobAgeMs;
  await db.run("DELETE FROM generation_jobs WHERE status = 'failed' AND finished_at IS NOT NULL AND finished_at < ?", cutoff);
  // Abandoned queued/processing jobs (crashed before pickup) older than 30 min.
  await db.run("DELETE FROM generation_jobs WHERE status IN ('queued','processing','analyzing','planning','rendering','uploading','saving') AND updated_at < ?", now() - 30 * 60 * 1000);
  storage.cleanupTemp(config.cleanupJobAgeMs);
}

module.exports = { createJob, getJob, updateJob, cleanupStaleJobs, runGeneration };
