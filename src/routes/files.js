"use strict";

const express = require("express");
const storage = require("../storage");
const { authRequired } = require("../middlewares/errors");

const router = express.Router();

/** Serve stored tutorial files. The URL-encoded path is relative to the
 *  storage root. When STORAGE_PUBLIC_URL is configured, redirect to the
 *  direct object URL instead of proxying through the backend. */
router.get("/*", authRequired, async (req, res, next) => {
  try {
    let rel = "";
    try {
      rel = decodeURIComponent(req.params[0] || "");
    } catch {
      return res.status(400).json({ error: { code: "BAD_PATH", message: "Invalid file path." } });
    }
    if (!rel || rel.includes("..") || rel.startsWith("/") || /[\\]/.test(rel)) {
      return res.status(400).json({ error: { code: "BAD_PATH", message: "Invalid file path." } });
    }

    const pub = storage.publicUrl(rel);
    if (pub) {
      res.set("Cache-Control", "public, max-age=86400");
      return res.redirect(302, pub);
    }

    const buffer = await storage.readRel(rel);
    if (buffer == null) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "File not found." } });
    }
    const type = storage.mimeFor(rel);
    res.set("Content-Type", type);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
