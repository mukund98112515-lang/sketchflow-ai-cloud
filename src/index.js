"use strict";

const db = require("./db");
const config = require("./config");
const logger = require("./logger");
const { cleanupStaleJobs } = require("./jobs/queue");

async function start() {
  // Start the HTTP server FIRST so the process is immediately alive and
  // /health responds, regardless of database/storage readiness. The database
  // is warmed up in the background and initialized lazily on first use, so a
  // not-yet-provisioned Postgres (or missing storage vars) can never crash or
  // delay the healthcheck.
  const { createApp } = require("./app");
  const app = createApp();

  const cleanupTimer = setInterval(() => {
    cleanupStaleJobs().catch((err) => logger.warn(`housekeeping failed: ${err.message}`));
  }, config.cleanupIntervalMs);

  const server = app.listen(config.port, config.host, () => {
    logger.info("SketchFlow backend starting");
    logger.info(`NODE_ENV=${config.nodeEnv}`);
    logger.info(`listening on ${config.host}:${config.port}`);
    logger.info("health endpoint ready at /health");
    logger.info(`public base url: ${config.baseUrl}`);
    logger.info(`AI provider: ${config.aiApiKey ? config.aiProvider : "algorithmic (no API key)"}`);
    logger.info(`job concurrency: ${config.jobConcurrency}`);
  });

  // Non-fatal database warm-up: never blocks the listener above. A failure
  // here is logged and the DB facade retries lazily on the next request.
  db.ready()
    .then(() => logger.info(`database ready: ${db.describe()}`))
    .catch((err) => logger.warn(`database not ready at startup (will retry on first use): ${err.message}`));

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down gracefully`);
    clearInterval(cleanupTimer);
    server.close(() => {
      db.close()
        .catch(() => {})
        .finally(() => process.exit(0));
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
