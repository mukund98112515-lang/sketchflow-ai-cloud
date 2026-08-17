"use strict";

const config = require("./config");
const logger = require("./logger");
const { cleanupStaleJobs } = require("./jobs/manager");

async function start() {
  // Start the HTTP server FIRST so the process is immediately alive and
  // /health responds. The backend is stateless: no database warm-up, no
  // storage setup, nothing to wait for.
  const { createApp } = require("./app");
  const app = createApp();

  // Periodic housekeeping: purge finished in-memory jobs + stale scratch files.
  const cleanupTimer = setInterval(() => {
    cleanupStaleJobs().catch((err) => logger.warn(`housekeeping failed: ${err.message}`));
  }, config.cleanupIntervalMs);

  const server = app.listen(config.port, config.host, () => {
    logger.info("SketchFlow backend starting");
    logger.info(`NODE_ENV=${config.nodeEnv}`);
    logger.info(`listening on ${config.host}:${config.port}`);
    logger.info("health endpoint ready at /health");
    logger.info(`public base url: ${config.baseUrl}`);
    const aiConfigured = !!(config.xaiApiKey || config.aiApiKey);
    logger.info(`AI provider: ${aiConfigured ? config.aiProvider : "algorithmic (no API key)"}`);
    logger.info(`job concurrency: ${config.jobConcurrency}`);
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down gracefully`);
    clearInterval(cleanupTimer);
    server.close(() => {
      process.exit(0);
    });
    // Force-exit if connections hang.
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  start().catch((err) => {
    logger.error(`startup failed: ${err.message}`);
    logger.error(err);
    process.exit(1);
  });
}

module.exports = { start };
