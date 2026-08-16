"use strict";

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const db = require("../db");
const storage = require("../storage");
const config = require("../config");
const { createJob } = require("../jobs/queue");
const { validateUploadMeta } = require("../ai/validate");
const { authRequired } = require("../middlewares/errors");
const { rateLimit } = require("../middlewares/rateLimit");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

const MIME_WHITELIST = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/gif",
];

function userIdOf(req) {
  const id =
    req.headers["x-device-id"] ||
    (req.query && req.query.deviceId) ||
    (req.body && req.body.deviceId) ||
    "local";
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** Build the absolute URL for a stored file, preferring the public object URL. */
function absolute(rel) {
  if (!rel) return null;
  const pub = storage.publicUrl(rel);
  return pub || `${config.baseUrl}/api/files/${encodeURIComponent(rel)}`;
}

function toTutorialDto(row) {
  return {
    id: row.id,
    title: row.title,
    subjectLabel: row.subject_label,
    originalImageUrl: absolute(row.original_image_url),
    finalSketchUrl: absolute(row.final_image_url),
    thumbnailUrl: absolute(row.thumbnail_url),
    drawingMode: row.mode,
    totalSteps: row.step_count,
    currentStep: row.current_step,
    shadingEnabled: !!row.shading,
    status: row.status,
    saved: !!row.saved,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* POST /api/tutorials/generate                                        */
/* ------------------------------------------------------------------ */

router.post(
  "/generate",
  authRequired,
  rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitGenerate }),
  upload.single("image"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: { code: "NO_IMAGE", message: "No image was uploaded." } });
      }

      const mode = String(req.body.mode || "detailed").toLowerCase();
      const stepCount = Number(req.body.stepCount || 8);
      const shading = req.body.shading === "true" || req.body.shading === "1" || req.body.shading === true;
      const thickness = Number(req.body.thickness || 1.3);
      const requestId = String(req.body.requestId || req.headers["x-request-id"] || "").slice(0, 64);
      const userId = userIdOf(req);

      const validation = validateUploadMeta({
        mode,
        stepCount,
        shading,
        fileSize: file.buffer.length,
        maxSize: config.maxUploadMb * 1024 * 1024,
      });
      if (!validation.ok) {
        return res.status(400).json({ error: { code: "VALIDATION_FAILED", message: validation.errors.join("; ") } });
      }
      if (!MIME_WHITELIST.includes(file.mimetype)) {
        return res.status(400).json({ error: { code: "UNSUPPORTED_IMAGE", message: "Unsupported file type. Please upload a JPEG, PNG, WebP, BMP or GIF photo." } });
      }

      // Move the uploaded bytes to an ephemeral scratch file for the async job.
      const tempRel = storage.saveTemp(file.originalname || "upload.bin", file.buffer);
      const tempPath = storage.filePathFor(tempRel);

      const { jobId, status, duplicate } = await createJob({
        requestId,
        upload: { path: tempPath, originalname: file.originalname, mimetype: file.mimetype },
        params: { mode, stepCount, shading, thickness },
        userId,
      });

      res.status(202).json({ jobId, status, duplicate: !!duplicate });
    } catch (err) {
      next(err);
    }
  }
);

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

router.get("/", authRequired, async (req, res, next) => {
  try {
    const userId = userIdOf(req);
    const status = String(req.query.status || "").trim();
    const saved = req.query.saved === "true" || req.query.saved === "1";
    const rows = await db.all(
      `SELECT * FROM tutorials
       WHERE user_id = ?
       ${status && status !== "all" ? "AND status = ?" : ""}
       ${req.query.saved !== undefined ? "AND saved = ?" : ""}
       ORDER BY updated_at DESC`,
      ...[
        userId,
        ...(status && status !== "all" ? [status] : []),
        ...(req.query.saved !== undefined ? [saved ? 1 : 0] : []),
      ]
    );
    res.json({ tutorials: rows.map(toTutorialDto) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Get one + steps                                                     */
/* ------------------------------------------------------------------ */

router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const row = await db.get("SELECT * FROM tutorials WHERE id = ?", req.params.id);
    if (!row) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Tutorial not found." } });
    const steps = await db.all("SELECT * FROM tutorial_steps WHERE tutorial_id = ? ORDER BY step_number ASC", row.id);
    const progress = await db.get("SELECT * FROM tutorial_progress WHERE user_id = ? AND tutorial_id = ?", userIdOf(req), row.id);

    res.json({
      tutorial: {
        ...toTutorialDto(row),
        steps: steps.map((s) => ({
          step: s.step_number,
          title: s.title,
          instruction: s.instruction,
          artistTip: s.artist_tip,
          imageUrl: absolute(s.image_url),
        })),
      },
      progress: progress
        ? { currentStep: progress.current_step, completed: !!progress.completed, lastOpenedAt: progress.last_opened_at }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Patch (rename, progress, status)                                    */
/* ------------------------------------------------------------------ */

router.patch("/:id", authRequired, async (req, res, next) => {
  try {
    const row = await db.get("SELECT * FROM tutorials WHERE id = ?", req.params.id);
    if (!row) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Tutorial not found." } });

    const allowed = {};
    if (req.body.title !== undefined) {
      const title = String(req.body.title).trim().slice(0, 80);
      if (!title) return res.status(400).json({ error: { code: "VALIDATION_FAILED", message: "Title cannot be empty." } });
      allowed.title = title;
    }
    if (req.body.currentStep !== undefined) {
      const cs = Number(req.body.currentStep);
      if (!Number.isInteger(cs) || cs < 1 || cs > row.step_count) {
        return res.status(400).json({ error: { code: "VALIDATION_FAILED", message: "Invalid step number." } });
      }
      allowed.current_step = cs;
    }
    if (req.body.status !== undefined) {
      if (!["generating", "in_progress", "completed", "failed"].includes(req.body.status)) {
        return res.status(400).json({ error: { code: "VALIDATION_FAILED", message: "Invalid status." } });
      }
      allowed.status = req.body.status;
      if (req.body.status === "completed" && row.status !== "completed") {
        allowed.completed_at = Date.now();
      }
    }
    if (req.body.saved !== undefined) {
      allowed.saved = req.body.saved === true || req.body.saved === "true" || req.body.saved === 1 ? 1 : 0;
    }
    allowed.updated_at = Date.now();

    const sets = Object.keys(allowed)
      .map((k) => `${k} = ?`)
      .join(", ");
    await db.run(`UPDATE tutorials SET ${sets} WHERE id = ?`, ...Object.values(allowed), req.params.id);

    // Keep local progress table in sync.
    if (allowed.current_step !== undefined) {
      await db.upsert(
        "tutorial_progress",
        { user_id: userIdOf(req), tutorial_id: row.id, current_step: allowed.current_step, completed: 0, last_opened_at: Date.now() },
        ["user_id", "tutorial_id"]
      );
    }

    const updated = await db.get("SELECT * FROM tutorials WHERE id = ?", row.id);
    res.json({ tutorial: toTutorialDto(updated) });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

router.delete("/:id", authRequired, async (req, res, next) => {
  try {
    const row = await db.get("SELECT * FROM tutorials WHERE id = ?", req.params.id);
    if (!row) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Tutorial not found." } });
    await db.run("DELETE FROM tutorials WHERE id = ?", row.id);
    await db.run("DELETE FROM tutorial_progress WHERE tutorial_id = ?", row.id);
    await storage.deleteTutorialFiles(row.user_id, row.id);
    res.json({ ok: true, id: row.id });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Completion marker                                                   */
/* ------------------------------------------------------------------ */

router.post("/:id/complete", authRequired, async (req, res, next) => {
  try {
    const row = await db.get("SELECT * FROM tutorials WHERE id = ?", req.params.id);
    if (!row) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Tutorial not found." } });
    await db.run("UPDATE tutorials SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", Date.now(), Date.now(), row.id);
    await db.upsert(
      "tutorial_progress",
      { user_id: userIdOf(req), tutorial_id: row.id, current_step: row.step_count, completed: 1, last_opened_at: Date.now() },
      ["user_id", "tutorial_id"]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
