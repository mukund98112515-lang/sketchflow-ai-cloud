"use strict";

const express = require("express");
const { getJob } = require("../jobs/queue");
const { authRequired } = require("../middlewares/errors");

const router = express.Router();

router.get("/:id", authRequired, async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found." } });
    }
    res.json({
      jobId: job.id,
      status: job.status, // queued | analyzing | planning | rendering | uploading | saving | completed | failed
      progress: job.progress,
      stage: job.stage,
      message: job.error_message,
      errorCode: job.error_code,
      tutorialId: job.tutorial_id,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
