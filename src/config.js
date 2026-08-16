"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");

// Local dev still needs a few folders, but in production nothing durable is
// kept on the server disk: uploads go to cloud object storage and metadata to
// managed Postgres. The temp dir below is EPHEMERAL scratch space used only
// while an image is being processed by the current instance.
const DATA_DIR = process.env.SKETCHFLOW_DATA_DIR || path.join(ROOT, "data");
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), "sketchflow-tmp");

fs.mkdirSync(TMP_DIR, { recursive: true });

function bool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return String(v).toLowerCase() === "true" || v === "1";
}

/** Build a Postgres connection string from a Supabase project URL + DB password.
 *  https://<ref>.supabase.co  ->  postgresql://postgres.<ref>:<pass>@db.<ref>.supabase.co:5432/postgres */
function buildSupabaseConnectionString(url, dbPassword) {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in)/i.exec(String(url).trim());
  if (!m) return "";
  const ref = m[1];
  return `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@db.${ref}.supabase.co:5432/postgres`;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

const storageProvider = (process.env.STORAGE_PROVIDER || (isProduction ? "s3" : "local")).toLowerCase();

const config = {
  nodeEnv,
  isProduction,
  port: parseInt(process.env.PORT || "8787", 10),
  host: process.env.HOST || "0.0.0.0",

  dataDir: DATA_DIR,
  tmpDir: TMP_DIR,
  uploadsDir: path.join(DATA_DIR, "uploads"),

  // Managed Postgres. When DATABASE_URL is set the backend uses Postgres
  // (cloud production). Otherwise it falls back to a local SQLite file so
  // local development keeps working without a database server.
  //
  // Supabase-friendly: if DATABASE_URL is absent but SUPABASE_URL + a
  // SUPABASE_DB_PASSWORD are provided, the Postgres connection string is
  // derived from them (host db.<ref>.supabase.co, database "postgres").
  databaseUrl:
    process.env.DATABASE_URL ||
    (process.env.SUPABASE_URL && process.env.SUPABASE_DB_PASSWORD
      ? buildSupabaseConnectionString(process.env.SUPABASE_URL, process.env.SUPABASE_DB_PASSWORD)
      : ""),
  // Accepted for future Supabase service-role usage (Storage/Auth). The app
  // itself connects over the Postgres wire protocol, so this is not a password.
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  dbPath: process.env.DATABASE_PATH || path.join(DATA_DIR, "sketchflow.db"),

  // Public base URL used to build absolute image URLs. This MUST be the public
  // HTTPS domain of the cloud backend in production (e.g. https://sketchflow-api.onrender.com).
  baseUrl: (process.env.PUBLIC_BASE_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || "8787"}`).replace(/\/$/, ""),

  // AI provider. Supports "openai" (and OpenAI-compatible endpoints),
  // "gemini", or "none". When none / no key, the algorithmic pipeline is used.
  aiProvider: process.env.AI_PROVIDER || "openai",
  aiApiKey: process.env.AI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "",
  aiBaseUrl: process.env.AI_BASE_URL || "",

  // Optional authentication token clients must send (Bearer). Leave empty to disable.
  authToken: process.env.AUTH_TOKEN || "",
  // Max requests to /tutorials/generate per window per device/user.
  rateLimitGenerate: parseInt(process.env.RATE_LIMIT_GENERATE || "8", 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || (5 * 60 * 1000), 10),

  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || "20", 10),
  maxImageDim: parseInt(process.env.MAX_IMAGE_DIM || "1536", 10),
  allowCleartext: bool(process.env.ALLOW_CLEARTEXT, !isProduction),

  // Job housekeeping: failed jobs are purged after this age.
  cleanupJobAgeMs: parseInt(process.env.CLEANUP_JOB_AGE_MS || (60 * 60 * 1000), 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || (15 * 60 * 1000), 10),

  // How many heavy generation jobs run in parallel per instance.
  jobConcurrency: Math.max(1, parseInt(process.env.JOB_CONCURRENCY || "1", 10)),

  // Image processing tuning.
  sketchThickness: parseFloat(process.env.SKETCH_THICKNESS || "1.0"),
  sketchPaper: process.env.SKETCH_PAPER || "#fbf9f5",

  // Cloud object storage (S3-compatible: Cloudflare R2, Supabase Storage,
  // AWS S3, DigitalOcean Spaces, MinIO...). Provider "local" is dev-only.
  //
  // Both STORAGE_* (generic) and R2_* (Cloudflare-specific) names are read;
  // explicit STORAGE_* values win over derived R2 ones.
  storageProvider,
  storageEndpoint:
    process.env.STORAGE_ENDPOINT ||
    process.env.R2_ENDPOINT ||
    (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ""),
  storageRegion: process.env.STORAGE_REGION || "auto",
  storageBucket: process.env.STORAGE_BUCKET || process.env.R2_BUCKET_NAME || "",
  storageAccessKey: process.env.STORAGE_ACCESS_KEY || process.env.R2_ACCESS_KEY_ID || "",
  storageSecretKey: process.env.STORAGE_SECRET_KEY || process.env.R2_SECRET_ACCESS_KEY || "",
  storageForcePathStyle: bool(process.env.STORAGE_FORCE_PATH_STYLE, true),
  // Optional public origin where the bucket is served (CDN). When set, the
  // backend redirects /api/files/* to the direct object URL instead of proxying.
  storagePublicUrl: (process.env.STORAGE_PUBLIC_URL || process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, ""),
};

module.exports = config;
