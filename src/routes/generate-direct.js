"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const config = require("../config");
const { getProvider } = require("../ai/providers");
const { validateUploadMeta, validateGuideResponse } = require("../ai/validate");
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

function saveTemp(originalName, buffer) {
  const ext = path.extname(originalName || "upload.bin") || ".bin";
  const name = `gen_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}${ext}`;
  const full = path.join(config.tmpDir, name);
  fs.writeFileSync(full, buffer);
  return full;
}

function deleteTemp(p) {
  try { if (p) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
}

/**
 * POST /api/generate-direct
 * Synchronous single-call AI generation — no jobs, no polling.
 * multipart/form-data: image, mode (easy|detailed|realistic),
 * stepCount (6|8|10|12), shading (true|false).
 * Returns 200 { title, subjectType, mode, stepCount, shading, steps }.
 */
router.post(
  "/generate-direct",
  authRequired,
  rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitGenerate }),
  upload.single("image"),
  async (req, res, next) => {
    let tempPath = null;
    try {
      const provider = getProvider();
      if (!provider) {
        return res.status(503).json({
          error: { code: "AI_NOT_CONFIGURED", message: "AI provider not configured. Set AI_API_KEY in environment." },
        });
      }

      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        return res.status(400).json({ error: { code: "NO_IMAGE", message: "No image was uploaded." } });
      }
      if (!MIME_WHITELIST.includes(file.mimetype)) {
        return res.status(400).json({ error: { code: "UNSUPPORTED_IMAGE", message: "Unsupported file type." } });
      }

      const mode = String(req.body.mode || "detailed").toLowerCase();
      const stepCount = Number(req.body.stepCount || 8);
      const shading = req.body.shading === "true" || req.body.shading === "1" || req.body.shading === true;

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

      tempPath = saveTemp(file.originalname || "upload.bin", file.buffer);

      const base64Image = file.buffer.toString("base64");
      const mimeType = file.mimetype || "image/jpeg";

      const guide = await provider.generateGuide({ base64Image, mimeType, mode, stepCount, shading });

      const guideValidation = validateGuideResponse(guide, { mode, stepCount, shading });
      if (!guideValidation.ok) {
        return res.status(502).json({
          error: { code: "AI_INVALID_RESPONSE", message: "AI returned invalid data: " + guideValidation.errors.join("; ") },
        });
      }

      deleteTemp(tempPath);
      tempPath = null;

      res.json(guide);
    } catch (err) {
      deleteTemp(tempPath);
      if (err.code === "AUTH_FAILED") {
        return res.status(502).json({ error: { code: "AI_AUTH_FAILED", message: err.message } });
      }
      if (err.code === "RATE_LIMITED") {
        return res.status(429).json({ error: { code: "AI_RATE_LIMITED", message: err.message } });
      }
      if (err.code === "PROVIDER_ERROR") {
        return res.status(502).json({ error: { code: "AI_PROVIDER_ERROR", message: err.message } });
      }
      if (err.code === "EMPTY_RESPONSE" || err.code === "INVALID_JSON") {
        return res.status(502).json({ error: { code: "AI_INVALID_RESPONSE", message: err.message } });
      }
      if (err.name === "TimeoutError" || err.code === "ABORT_ERR") {
        return res.status(504).json({ error: { code: "AI_TIMEOUT", message: "AI request timed out. Please try again." } });
      }
      next(err);
    }
  }
);

module.exports = router;
