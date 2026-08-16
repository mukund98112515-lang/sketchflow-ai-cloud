"use strict";

const fs = require("fs");
const path = require("path");

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

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

function sanitize(id) {
  return String(id || "local").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function isNotFound(err) {
  return (
    err &&
    ["NoSuchKey", "NotFound", "404"].includes(String(err.name || err.Code || err.code))
  );
}

/** S3-compatible object storage (Supabase Storage, Cloudflare R2, AWS S3,
 *  DigitalOcean Spaces, MinIO...). This is the authoritative production store
 *  for all original/generated images. */
function createS3Storage(config) {
  if (!config.storageBucket) {
    throw new Error("STORAGE_PROVIDER=s3 requires STORAGE_BUCKET");
  }
  if (!config.storageAccessKey || !config.storageSecretKey) {
    throw new Error("STORAGE_PROVIDER=s3 requires STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY");
  }

  const client = new S3Client({
    region: config.storageRegion || "us-east-1",
    endpoint: config.storageEndpoint || undefined,
    forcePathStyle: config.storageForcePathStyle,
    credentials: {
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecretKey,
    },
  });

  const bucket = config.storageBucket;

  function safeJoinKey(...parts) {
    return parts.filter(Boolean).map((p) => String(p).replace(/^\/+|\/+$/g, "")).join("/");
  }

  function tutorialKey(userId, tutorialId) {
    return safeJoinKey("tutorials", sanitize(userId), sanitize(tutorialId));
  }

  async function put(key, buffer) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeFor(key),
      })
    );
    return key;
  }

  function saveTutorialFile(userId, tutorialId, fileName, buffer) {
    const key = safeJoinKey(tutorialKey(userId, tutorialId), fileName);
    return put(key, buffer);
  }

  function saveStepImage(userId, tutorialId, stepNumber, buffer) {
    const name = `step_${String(stepNumber).padStart(2, "0")}.jpg`;
    return saveTutorialFile(userId, tutorialId, `steps/${name}`, buffer);
  }

  // Temp scratch is always local + ephemeral, never authoritative.
  function saveTemp(fileName, buffer) {
    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    fs.writeFileSync(path.join(config.tmpDir, name), buffer);
    return `.tmp/${name}`;
  }

  async function readRel(relPath) {
    if (!relPath) return null;
    try {
      const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: relPath }));
      return streamToBuffer(Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async function existsRel(relPath) {
    if (!relPath) return false;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: relPath }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async function statRel(relPath) {
    if (!relPath) return null;
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: relPath }));
      return { size: head.ContentLength, mtimeMs: head.LastModified ? new Date(head.LastModified).getTime() : Date.now(), isFile: true };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Temp files resolve to the local ephemeral tmp dir; anything else has no
   *  meaningful local path in cloud mode. */
  function filePathFor(relPath) {
    if (!relPath) return null;
    if (relPath.startsWith(".tmp/")) return path.join(config.tmpDir, relPath.slice(5));
    return null;
  }

  async function deleteTutorialFiles(userId, tutorialId) {
    const prefix = `${tutorialKey(userId, tutorialId)}/`;
    let token;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
      );
      const keys = (listed.Contents || []).map((o) => ({ Key: o.Key }));
      if (keys.length) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys, Quiet: true },
          })
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
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

  function publicUrl(relPath) {
    if (!relPath) return null;
    return config.storagePublicUrl ? `${config.storagePublicUrl}/${relPath}` : null;
  }

  return {
    provider: "s3",
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
    publicUrl,
  };
}

module.exports = { createS3Storage };
