"use strict";

const { Pool, types } = require("pg");

// BIGINT (timestamps) must come back as JS numbers, not strings, so the API
// contract keeps `createdAt`/`updatedAt`/etc. as JSON numbers (Android Long).
types.setTypeParser(types.builtins.INT8, (v) => (v == null ? null : parseInt(v, 10)));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Artist',
  profile_image TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tutorials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,
  subject_label TEXT,
  original_image_url TEXT NOT NULL,
  final_image_url TEXT,
  thumbnail_url TEXT,
  mode TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  shading INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'generating',
  saved INTEGER NOT NULL DEFAULT 1,
  completed_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tutorial_steps (
  id TEXT PRIMARY KEY,
  tutorial_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  artist_tip TEXT,
  image_url TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tutorial_progress (
  user_id TEXT NOT NULL,
  tutorial_id TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  last_opened_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, tutorial_id),
  FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  tutorial_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT,
  error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_tutorials_user ON tutorials(user_id);
CREATE INDEX IF NOT EXISTS idx_steps_tutorial ON tutorial_steps(tutorial_id, step_number);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON generation_jobs(status);
`;

/** Translate SQLite-style `?` placeholders to Postgres `$1..$n`. */
function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function createPostgresDb(connectionString, { ssl } = {}) {
  const pool = new Pool({ connectionString, ssl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });

  async function init() {
    let lastErr;
    for (let attempt = 1; attempt <= 15; attempt++) {
      try {
        await pool.query("SELECT 1");
        await pool.query(SCHEMA);
        return this;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw lastErr || new Error("Could not connect to Postgres");
  }

  return {
    isPostgres: true,
    pool,
    async init() {
      return init.call(this);
    },
    async get(sql, ...params) {
      const { rows } = await pool.query(toPg(sql), params);
      return rows[0];
    },
    async all(sql, ...params) {
      const { rows } = await pool.query(toPg(sql), params);
      return rows;
    },
    async run(sql, ...params) {
      const r = await pool.query(toPg(sql), params);
      return { changes: r.rowCount || 0 };
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPostgresDb, toPg };
