"use strict";

const fs = require("fs");
const path = require("path");

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

function mimeFor(fileName) {
  return MIME_BY_EXT[path.extname(String(fileName)).toLowerCase()] || "application/octet-stream";
}

/** Local-filesystem storage used only for local development. */
function createLocalStorage(config) {
  const ROOT = config.uploadsDir;

  function safeJoin(base, ...parts) {
    const target = path.resolve(base, ...parts);
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid storage path");
    }
    return target;
  }

  function sanitize(id) {
    return String(id || "local").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function tutorialDir(userId, tutorialId) {
    const dir = safeJoin(ROOT, sanitize(userId), "tutorials", sanitize(tutorialId));
    fs.mkdirSync(path.join(dir, "steps"), { recursive: true });
    return dir;
  }

  function save(relDir, fileName, buffer) {
    const dir = safeJoin(ROOT, relDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = safeJoin(ROOT, relDir, fileName);
    fs.writeFileSync(file, buffer);
    return path.posix.join(relDir.replace(/\\/g, "/"), fileName);
  }

  function saveTutorialFile(userId, tutorialId, fileName, buffer) {
    const dir = tutorialDir(userId, tutorialId);
    fs.writeFileSync(safeJoin(dir, fileName), buffer);
    return path.posix.join(sanitize(userId), "tutorials", sanitize(tutorialId), fileName);
  }

  function saveStepImage(userId, tutorialId, stepNumber, buffer) {
    const name = `step_${String(stepNumber).padStart(2, "0")}.jpg`;
    return saveTutorialFile(userId, tutorialId, path.posix.join("steps", name), buffer);
  }

  // Temp files are ALWAYS local (per-instance ephemeral scratch), never the
  // authoritative store. They live under config.tmpDir regardless of provider.
  function saveTemp(fileName, buffer) {
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    fs.writeFileSync(safeJoin(config.tmpDir, name), buffer);
    return path.posix.join(".tmp", name);
  }

  function absPath(relPath) {
    if (!relPath) return null;
    return safeJoin(ROOT, relPath);
  }

  function readRel(relPath) {
    const p = absPath(relPath);
    if (!p || !fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  }

  function existsRel(relPath) {
    const p = absPath(relPath);
    return !!p && fs.existsSync(p);
  }

  function statRel(relPath) {
    const p = absPath(relPath);
    if (!p || !fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() };
  }

  /** Resolve a rel path to a real file path. Temp files map to tmpDir. */
  function filePathFor(relPath) {
    if (!relPath) return null;
    if (relPath.startsWith(".tmp/")) return safeJoin(config.tmpDir, relPath.slice(5));
    return absPath(relPath);
  }

  function deleteTutorialFiles(userId, tutorialId) {
    const dir = safeJoin(ROOT, sanitize(userId), "tutorials", sanitize(tutorialId));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function cleanupTemp(maxAgeMs) {
    if (!fs.existsSync(config.tmpDir)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(config.tmpDir)) {
      const p = path.join(config.tmpDir, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    provider: "local",
    mimeFor,
    saveTutorialFile,
    saveStepImage,
    saveTemp,
    readRel,
    existsRel,
    statRel,
    filePathFor,
    deleteTutorialFiles,
    cleanupTemp,
    publicUrl: () => null,
  };
}

module.exports = { createLocalStorage };
