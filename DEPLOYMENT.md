# SketchFlow AI — Cloud Deployment (Render + Supabase + Cloudflare R2)

This moves the backend from running on your PC to a cloud host so the Android
app works without your computer being on.

```
Before:  Android App → your PC → local Node backend → local files
After:   Android App → Render HTTPS backend → Supabase Postgres + Cloudflare R2
```

Nothing authoritative lives on the server's disk. Metadata → managed Postgres.
Original/generated images → S3-compatible object storage (Cloudflare R2). The
container's disk is used only for ephemeral in-flight image processing.

All three services are used on their free tiers.

---

## 1. What you deploy

| Path                  | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `app/server/`         | The Node.js/Express backend (deployment root)                |
| `Dockerfile`          | Production container (Node 22)                               |
| `src/config.js`       | All config from environment variables (no hardcoded secrets) |
| `src/db.js`           | Postgres (cloud) / SQLite (local dev) via `DATABASE_URL`     |
| `src/storage.js`      | S3-compatible object storage (cloud) / local fs (dev)        |
| `supabase/schema.sql` | Reference schema (manual setup, no CLI needed)               |

The verified sketch pipeline (`src/ai/*`, job flow, tests) is unchanged in
behavior. The only functional fixes were cloud-safety fixes (async DB calls,
object storage, no persistent server disk).

---

## 2. Prerequisites

- A GitHub repository containing this project.
- A [Render](https://render.com) account — free tier is fine to start.
- A [Supabase](https://supabase.com) project — free tier Postgres.
- A [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket — free tier.

---

## 3. Database: Supabase setup

1. Create a project in Supabase (free plan). Note the **Project URL** in
   **Project Settings → API** (e.g. `https://abcdefghijk.supabase.co`).
2. Set a **Database password** when creating the project, or reset it in
   **Project Settings → Database** (Authentication tab).
3. Optional but recommended — create the tables. Open the **SQL Editor** in
   the Supabase dashboard and run the statements from `supabase/schema.sql`
   (they are `CREATE TABLE IF NOT EXISTS`, safe to run again).

The backend derives the Postgres connection string from `SUPABASE_URL` +
`SUPABASE_DB_PASSWORD` automatically (host `db.<ref>.supabase.co`), so you
don't have to assemble the URI by hand. Alternatively set `DATABASE_URL`
directly to the full connection string from **Project Settings → Database →
Connection string → URI**.

> NOTE: If you just want the backend to come up, Supabase doesn't even need
> tables beforehand — jobs/tutorials are `CREATE TABLE IF NOT EXISTS`'d on
> first run. But running `supabase/schema.sql` keeps the dashboard schema
> explicit.

---

## 4. Storage: Cloudflare R2 setup

1. Create a bucket (e.g. `sketchflow-assets`). Access level **public** if you
   want direct URLs, or keep private and let the backend proxy `/api/files/*`.
2. **Manage R2 API Tokens → Create API token** with *Object Read & Write*
   permission. Copy the **Access Key ID** and **Secret Access Key**.
3. On the bucket's Settings page, copy your **Account ID** (also on the R2
   overview page, e.g. `abc123...`).

The backend builds the R2 endpoint automatically from `R2_ACCOUNT_ID`
(`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

---

## 5. Render deploy steps

1. **Push this project to GitHub.**
2. In Render, **New → Web Service → Connect your GitHub repo**, pick the repo.
3. Set **Root Directory** to `app/server` (where the `Dockerfile` lives).
   Render will build the Dockerfile.
4. Select the **Free** instance type, then add the environment variables
   (section 6) before creating the service.
5. Render generates a public HTTPS domain automatically
   (e.g. `https://sketchflow-api.onrender.com`).
6. Deploy, wait for the build, then verify: open
   `https://<your-domain>/health` — it should return `{"ok":true,...}`.

> Render retries the DB connection on startup (up to ~45s), so the backend
> will come up even if Postgres isn't ready first. If Postgres is still
> unreachable, `/health` reports it but the process stays alive.

---

## 6. Environment variables

Set on Render (Dashboard → Web Service → Environment):

| Variable                | Example / value                                         | Required |
| ----------------------- | ------------------------------------------------------- | -------- |
| `NODE_ENV`              | `production`                                            | yes      |
| `PORT`                  | `10000` (Render injects it)                             | no       |
| `PUBLIC_BASE_URL`       | `https://sketchflow-api.onrender.com`                   | yes      |
| `SUPABASE_URL`          | `https://abcdefghijk.supabase.co`                      | yes*     |
| `SUPABASE_DB_PASSWORD`  | your Supabase database password                          | yes*     |
| `DATABASE_URL`          | full Postgres URI (alternative to the two above)        | yes*     |
| `STORAGE_PROVIDER`      | `s3` (default in production)                            | no       |
| `R2_ACCOUNT_ID`         | your Cloudflare account id (e.g. `abc123...`)           | yes      |
| `R2_ACCESS_KEY_ID`      | R2 token access key                                     | yes      |
| `R2_SECRET_ACCESS_KEY`  | R2 token secret key                                     | yes      |
| `R2_BUCKET_NAME`        | `sketchflow-assets`                                     | yes      |
| `R2_PUBLIC_BASE_URL`    | optional CDN origin; empty = proxy via backend          | no       |
| `AUTH_TOKEN`            | optional Bearer token for API requests                  | no       |
| `AI_API_KEY`            | optional LLM key (OpenAI); skip for algorithmic mode    | no       |

\* Either `DATABASE_URL`, or `SUPABASE_URL` + `SUPABASE_DB_PASSWORD`.

Generic `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, etc. work too and win over
the derived `R2_*` values.

Optional tuning: `MAX_UPLOAD_MB` (default 20), `MAX_IMAGE_DIM` (default 1536),
`RATE_LIMIT_GENERATE` (default 8), `JOB_CONCURRENCY` (default 1),
`LOG_LEVEL` (default info).

**Recommended instance**: the pipeline does real image processing, so use a
service with **at least 512MB–1GB RAM** (Render → Service → Instance Type).
One instance is fine for v1. The free instance spins down when idle; the first
request after idle may take a few seconds to wake.

---

## 7. Android app changes

The Android app is already pointed at the cloud backend:

- `SettingsStore.DEFAULT_BACKEND_URL` defaults to
  `https://sketchflow-api.onrender.com`.
- After you deploy, **confirm this constant matches your real domain** in
  `android/app/src/main/java/ai/sketchflow/app/settings/SettingsStore.kt`
  (and rebuild the APK).
- Users can still override the URL in the app: **Settings → Backend server**.
  This is useful for testing without rebuilding.
- Local dev (emulator) still works by setting the backend URL to
  `http://10.0.2.2:8787` in Settings.

---

## 8. Local development (still works, unchanged)

```powershell
cd app/server
npm install
npm start            # http://localhost:8787
```

No `DATABASE_URL`/`STORAGE_PROVIDER` set → SQLite file + local folder,
exactly like before. Tests:

```powershell
npm test             # pipeline quality + HTTP integration + SQL utils
```

---

## 9. Verification checklist

1. `GET /health` on the public domain returns `{"ok":true,...}`.
2. Upload a photo from the Android app → generation → tutorial opens — with
   your PC off, on mobile data, on another Wi-Fi.
3. Images load from `/api/files/*` or the storage CDN.
4. `Supabase → Table Editor` shows rows in `tutorials`, `tutorial_steps`,
   `generation_jobs`.
5. `Render → Logs` shows the job lifecycle
   (job created → stages → tutorial saved → completed).

---

## 10. Troubleshooting

- **Startup fails "STORAGE_PROVIDER=s3 requires STORAGE_BUCKET"** → set the
  storage env vars (R2 bucket + keys), or temporarily set
  `STORAGE_PROVIDER=local` (dev only).
- **Startup fails connecting to Postgres** → check `SUPABASE_URL` /
  `SUPABASE_DB_PASSWORD` (or `DATABASE_URL`). Supabase Postgres works with SSL
  enabled (default here).
- **App shows "Cannot reach the server"** → the Android default URL still
  points to the placeholder domain; update `SettingsStore.kt` or use the
  in-app Settings override.
- **Job fails with `GENERATION_FAILED`** → check Render logs for the error
  message; most likely a storage credential/endpoint issue.
- **Free instance sleeps** → Render free instances go idle after ~15 min; the
  first request after that is slow while it wakes up.

---

## 11. Security notes

- Secrets live only in Render env vars, never in source or the Android app.
- The Android app talks only to the public HTTPS backend; the backend holds
  the DB/storage/LLM keys.
- Image URLs are served through `/api/files/*` behind the same optional
  `AUTH_TOKEN` check unless `R2_PUBLIC_BASE_URL` is set (public bucket).
- Cleanup: failed jobs and ephemeral temp files are purged automatically
  (see `cleanupStaleJobs`).
