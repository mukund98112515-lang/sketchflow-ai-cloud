"use strict";

const config = require("./config");
const logger = require("./logger");

let impl = null;

/**
 * Unified storage facade.
 *  - local: filesystem under data/uploads (development only)
 *  - s3:    S3-compatible object storage (production)
 * All methods accept/return relative posix paths. Temp scratch (`.tmp/*`) is
 * always stored on the instance's ephemeral disk, never as authoritative data.
 *
 * The impl is created LAZILY (first use), never at require time, so the API
 * server starts and serves /health even when object storage is not configured
 * yet or is temporarily misconfigured. Configuration errors are reported when
 * an endpoint actually uses storage, not at boot.
 */
function createStorage() {
  if (config.storageProvider === "s3") {
    const { createS3Storage } = require("./storage/s3");
    return createS3Storage(config);
  }
  const { createLocalStorage } = require("./storage/local");
  return createLocalStorage(config);
}

function getStorage() {
  if (!impl) {
    impl = createStorage(); // throws with a clear message if not configured
  }
  return impl;
}

// Startup logging only (no secrets). Never throws at require time.
if (config.storageProvider === "s3") {
  if (!config.storageBucket) {
    logger.warn("object storage (s3) not configured yet — STORAGE_BUCKET missing; storage endpoints will report an error until configured");
  } else {
    logger.info(`storage: s3 provider (bucket: ${config.storageBucket})`);
  }
} else {
  logger.info("storage: local provider (dev only)");
}

module.exports = {
  provider: config.storageProvider,
  mimeFor: (fileName) => getStorage().mimeFor(fileName),
  saveTutorialFile: (userId, tutorialId, fileName, buffer) => getStorage().saveTutorialFile(userId, tutorialId, fileName, buffer),
  saveStepImage: (userId, tutorialId, stepNumber, buffer) => getStorage().saveStepImage(userId, tutorialId, stepNumber, buffer),
  saveTemp: (fileName, buffer) => getStorage().saveTemp(fileName, buffer),
  readRel: (relPath) => getStorage().readRel(relPath),
  existsRel: (relPath) => getStorage().existsRel(relPath),
  statRel: (relPath) => getStorage().statRel(relPath),
  filePathFor: (relPath) => getStorage().filePathFor(relPath),
  deleteTutorialFiles: (userId, tutorialId) => getStorage().deleteTutorialFiles(userId, tutorialId),
  cleanupTemp: (maxAgeMs) => getStorage().cleanupTemp(maxAgeMs),
  publicUrl: (relPath) => getStorage().publicUrl(relPath),
};
