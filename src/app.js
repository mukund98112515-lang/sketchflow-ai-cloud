"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const config = require("./config");
const { notFound, errorHandler, deviceKey } = require("./middlewares/errors");

const tutorialsRouter = require("./routes/tutorials");
const jobsRouter = require("./routes/jobs");
const filesRouter = require("./routes/files");
const traceRouter = require("./routes/trace");

/** Build the Express app (routes, middleware). Doesn't listen — see index.js. */
function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(deviceKey);

  // Health check used by the Android app and by deployment health checks.
  // Returns immediately: no DB, no storage, no AI, no auth.
  const health = (req, res) => {
    res.json({
      ok: true,
      service: "sketchflow-backend",
      version: "1.0.0",
      name: "SketchFlow AI",
      aiConfigured: !!config.aiApiKey,
      aiProvider: config.aiApiKey ? config.aiProvider : "local",
      time: Date.now(),
    });
  };
  app.get("/health", health);
  app.get("/api/health", health);

  // Simple root route (handy when a healthcheck probe hits "/" instead).
  app.get("/", (req, res) => {
    res.status(200).json({ name: "SketchFlow AI API", status: "online" });
  });

  app.use("/api/tutorials", tutorialsRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/trace", traceRouter);

  // Static web app (the design UI) when present.
  const publicDir = path.join(__dirname, "..", "public");
  if (fs.existsSync(path.join(publicDir, "index.html"))) {
    app.use(express.static(publicDir));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
